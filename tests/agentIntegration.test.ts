import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ALLOWED_REPOSITORY, SYSTEM_ROOT, loadTestPolicy, makeRepo, seedPolicyContext } from './helpers.ts';
import type { RepoFixture } from './helpers.ts';
import type { ReviewLedger } from '../src/contracts.ts';
import { AGENT_TRUSTED_PATHS, agentPolicyDigest, loadAgentTrust } from '../src/agentContracts.ts';
import { loadPolicy } from '../src/policy.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const REVIEW_SYSTEM_SHA = 'f'.repeat(40);
const LIMITS = { maxFiles: 100, maxSourceBytes: 1_000_000, maxReadBytes: 100_000 };

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

function cli(args: string[]): CliResult {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', CLI, ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function writeJson(filePath: string, value: unknown): string {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
  return filePath;
}

function emptyLedger(): ReviewLedger {
  return { schemaVersion: 1, repository: ALLOWED_REPOSITORY, pullRequest: 17, lastHeadSha: null, openFindings: [] };
}

function checkpoint(ledger: ReviewLedger = emptyLedger(), stateVersion = 'state-1'): unknown {
  return {
    schemaVersion: 1,
    repository: ALLOWED_REPOSITORY,
    pullRequest: 17,
    stateVersion,
    ledger,
  };
}

interface AgentRepo {
  repo: RepoFixture;
  baseSha: string;
  headSha: string;
  tmp: string;
  checkpointPath: string;
  limitsPath: string;
}

function makeAgentRepo(): AgentRepo {
  const repo = makeRepo();
  const loaded = loadTestPolicy();
  seedPolicyContext(repo, loaded);
  repo.write('src/action.ts', 'export const required = true;\n');
  const baseSha = repo.commit('base');
  repo.write('src/action.ts', 'export const required = false;\n');
  const headSha = repo.commit('head');
  const tmp = mkdtempSync(path.join(tmpdir(), 'srs-agent-'));
  const checkpointPath = writeJson(path.join(tmp, 'prior-state.json'), checkpoint());
  const limitsPath = writeJson(path.join(tmp, 'limits.json'), LIMITS);
  return { repo, baseSha, headSha, tmp, checkpointPath, limitsPath };
}

function prepareArgs(
  a: AgentRepo,
  options: { overrides?: Record<string, string>; extra?: string[]; out?: string } = {},
): string[] {
  const flags = new Map<string, string>([
    ['checkout', a.repo.dir],
    ['repository', ALLOWED_REPOSITORY],
    ['pr', '17'],
    ['base', a.baseSha],
    ['head', a.headSha],
    ['run-id', 'run-agent-1'],
    ['review-system-sha', REVIEW_SYSTEM_SHA],
    ['prior-state', a.checkpointPath],
    ['validation-limits', a.limitsPath],
    ['out', options.out ?? path.join(a.tmp, 'prepared')],
    ['offline', 'true'],
  ]);
  for (const [key, value] of Object.entries(options.overrides ?? {})) flags.set(key, value);
  return ['prepare-agent', ...[...flags.entries()].flatMap(([key, value]) => [`--${key}`, value]), ...(options.extra ?? [])];
}

function executionFile(a: AgentRepo, overrides: Record<string, unknown> = {}): string {
  return writeJson(path.join(a.tmp, 'execution.json'), {
    schemaVersion: 1,
    mode: 'offline',
    synthetic: true,
    conclusion: 'success',
    termination: 'completed',
    model: loadTestPolicy().policy.model,
    runId: 'run-agent-1',
    ...overrides,
  });
}

function currentFile(a: AgentRepo, overrides: Record<string, unknown> = {}): string {
  return writeJson(path.join(a.tmp, 'current.json'), {
    repository: ALLOWED_REPOSITORY,
    pullRequest: 17,
    headSha: a.headSha,
    baseSha: a.baseSha,
    runId: 'run-agent-1',
    reviewSystemSha: REVIEW_SYSTEM_SHA,
    ...overrides,
  });
}

interface PreparedRun {
  a: AgentRepo;
  prepOut: string;
  request: Record<string, unknown> & { identity: Record<string, unknown>; changes: { path: string; status: string; previousPath?: string }[]; dependencyEdges: { from: string; to: string }[] };
}

function runPrepare(a: AgentRepo, expectedStatus: 0 | 3 = 0): PreparedRun {
  const prepOut = path.join(a.tmp, 'prepared');
  const result = cli(prepareArgs(a, { out: prepOut }));
  assert.equal(result.status, expectedStatus, result.stderr);
  const request = JSON.parse(readFileSync(path.join(prepOut, 'request.json'), 'utf8'));
  if (expectedStatus === 3) {
    assert.equal(request.complete, false, 'incomplete preparation must mark the request incomplete');
    assert.ok(request.limitations.length > 0);
  }
  return { a, prepOut, request };
}

function agentCoverage(request: PreparedRun['request'], relatedOverrides: Record<string, string[]> = {}): unknown[] {
  const edges = request.dependencyEdges;
  return request.changes.flatMap((change) => {
    const relevant = new Set([change.path, ...(change.previousPath ? [change.previousPath] : [])]);
    const neighbors = [...new Set(edges.flatMap((edge) => [
      ...(relevant.has(edge.from) ? [edge.to] : []),
      ...(relevant.has(edge.to) ? [edge.from] : []),
    ]).filter((candidate) => !relevant.has(candidate)))].sort();
    return ['test-validity', 'reliability-impact', 'maintainability'].map((dimension) => ({
      path: change.path,
      dimension,
      assessment: 'reviewed',
      rationale: 'Reviewed before/after source and direct dependency context.',
      relatedPaths: relatedOverrides[change.path] ?? neighbors,
    }));
  });
}

function agentReport(request: PreparedRun['request'], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    identity: request.identity,
    complete: true,
    limitations: [],
    coverage: agentCoverage(request),
    findings: [],
    reconciliations: [],
    ...overrides,
  };
}

function validateArgs(
  run: PreparedRun,
  files: { report: string; execution?: string; current?: string; priorState?: string },
  options: { out?: string; extra?: string[] } = {},
): string[] {
  const flags = new Map<string, string>([
    ['checkout', run.a.repo.dir],
    ['request', path.join(run.prepOut, 'request.json')],
    ['report', files.report],
    ['execution', files.execution ?? executionFile(run.a)],
    ['current', files.current ?? currentFile(run.a)],
    ['prior-state', files.priorState ?? run.a.checkpointPath],
    ['out', options.out ?? path.join(run.a.tmp, 'validated')],
    ['offline', 'true'],
  ]);
  return ['validate-agent', ...[...flags.entries()].flatMap(([key, value]) => [`--${key}`, value]), ...(options.extra ?? [])];
}

function writeReport(a: AgentRepo, report: unknown, name = 'report.json'): string {
  return writeJson(path.join(a.tmp, name), report);
}

test('prepare-agent emits synthetic offline request, instructions, and bound report schema', (): void => {
  const a = makeAgentRepo();
  const out = path.join(a.tmp, 'prepared');
  const result = cli(prepareArgs(a, { out }));
  assert.equal(result.status, 0, result.stderr);
  const stdout = JSON.parse(result.stdout);
  assert.equal(stdout.status, 'prepared');
  assert.equal(stdout.synthetic, true);
  assert.equal(stdout.operational, false);

  const request = JSON.parse(readFileSync(path.join(out, 'request.json'), 'utf8'));
  assert.equal(request.schemaVersion, 1);
  assert.equal(request.kind, 'agent-review');
  assert.equal(request.mode, 'offline');
  assert.equal(request.synthetic, true);
  assert.equal(request.operational, false);
  assert.equal(request.reviewSystemSha, REVIEW_SYSTEM_SHA);
  assert.equal(request.priorStateVersion, 'state-1');
  assert.equal('files' in request, false);
  assert.equal('partitionManifest' in request, false);
  assert.equal('partitionScope' in request, false);
  assert.deepEqual(request.priorLedger, emptyLedger());
  assert.deepEqual(request.validationLimits, LIMITS);
  assert.equal(request.identity.repository, ALLOWED_REPOSITORY);
  assert.equal(request.identity.pullRequest, 17);
  assert.equal(request.identity.headSha, a.headSha);
  assert.equal(request.identity.baseSha, a.baseSha);
  assert.notEqual(request.identity.mergeBaseSha, '');
  assert.equal(request.identity.model, loadTestPolicy().policy.model);
  assert.equal(request.identity.runId, 'run-agent-1');
  assert.notEqual(request.identity.policyDigest, loadTestPolicy().digest);
  assert.equal(request.previousHeadSha, null);
  assert.deepEqual(request.changes, [{ path: 'src/action.ts', status: 'modified' }]);
  assert.equal(request.complete, true);
  assert.deepEqual(request.limitations, []);
  assert.match(request.cumulativeDiff, /required = false/);
  assert.equal(request.deltaDiff, null);

  const instructions = readFileSync(path.join(out, 'instructions.md'), 'utf8');
  assert.match(instructions, /Sentinel agent review procedure/);
  assert.doesNotMatch(instructions, /Partition review protocol|Runner source presentation|Sentinel cumulative review contract/);

  const schema = JSON.parse(readFileSync(path.join(out, 'report.schema.json'), 'utf8'));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.identity.properties.headSha.const, a.headSha);
  assert.equal(schema.properties.identity.properties.policyDigest.const, request.identity.policyDigest);
});

test('validate-agent accepts a fabricated complete report and emits a synthetic pass envelope', (): void => {
  const run = runPrepare(makeAgentRepo());
  const report = writeReport(run.a, agentReport(run.request));
  const out = path.join(run.a.tmp, 'validated');
  const result = cli(validateArgs(run, { report }, { out }));
  assert.equal(result.status, 0, result.stderr);
  const stdout = JSON.parse(result.stdout);
  assert.equal(stdout.synthetic, true);
  assert.equal(stdout.operational, false);
  assert.equal(stdout.status, 'pass');

  const envelope = JSON.parse(readFileSync(path.join(out, 'decision.json'), 'utf8'));
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.kind, 'offline-agent-decision');
  assert.equal(envelope.synthetic, true);
  assert.equal(envelope.operational, false);
  assert.equal(envelope.decision.status, 'pass');
  assert.equal(envelope.decision.ledger.lastHeadSha, run.request.identity.headSha);
  const audit = JSON.parse(readFileSync(path.join(out, 'validation-audit.json'), 'utf8'));
  assert.equal(audit.synthetic, true);
  assert.equal(audit.operational, false);
  assert.equal(audit.stage, 'evaluated');
  assert.ok(Array.isArray(audit.sourceReads));
  const preserved = readFileSync(path.join(out, 'report.json'), 'utf8');
  assert.equal(preserved, readFileSync(report, 'utf8'));
});

const HEAD_EVIDENCE = { path: 'src/action.ts', revision: 'head' as const, startLine: 1, endLine: 1, quote: 'export const required = false;' };

function blockerFinding(evidence: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'F-1',
    ruleId: 'SR-002',
    severity: 'blocker',
    title: 'Required setup bypassed',
    explanation: 'Mechanism shown.',
    impact: 'Reachable consequence.',
    introducedBy: evidence,
    evidence: [evidence],
    counterEvidence: ['Checked.'],
  };
}

test('a valid fabricated blocker report yields synthetic changes_required', (): void => {
  const run = runPrepare(makeAgentRepo());
  const report = writeReport(run.a, agentReport(run.request, { findings: [blockerFinding(HEAD_EVIDENCE)] }));
  const result = cli(validateArgs(run, { report }));
  assert.equal(result.status, 2, result.stderr);
  const envelope = JSON.parse(readFileSync(path.join(run.a.tmp, 'validated', 'decision.json'), 'utf8'));
  assert.equal(envelope.decision.status, 'changes_required');
  assert.equal(envelope.operational, false);
});

test('corrupted quote, wrong revision, and out-of-range citations are incomplete, never repaired', (): void => {
  const corrupted = { ...HEAD_EVIDENCE, quote: 'export const required = true;' };
  const wrongRevision = { ...HEAD_EVIDENCE, revision: 'base' };
  const outOfRange = { ...HEAD_EVIDENCE, startLine: 2, endLine: 2 };
  for (const [name, evidence] of Object.entries({ corrupted, wrongRevision, outOfRange })) {
    const run = runPrepare(makeAgentRepo());
    const report = writeReport(run.a, agentReport(run.request, { findings: [blockerFinding(evidence)] }), name);
    const result = cli(validateArgs(run, { report }, { out: path.join(run.a.tmp, `validated-${name}`) }));
    assert.equal(result.status, 3, `${name}: ${result.stderr}`);
    const envelope = JSON.parse(readFileSync(path.join(run.a.tmp, `validated-${name}`, 'decision.json'), 'utf8'));
    assert.equal(envelope.decision.status, 'incomplete');
    assert.match(envelope.decision.reasons.join(' '), /evidence absent/i);
  }
});

test('stale current attestation, mutated prior-state version/ledger, and tampered request metadata are nonpass', (): void => {
  const cases: { name: string; mutate: (ctx: { request: Record<string, unknown>; priorState: Record<string, unknown>; current: Record<string, unknown> }) => void }[] = [
    { name: 'current-head', mutate: ({ current }) => { current.headSha = '1'.repeat(40); } },
    { name: 'current-base', mutate: ({ current }) => { current.baseSha = '2'.repeat(40); } },
    { name: 'current-run', mutate: ({ current }) => { current.runId = 'run-agent-2'; } },
    { name: 'current-review-system', mutate: ({ current }) => { current.reviewSystemSha = '3'.repeat(40); } },
    { name: 'prior-version', mutate: ({ priorState }) => { priorState.stateVersion = 'state-2'; } },
    {
      name: 'prior-ledger',
      mutate: ({ priorState }) => {
        (priorState.ledger as Record<string, unknown>).openFindings = [blockerFinding(HEAD_EVIDENCE)];
      },
    },
    { name: 'request-digest', mutate: ({ request }) => { (request.identity as Record<string, unknown>).policyDigest = '0'.repeat(64); } },
    { name: 'request-model', mutate: ({ request }) => { (request.identity as Record<string, unknown>).model = 'other-model'; } },
    { name: 'request-run', mutate: ({ request }) => { (request.identity as Record<string, unknown>).runId = 'run-agent-2'; } },
    { name: 'request-diff', mutate: ({ request }) => { request.cumulativeDiff = 'tampered diff\n'; } },
    { name: 'request-changes', mutate: ({ request }) => { request.changes = []; } },
    { name: 'request-edges', mutate: ({ request }) => { request.dependencyEdges = [{ from: 'src/consumer.ts', to: 'src/action.ts' }]; } },
  ];
  for (const item of cases) {
    const run = runPrepare(makeAgentRepo());
    const request = structuredClone(run.request) as Record<string, unknown>;
    const priorState = JSON.parse(readFileSync(run.a.checkpointPath, 'utf8')) as Record<string, unknown>;
    const current = {
      repository: ALLOWED_REPOSITORY,
      pullRequest: 17,
      headSha: run.a.headSha,
      baseSha: run.a.baseSha,
      runId: 'run-agent-1',
      reviewSystemSha: REVIEW_SYSTEM_SHA,
    };
    item.mutate({ request, priorState, current });
    const requestPath = writeJson(path.join(run.a.tmp, `request-${item.name}.json`), request);
    const priorPath = writeJson(path.join(run.a.tmp, `prior-${item.name}.json`), priorState);
    const currentPath = writeJson(path.join(run.a.tmp, `current-${item.name}.json`), current);
    const report = writeReport(run.a, agentReport(request as never), `report-${item.name}.json`);
    const flags = new Map<string, string>([
      ['checkout', run.a.repo.dir], ['request', requestPath], ['report', report],
      ['execution', executionFile(run.a)], ['current', currentPath], ['prior-state', priorPath],
      ['out', path.join(run.a.tmp, `validated-${item.name}`)], ['offline', 'true'],
    ]);
    const args = ['validate-agent', ...[...flags.entries()].flatMap(([key, value]) => [`--${key}`, value])];
    const result = cli(args);
    assert.equal(result.status, 3, `${item.name}: stdout=${result.stdout} stderr=${result.stderr}`);
    const envelope = JSON.parse(readFileSync(path.join(run.a.tmp, `validated-${item.name}`, 'decision.json'), 'utf8'));
    assert.equal(envelope.decision.status, 'incomplete', item.name);
    assert.equal(envelope.decision.ledger.lastHeadSha, null, `${item.name}: prior ledger retained`);
  }
});

test('missing or corrupt checkpoint and malformed orchestration inputs are CLI failures', (): void => {
  const a = makeAgentRepo();
  const missing = cli(prepareArgs(a, { overrides: { 'prior-state': path.join(a.tmp, 'absent.json') } }));
  assert.equal(missing.status, 1);
  const corruptPath = writeJson(path.join(a.tmp, 'corrupt.json'), { schemaVersion: 1 });
  const corrupt = cli(prepareArgs(a, { overrides: { 'prior-state': corruptPath } }));
  assert.equal(corrupt.status, 1);
  const run = runPrepare(makeAgentRepo());
  const report = writeReport(run.a, agentReport(run.request));
  const badCurrent = writeJson(path.join(run.a.tmp, 'current-bad.json'), { repository: ALLOWED_REPOSITORY });
  const result = cli(validateArgs(run, { report, current: badCurrent }));
  assert.equal(result.status, 1);
});

test('a prior blocker is never dropped: omitted reconciliation is incomplete, open stays blocking, evidence-fixed passes', (): void => {
  const priorFinding = {
    id: 'F-1',
    ruleId: 'SR-002',
    severity: 'blocker' as const,
    title: 'Required setup bypassed',
    explanation: 'Prior mechanism shown.',
    impact: 'Prior consequence.',
    introducedBy: HEAD_EVIDENCE,
    evidence: [HEAD_EVIDENCE],
    counterEvidence: ['Checked.'],
  };
  const priorLedger: ReviewLedger = { ...emptyLedger(), openFindings: [priorFinding] };

  // Omitted reconciliation -> incomplete, blocker retained.
  {
    const a = makeAgentRepo();
    a.checkpointPath = writeJson(path.join(a.tmp, 'prior-state.json'), checkpoint(priorLedger));
    const run = runPrepare(a);
    const report = writeReport(run.a, agentReport(run.request));
    const result = cli(validateArgs(run, { report }));
    assert.equal(result.status, 3, result.stderr);
    const envelope = JSON.parse(readFileSync(path.join(run.a.tmp, 'validated', 'decision.json'), 'utf8'));
    assert.equal(envelope.decision.status, 'incomplete');
    assert.equal(envelope.decision.ledger.openFindings[0]?.id, 'F-1');
  }

  // Open reconciliation plus retained finding -> changes_required.
  {
    const a = makeAgentRepo();
    a.checkpointPath = writeJson(path.join(a.tmp, 'prior-state.json'), checkpoint(priorLedger));
    const run = runPrepare(a);
    const report = writeReport(run.a, agentReport(run.request, {
      findings: [blockerFinding(HEAD_EVIDENCE)],
      reconciliations: [{ findingId: 'F-1', outcome: 'open', rationale: 'Mechanism still reachable.', evidence: [HEAD_EVIDENCE] }],
    }));
    const result = cli(validateArgs(run, { report }));
    assert.equal(result.status, 2, result.stderr);
    const envelope = JSON.parse(readFileSync(path.join(run.a.tmp, 'validated', 'decision.json'), 'utf8'));
    assert.equal(envelope.decision.status, 'changes_required');
    assert.equal(envelope.decision.ledger.openFindings[0]?.id, 'F-1');
  }

  // Evidence-based fixed reconciliation -> synthetic pass clears the blocker.
  {
    const a = makeAgentRepo();
    a.checkpointPath = writeJson(path.join(a.tmp, 'prior-state.json'), checkpoint({ ...priorLedger, lastHeadSha: a.baseSha }));
    const run = runPrepare(a);
    const report = writeReport(run.a, agentReport(run.request, {
      reconciliations: [{ findingId: 'F-1', outcome: 'fixed', rationale: 'Synthetic resolution attestation citing current source; semantic correctness is not established by this fixture.', evidence: [HEAD_EVIDENCE] }],
    }));
    const result = cli(validateArgs(run, { report }));
    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(readFileSync(path.join(run.a.tmp, 'validated', 'decision.json'), 'utf8'));
    assert.equal(envelope.decision.status, 'pass');
    assert.equal(envelope.decision.ledger.openFindings.length, 0);
    const audit = JSON.parse(readFileSync(path.join(run.a.tmp, 'validated', 'validation-audit.json'), 'utf8'));
    assert.deepEqual(audit.resolutionOverlaps, []);
    assert.deepEqual(audit.fixedEvidenceOutsideScope, []);
  }

  // An incomplete report cannot clear the blocker even while claiming fixed.
  {
    const a = makeAgentRepo();
    a.checkpointPath = writeJson(path.join(a.tmp, 'prior-state.json'), checkpoint({ ...priorLedger, lastHeadSha: a.baseSha }));
    const run = runPrepare(a);
    const report = writeReport(run.a, agentReport(run.request, {
      complete: false,
      limitations: ['Could not inspect runtime wiring.'],
      reconciliations: [{ findingId: 'F-1', outcome: 'fixed', rationale: 'Claimed fixed.', evidence: [HEAD_EVIDENCE] }],
    }));
    const result = cli(validateArgs(run, { report }));
    assert.equal(result.status, 3, result.stderr);
    const envelope = JSON.parse(readFileSync(path.join(run.a.tmp, 'validated', 'decision.json'), 'utf8'));
    assert.equal(envelope.decision.status, 'incomplete');
    assert.equal(envelope.decision.ledger.openFindings[0]?.id, 'F-1');
  }
});

test('report contract violations are incomplete: missing dimension, duplicates, blocked, unknown fields, partitionScope, bad JSON', (): void => {
  const baseReport = (request: PreparedRun['request']): Record<string, unknown> => agentReport(request);
  const cases: { name: string; build: (request: PreparedRun['request']) => unknown }[] = [
    {
      name: 'missing-dimension',
      build: (request) => agentReport(request, {
        coverage: (agentCoverage(request) as { dimension: string }[]).filter((entry) => entry.dimension !== 'maintainability'),
      }),
    },
    {
      name: 'duplicate-coverage',
      build: (request) => {
        const coverage = agentCoverage(request) as unknown[];
        return agentReport(request, { coverage: [...coverage, coverage[0]] });
      },
    },
    {
      name: 'blocked-coverage',
      build: (request) => agentReport(request, {
        coverage: (agentCoverage(request) as { assessment: string }[]).map((entry) => ({ ...entry, assessment: 'blocked' })),
      }),
    },
    { name: 'incomplete-report', build: (request) => agentReport(request, { complete: false, limitations: ['Context gap.'] }) },
    { name: 'extra-top-field', build: (request) => ({ ...baseReport(request), verdict: 'pass' }) },
    {
      name: 'extra-nested-field',
      build: (request) => agentReport(request, {
        coverage: (agentCoverage(request) as object[]).map((entry) => ({ ...entry, inspected: true })),
      }),
    },
    { name: 'partition-scope', build: (request) => ({ ...baseReport(request), partitionScope: { manifestDigest: 'a'.repeat(64), partitionId: 'part-001' } }) },
    { name: 'unknown-rule', build: (request) => agentReport(request, { findings: [blockerFinding({ ...HEAD_EVIDENCE })].map((f) => ({ ...f, ruleId: 'XX-999' })) }) },
  ];
  for (const item of cases) {
    const run = runPrepare(makeAgentRepo());
    const report = writeReport(run.a, item.build(run.request), `report-${item.name}.json`);
    const out = path.join(run.a.tmp, `validated-${item.name}`);
    const result = cli(validateArgs(run, { report }, { out }));
    assert.equal(result.status, 3, `${item.name}: stdout=${result.stdout} stderr=${result.stderr}`);
    const envelope = JSON.parse(readFileSync(path.join(out, 'decision.json'), 'utf8'));
    assert.equal(envelope.decision.status, 'incomplete', item.name);
  }

  // Raw report text that is not strict JSON: fences, trailing prose, malformed.
  for (const [name, text] of Object.entries({
    fenced: `\`\`\`json\n{"schemaVersion":1}\n\`\`\`\n`,
    'trailing-prose': '{"schemaVersion":1}\nextra text\n',
    malformed: '{not json',
  })) {
    const run = runPrepare(makeAgentRepo());
    const reportPath = path.join(run.a.tmp, `raw-${name}.json`);
    writeFileSync(reportPath, text);
    const out = path.join(run.a.tmp, `validated-${name}`);
    const result = cli(validateArgs(run, { report: reportPath }, { out }));
    assert.equal(result.status, 3, `${name}: stdout=${result.stdout} stderr=${result.stderr}`);
    const envelope = JSON.parse(readFileSync(path.join(out, 'decision.json'), 'utf8'));
    assert.equal(envelope.decision.status, 'incomplete', name);
    assert.equal(readFileSync(path.join(out, 'report.json'), 'utf8'), text, `${name}: raw bytes preserved`);
  }

  // A missing report file is missing execution evidence: incomplete with the prior ledger retained.
  {
    const run = runPrepare(makeAgentRepo());
    const out = path.join(run.a.tmp, 'validated-missing-report');
    const result = cli(validateArgs(run, { report: path.join(run.a.tmp, 'no-such-report.json') }, { out }));
    assert.equal(result.status, 3, result.stderr);
    const envelope = JSON.parse(readFileSync(path.join(out, 'decision.json'), 'utf8'));
    assert.equal(envelope.decision.status, 'incomplete');
    assert.equal(envelope.decision.ledger.lastHeadSha, null);
    assert.equal(existsSync(path.join(out, 'report.json')), false);
  }
});

test('a duplicated JSON key in an otherwise valid report is refused, while the same clean object passes', (): void => {
  const run = runPrepare(makeAgentRepo());
  const clean = JSON.stringify(agentReport(run.request));
  assert.ok(clean.includes('"complete":true'));
  const cleanPath = path.join(run.a.tmp, 'clean-report.json');
  writeFileSync(cleanPath, clean);
  const cleanOut = path.join(run.a.tmp, 'validated-clean');
  assert.equal(cli(validateArgs(run, { report: cleanPath }, { out: cleanOut })).status, 0);

  const duplicated = clean.replace('"complete":true', '"complete":false,"complete":true');
  assert.ok(duplicated.includes('"complete":false,"complete":true'));
  const dupPath = path.join(run.a.tmp, 'dup-report.json');
  writeFileSync(dupPath, duplicated);
  const dupOut = path.join(run.a.tmp, 'validated-dup');
  const result = cli(validateArgs(run, { report: dupPath }, { out: dupOut }));
  assert.equal(result.status, 3, result.stderr);
  const envelope = JSON.parse(readFileSync(path.join(dupOut, 'decision.json'), 'utf8'));
  assert.equal(envelope.decision.status, 'incomplete');
  assert.match(envelope.decision.reasons.join(' '), /duplicate JSON object key/i);
});

test('unusable execution attestations are incomplete even when the fabricated report is clean', (): void => {
  const model = loadTestPolicy().policy.model;
  const cases: { name: string; execution?: Record<string, unknown>; raw?: string | null }[] = [
    { name: 'failure', execution: { conclusion: 'failure' } },
    { name: 'interrupted', execution: { termination: 'interrupted' } },
    { name: 'timeout', execution: { termination: 'timeout' } },
    { name: 'budget', execution: { termination: 'budget_exhausted' } },
    { name: 'turns', execution: { termination: 'turn_exhausted' } },
    { name: 'model', execution: { model: 'other-model' } },
    { name: 'run', execution: { runId: 'run-agent-2' } },
    { name: 'missing-file', raw: null },
    { name: 'malformed', raw: '{not json' },
    { name: 'operational-field', execution: { schemaVersion: 1, mode: 'offline', synthetic: true, conclusion: 'success', termination: 'completed', model, runId: 'run-agent-1', operational: false } },
  ];
  for (const item of cases) {
    const run = runPrepare(makeAgentRepo());
    const report = writeReport(run.a, agentReport(run.request), `report-exec-${item.name}.json`);
    let executionPath = path.join(run.a.tmp, 'no-such-execution.json');
    if (item.execution !== undefined) {
      executionPath = writeJson(path.join(run.a.tmp, `exec-${item.name}.json`), {
        schemaVersion: 1,
        mode: 'offline',
        synthetic: true,
        conclusion: 'success',
        termination: 'completed',
        model,
        runId: 'run-agent-1',
        ...item.execution,
      });
    } else if (item.raw !== undefined && item.raw !== null) {
      executionPath = path.join(run.a.tmp, `exec-${item.name}.json`);
      writeFileSync(executionPath, item.raw);
    }
    const out = path.join(run.a.tmp, `validated-exec-${item.name}`);
    const result = cli(validateArgs(run, { report, execution: executionPath }, { out }));
    assert.equal(result.status, 3, `${item.name}: stdout=${result.stdout} stderr=${result.stderr}`);
    const envelope = JSON.parse(readFileSync(path.join(out, 'decision.json'), 'utf8'));
    assert.equal(envelope.decision.status, 'incomplete', item.name);
    assert.equal(envelope.decision.ledger.lastHeadSha, null, `${item.name}: prior ledger retained`);
  }
});

test('dependencyEdges cover only direct incidents of changed paths; transitive source is never serialized; direct callers are mandatory', (): void => {
  const repo = makeRepo();
  seedPolicyContext(repo, loadTestPolicy());
  repo.write('src/deep.ts', 'export const DEEP_IMPL_MARKER = "deep-unique-9f3a";\n');
  repo.write('src/helper.ts', 'import { DEEP_IMPL_MARKER } from "./deep";\nexport const helper = DEEP_IMPL_MARKER.length;\n');
  repo.write('src/action.ts', 'import { helper } from "./helper";\nexport const action = helper;\n');
  repo.write('src/consumer.ts', 'import { action } from "./action";\nexport const consumer = action;\n');
  const baseSha = repo.commit('base');
  repo.write('src/action.ts', 'import { helper } from "./helper";\nexport const action = helper + 1;\n');
  const headSha = repo.commit('head');
  const tmp = mkdtempSync(path.join(tmpdir(), 'srs-agent-edges-'));
  const checkpointPath = writeJson(path.join(tmp, 'prior-state.json'), checkpoint());
  const limitsPath = writeJson(path.join(tmp, 'limits.json'), LIMITS);
  const a: AgentRepo = { repo, baseSha, headSha, tmp, checkpointPath, limitsPath };

  const prepOut = path.join(tmp, 'prepared');
  const prepared = cli(prepareArgs(a, { out: prepOut }));
  assert.equal(prepared.status, 0, prepared.stderr);
  const request = JSON.parse(readFileSync(path.join(prepOut, 'request.json'), 'utf8'));
  assert.deepEqual(request.dependencyEdges, [
    { from: 'src/action.ts', to: 'src/helper.ts' },
    { from: 'src/consumer.ts', to: 'src/action.ts' },
  ]);
  const requestText = readFileSync(path.join(prepOut, 'request.json'), 'utf8');
  assert.equal(requestText.includes('deep-unique-9f3a'), false, 'transitive dependency source must not be serialized');
  assert.equal(requestText.includes('src/deep.ts'), false, 'transitive dependency path is not an incident edge');
  const instructions = readFileSync(path.join(prepOut, 'instructions.md'), 'utf8');
  assert.equal(instructions.includes('deep-unique-9f3a'), false);

  const run: PreparedRun = { a, prepOut, request };

  // Omitting the changed path's own importer is incomplete.
  const omitCaller = writeReport(a, agentReport(request, {
    coverage: agentCoverage(request, { 'src/action.ts': ['src/helper.ts'] }),
  }), 'report-omit-caller.json');
  const omitCallerOut = path.join(tmp, 'validated-omit-caller');
  assert.equal(cli(validateArgs(run, { report: omitCaller }, { out: omitCallerOut })).status, 3);
  const callerDecision = JSON.parse(readFileSync(path.join(omitCallerOut, 'decision.json'), 'utf8'));
  assert.match(callerDecision.decision.reasons.join(' '), /omitted dependency\/caller src\/consumer\.ts/);

  // Omitting the direct dependency is incomplete.
  const omitDep = writeReport(a, agentReport(request, {
    coverage: agentCoverage(request, { 'src/action.ts': ['src/consumer.ts'] }),
  }), 'report-omit-dep.json');
  const omitDepOut = path.join(tmp, 'validated-omit-dep');
  assert.equal(cli(validateArgs(run, { report: omitDep }, { out: omitDepOut })).status, 3);
  const depDecision = JSON.parse(readFileSync(path.join(omitDepOut, 'decision.json'), 'utf8'));
  assert.match(depDecision.decision.reasons.join(' '), /omitted dependency\/caller src\/helper\.ts/);

  // Acknowledging both direct neighbors passes; deep.ts is not required.
  const report = writeReport(a, agentReport(request));
  const out = path.join(tmp, 'validated');
  const result = cli(validateArgs(run, { report }, { out }));
  assert.equal(result.status, 0, result.stderr);
  const audit = JSON.parse(readFileSync(path.join(out, 'validation-audit.json'), 'utf8'));
  const loadedKeys = audit.sourceReads.map((read: { revision: string; path: string }) => `${read.revision}:${read.path}`);
  assert.ok(loadedKeys.includes('head:src/helper.ts'));
  assert.ok(loadedKeys.includes('head:src/consumer.ts'));
  assert.ok(Array.isArray(audit.contextPaths) && audit.contextPaths.length > 0);
  assert.ok(audit.contextPaths.every((entry: { availableAtMergeBase: boolean }) => entry.availableAtMergeBase === true));
});

test('cumulative review spans two pushes while deltaDiff is previous-head navigation only', (): void => {
  const repo = makeRepo();
  seedPolicyContext(repo, loadTestPolicy());
  repo.write('src/a.ts', 'export const a = 1;\n');
  const baseSha = repo.commit('base');
  repo.write('src/a.ts', 'export const a = 2;\n');
  const head1 = repo.commit('push one');
  repo.write('src/b.ts', 'export const b = 1;\n');
  const headSha = repo.commit('push two');
  const tmp = mkdtempSync(path.join(tmpdir(), 'srs-agent-cum-'));
  const ledger: ReviewLedger = { ...emptyLedger(), lastHeadSha: head1 };
  const checkpointPath = writeJson(path.join(tmp, 'prior-state.json'), checkpoint(ledger));
  const limitsPath = writeJson(path.join(tmp, 'limits.json'), LIMITS);
  const a: AgentRepo = { repo, baseSha, headSha, tmp, checkpointPath, limitsPath };
  const run = runPrepare(a);
  assert.deepEqual(
    run.request.changes.map((change) => `${change.status}:${change.path}`),
    ['modified:src/a.ts', 'added:src/b.ts'],
  );
  assert.equal(run.request.previousHeadSha, head1);
  assert.match(run.request.cumulativeDiff as string, /export const a = 2/);
  assert.match(run.request.cumulativeDiff as string, /export const b = 1/);
  assert.doesNotMatch(run.request.deltaDiff as string, /export const a = 2/);
  assert.match(run.request.deltaDiff as string, /export const b = 1/);
  const report = writeReport(a, agentReport(run.request));
  const result = cli(validateArgs(run, { report }));
  assert.equal(result.status, 0, result.stderr);
});

test('renames resolve base source at the old path and deletions at merge base only', (): void => {
  const repo = makeRepo();
  seedPolicyContext(repo, loadTestPolicy());
  repo.write('src/old.ts', 'export const v = 1;\n');
  repo.write('src/gone.ts', 'export const g = 1;\n');
  const baseSha = repo.commit('base');
  repo.git(['mv', 'src/old.ts', 'src/new.ts']);
  repo.remove('src/gone.ts');
  const headSha = repo.commit('rename and delete');
  const tmp = mkdtempSync(path.join(tmpdir(), 'srs-agent-ren-'));
  const checkpointPath = writeJson(path.join(tmp, 'prior-state.json'), checkpoint());
  const limitsPath = writeJson(path.join(tmp, 'limits.json'), LIMITS);
  const a: AgentRepo = { repo, baseSha, headSha, tmp, checkpointPath, limitsPath };
  const run = runPrepare(a);
  assert.deepEqual(run.request.changes, [
    { path: 'src/gone.ts', status: 'deleted' },
    { path: 'src/new.ts', status: 'renamed', previousPath: 'src/old.ts' },
  ]);
  const report = writeReport(a, agentReport(run.request));
  const result = cli(validateArgs(run, { report }));
  assert.equal(result.status, 0, result.stderr);

  // A blocker attributed to the old path resolves base evidence at merge base.
  const renamedOut = path.join(tmp, 'validated-renamed-blocker');
  const blockerReport = writeReport(a, agentReport(run.request, {
    findings: [blockerFinding({ path: 'src/old.ts', revision: 'base', startLine: 1, endLine: 1, quote: 'export const v = 1;' })],
  }), 'report-renamed-blocker.json');
  assert.equal(cli(validateArgs(run, { report: blockerReport }, { out: renamedOut })).status, 2);

  // The old path at head is absent; citations never fall back across revisions.
  const wrongOut = path.join(tmp, 'validated-wrong-rev');
  const wrongReport = writeReport(a, agentReport(run.request, {
    findings: [blockerFinding({ path: 'src/old.ts', revision: 'head', startLine: 1, endLine: 1, quote: 'export const v = 2;' })],
  }), 'report-wrong-rev.json');
  const wrong = cli(validateArgs(run, { report: wrongReport }, { out: wrongOut }));
  assert.equal(wrong.status, 3);
  const wrongDecision = JSON.parse(readFileSync(path.join(wrongOut, 'decision.json'), 'utf8'));
  assert.match(wrongDecision.decision.reasons.join(' '), /evidence absent/);
});

test('base revision evidence resolves the merge base, not the advancing target branch head', (): void => {
  const repo = makeRepo();
  seedPolicyContext(repo, loadTestPolicy());
  repo.write('src/action.ts', 'export const v = "merge-base";\n');
  const baseSha = repo.commit('merge-base commit');
  repo.git(['checkout', '-b', 'feature']);
  repo.write('src/action.ts', 'export const v = "head";\n');
  const headSha = repo.commit('feature head');
  repo.git(['checkout', 'main']);
  repo.write('src/action.ts', 'export const v = "advanced";\n');
  const targetSha = repo.commit('target branch advances');
  const tmp = mkdtempSync(path.join(tmpdir(), 'srs-agent-mb-'));
  const checkpointPath = writeJson(path.join(tmp, 'prior-state.json'), checkpoint());
  const limitsPath = writeJson(path.join(tmp, 'limits.json'), LIMITS);
  const a: AgentRepo = { repo, baseSha: targetSha, headSha, tmp, checkpointPath, limitsPath };
  const run = runPrepare(a);
  assert.equal(run.request.identity.baseSha, targetSha);
  assert.equal(run.request.identity.mergeBaseSha, baseSha);

  // Citing merge-base content at revision base resolves.
  const resolvedOut = path.join(tmp, 'validated-resolved');
  const resolved = writeReport(a, agentReport(run.request, {
    findings: [blockerFinding({ path: 'src/action.ts', revision: 'base', startLine: 1, endLine: 1, quote: 'export const v = "merge-base";' })],
  }), 'report-resolved.json');
  assert.equal(cli(validateArgs(run, { report: resolved }, { out: resolvedOut })).status, 2);

  // Citing the target branch's newer content at revision base does not resolve.
  const staleOut = path.join(tmp, 'validated-stale');
  const stale = writeReport(a, agentReport(run.request, {
    findings: [blockerFinding({ path: 'src/action.ts', revision: 'base', startLine: 1, endLine: 1, quote: 'export const v = "advanced";' })],
  }), 'report-stale.json');
  const staleResult = cli(validateArgs(run, { report: stale }, { out: staleOut }));
  assert.equal(staleResult.status, 3, staleResult.stderr);
  const staleDecision = JSON.parse(readFileSync(path.join(staleOut, 'decision.json'), 'utf8'));
  assert.match(staleDecision.decision.reasons.join(' '), /evidence absent/);
});

test('a dirty working tree never substitutes for immutable commit objects', (): void => {
  const run = runPrepare(makeAgentRepo());
  run.a.repo.write('src/action.ts', 'export const required = "DIRTY WORKING TREE";\n');
  const report = writeReport(run.a, agentReport(run.request, { findings: [blockerFinding(HEAD_EVIDENCE)] }));
  const result = cli(validateArgs(run, { report }));
  assert.equal(result.status, 2, result.stderr);
});

test('unsafe, secret-like, symlinked, and binary source is refused without fallback', (): void => {
  // A secret-like changed path refuses preparation outright.
  {
    const repo = makeRepo();
    seedPolicyContext(repo, loadTestPolicy());
    repo.write('src/action.ts', 'export const a = 1;\n');
    const baseSha = repo.commit('base');
    repo.write('.env', 'TOKEN=x\n');
    const headSha = repo.commit('secret');
    const tmp = mkdtempSync(path.join(tmpdir(), 'srs-agent-secret-'));
    const checkpointPath = writeJson(path.join(tmp, 'prior-state.json'), checkpoint());
    const limitsPath = writeJson(path.join(tmp, 'limits.json'), LIMITS);
    const result = cli(prepareArgs({ repo, baseSha, headSha, tmp, checkpointPath, limitsPath }));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unsafe or secret-like/i);
  }

  // A changed symlink makes preparation incomplete because its required source can never be read.
  {
    const repo = makeRepo();
    seedPolicyContext(repo, loadTestPolicy());
    repo.write('src/action.ts', 'export const a = 1;\n');
    const baseSha = repo.commit('base');
    repo.link('src/action.ts', 'src/link.ts');
    const headSha = repo.commit('symlink');
    const tmp = mkdtempSync(path.join(tmpdir(), 'srs-agent-link-'));
    const checkpointPath = writeJson(path.join(tmp, 'prior-state.json'), checkpoint());
    const limitsPath = writeJson(path.join(tmp, 'limits.json'), LIMITS);
    const a: AgentRepo = { repo, baseSha, headSha, tmp, checkpointPath, limitsPath };
    const run = runPrepare(a, 3);
    assert.match((run.request.limitations as string[]).join(' '), /symlink/i);
    const report = writeReport(a, agentReport(run.request));
    const result = cli(validateArgs(run, { report }));
    assert.equal(result.status, 3, result.stderr);
    const envelope = JSON.parse(readFileSync(path.join(a.tmp, 'validated', 'decision.json'), 'utf8'));
    assert.match(envelope.decision.reasons.join(' '), /symlink/i);
  }

  // A changed binary file can never supply required source.
  {
    const repo = makeRepo();
    seedPolicyContext(repo, loadTestPolicy());
    repo.write('src/action.ts', 'export const a = 1;\n');
    const baseSha = repo.commit('base');
    repo.write('src/blob.ts', Buffer.from([0x00, 0x01, 0x02, 0xff]));
    const headSha = repo.commit('binary');
    const tmp = mkdtempSync(path.join(tmpdir(), 'srs-agent-bin-'));
    const checkpointPath = writeJson(path.join(tmp, 'prior-state.json'), checkpoint());
    const limitsPath = writeJson(path.join(tmp, 'limits.json'), LIMITS);
    const a: AgentRepo = { repo, baseSha, headSha, tmp, checkpointPath, limitsPath };
    const run = runPrepare(a, 3);
    assert.match((run.request.limitations as string[]).join(' '), /binary/i);
    const report = writeReport(a, agentReport(run.request));
    const result = cli(validateArgs(run, { report }));
    assert.equal(result.status, 3, result.stderr);
    const envelope = JSON.parse(readFileSync(path.join(a.tmp, 'validated', 'decision.json'), 'utf8'));
    assert.match(envelope.decision.reasons.join(' '), /binary/i);
  }

  // Changed source that is not valid UTF-8 (even without NUL bytes) is unusable.
  {
    const repo = makeRepo();
    seedPolicyContext(repo, loadTestPolicy());
    repo.write('src/action.ts', 'export const a = 1;\n');
    const baseSha = repo.commit('base');
    repo.write('src/bad.ts', Buffer.from([0xff, 0xfe, 0x61, 0x0a]));
    const headSha = repo.commit('invalid utf8');
    const tmp = mkdtempSync(path.join(tmpdir(), 'srs-agent-utf8-'));
    const checkpointPath = writeJson(path.join(tmp, 'prior-state.json'), checkpoint());
    const limitsPath = writeJson(path.join(tmp, 'limits.json'), LIMITS);
    const a: AgentRepo = { repo, baseSha, headSha, tmp, checkpointPath, limitsPath };
    const run = runPrepare(a, 3);
    assert.match((run.request.limitations as string[]).join(' '), /UTF-8/i);
    const report = writeReport(a, agentReport(run.request));
    const result = cli(validateArgs(run, { report }));
    assert.equal(result.status, 3, result.stderr);
    const envelope = JSON.parse(readFileSync(path.join(a.tmp, 'validated', 'decision.json'), 'utf8'));
    assert.match(envelope.decision.reasons.join(' '), /UTF-8/i);
  }

  // A secret-like evidence path is refused during verification, not silently skipped.
  {
    const run = runPrepare(makeAgentRepo());
    const report = writeReport(run.a, agentReport(run.request, {
      findings: [blockerFinding({ path: '.env', revision: 'head', startLine: 1, endLine: 1, quote: 'TOKEN=x' })],
    }));
    const result = cli(validateArgs(run, { report }));
    assert.equal(result.status, 3, result.stderr);
    const envelope = JSON.parse(readFileSync(path.join(run.a.tmp, 'validated', 'decision.json'), 'utf8'));
    assert.match(envelope.decision.reasons.join(' '), /secret-like|refused/i);
  }

  // An absent evidence path is incomplete, not fabricated.
  {
    const run = runPrepare(makeAgentRepo());
    const report = writeReport(run.a, agentReport(run.request, {
      findings: [blockerFinding({ path: 'src/missing.ts', revision: 'head', startLine: 1, endLine: 1, quote: 'x' })],
    }));
    const result = cli(validateArgs(run, { report }));
    assert.equal(result.status, 3, result.stderr);
  }
});

test('validation-limits must be exact positive integers and offline source budgets refuse partial passes', (): void => {
  for (const [name, limits] of Object.entries({
    'missing-key': { maxFiles: 10, maxSourceBytes: 1000 },
    zero: { maxFiles: 0, maxSourceBytes: 1000, maxReadBytes: 100 },
    'extra-key': { ...LIMITS, maxTurns: 5 },
    negative: { maxFiles: -1, maxSourceBytes: 1000, maxReadBytes: 100 },
    string: { maxFiles: '100', maxSourceBytes: 1000, maxReadBytes: 100 },
  })) {
    const a = makeAgentRepo();
    const limitsPath = writeJson(path.join(a.tmp, `limits-${name}.json`), limits);
    const result = cli(prepareArgs(a, { overrides: { 'validation-limits': limitsPath } }));
    assert.equal(result.status, 1, `${name}: expected CLI failure, got ${result.status}`);
  }

  // A 5-byte per-read cap makes required source unreadable at preparation itself.
  {
    const a = makeAgentRepo();
    a.limitsPath = writeJson(path.join(a.tmp, 'limits.json'), { maxFiles: 100, maxSourceBytes: 1_000_000, maxReadBytes: 5 });
    const run = runPrepare(a, 3);
    assert.match((run.request.limitations as string[]).join(' '), /per-read limit/i);
    const report = writeReport(run.a, agentReport(run.request));
    const result = cli(validateArgs(run, { report }));
    assert.equal(result.status, 3, result.stderr);
  }

  // Only evidence-only loads count against maxFiles: two extra cited files
  // cannot fit inside maxFiles 1, and a 10-byte cumulative cap refuses even
  // required changed-file loads. Preparation still completes; validation refuses.
  for (const [name, limits, extraEvidence] of [
    ['max-files', { maxFiles: 1, maxSourceBytes: 1_000_000, maxReadBytes: 100_000 }, [
      { path: 'CLAUDE.md', revision: 'base', startLine: 1, endLine: 1, quote: '# stub CLAUDE.md' },
      { path: 'package.json', revision: 'base', startLine: 1, endLine: 1, quote: '{"name":"fixture","private":true}' },
    ]],
    ['max-bytes', { maxFiles: 100, maxSourceBytes: 10, maxReadBytes: 100_000 }, []],
  ] as const) {
    const a = makeAgentRepo();
    a.limitsPath = writeJson(path.join(a.tmp, 'limits.json'), limits);
    const run = runPrepare(a);
    const overrides: Record<string, unknown> = extraEvidence.length === 0 ? {} : {
      findings: [{
        id: 'F-extra', ruleId: 'SR-002', severity: 'advisory',
        title: 'Synthetic advisory citing extra files.', explanation: 'Cites unchanged context.', impact: 'None.',
        introducedBy: { path: 'src/action.ts', revision: 'head', startLine: 1, endLine: 1, quote: 'export const required = false;' },
        evidence: extraEvidence,
        counterEvidence: [],
      }],
    };
    const report = writeReport(run.a, agentReport(run.request, overrides));
    const result = cli(validateArgs(run, { report }));
    assert.equal(result.status, 3, `${name}: stdout=${result.stdout} stderr=${result.stderr}`);
    const out = path.join(run.a.tmp, 'validated');
    const envelope = JSON.parse(readFileSync(path.join(out, 'decision.json'), 'utf8'));
    assert.match(envelope.decision.reasons.join(' '), /budget|exceeding|exceeded/i, name);
    const audit = JSON.parse(readFileSync(path.join(out, 'validation-audit.json'), 'utf8'));
    const loadedReads = audit.sourceReads.filter((read: { status: string }) => read.status === 'loaded');
    assert.equal(audit.budget.sources, loadedReads.length, `${name}: audit budget must reflect actual loaded sources, not reset to zero`);
    assert.equal(audit.budget.totalBytes, loadedReads.reduce((sum: number, read: { bytes: number }) => sum + read.bytes, 0), name);
    if (name === 'max-files') assert.equal(audit.budget.sources, 1, 'one source must have loaded before the cap tripped');
  }
});

test('existing or symlinked output directories and non-offline markers are refused', (): void => {
  const a = makeAgentRepo();
  const existing = path.join(a.tmp, 'occupied');
  mkdirSync(existing);
  writeJson(path.join(existing, 'sentinel.json'), {});
  assert.equal(cli(prepareArgs(a, { out: existing })).status, 1);
  const linkedDir = path.join(a.tmp, 'real-dir');
  mkdirSync(linkedDir);
  writeJson(path.join(linkedDir, 'x.json'), {});
  symlinkSync(linkedDir, path.join(a.tmp, 'out-link'), 'dir');
  assert.equal(cli(prepareArgs(a, { out: path.join(a.tmp, 'out-link') })).status, 1);

  assert.equal(cli(prepareArgs(a, { overrides: { offline: 'false' } })).status, 1);
  assert.equal(cli(prepareArgs(a, { extra: ['--execute', 'now'] })).status, 1);
  assert.equal(cli(prepareArgs(a, { extra: ['--live', 'now'] })).status, 1);
  assert.equal(cli(prepareArgs(a, { extra: ['--state-root', a.tmp] })).status, 1);
  const noOffline = prepareArgs(a).filter((arg) => arg !== '--offline' && arg !== 'true');
  assert.equal(cli(noOffline).status, 1);

  const run = runPrepare(a);
  const report = writeReport(run.a, agentReport(run.request));
  const occupiedOut = path.join(run.a.tmp, 'occupied-validate');
  mkdirSync(occupiedOut);
  writeJson(path.join(occupiedOut, 'sentinel.json'), {});
  assert.equal(cli(validateArgs(run, { report }, { out: occupiedOut })).status, 1);
});

test('agent digest is domain-separated: trusted agent inputs move it, packet digest algorithm is untouched', (): void => {
  const loaded = loadTestPolicy();
  const trust = loadAgentTrust(SYSTEM_ROOT, loaded.digest);
  assert.notEqual(trust.digest, loaded.digest);
  assert.match(trust.digest, /^[0-9a-f]{64}$/);

  const root = mkdtempSync(path.join(tmpdir(), 'srs-agent-trust-'));
  cpSync(path.join(SYSTEM_ROOT, 'policy'), path.join(root, 'policy'), { recursive: true });
  cpSync(path.join(SYSTEM_ROOT, 'src'), path.join(root, 'src'), { recursive: true });
  const copy = loadAgentTrust(root, loaded.digest);
  assert.equal(copy.digest, trust.digest, 'identical trusted inputs must give an identical digest');
  assert.equal(loadPolicy(root).digest, loaded.digest, 'identical packet inputs must give the identical packet digest');

  const promptPath = path.join(root, 'policy', 'agent.prompt.md');
  writeFileSync(promptPath, `${readFileSync(promptPath, 'utf8')}\nchanged\n`);
  const moved = loadAgentTrust(root, loaded.digest);
  assert.notEqual(moved.digest, trust.digest, 'agent prompt change must move the agent digest');
  assert.equal(loadPolicy(root).digest, loaded.digest, 'agent prompt is not a packet trusted path');

  const reviewPath = path.join(root, 'src', 'agentReview.ts');
  writeFileSync(reviewPath, `${readFileSync(reviewPath, 'utf8')}\n// changed\n`);
  const movedAgain = loadAgentTrust(root, loaded.digest);
  assert.notEqual(movedAgain.digest, trust.digest);
  assert.notEqual(movedAgain.digest, moved.digest);

  const packetDigestAgain = agentPolicyDigest(loaded.digest, new Map(
    AGENT_TRUSTED_PATHS.map((trustedPath) => [trustedPath, Buffer.from('different bytes')]),
  ));
  assert.notEqual(packetDigestAgain, trust.digest);
});

test('record refuses offline artifacts and agent commands create no operational state', (): void => {
  const run = runPrepare(makeAgentRepo());
  const report = writeReport(run.a, agentReport(run.request));
  const valOut = path.join(run.a.tmp, 'validated');
  assert.equal(cli(validateArgs(run, { report }, { out: valOut })).status, 0);
  const decisionPath = path.join(valOut, 'decision.json');

  // The agent request is not a ReviewSnapshot; the packet validator rejects it before state is touched.
  const cleanState = mkdtempSync(path.join(tmpdir(), 'srs-agent-state-clean-'));
  const refused = cli(['record', '--snapshot', path.join(run.prepOut, 'request.json'), '--report', report, '--state-root', cleanState]);
  assert.equal(refused.status, 1);
  assert.equal(readdirSync(cleanState).length, 0, 'rejected input must not create state directories');

  // The synthetic decision envelope is refused even against a real packet snapshot.
  const packetState = mkdtempSync(path.join(tmpdir(), 'srs-agent-state-packet-'));
  const packetOut = path.join(run.a.tmp, 'packet');
  const packet = cli([
    'prepare', '--checkout', run.a.repo.dir, '--repository', ALLOWED_REPOSITORY, '--pr', '17',
    '--base', run.a.baseSha, '--head', run.a.headSha, '--run-id', 'run-packet', '--out', packetOut,
    '--state-root', packetState,
  ]);
  assert.equal(packet.status, 0, packet.stderr);
  const refusedEnvelope = cli([
    'record', '--snapshot', path.join(packetOut, 'snapshot.json'), '--report', decisionPath,
    '--state-root', packetState,
  ]);
  assert.equal(refusedEnvelope.status, 1);
  assert.match(refusedEnvelope.stderr, /synthetic/i);
  const journalPath = path.join(packetState, 'repos', ...ALLOWED_REPOSITORY.split('/'), 'prs', '17', 'journal.jsonl');
  assert.equal(existsSync(journalPath), false, 'no journal entry may be written for a synthetic envelope');
});

test('a checkpoint whose ledger targets a different repository or pull request is rejected at both entries', (): void => {
  for (const [name, mutate] of Object.entries({
    'inner-repo': (ledger: ReviewLedger): ReviewLedger => ({ ...ledger, repository: 'devrev/other-repo' }),
    'inner-pr': (ledger: ReviewLedger): ReviewLedger => ({ ...ledger, pullRequest: 99 }),
  })) {
    const a = makeAgentRepo();
    a.checkpointPath = writeJson(path.join(a.tmp, 'prior-state.json'), checkpoint(mutate(emptyLedger())));
    const prepared = cli(prepareArgs(a));
    assert.equal(prepared.status, 1, `${name}: preparation must reject mismatched inner ledger`);
    assert.match(prepared.stderr, /ledger (repository|pullRequest) does not match/i);

    const run = runPrepare(makeAgentRepo());
    const report = writeReport(run.a, agentReport(run.request));
    const priorPath = writeJson(path.join(run.a.tmp, `prior-${name}.json`), checkpoint(mutate(emptyLedger())));
    const result = cli(validateArgs(run, { report, priorState: priorPath }, { out: path.join(run.a.tmp, `validated-${name}`) }));
    assert.equal(result.status, 1, `${name}: validation input must reject mismatched inner ledger`);
  }
});

test('literal arrows in filenames cannot collapse distinct dependency edges', (): void => {
  const repo = makeRepo();
  seedPolicyContext(repo, loadTestPolicy());
  repo.write('src/c.ts', 'export const c = 1;\n');
  repo.write('b.ts->src/c.ts', 'export const deep = 1;\n');
  repo.write('src/a.ts', 'import { deep } from "../b.ts->src/c";\nexport const a = deep;\n');
  repo.write('src/a.ts->b.ts', 'import { c } from "./c";\nexport const ab = c;\n');
  const baseSha = repo.commit('base');
  repo.write('src/a.ts', 'import { deep } from "../b.ts->src/c";\nexport const a = deep + 1;\n');
  repo.write('src/a.ts->b.ts', 'import { c } from "./c";\nexport const ab = c + 1;\n');
  const headSha = repo.commit('head');
  const tmp = mkdtempSync(path.join(tmpdir(), 'srs-agent-arrows-'));
  const checkpointPath = writeJson(path.join(tmp, 'prior-state.json'), checkpoint());
  const limitsPath = writeJson(path.join(tmp, 'limits.json'), LIMITS);
  const a: AgentRepo = { repo, baseSha, headSha, tmp, checkpointPath, limitsPath };
  const run = runPrepare(a);
  assert.deepEqual(run.request.dependencyEdges, [
    { from: 'src/a.ts', to: 'b.ts->src/c.ts' },
    { from: 'src/a.ts->b.ts', to: 'src/c.ts' },
  ]);
});

test('missing canonical context is incomplete at preparation and validation, retaining the ledger', (): void => {
  const repo = makeRepo();
  seedPolicyContext(repo, loadTestPolicy());
  repo.remove('CLAUDE.md');
  repo.write('src/action.ts', 'export const required = true;\n');
  const baseSha = repo.commit('base');
  repo.write('src/action.ts', 'export const required = false;\n');
  const headSha = repo.commit('head');
  const tmp = mkdtempSync(path.join(tmpdir(), 'srs-agent-ctx-'));
  const checkpointPath = writeJson(path.join(tmp, 'prior-state.json'), checkpoint());
  const limitsPath = writeJson(path.join(tmp, 'limits.json'), LIMITS);
  const a: AgentRepo = { repo, baseSha, headSha, tmp, checkpointPath, limitsPath };

  const run = runPrepare(a, 3);
  assert.equal(run.request.complete, false);
  assert.ok(
    (run.request.limitations as string[]).includes('Required source CLAUDE.md is absent at the base revision.'),
    `limitations: ${JSON.stringify(run.request.limitations)}`,
  );

  const report = writeReport(run.a, agentReport(run.request));
  const result = cli(validateArgs(run, { report }));
  assert.equal(result.status, 3, result.stderr);
  const envelope = JSON.parse(readFileSync(path.join(run.a.tmp, 'validated', 'decision.json'), 'utf8'));
  assert.equal(envelope.decision.status, 'incomplete');
  assert.equal(envelope.decision.ledger.lastHeadSha, null, 'prior ledger must be retained');
  assert.match(envelope.decision.reasons.join(' '), /CLAUDE\.md/);
});

test('changed files do not count against maxFiles and coverage related paths only need to exist', (): void => {
  const repo = makeRepo();
  const loaded = loadTestPolicy();
  seedPolicyContext(repo, loaded);
  repo.write('src/shared.ts', 'export const shared = 1;\n');
  for (let i = 0; i < 101; i += 1) repo.write(`src/file${i}.ts`, 'export const v = 1;\n');
  const baseSha = repo.commit('base');
  for (let i = 0; i < 101; i += 1) repo.write(`src/file${i}.ts`, `export const v${i} = ${i};\n`);
  const headSha = repo.commit('head');
  const tmp = mkdtempSync(path.join(tmpdir(), 'srs-agent-many-'));
  const a: AgentRepo = {
    repo,
    baseSha,
    headSha,
    tmp,
    checkpointPath: writeJson(path.join(tmp, 'prior-state.json'), checkpoint()),
    limitsPath: writeJson(path.join(tmp, 'limits.json'), { maxFiles: 200, maxSourceBytes: 1_000_000, maxReadBytes: 100_000 }),
  };
  const run = runPrepare(a);
  assert.equal(run.request.changes.length, 101);
  // A relatedPath that exists in the trees but is never loaded still satisfies
  // the coverage check and is recorded as present rather than read.
  const report = agentReport(run.request);
  (report.coverage as { relatedPaths: string[] }[])[0].relatedPaths = ['src/shared.ts'];
  const reportPath = writeReport(a, report);
  const out = path.join(a.tmp, 'validated');
  const result = cli(validateArgs(run, { report: reportPath }, { out }));
  assert.equal(result.status, 0, result.stderr);
  const audit = JSON.parse(readFileSync(path.join(out, 'validation-audit.json'), 'utf8'));
  assert.equal(audit.budget.cappedSources, 0);
  assert.equal(audit.budget.sources, 202);
  assert.ok(audit.sourceReads.some((read: { path: string; status: string }) => read.path === 'src/shared.ts' && read.status === 'present'));

  const absentOut = path.join(mkdtempSync(path.join(tmpdir(), 'srs-absent-')), 'validated');
  const badReport = agentReport(run.request);
  (badReport.coverage as { relatedPaths: string[] }[])[0].relatedPaths = ['src/missing.ts'];
  const badPath = writeReport(a, badReport, 'report-missing.json');
  const bad = cli(validateArgs(run, { report: badPath }, { out: absentOut }));
  assert.equal(bad.status, 3, bad.stderr);
  const badAudit = JSON.parse(readFileSync(path.join(absentOut, 'validation-audit.json'), 'utf8'));
  assert.match(JSON.stringify(badAudit), /src\/missing\.ts is absent at head and merge base|unavailable source/);
});
