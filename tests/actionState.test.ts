import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { persistPrState } from '../src/actionState.ts';
import type { GitRunner, PrStateRecord, StateIndex } from '../src/actionState.ts';

const REPO = 'devrev/sentinel';

function makeStateDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'srs-astate-'));
  writeFileSync(path.join(dir, 'index.json'), `${JSON.stringify({ schemaVersion: 1, repository: REPO, pullRequests: [] })}\n`);
  return dir;
}

function makeRecord(): PrStateRecord {
  return {
    schemaVersion: 1,
    repository: REPO,
    pullRequest: 17,
    stateVersion: 'run-1',
    ledger: { schemaVersion: 1, repository: REPO, pullRequest: 17, lastHeadSha: null, openFindings: [] },
    runId: 'run-1',
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    status: 'pending',
  };
}

function makeIndex(pullRequests: number[]): StateIndex {
  return { schemaVersion: 1, repository: REPO, pullRequests };
}

test('a push race with another PR record retries on the fetched tip and merges the index', (): void => {
  const dir = makeStateDir();
  const indexPath = path.join(dir, 'index.json');
  const calls: string[] = [];
  const git: GitRunner = (_checkout, args) => {
    calls.push(args[0]);
    if (args[0] === 'push' && calls.filter((name) => name === 'push').length === 1) {
      throw new Error('! [rejected] HEAD -> sentinel-review-state (non-fast-forward)');
    }
    // The remote raced us on prs/23.json only; the record-filtered diff stays clean.
    if (args[0] === 'diff') return '';
    if (args[0] === 'reset') {
      writeFileSync(indexPath, `${JSON.stringify(makeIndex([23]))}\n`);
      return '';
    }
    return '';
  };
  persistPrState(git, dir, makeIndex([17]), makeRecord(), { message: 'reserve', token: 'token' });
  assert.equal(calls.filter((name) => name === 'push').length, 2);
  assert.deepEqual(JSON.parse(readFileSync(indexPath, 'utf8')).pullRequests, [17, 23]);
  assert.ok(readFileSync(path.join(dir, 'prs', '17.json'), 'utf8').includes('"pullRequest": 17'));
});

test('a push race touching the same PR record fails closed without a merge or retry push', (): void => {
  const dir = makeStateDir();
  const calls: string[] = [];
  const git: GitRunner = (_checkout, args) => {
    calls.push(args[0]);
    if (args[0] === 'push') throw new Error('! [rejected] HEAD -> sentinel-review-state (non-fast-forward)');
    if (args[0] === 'diff') return 'prs/17.json\n';
    return '';
  };
  assert.throws(
    () => persistPrState(git, dir, makeIndex([17]), makeRecord(), { message: 'reserve', token: 'token' }),
    /concurrent update to prs\/17\.json/,
  );
  assert.equal(calls.filter((name) => name === 'push').length, 1);
});

test('a non-rejection push failure throws immediately without fetching', (): void => {
  const dir = makeStateDir();
  const calls: string[] = [];
  const git: GitRunner = (_checkout, args) => {
    calls.push(args[0]);
    if (args[0] === 'push') throw new Error('permission denied');
    return '';
  };
  assert.throws(
    () => persistPrState(git, dir, makeIndex([17]), makeRecord(), { message: 'reserve', token: 'token' }),
    /permission denied/,
  );
  assert.equal(calls.filter((name) => name === 'push').length, 1);
  assert.equal(calls.filter((name) => name === 'fetch').length, 0);
});

test('push and fetch run under the C locale so rejection messages stay stable', (): void => {
  const dir = makeStateDir();
  const envs: (NodeJS.ProcessEnv | undefined)[] = [];
  const git: GitRunner = (_checkout, args, options) => {
    if (args[0] === 'push' || args[0] === 'fetch') envs.push(options?.env);
    return '';
  };
  persistPrState(git, dir, makeIndex([17]), makeRecord(), { message: 'reserve', token: 'token' });
  assert.equal(envs.length, 1);
  assert.equal(envs[0]?.LC_ALL, 'C');
  assert.equal(envs[0]?.LANG, 'C');
});

test('three consecutive rejections exhaust the retry bound and throw', (): void => {
  const dir = makeStateDir();
  const calls: string[] = [];
  const envs: (NodeJS.ProcessEnv | undefined)[] = [];
  const git: GitRunner = (_checkout, args, options) => {
    calls.push(args[0]);
    if (args[0] === 'push' || args[0] === 'fetch') envs.push(options?.env);
    if (args[0] === 'push') throw new Error('error: failed to push some refs (fetch first)');
    if (args[0] === 'diff') return '';
    return '';
  };
  assert.throws(
    () => persistPrState(git, dir, makeIndex([17]), makeRecord(), { message: 'reserve', token: 'token' }),
    /fetch first/,
  );
  assert.equal(calls.filter((name) => name === 'push').length, 3);
  assert.equal(calls.filter((name) => name === 'fetch').length, 2);
  assert.ok(envs.every((env) => env?.LC_ALL === 'C'));
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'index.json'), 'utf8')).pullRequests, [17]);
});
