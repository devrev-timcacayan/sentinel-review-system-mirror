import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchSentinelReview } from '../integration/dispatch-sentinel-review.ts';

const SHA = 'a'.repeat(40);
const HEAD = 'c'.repeat(40);

function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    CIRCLECI: 'true',
    CIRCLE_BRANCH: 'staging',
    CIRCLE_PROJECT_USERNAME: 'devrev',
    CIRCLE_PROJECT_REPONAME: 'sentinel',
    CIRCLE_SHA1: SHA,
    SENTINEL_REVIEW_DISPATCH_READY: 'true',
    SENTINEL_REVIEW_PR: '529',
    SENTINEL_REVIEW_POC_APPROVED_PR: '529',
    SENTINEL_REVIEW_DISPATCH_TOKEN: 'secret-dispatch-token',
    ...overrides,
  };
}

interface Call { url: string; method: string; body?: string }

function mockFetch(calls: Call[], responses: Record<string, { status: number; json?: unknown }> = {}): typeof fetch {
  return (async (url: unknown, init?: { method?: string; body?: string }): Promise<Response> => {
    const path = String(url).replace('https://api.github.com', '');
    calls.push({ url: path, method: init?.method ?? 'GET', body: init?.body });
    const canned = responses[path] ?? responses['*'];
    if (canned === undefined) return { status: 500, json: async () => ({}) } as Response;
    return { status: canned.status, json: async () => canned.json } as Response;
  }) as typeof fetch;
}

const PULL = {
  number: 529, state: 'open', title: 'POC Test: bridge-DO NOT REVIEW', body: null,
  base: { ref: 'staging', sha: SHA },
  head: { sha: HEAD, repo: { full_name: 'devrev/sentinel' } },
};

function happyResponses(overrides: Record<string, { status: number; json?: unknown }> = {}): Record<string, { status: number; json?: unknown }> {
  return {
    '/repos/devrev/sentinel/branches/staging': { status: 200, json: { commit: { sha: SHA } } },
    '/repos/devrev/sentinel/pulls/529': { status: 200, json: PULL },
    '/repos/devrev/sentinel/actions/workflows/claude-code-review.yml/dispatches': { status: 204, json: {} },
    ...overrides,
  };
}

test('a valid staging job issues exactly two GETs and one dispatch POST with the exact body', async (): Promise<void> => {
  const calls: Call[] = [];
  await dispatchSentinelReview(baseEnv(), mockFetch(calls, happyResponses()));
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'GET', 'POST']);
  assert.deepEqual(calls.map((c) => c.url), [
    '/repos/devrev/sentinel/branches/staging',
    '/repos/devrev/sentinel/pulls/529',
    '/repos/devrev/sentinel/actions/workflows/claude-code-review.yml/dispatches',
  ]);
  assert.deepEqual(JSON.parse(String(calls[2].body)), {
    ref: 'staging',
    inputs: { mode: 'review', pr_number: '529', base_sha: SHA, head_sha: HEAD },
  });
});

test('every missing gate rejects before any POST and never leaks the token', async (): Promise<void> => {
  const cases: [string, NodeJS.ProcessEnv][] = [
    ['not-circleci', { CIRCLECI: 'false' }],
    ['wrong-branch', { CIRCLE_BRANCH: 'main' }],
    ['wrong-user', { CIRCLE_PROJECT_USERNAME: 'other' }],
    ['wrong-repo', { CIRCLE_PROJECT_REPONAME: 'other' }],
    ['bad-sha', { CIRCLE_SHA1: 'ABC' }],
    ['not-ready', { SENTINEL_REVIEW_DISPATCH_READY: 'false' }],
    ['pr-leading-zero', { SENTINEL_REVIEW_PR: '0529' }],
    ['pr-nondecimal', { SENTINEL_REVIEW_PR: 'abc' }],
    ['pr-unapproved', { SENTINEL_REVIEW_PR: '17' }],
    ['no-token', { SENTINEL_REVIEW_DISPATCH_TOKEN: '' }],
  ];
  for (const [name, env] of cases) {
    const calls: Call[] = [];
    const result = await dispatchSentinelReview(baseEnv(env), mockFetch(calls, happyResponses())).then(() => 'ok', (e: Error) => e.message);
    assert.notEqual(result, 'ok', name);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0, name);
    assert.doesNotMatch(result, /secret-dispatch-token/, name);
  }
});

test('stale branch SHA, invalid PR shape, and HTTP failures reject before POST', async (): Promise<void> => {
  const branchOk = { status: 200, json: { commit: { sha: SHA } } };
  const scenarios: [string, Record<string, { status: number; json?: unknown }>][] = [
    ['stale-branch', { '/repos/devrev/sentinel/branches/staging': { status: 200, json: { commit: { sha: 'f'.repeat(40) } } } }],
    ['branch-404', { '/repos/devrev/sentinel/branches/staging': { status: 404, json: {} } }],
    ['closed-pr', { '/repos/devrev/sentinel/pulls/529': { status: 200, json: { ...PULL, state: 'closed' } } }],
    ['fork-head', { '/repos/devrev/sentinel/pulls/529': { status: 200, json: { ...PULL, head: { sha: HEAD, repo: { full_name: 'other/fork' } } } } }],
    ['bad-title', { '/repos/devrev/sentinel/pulls/529': { status: 200, json: { ...PULL, title: 'ordinary PR' } } }],
    ['wrong-base', { '/repos/devrev/sentinel/pulls/529': { status: 200, json: { ...PULL, base: { ref: 'main', sha: SHA } } } }],
    ['stale-base-sha', { '/repos/devrev/sentinel/pulls/529': { status: 200, json: { ...PULL, base: { ref: 'staging', sha: 'f'.repeat(40) } } } }],
    ['pull-404', { '/repos/devrev/sentinel/pulls/529': { status: 404, json: {} } }],
    ['post-403', { '/repos/devrev/sentinel/actions/workflows/claude-code-review.yml/dispatches': { status: 403, json: {} } }],
  ];
  for (const [name, responses] of scenarios) {
    const calls: Call[] = [];
    const result = await dispatchSentinelReview(baseEnv(), mockFetch(calls, happyResponses(responses))).then(() => 'ok', (e: Error) => e.message);
    assert.notEqual(result, 'ok', name);
    assert.equal(calls.filter((c) => c.method === 'POST').length, name === 'post-403' ? 1 : 0, name);
    assert.doesNotMatch(result, /secret-dispatch-token/, name);
  }
});

test('a fetch exception is sanitized and never retries the POST', async (): Promise<void> => {
  const calls: Call[] = [];
  const failing = (async (url: unknown, init?: { method?: string; body?: string }): Promise<Response> => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' });
    throw new Error('secret-dispatch-token leaked raw socket detail');
  }) as typeof fetch;
  const result = await dispatchSentinelReview(baseEnv(), failing).then(() => 'ok', (e: Error) => e.message);
  assert.notEqual(result, 'ok');
  assert.doesNotMatch(result, /secret-dispatch-token|socket/i);
  const calls2: Call[] = [];
  let posts = 0;
  const timeoutPost = (async (url: unknown, init?: { method?: string; body?: string }): Promise<Response> => {
    calls2.push({ url: String(url), method: init?.method ?? 'GET' });
    if (init?.method === 'POST') { posts += 1; throw new Error('timed out'); }
    return { status: 200, json: async () => (String(url).endsWith('/branches/staging') ? { commit: { sha: SHA } } : PULL) } as Response;
  }) as typeof fetch;
  await dispatchSentinelReview(baseEnv(), timeoutPost).then(() => 'ok', () => 'rejected');
  assert.equal(posts, 1, 'a failed POST is never retried');
});
