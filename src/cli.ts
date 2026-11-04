import { mkdirSync, readFileSync } from 'node:fs';
import { writePacketFile } from './artifactFiles.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultSystemRoot, loadPolicy } from './policy.ts';
import { parseStrictJson } from './strictJson.ts';
import type { LoadedPolicy } from './policy.ts';
import { collectSnapshot, resolveRefToSha, validateSnapshot } from './snapshot.ts';
import { buildReviewBundle } from './partitionPlanner.ts';
import { projectPartition } from './partitionContract.ts';
import { defaultStateRoot, migrateLegacyJournal, prStore, readLedger, recordReview, withPrLock } from './state.ts';
import { prepareRetrospective, validateCloseEvent } from './retrospective.ts';
import { commandPrepareAgent, commandValidateAgent } from './agentCli.ts';
import { realHostDeps, runActionHost, HostInputError } from './actionHost.ts';
import type { PartitionManifest, ReviewLedger, ReviewSnapshot } from './contracts.ts';

const USAGE = `sentinel-review-system (local shadow-mode POC)

Usage:
  cli prepare --checkout PATH --repository OWNER/REPO --pr N --base REF --head REF --run-id ID [--previous-head REF] --out DIR [--state-root PATH] [--system-root PATH]
  cli prepare-bundle --checkout PATH --repository OWNER/REPO --pr N --base REF --head REF --run-id ID [--previous-head REF] --out DIR [--state-root PATH] [--system-root PATH]
  cli record --snapshot FILE --report FILE [--state-root PATH] [--system-root PATH]
  cli retrospective --repository OWNER/REPO --pr N --event FILE --out DIR [--state-root PATH] [--system-root PATH]
  cli journal-migrate --repository OWNER/REPO --pr N [--state-root PATH] [--system-root PATH]
  cli prepare-agent --offline true --checkout PATH --repository OWNER/REPO --pr N --base REF --head REF --run-id ID --review-system-sha SHA --prior-state FILE --validation-limits FILE --out DIR [--system-root PATH]
  cli validate-agent --offline true --checkout PATH --request FILE --report FILE --execution FILE --current FILE --prior-state FILE --out DIR [--system-root PATH]
  cli action-host <start-status|fail-status|reserve|check|materialize|capture|finalize> [stage flags]
  cli --help

prepare-bundle captures the full source set without the maxFiles entry cap (total byte cap unchanged),
partitions it into dependency-closed part requests bounded by maxFiles, and writes snapshot.json with the
manifest, review-request.json listing part payload paths, and parts/part-NNN.review-request.json payloads.
An incomplete parent or an unsplittable context root exits 3 with limitations and publishes nothing.

Exit codes for record: 0 pass, 2 changes_required, 3 incomplete, 1 operational/input failure.
Snapshot files are operator-supplied local collector artifacts; this tool validates their shape and
policy digest but makes no authenticity claim for untrusted uploads.

prepare-agent/validate-agent are OFFLINE-ONLY seams (require --offline true) for the agent
integration prototype. They read a synthetic prior-state checkpoint, local Git objects, a
fabricated structured_output report, and synthetic execution/current attestations, then emit
synthetic artifacts. They access no journal or operational state and authorize nothing.
Exit codes for validate-agent: 0 synthetic pass, 2 synthetic changes_required, 3 incomplete,
1 malformed invocation/input.`;

class UsageError extends Error {}

function parseFlags(args: string[], allowed: string[], required: string[]): Map<string, string> {
  const values = new Map<string, string>();
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (!token.startsWith('--')) throw new UsageError(`Unexpected positional argument: ${token}`);
    const eq = token.indexOf('=');
    const name = token.slice(2, eq < 0 ? undefined : eq);
    if (!allowed.includes(name)) throw new UsageError(`Unknown option: --${name}`);
    if (values.has(name)) throw new UsageError(`Duplicate option: --${name}`);
    let value: string;
    if (eq >= 0) {
      value = token.slice(eq + 1);
    } else {
      index += 1;
      if (index >= args.length || args[index].startsWith('--')) throw new UsageError(`Missing value for --${name}`);
      value = args[index];
    }
    values.set(name, value);
    index += 1;
  }
  for (const name of required) {
    if (!values.has(name)) throw new UsageError(`Missing required option: --${name}`);
  }
  return values;
}

function parsePrNumber(raw: string | undefined): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || String(value) !== String(raw)) {
    throw new UsageError(`Invalid --pr value: ${raw}`);
  }
  return value;
}

function parseJsonFile(filePath: string, label: string): unknown {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new UsageError(`Cannot read ${label} file ${filePath}: ${(error as Error).message}`);
  }
  try {
    return parseStrictJson(text);
  } catch (error) {
    throw new UsageError(`${label} file ${filePath} is not valid JSON: ${(error as Error).message}`);
  }
}

function priorFindingContextPaths(ledger: ReviewLedger): string[] {
  const paths = new Set<string>();
  for (const finding of ledger.openFindings) {
    paths.add(finding.introducedBy.path);
    for (const evidence of finding.evidence) paths.add(evidence.path);
  }
  return [...paths].sort();
}

function commandPrepare(args: string[], bundle = false): number {
  const flags = parseFlags(args, ['checkout', 'repository', 'pr', 'base', 'head', 'run-id', 'previous-head', 'out', 'state-root', 'system-root'], ['checkout', 'repository', 'pr', 'base', 'head', 'run-id', 'out']);
  const systemRoot = path.resolve(flags.get('system-root') ?? defaultSystemRoot());
  const loaded: LoadedPolicy = loadPolicy(systemRoot);
  const repository = flags.get('repository') as string;
  if (!loaded.policy.repositories.includes(repository)) {
    throw new UsageError(`Repository ${repository} is outside the trusted policy allowlist (${loaded.policy.repositories.join(', ')}).`);
  }
  const pullRequest = parsePrNumber(flags.get('pr'));
  const checkout = path.resolve(flags.get('checkout') as string);
  const stateRoot = path.resolve(flags.get('state-root') ?? defaultStateRoot(systemRoot));
  const store = prStore(stateRoot, repository, pullRequest);
  const priorLedger = withPrLock(store, (): ReviewLedger => readLedger(store), 'prepare-read');

  let previousHeadRef = flags.get('previous-head');
  if (priorLedger.lastHeadSha !== null) {
    if (previousHeadRef !== undefined) {
      const resolved = resolveRefToSha(checkout, previousHeadRef, 'previous-head');
      if (resolved !== priorLedger.lastHeadSha) {
        throw new UsageError(`--previous-head resolves to ${resolved}, conflicting with persisted ledger lastHeadSha ${priorLedger.lastHeadSha}.`);
      }
    }
    previousHeadRef = priorLedger.lastHeadSha;
  }

  const snapshot: ReviewSnapshot = collectSnapshot({
    checkout,
    repository,
    pullRequest,
    baseRef: flags.get('base') as string,
    headRef: flags.get('head') as string,
    ...(previousHeadRef !== undefined ? { previousHeadRef } : {}),
    runId: flags.get('run-id') as string,
    additionalContextPaths: priorFindingContextPaths(priorLedger),
  }, loaded, bundle ? 'bundle' : 'single');

  const outDir = path.resolve(flags.get('out') as string);
  mkdirSync(outDir, { recursive: true });

  if (bundle) {
    let parent: ReviewSnapshot;
    try {
      parent = buildReviewBundle(snapshot, loaded.policy);
    } catch (error) {
      console.log(JSON.stringify({
        status: 'incomplete',
        identity: snapshot.identity,
        limitations: [...snapshot.limitations, (error as Error).message],
      }, null, 2));
      return 3;
    }
    const manifest = parent.partitionManifest as PartitionManifest;
    const partsDir = path.join(outDir, 'parts');
    mkdirSync(partsDir, { recursive: true });
    const partPaths: string[] = [];
    for (const partition of manifest.partitions) {
      const projected = projectPartition(parent, partition);
      const partRequest = {
        schemaVersion: 1,
        kind: 'partition-review-request',
        partitionId: partition.id,
        manifestDigest: manifest.digest,
        prompt: `${loaded.reviewPrompt}\n\n${loaded.partitionPrompt}`,
        responseContract: loaded.responseContract,
        policy: loaded.policy,
        policyDigest: loaded.digest,
        snapshot: projected,
        priorLedger,
      };
      const partPath = path.join(partsDir, `${partition.id}.review-request.json`);
      writePacketFile(partPath, `${JSON.stringify(partRequest, null, 2)}\n`);
      partPaths.push(partPath);
    }
    const snapshotPath = path.join(outDir, 'snapshot.json');
    const requestPath = path.join(outDir, 'review-request.json');
    const snapshotResult = writePacketFile(snapshotPath, `${JSON.stringify(parent, null, 2)}\n`);
    const request = {
      schemaVersion: 1,
      kind: 'partitioned-review-bundle',
      identity: parent.identity,
      manifest,
      parts: partPaths,
      priorLedger,
    };
    const requestResult = writePacketFile(requestPath, `${JSON.stringify(request, null, 2)}\n`);
    console.log(JSON.stringify({
      status: 'prepared',
      kind: 'partitioned-review-bundle',
      snapshot: { path: snapshotPath, result: snapshotResult },
      request: { path: requestPath, result: requestResult },
      changes: parent.changes.length,
      size: parent.size,
      files: parent.files.length,
      partCount: manifest.partitions.length,
      partSourceCounts: manifest.partitions.map((partition): number => partition.sourceKeys.length),
      previousHeadSha: parent.previousHeadSha,
    }, null, 2));
    return 0;
  }

  const snapshotPath = path.join(outDir, 'snapshot.json');
  const requestPath = path.join(outDir, 'review-request.json');
  const snapshotResult = writePacketFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  const request = {
    schemaVersion: 1,
    kind: 'sentinel-review-request',
    prompt: loaded.reviewPrompt,
    responseContract: loaded.responseContract,
    policy: loaded.policy,
    policyDigest: loaded.digest,
    snapshot,
    priorLedger,
  };
  const requestResult = writePacketFile(requestPath, `${JSON.stringify(request, null, 2)}\n`);
  console.log(JSON.stringify({
    status: 'prepared',
    snapshot: { path: snapshotPath, result: snapshotResult },
    request: { path: requestPath, result: requestResult },
    changes: snapshot.changes.length,
    size: snapshot.size,
    files: snapshot.files.length,
    dependencyEdges: snapshot.dependencyEdges.length,
    complete: snapshot.complete,
    limitations: snapshot.limitations,
    contextSelections: snapshot.contextPlan.selections.length,
    contextFallbacks: snapshot.contextPlan.fallbacks.length,
    previousHeadSha: snapshot.previousHeadSha,
  }, null, 2));
  return 0;
}

function commandRecord(args: string[]): number {
  const flags = parseFlags(args, ['snapshot', 'report', 'state-root', 'system-root'], ['snapshot', 'report']);
  const systemRoot = path.resolve(flags.get('system-root') ?? defaultSystemRoot());
  const loaded = loadPolicy(systemRoot);
  const snapshot = validateSnapshot(parseJsonFile(flags.get('snapshot') as string, 'snapshot'), loaded);
  const report = parseJsonFile(flags.get('report') as string, 'report');
  const stateRoot = path.resolve(flags.get('state-root') ?? defaultStateRoot(systemRoot));
  const { decision, replayed, superseded } = recordReview(stateRoot, snapshot, report, loaded.policy);
  console.log(JSON.stringify({ replayed, superseded, decision }, null, 2));
  if (superseded) return 3;
  if (decision.status === 'pass') return 0;
  if (decision.status === 'changes_required') return 2;
  return 3;
}

function commandJournalMigrate(args: string[]): number {
  const flags = parseFlags(args, ['repository', 'pr', 'state-root', 'system-root'], ['repository', 'pr']);
  const systemRoot = path.resolve(flags.get('system-root') ?? defaultSystemRoot());
  const loaded = loadPolicy(systemRoot);
  const repository = flags.get('repository') as string;
  if (!loaded.policy.repositories.includes(repository)) {
    throw new UsageError(`Repository ${repository} is outside the trusted policy allowlist (${loaded.policy.repositories.join(', ')}).`);
  }
  const pullRequest = parsePrNumber(flags.get('pr'));
  const stateRoot = path.resolve(flags.get('state-root') ?? defaultStateRoot(systemRoot));
  const store = prStore(stateRoot, repository, pullRequest);
  const result = migrateLegacyJournal(store);
  console.log(JSON.stringify({
    status: result.status,
    entries: result.migrated,
    alreadyCurrent: result.alreadyCurrent,
    journalPath: store.journalPath,
    backupPath: result.backupPath,
    note: 'Migration validates available immutable snapshot transition evidence but does not authenticate local records or replay historical reports under current policy.',
  }, null, 2));
  return 0;
}

function commandRetrospective(args: string[]): number {
  const flags = parseFlags(args, ['repository', 'pr', 'event', 'out', 'state-root', 'system-root'], ['repository', 'pr', 'event', 'out']);
  const systemRoot = path.resolve(flags.get('system-root') ?? defaultSystemRoot());
  const loaded = loadPolicy(systemRoot);
  const repository = flags.get('repository') as string;
  if (!loaded.policy.repositories.includes(repository)) {
    throw new UsageError(`Repository ${repository} is outside the trusted policy allowlist (${loaded.policy.repositories.join(', ')}).`);
  }
  const pullRequest = parsePrNumber(flags.get('pr'));
  const event = validateCloseEvent(parseJsonFile(flags.get('event') as string, 'event'));
  const stateRoot = path.resolve(flags.get('state-root') ?? defaultStateRoot(systemRoot));
  const { draft, draftPath, replayed } = prepareRetrospective(stateRoot, repository, pullRequest, event, loaded.digest);
  const outDir = path.resolve(flags.get('out') as string);
  mkdirSync(outDir, { recursive: true });
  const draftOut = path.join(outDir, 'retrospective-draft.json');
  const requestOut = path.join(outDir, 'retrospective-request.json');
  writePacketFile(draftOut, `${JSON.stringify(draft, null, 2)}\n`);
  const request = {
    schemaVersion: 1,
    kind: 'sentinel-retrospective-request',
    prompt: loaded.retrospectivePrompt,
    policyDigest: loaded.digest,
    draft,
  };
  writePacketFile(requestOut, `${JSON.stringify(request, null, 2)}\n`);
  console.log(JSON.stringify({
    status: 'prepared',
    replayed,
    persistedDraft: draftPath,
    draft: draftOut,
    request: requestOut,
    mode: draft.mode,
    runs: draft.reviewHistory.length,
    unresolvedFindingIds: draft.unresolvedFindingIds,
    limitations: draft.limitations,
  }, null, 2));
  return 0;
}

const ACTION_HOST_FLAGS = ['source-checkout', 'state-checkout', 'prepared', 'result', 'out', 'system-root'];

async function commandActionHost(args: string[]): Promise<number> {
  const [stage, ...rest] = args;
  const options: Record<string, string> = {};
  let index = 0;
  while (index < rest.length) {
    const token = rest[index];
    if (!token.startsWith('--')) throw new UsageError(`Unexpected positional argument: ${token}`);
    const eq = token.indexOf('=');
    const name = token.slice(2, eq < 0 ? undefined : eq);
    if (!ACTION_HOST_FLAGS.includes(name)) throw new UsageError(`Unknown option: --${name}`);
    const value = eq >= 0 ? token.slice(eq + 1) : rest[++index];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`Missing value for --${name}`);
    const key = name.replace(/-([a-z])/g, (_match: string, letter: string): string => letter.toUpperCase());
    if (options[key] !== undefined) throw new UsageError(`Duplicate option: --${name}`);
    options[key] = value;
    index += 1;
  }
  if (stage === undefined || stage.length === 0) throw new UsageError('Missing action-host stage');
  try {
    return await runActionHost(stage, options, realHostDeps());
  } catch (error) {
    if (error instanceof HostInputError) throw new UsageError(error.message);
    throw error;
  }
}

export function runCli(argv: string[]): number | Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === '--help' || command === '-h' || command === 'help') {
      console.log(USAGE);
      return 0;
    }
    if (command === 'prepare') return commandPrepare(rest);
    if (command === 'prepare-bundle') return commandPrepare(rest, true);
    if (command === 'record') return commandRecord(rest);
    if (command === 'retrospective') return commandRetrospective(rest);
    if (command === 'journal-migrate') return commandJournalMigrate(rest);
    if (command === 'prepare-agent') return commandPrepareAgent(rest);
    if (command === 'validate-agent') return commandValidateAgent(rest);
    if (command === 'action-host') return commandActionHost(rest);
    throw new UsageError(`Unknown command: ${String(command)}\n\n${USAGE}`);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`error: ${error.message}`);
    } else {
      console.error(`error: ${(error as Error).message}`);
    }
    return 1;
  }
}

const invokedAs = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedAs === fileURLToPath(import.meta.url)) {
  const result = runCli(process.argv.slice(2));
  if (result instanceof Promise) {
    result.then(
      (code: number): void => { process.exitCode = code; },
      (error: unknown): void => {
        console.error(`error: ${(error as Error).message}`);
        process.exitCode = 1;
      },
    );
  } else {
    process.exitCode = result;
  }
}
