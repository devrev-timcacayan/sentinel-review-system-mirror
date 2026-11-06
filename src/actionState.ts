import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isReviewLedger } from './agentContracts.ts';
import { STATE_BRANCH } from './actionControls.ts';
import { parseStrictJson } from './strictJson.ts';
import type { ReviewLedger } from './contracts.ts';

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const STATE_REMOTE_URLS = new Set([
  'https://github.com/devrev/sentinel',
  'https://github.com/devrev/sentinel.git',
  'git@github.com:devrev/sentinel.git',
]);

// Injected by tests; the real host supplies gitRun. Git argv only, never a shell.
export type GitRunner = (checkout: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => string;

export function gitRun(checkout: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}): string {
  const result = spawnSync('git', ['-C', checkout, '-c', 'core.hooksPath=/dev/null', ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...(options.env ?? {}) },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed in ${checkout}: ${(result.stderr ?? '').trim() || `exit ${result.status}`}`);
  }
  return result.stdout.trim();
}

export interface StateIndex {
  schemaVersion: 1;
  repository: 'devrev/sentinel';
  pullRequests: number[];
}

export interface PrStateRecord {
  schemaVersion: 1;
  repository: string;
  pullRequest: number;
  stateVersion: string;
  ledger: ReviewLedger;
  runId: string;
  headSha: string;
  baseSha: string;
  status: 'pending' | 'pass' | 'changes_required' | 'incomplete';
}

export interface PrStateView {
  index: StateIndex;
  record: PrStateRecord | null;
  ledger: ReviewLedger;
  isNew: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key: string): boolean => key in value);
}

function check(condition: boolean, reason: string): asserts condition {
  if (!condition) throw new Error(`State branch integrity failure: ${reason}`);
}

export function validateStateIndex(input: unknown): StateIndex {
  check(isObject(input), 'index.json is not an object');
  check(hasKeys(input, ['schemaVersion', 'repository', 'pullRequests']), 'index.json has unexpected or missing fields');
  check(input.schemaVersion === 1, 'index.json schemaVersion must be 1');
  check(input.repository === 'devrev/sentinel', 'index.json repository must be devrev/sentinel');
  check(Array.isArray(input.pullRequests), 'index.json pullRequests must be an array');
  const seen = new Set<number>();
  for (const value of input.pullRequests as unknown[]) {
    check(Number.isSafeInteger(value) && Number(value) > 0, 'index.json pullRequests must contain positive integers');
    check(!seen.has(Number(value)), `index.json pullRequests contains duplicate ${Number(value)}`);
    seen.add(Number(value));
  }
  return input as unknown as StateIndex;
}

export function validatePrStateRecord(input: unknown): PrStateRecord {
  check(isObject(input), 'PR state record is not an object');
  check(
    hasKeys(input, ['schemaVersion', 'repository', 'pullRequest', 'stateVersion', 'ledger', 'runId', 'headSha', 'baseSha', 'status']),
    'PR state record has unexpected or missing fields',
  );
  check(input.schemaVersion === 1, 'PR state record schemaVersion must be 1');
  check(typeof input.repository === 'string' && input.repository.length > 0, 'PR state record repository invalid');
  check(Number.isSafeInteger(input.pullRequest) && Number(input.pullRequest) > 0, 'PR state record pullRequest invalid');
  check(
    typeof input.stateVersion === 'string' && SAFE_ID_PATTERN.test(input.stateVersion),
    'PR state record stateVersion must be a nonempty bounded identifier',
  );
  check(isReviewLedger(input.ledger), 'PR state record ledger is invalid');
  check(
    input.ledger.repository === input.repository && input.ledger.pullRequest === input.pullRequest,
    'PR state record ledger does not match the record repository/pull request',
  );
  check(typeof input.runId === 'string' && SAFE_ID_PATTERN.test(input.runId), 'PR state record runId invalid');
  check(typeof input.headSha === 'string' && SHA_PATTERN.test(input.headSha), 'PR state record headSha must be a 40-char SHA');
  check(typeof input.baseSha === 'string' && SHA_PATTERN.test(input.baseSha), 'PR state record baseSha must be a 40-char SHA');
  check(['pending', 'pass', 'changes_required', 'incomplete'].includes(String(input.status)), 'PR state record status invalid');
  return input as unknown as PrStateRecord;
}

export function pendingStateVersion(runId: string): string {
  return runId;
}

export function completedStateVersion(runId: string): string {
  return `${runId}-completed`;
}

export function indexFilePath(stateDir: string): string {
  return path.join(stateDir, 'index.json');
}

export function recordFilePath(stateDir: string, pullRequest: number): string {
  return path.join(stateDir, 'prs', `${String(pullRequest)}.json`);
}

function assertRealDir(dirPath: string, label: string): void {
  const stat = lstatSync(dirPath, { throwIfNoEntry: false });
  check(stat?.isDirectory() === true && !stat.isSymbolicLink(), `${label} is not a trusted directory`);
}

export function validateStateCheckout(git: GitRunner, dir: string): { dir: string; headSha: string } {
  const resolved = path.resolve(dir);
  assertRealDir(resolved, 'state checkout');
  const remote = git(resolved, ['remote', 'get-url', 'origin']);
  check(STATE_REMOTE_URLS.has(remote), `state checkout origin is not the authorized repository: ${remote}`);
  const ref = git(resolved, ['symbolic-ref', '-q', 'HEAD']);
  check(ref === `refs/heads/${STATE_BRANCH}`, `state checkout is not on ${STATE_BRANCH}: ${ref}`);
  const headSha = git(resolved, ['rev-parse', 'HEAD']);
  check(SHA_PATTERN.test(headSha), `state checkout HEAD is not a commit SHA: ${headSha}`);
  const dirty = git(resolved, ['status', '--porcelain']);
  check(dirty === '', 'state checkout has preexisting uncommitted changes');
  return { dir: resolved, headSha };
}

function readJsonFile(filePath: string, label: string): unknown {
  const stat = lstatSync(filePath, { throwIfNoEntry: false });
  if (stat === undefined) return null;
  check(stat.isFile() && !stat.isSymbolicLink(), `${label} is not a regular file`);
  try {
    return parseStrictJson(readFileSync(filePath, 'utf8'));
  } catch (error) {
    check(false, `${label} is corrupt: ${(error as Error).message}`);
  }
}

export function emptyLedger(repository: string, pullRequest: number): ReviewLedger {
  return { schemaVersion: 1, repository, pullRequest, lastHeadSha: null, openFindings: [] };
}

export function loadPrState(stateDir: string, repository: string, pullRequest: number): PrStateView {
  const resolved = path.resolve(stateDir);
  assertRealDir(resolved, 'state checkout');
  const indexRaw = readJsonFile(indexFilePath(resolved), 'index');
  check(indexRaw !== null, 'state index is missing or corrupt; provision the authorized branch first');
  const index = validateStateIndex(indexRaw);
  const prsDir = path.join(resolved, 'prs');
  const prsStat = lstatSync(prsDir, { throwIfNoEntry: false });
  if (prsStat !== undefined) assertRealDir(prsDir, 'prs directory');
  const recordRaw = readJsonFile(recordFilePath(resolved, pullRequest), 'record');
  const listed = index.pullRequests.includes(pullRequest);
  if (recordRaw === null && listed) {
    check(false, `index lists PR ${pullRequest} but its state record is missing or corrupt`);
  }
  if (recordRaw !== null && !listed) {
    check(false, `state record exists for PR ${pullRequest} but index does not list it`);
  }
  if (recordRaw === null) {
    return { index, record: null, ledger: emptyLedger(repository, pullRequest), isNew: true };
  }
  const record = validatePrStateRecord(recordRaw);
  check(record.repository === repository && record.pullRequest === pullRequest, 'state record targets a different repository or PR');
  return { index, record, ledger: record.ledger, isNew: false };
}

export interface PersistOptions {
  message: string;
  token: string;
}

export function persistPrState(
  git: GitRunner,
  stateDir: string,
  index: StateIndex,
  record: PrStateRecord,
  options: PersistOptions,
): void {
  const resolved = path.resolve(stateDir);
  assertRealDir(resolved, 'state checkout');
  check(typeof options.token === 'string' && options.token.length > 0, 'a nonempty credential is required to persist state');
  const prsDir = path.join(resolved, 'prs');
  const recordRel = `prs/${String(record.pullRequest)}.json`;
  const commitConfig = [
    '-c', 'user.name=sentinel-review',
    '-c', 'user.email=sentinel-review@users.noreply.github.com',
  ];
  const writeState = (stateIndex: StateIndex): void => {
    if (lstatSync(prsDir, { throwIfNoEntry: false }) === undefined) mkdirSync(prsDir, { mode: 0o700 });
    assertRealDir(prsDir, 'prs directory');
    writeFileSync(indexFilePath(resolved), `${JSON.stringify(stateIndex, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(recordFilePath(resolved, record.pullRequest), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    git(resolved, [...commitConfig, 'add', '--', 'index.json', recordRel]);
    git(resolved, [...commitConfig, 'commit', '-m', options.message]);
  };
  writeState(index);
  // Rejection detection relies on git's C-locale stderr strings.
  const pushEnv = {
    LC_ALL: 'C',
    LANG: 'C',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${options.token}`).toString('base64')}`,
  };
  // A rejected push means another run committed first. Rebase on the fetched
  // tip only when it left this PR's record untouched; a same-PR conflict is a
  // raced decision and must fail closed rather than merge.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      git(resolved, ['push', 'origin', `HEAD:refs/heads/${STATE_BRANCH}`], { env: pushEnv });
      return;
    } catch (error) {
      const message = (error as Error).message;
      if (!/non-fast-forward|fetch first|\[rejected\]/.test(message) || attempt === 3) throw error;
      git(resolved, ['fetch', 'origin', `refs/heads/${STATE_BRANCH}`], { env: pushEnv });
      const drift = git(resolved, ['diff', '--name-only', 'HEAD^', 'FETCH_HEAD', '--', recordRel]);
      check(drift === '', `state branch advanced with a concurrent update to ${recordRel}; refusing to merge same-PR state`);
      git(resolved, ['reset', '--hard', 'FETCH_HEAD']);
      const remoteIndex = validateStateIndex(readJsonFile(indexFilePath(resolved), 'index'));
      const merged: StateIndex = remoteIndex.pullRequests.includes(record.pullRequest)
        ? remoteIndex
        : { ...remoteIndex, pullRequests: [...remoteIndex.pullRequests, record.pullRequest].sort((a: number, b: number): number => a - b) };
      writeState(merged);
    }
  }
}
