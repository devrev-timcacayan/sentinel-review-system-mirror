import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { defaultSystemRoot, loadPolicy } from './policy.ts';
import { parseStrictJson } from './strictJson.ts';
import { parseSpendLimit } from './reviewBudget.ts';
import { runPartitionReview } from './reviewRunner.ts';
import { createMockProvider } from './mockProvider.ts';
import { createBedrockProvider } from './bedrockProvider.ts';
import type { ReviewLedger, ReviewSnapshot } from './contracts.ts';
import { canonicalJson } from './partitionContract.ts';

const USAGE = `sentinel-review-system local model runner (no hosted lifecycle)

Usage:
  review --bundle DIR --out DIR --provider mock --responses FILE [--system-root PATH]
  review --bundle DIR --out DIR --provider bedrock --provider-config FILE --max-spend-usd USD --execute [--system-root PATH]

Exit codes: 0 pass, 2 changes_required, 3 incomplete/blocked, 1 operational/input failure.
Provider credentials, model, capabilities, prices, and spend remain unverified until a human
supplies a real verified provider configuration. Mock runs are synthetic replay only.`;

function fail(message: string): never {
  throw new Error(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return isObject(value) && Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function isLedger(value: unknown): value is ReviewLedger {
  return hasKeys(value, ['schemaVersion', 'repository', 'pullRequest', 'lastHeadSha', 'openFindings'])
    && value.schemaVersion === 1
    && typeof value.repository === 'string'
    && typeof value.pullRequest === 'number' && Number.isSafeInteger(value.pullRequest) && value.pullRequest > 0
    && (value.lastHeadSha === null || (typeof value.lastHeadSha === 'string' && /^[0-9a-f]{40}$/.test(value.lastHeadSha)))
    && Array.isArray(value.openFindings);
}

function readJson(filePath: string): unknown {
  try {
    return parseStrictJson(readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`${filePath} is not valid strict JSON: ${(error as Error).message}`);
  }
}

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      bundle: { type: 'string' },
      out: { type: 'string' },
      provider: { type: 'string' },
      responses: { type: 'string' },
      'provider-config': { type: 'string' },
      'max-spend-usd': { type: 'string' },
      execute: { type: 'boolean' },
      'system-root': { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (parsed.values.help || argv.length === 0) {
    console.log(USAGE);
    return 0;
  }
  const values = parsed.values;
  for (const required of ['bundle', 'out', 'provider'] as const) {
    if (typeof values[required] !== 'string' || (values[required] as string).length === 0) fail(`Missing required --${required}`);
  }
  const providerKind = values.provider as string;
  if (providerKind !== 'mock' && providerKind !== 'bedrock') fail(`Unknown provider ${providerKind}`);
  const bundleDir = path.resolve(values.bundle as string);
  const outDir = path.resolve(values.out as string);
  const systemRoot = path.resolve(values['system-root'] ?? defaultSystemRoot());
  const loaded = loadPolicy(systemRoot);

  const snapshot = readJson(path.join(bundleDir, 'snapshot.json')) as ReviewSnapshot;
  const request = readJson(path.join(bundleDir, 'review-request.json'));
  if (!hasKeys(request, ['schemaVersion', 'kind', 'identity', 'manifest', 'parts', 'priorLedger'])
    || request.schemaVersion !== 1 || request.kind !== 'partitioned-review-bundle'
    || !Array.isArray(request.parts) || !request.parts.every((part): part is string => typeof part === 'string')) {
    fail('review-request.json is not a valid partitioned-review-bundle manifest request.');
  }
  const parentManifest = (snapshot as { partitionManifest?: unknown }).partitionManifest;
  if (canonicalJson(request.manifest) !== canonicalJson(parentManifest)
    || canonicalJson(request.identity) !== canonicalJson((snapshot as { identity?: unknown }).identity)
    || request.parts.length !== ((request.manifest as { partitions?: unknown[] }).partitions?.length ?? -1)) {
    fail('review-request.json identity/manifest do not match snapshot.json.');
  }
  const priorLedger = request.priorLedger;
  if (!isLedger(priorLedger)) {
    fail('review-request.json is missing a valid priorLedger.');
  }

  let provider;
  let maxSpendMicros = Number.MAX_SAFE_INTEGER;
  if (providerKind === 'mock') {
    if (typeof values.responses !== 'string') fail('mock provider requires --responses FILE.');
    if (values['provider-config'] !== undefined || values.execute === true || values['max-spend-usd'] !== undefined) {
      fail('mock provider forbids --provider-config, --max-spend-usd, and --execute.');
    }
    provider = createMockProvider(path.resolve(values.responses));
  } else {
    try {
      if (typeof values['provider-config'] !== 'string' || typeof values['max-spend-usd'] !== 'string' || values.execute !== true) {
        fail('bedrock requires --provider-config FILE, --max-spend-usd USD, and --execute.');
      }
      maxSpendMicros = parseSpendLimit(values['max-spend-usd']);
      const config = readJson(path.resolve(values['provider-config']));
      provider = createBedrockProvider(config, { execute: true, maxSpendMicros }, { trustedModelId: loaded.policy.model });
    } catch (error) {
      console.error(`blocked: ${(error as Error).message}`);
      return 3;
    }
  }

  const result = await runPartitionReview(snapshot, priorLedger, loaded, provider, {
    outputDirectory: outDir,
    maxSpendMicros,
    execute: values.execute === true,
  });
  console.log(JSON.stringify({
    status: result.decision.status,
    synthetic: result.synthetic,
    uncertainCharges: result.uncertainCharges,
    reportPath: result.reportPath,
    executionPath: result.executionPath,
    attempts: result.attempts.length,
    budget: result.budget,
    decisionReasons: result.decision.reasons,
  }, null, 2));
  if (result.decision.status === 'pass') return 0;
  if (result.decision.status === 'changes_required') return 2;
  return 3;
}

const invokedAs = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedAs === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    console.error(`error: ${(error as Error).message}`);
    process.exitCode = 1;
  });
}
