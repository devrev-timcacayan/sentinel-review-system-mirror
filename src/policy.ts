import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DIMENSIONS } from './contracts.ts';
import type { ReviewPolicy } from './contracts.ts';

const TRUSTED_PATHS = [
  'policy/review-system.json',
  'policy/review.prompt.md',
  'policy/retrospective.prompt.md',
  'policy/partition.prompt.md',
  'policy/runner.prompt.md',
  'policy/evidence-repair.prompt.md',
  'src/artifactFiles.ts',
  'src/bedrockProvider.ts',
  'src/cli.ts',
  'src/contextPlanner.ts',
  'src/contracts.ts',
  'src/gate.ts',
  'src/mockProvider.ts',
  'src/partitionContract.ts',
  'src/partitionGate.ts',
  'src/partitionPlanner.ts',
  'src/policy.ts',
  'src/providerTypes.ts',
  'src/reviewBudget.ts',
  'src/reviewCli.ts',
  'src/reviewRunner.ts',
  'src/reviewValidation.ts',
  'src/snapshot.ts',
  'src/state.ts',
  'src/strictJson.ts',
] as const;

export interface LoadedPolicy {
  policy: ReviewPolicy;
  digest: string;
  reviewPrompt: string;
  retrospectivePrompt: string;
  partitionPrompt: string;
  runnerPrompt: string;
  evidenceRepairPrompt: string;
  responseContract: string;
}

export function defaultSystemRoot(): string {
  return path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRelativeSafePath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && !value.startsWith('/')
    && !value.includes('\\')
    && !value.includes('\0')
    && !value.split('/').some((part: string): boolean => part === '..' || part === '.' || part === '');
}

function isRepositoryKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value);
}

function validatePolicy(value: unknown, origin: string): ReviewPolicy {
  function check(condition: boolean, reason: string): asserts condition {
    if (!condition) throw new Error(`Trusted policy ${origin} is invalid: ${reason}`);
  }
  check(isObject(value), 'config is not an object');
  check(value.schemaVersion === 1, 'schemaVersion must be 1');
  check(
    Array.isArray(value.repositories) && value.repositories.length > 0 && value.repositories.every(isRepositoryKey),
    'repositories must be a non-empty array of owner/name keys',
  );
  check(typeof value.model === 'string' && value.model.trim().length > 0, 'model must be a non-empty string');
  check(
    Array.isArray(value.dimensions) && value.dimensions.length > 0
      && value.dimensions.every((dimension: unknown): boolean => DIMENSIONS.some((known: string): boolean => known === dimension)),
    'dimensions must be a non-empty subset of the contract dimensions',
  );
  check(isObject(value.limits), 'limits must be an object');
  for (const key of ['maxFiles', 'maxSourceBytes', 'maxDiffBytes', 'warnChangedLines', 'blockChangedLines']) {
    check(Number.isSafeInteger(value.limits[key]) && Number(value.limits[key]) > 0, `limits.${key} must be a positive integer`);
  }
  check(
    Number(value.limits.warnChangedLines) < Number(value.limits.blockChangedLines),
    'limits.warnChangedLines must be lower than limits.blockChangedLines',
  );
  check(Array.isArray(value.contextPaths) && value.contextPaths.every(isRelativeSafePath), 'contextPaths must be relative safe paths');
  check(Array.isArray(value.rules) && value.rules.length > 0, 'rules must be a non-empty array');
  const seen = new Set<string>();
  for (const rule of value.rules) {
    check(isObject(rule), 'each rule must be an object');
    for (const key of ['id', 'name', 'blocking', 'exception']) {
      check(typeof rule[key] === 'string' && (rule[key] as string).trim().length > 0, `rule.${key} must be a non-empty string`);
    }
    check(typeof rule.id === 'string', 'rule.id must be a string');
    check(!seen.has(rule.id), `duplicate rule id ${rule.id}`);
    seen.add(rule.id);
  }
  return value as unknown as ReviewPolicy;
}

export function policyDigest(files: Map<string, Buffer>): string {
  const hash = createHash('sha256');
  for (const trustedPath of [...TRUSTED_PATHS].sort()) {
    const content = files.get(trustedPath);
    if (content === undefined) throw new Error(`Trusted input missing for digest: ${trustedPath}`);
    hash.update(`${trustedPath.length}:${trustedPath}`);
    hash.update(`${content.length}:`);
    hash.update(content);
  }
  return hash.digest('hex');
}

export function loadPolicy(systemRoot: string = defaultSystemRoot()): LoadedPolicy {
  const root = path.resolve(systemRoot);
  const files = new Map<string, Buffer>();
  for (const trustedPath of TRUSTED_PATHS) {
    const absolute = path.join(root, trustedPath);
    const resolved = path.resolve(absolute);
    if (!resolved.startsWith(root + path.sep)) throw new Error(`Trusted path escapes system root: ${trustedPath}`);
    files.set(trustedPath, readFileSync(resolved));
  }
  const configText = files.get('policy/review-system.json')?.toString('utf8');
  if (configText === undefined) throw new Error('Trusted policy config is missing.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(configText);
  } catch (error) {
    throw new Error(`Trusted policy config is not valid JSON: ${(error as Error).message}`);
  }
  const policy = validatePolicy(parsed, 'policy/review-system.json');
  return {
    policy,
    digest: policyDigest(files),
    reviewPrompt: files.get('policy/review.prompt.md')?.toString('utf8') ?? '',
    retrospectivePrompt: files.get('policy/retrospective.prompt.md')?.toString('utf8') ?? '',
    partitionPrompt: files.get('policy/partition.prompt.md')?.toString('utf8') ?? '',
    runnerPrompt: files.get('policy/runner.prompt.md')?.toString('utf8') ?? '',
    evidenceRepairPrompt: files.get('policy/evidence-repair.prompt.md')?.toString('utf8') ?? '',
    responseContract: files.get('src/contracts.ts')?.toString('utf8') ?? '',
  };
}
