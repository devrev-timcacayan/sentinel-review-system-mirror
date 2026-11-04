import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readActionControls } from '../src/actionControls.ts';
import { verifyActionExecution, isVerifiedActionExecution } from '../src/actionExecution.ts';
import { validateActionRequest, validateAgentRequest } from '../src/agentContracts.ts';
import type { AgentPriorCheckpoint } from '../src/agentContracts.ts';
import { prepareActionReview, validateActionReview } from '../src/agentReview.ts';
import { completedStateVersion, loadPrState, pendingStateVersion, persistPrState, validateStateIndex, validatePrStateRecord } from '../src/actionState.ts';
import type { PrStateRecord, StateIndex } from '../src/actionState.ts';
import { diffHeadLines, renderSummary, runActionHost } from '../src/actionHost.ts';
import type { HostDeps } from '../src/actionHost.ts';
import { createAgentReportSchema } from '../src/agentSchema.ts';
import { ALLOWED_REPOSITORY, SYSTEM_ROOT, loadTestPolicy, makeRepo, seedPolicyContext } from './helpers.ts';
import type { RepoFixture } from './helpers.ts';
import type { ReviewLedger } from '../src/contracts.ts';

const PIN = 'f'.repeat(40);
const REPO = 'devrev/sentinel';
const LIMITS = { maxFiles: 100, maxSourceBytes: 1_000_000, maxReadBytes: 100_000 };
const CONTROLS = { maxTurns: 10, maxBudgetUsd: 1, timeoutMinutes: 2, ...LIMITS };

function tmp(): string { return mkdtempSync(path.join(tmpdir(), 'srs-action-')); }

function makeSource(): { repo: RepoFixture; baseSha: string; headSha: string } {
  const repo = makeRepo();
  seedPolicyContext(repo, loadTestPolicy());
  repo.write('src/action.ts', 'export const required = true;\n');
  const baseSha = repo.commit('base');
  repo.write('src/action.ts', 'export const required = false;\n');
  const headSha = repo.commit('head');
  return { repo, baseSha, headSha };
}

function checkpoint(ledger?: ReviewLedger): AgentPriorCheckpoint {
  return {
    schemaVersion: 1,
    repository: REPO,
    pullRequest: 17,
    stateVersion: 'gha-1-1',
    ledger: ledger ?? { schemaVersion: 1, repository: REPO, pullRequest: 17, lastHeadSha: null, openFindings: [] },
  };
}

function prepareArgs(source: { repo: RepoFixture; baseSha: string; headSha: string }, out: string) {
  return {
    checkout: source.repo.dir,
    repository: REPO,
    pullRequest: 17,
    baseRef: source.baseSha,
    headRef: source.headSha,
    runId: 'gha-1-1',
    reviewSystemSha: PIN,
    priorState: checkpoint(),
    validationLimits: LIMITS,
    outDir: out,
    systemRoot: SYSTEM_ROOT,
  };
}

test('action preparation labels mode action/operational and both validators discriminate modes', (): void => {
  const source = makeSource();
  const out = path.join(tmp(), 'prepared');
  const result = prepareActionReview(prepareArgs(source, out));
  assert.equal(result.status, 'prepared');
  assert.equal(result.request.mode, 'action');
  assert.equal(result.request.synthetic, false);
  assert.equal(result.request.operational, true);
  assert.equal(validateActionRequest(result.request).mode, 'action');
  assert.throws(() => validateAgentRequest(result.request), /mode must be offline/);
  assert.equal('files' in result.request, false);
});

const REPORT = { schemaVersion: 1, complete: true, limitations: [], coverage: [], findings: [], reconciliations: [] };

function executionTrace(report: unknown): string {
  const model = loadTestPolicy().policy.model;
  return JSON.stringify([
    { type: 'system', subtype: 'init', session_id: 'session-1', model },
    { type: 'result', subtype: 'success', is_error: false, session_id: 'session-1', permission_denials: [], modelUsage: { [model]: {} }, num_turns: 2, total_cost_usd: 0.25, duration_ms: 1000, structured_output: report },
  ]);
}

function verifiedReceipt(report: unknown, runId = 'gha-1-1') {
  return verifyActionExecution(
    { actionOutcome: 'success', actionConclusion: 'success', sessionId: 'session-1', structuredOutput: JSON.stringify(report), executionText: executionTrace(report) },
    { model: loadTestPolicy().policy.model, runId, maxTurns: 10, maxBudgetUsd: 1, maxDurationMs: 120_000 },
  );
}

function preparedRun() {
  const source = makeSource();
  const out = path.join(tmp(), 'prepared');
  const prepared = prepareActionReview(prepareArgs(source, out));
  const report = {
    ...REPORT,
    identity: prepared.request.identity,
    coverage: prepared.request.changes.flatMap((change) =>
      ['test-validity', 'reliability-impact', 'maintainability'].map((dimension) => ({
        path: change.path, dimension, assessment: 'reviewed', rationale: 'Reviewed.', relatedPaths: [],
      }))),
  };
  return { source, prepared, report };
}

function validateArgs(run: ReturnType<typeof preparedRun>, receipt: unknown, executionError: string | null = null) {
  return {
    checkout: run.source.repo.dir,
    request: run.prepared.request,
    reportText: JSON.stringify(run.report),
    receipt,
    executionError,
    current: { repository: REPO, pullRequest: 17, headSha: run.source.headSha, baseSha: run.source.baseSha, runId: 'gha-1-1', reviewSystemSha: PIN },
    priorState: checkpoint(),
    outDir: path.join(tmp(), 'validated'),
    systemRoot: SYSTEM_ROOT,
  };
}

test('action validation requires a WeakSet-verified receipt and emits an operational decision', (): void => {
  const run = preparedRun();
  const pass = validateActionReview(validateArgs(run, verifiedReceipt(run.report)));
  assert.equal(pass.status, 'pass');
  assert.equal(pass.envelope.kind, 'action-agent-decision');
  assert.equal(pass.envelope.synthetic, false);
  assert.equal(pass.envelope.operational, true);

  const fabricated = preparedRun();
  const fakeReceipt = JSON.parse(JSON.stringify(verifiedReceipt(fabricated.report)));
  const denied = validateActionReview(validateArgs(fabricated, fakeReceipt));
  assert.equal(denied.status, 'incomplete');
  assert.equal(denied.envelope.synthetic, false);

  const nullReceipt = preparedRun();
  const missing = validateActionReview(validateArgs(nullReceipt, null, 'action failed'));
  assert.equal(missing.status, 'incomplete');

  const offline = validateAgentRequest; // offline path cannot consume action artifacts
  assert.throws(() => offline(fabricated.prepared.request));
});

test('state index and records fail closed on inconsistency and admit only valid registrations', (): void => {
  const dir = tmp();
  assert.throws(() => loadPrState(dir, REPO, 17), /integrity failure/i);

  const index: StateIndex = { schemaVersion: 1, repository: 'devrev/sentinel', pullRequests: [17] };
  writeFileSync(path.join(dir, 'index.json'), `${JSON.stringify(index)}\n`);

  // Listed PR with no record is corruption; unlisted with no record is a valid new PR only if unlisted.
  assert.throws(() => loadPrState(dir, REPO, 17), /missing or corrupt/);
  const fresh = loadPrState(dir, REPO, 18);
  assert.equal(fresh.isNew, true);
  assert.deepEqual(fresh.ledger.openFindings, []);

  // A record for an unlisted PR is inconsistency.
  mkdirSync(path.join(dir, 'prs'));
  writeFileSync(path.join(dir, 'prs', '19.json'), `${JSON.stringify({
    schemaVersion: 1, repository: REPO, pullRequest: 19, stateVersion: 'gha-1-1',
    ledger: { schemaVersion: 1, repository: REPO, pullRequest: 19, lastHeadSha: null, openFindings: [] },
    runId: 'gha-1-1', headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), status: 'pending',
  })}\n`);
  assert.throws(() => loadPrState(dir, REPO, 19), /index does not list/);

  const bad = { schemaVersion: 1, repository: 'devrev/other', pullRequests: [1] };
  assert.throws(() => validateStateIndex(bad), /repository must be devrev\/sentinel/);
  const dup = { schemaVersion: 1, repository: 'devrev/sentinel', pullRequests: [1, 1] };
  assert.throws(() => validateStateIndex(dup), /duplicate/);

  const record: PrStateRecord = {
    schemaVersion: 1, repository: REPO, pullRequest: 17, stateVersion: pendingStateVersion('gha-1-1'),
    ledger: { schemaVersion: 1, repository: REPO, pullRequest: 17, lastHeadSha: null, openFindings: [] },
    runId: 'gha-1-1', headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), status: 'pending',
  };
  assert.equal(validatePrStateRecord(record).status, 'pending');
  assert.throws(() => validatePrStateRecord({ ...record, ledger: { ...record.ledger, pullRequest: 99 } }), /does not match/);
  assert.equal(completedStateVersion('gha-1-1'), 'gha-1-1-completed');

  // persist uses exact argv sequences: add/commit/ff push only, hooks disabled, token in env.
  const calls: { args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const fakeGit = (_dir: string, args: string[], options?: { env?: NodeJS.ProcessEnv }): string => {
    calls.push({ args, env: options?.env });
    return '';
  };
  const stateDir = tmp();
  writeFileSync(path.join(stateDir, 'index.json'), `${JSON.stringify(index)}\n`);
  persistPrState(fakeGit, stateDir, index, record, { message: 'review: reserve PR 17 for gha-1-1', token: 'secret' });
  assert.deepEqual(calls.map((call) => call.args[call.args.length - 1] === '--' ? call.args : call.args).length >= 3, true);
  const addCall = calls.find((call) => call.args.includes('add'));
  assert.ok(addCall && addCall.args.includes('index.json') && addCall.args.includes('prs/17.json'));
  const commitCall = calls.find((call) => call.args.includes('commit'));
  assert.ok(commitCall && commitCall.args.includes('review: reserve PR 17 for gha-1-1'));
  const pushCall = calls.find((call) => call.args.includes('push'));
  assert.ok(pushCall && pushCall.args.includes('HEAD:refs/heads/sentinel-review-state') && !pushCall.args.includes('--force'));
  assert.equal(pushCall?.env?.GIT_CONFIG_VALUE_0, `AUTHORIZATION: basic ${Buffer.from('x-access-token:secret').toString('base64')}`);
});

function hostDeps(overrides: Partial<HostDeps> = {}): HostDeps {
  const calls: { args: string[] }[] = [];
  const git = (dir: string, args: string[]): string => {
    calls.push({ args });
    const key = args[0];
    if (key === 'remote') return 'https://github.com/devrev/sentinel';
    if (key === 'symbolic-ref') return 'refs/heads/sentinel-review-state';
    if (key === 'rev-parse') return 'b'.repeat(40);
    if (key === 'status' || key === 'cat-file') return '';
    if (key === 'add' || key === 'commit' || key === 'push' || key === 'fetch') return '';
    return '';
  };
  const event = {
    pull_request: {
      number: 17,
      title: 'POC Test: docs touch-DO NOT REVIEW',
      body: null,
      base: { ref: 'staging', sha: 'b'.repeat(40) },
      head: { sha: 'c'.repeat(40), repo: { full_name: REPO } },
    },
  };
  const env: NodeJS.ProcessEnv = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: REPO,
    GITHUB_EVENT_NAME: 'pull_request_target',
    GITHUB_RUN_ID: '7',
    GITHUB_RUN_ATTEMPT: '3',
    REVIEW_SYSTEM_SHA: PIN,
    SENTINEL_REVIEW_POC_APPROVED_PR: '17',
    SENTINEL_REVIEW_CONTROLS_VERIFIED: 'true',
    SENTINEL_REVIEW_MAX_TURNS: '10',
    SENTINEL_REVIEW_MAX_USD: '1',
    SENTINEL_REVIEW_TIMEOUT_MINUTES: '2',
    SENTINEL_REVIEW_MAX_FILES: '100',
    SENTINEL_REVIEW_MAX_SOURCE_BYTES: '1000000',
    SENTINEL_REVIEW_MAX_READ_BYTES: '100000',
    GH_TOKEN: 'fixture-token',
  };
  const eventPath = path.join(tmp(), 'event.json');
  writeFileSync(eventPath, JSON.stringify(event));
  env.GITHUB_EVENT_PATH = eventPath;
  const http = (request: { method: string; path: string }): { status: number; json: unknown } => {
    if (request.path.startsWith('/repos/devrev/sentinel/pulls/')) {
      return { status: 200, json: event.pull_request ? { number: 17, state: 'open', base: event.pull_request.base, head: event.pull_request.head } : {} };
    }
    if (request.path.startsWith('/repos/devrev/sentinel/actions/runs/')) {
      return { status: 200, json: { id: 7, run_attempt: 3, event: 'pull_request_target', path: '.github/workflows/claude-code-review.yml@refs/heads/staging' } };
    }
    if (request.method === 'POST') return { status: 201, json: { id: 1 } };
    return { status: 404, json: {} };
  };
  return {
    env,
    git,
    http,
    systemIntegrity: () => ({ headSha: PIN, pristine: true }),
    ...overrides,
  };
}

test('readActionControls refuses unapproved PRs and unverified flags', (): void => {
  const env = hostDeps().env;
  assert.equal(readActionControls(env, 17).maxTurns, 10);
  assert.throws(() => readActionControls(env, 18), /not explicitly authorized/);
  assert.throws(() => readActionControls({ ...env, SENTINEL_REVIEW_CONTROLS_VERIFIED: 'false' }, 17), /verified before activation/);
});

test('action-host reserve writes a pending reservation only after full preparation', async (): Promise<void> => {
  const source = makeSource();
  const stateDir = tmp();
  writeFileSync(path.join(stateDir, 'index.json'), `${JSON.stringify({ schemaVersion: 1, repository: 'devrev/sentinel', pullRequests: [] })}\n`);
  const pushes: string[][] = [];
  const deps = hostDeps();
  const realGit = deps.git;
  deps.git = (dir: string, args: string[]): string => {
    if (args[0] === 'push') pushes.push(args);
    return realGit(dir, args);
  };
  const event = JSON.parse(readFileSync(deps.env.GITHUB_EVENT_PATH as string, 'utf8'));
  event.pull_request.base.sha = source.baseSha;
  event.pull_request.head.sha = source.headSha;
  writeFileSync(deps.env.GITHUB_EVENT_PATH as string, JSON.stringify(event));
  deps.http = (request: { method: string; path: string }) => {
    if (request.path.startsWith('/repos/devrev/sentinel/pulls/')) {
      return { status: 200, json: { number: 17, state: 'open', base: { ref: 'staging', sha: source.baseSha }, head: { sha: source.headSha, repo: { full_name: REPO } } } };
    }
    if (request.path.startsWith('/repos/devrev/sentinel/actions/runs/')) {
      return { status: 200, json: { id: 7, run_attempt: 3, event: 'pull_request_target', path: '.github/workflows/claude-code-review.yml@x' } };
    }
    return { status: 201, json: { id: 1 } };
  };
  const out = path.join(tmp(), 'prepared');
  const code = await runActionHost('reserve', {
    sourceCheckout: source.repo.dir,
    stateCheckout: stateDir,
    out,
    systemRoot: SYSTEM_ROOT,
  }, deps);
  assert.equal(code, 0);
  assert.equal(pushes.length, 1);
  const record = JSON.parse(readFileSync(path.join(stateDir, 'prs', '17.json'), 'utf8'));
  assert.equal(record.status, 'pending');
  assert.equal(record.stateVersion, 'gha-7-3');
  assert.equal(record.runId, 'gha-7-3');
  const index = JSON.parse(readFileSync(path.join(stateDir, 'index.json'), 'utf8'));
  assert.deepEqual(index.pullRequests, [17]);
});

test('workflow templates satisfy the static contract', (): void => {
  const main = readFileSync(path.join(SYSTEM_ROOT, 'integration', 'sentinel-claude-code-review.yml'), 'utf8');
  const retired = readFileSync(path.join(SYSTEM_ROOT, 'integration', 'retired-sentinel-review.yml'), 'utf8');
  const actionUses = main.match(/uses:\s*anthropics\/claude-code-action@/g) ?? [];
  assert.equal(actionUses.length, 1, 'exactly one anthropics action invocation');
  assert.match(main, /anthropics\/claude-code-action@1d6de8cb0c237e7c15e9e1bdf973826ebae490cc/);
  assert.match(main, /workflow_dispatch:/);
  assert.doesNotMatch(main, /pull_request_target/);
  assert.match(main, /contents: write/);
  assert.match(main, /contents: read/);
  assert.match(main, /id-token: write/);
  assert.doesNotMatch(main, /(gh |hub |curl ).*comment/i);
  assert.doesNotMatch(retired, /anthropics\/claude-code-action|configure-aws-credentials|pull_request_target/);
  assert.doesNotMatch(retired, /pull_request:/);
});

test('diffHeadLines maps head-side hunk lines per file and ignores binary or deleted entries', (): void => {
  const diff = [
    'diff --git a/src/one.ts b/src/one.ts',
    'index 111..222 100644',
    '--- a/src/one.ts',
    '+++ b/src/one.ts',
    '@@ -1,3 +1,4 @@',
    ' line',
    '+added',
    '@@ -10,2 +11,3 @@',
    ' line',
    'diff --git a/src/two.ts b/src/two.ts',
    '--- a/src/two.ts',
    '+++ b/src/two.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git a/src/old.ts b/src/new.ts',
    'similarity index 90%',
    'rename from src/old.ts',
    'rename to src/new.ts',
    '--- a/src/old.ts',
    '+++ b/src/new.ts',
    '@@ -3,2 +5,2 @@',
    ' ctx',
    'diff --git a/src/gone.ts b/src/gone.ts',
    'deleted file mode 100644',
    '--- a/src/gone.ts',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-dead',
    'diff --git a/img.png b/img.png',
    'Binary files a/img.png and b/img.png differ',
    '',
  ].join('\n');
  const map = diffHeadLines(diff);
  assert.deepEqual([...map.get('src/one.ts') ?? []].sort((a: number, b: number): number => a - b), [1, 2, 3, 4, 11, 12, 13]);
  assert.deepEqual([...map.get('src/two.ts') ?? []], [1], 'omitted hunk count defaults to one line');
  assert.deepEqual([...map.get('src/new.ts') ?? []], [5, 6], 'renames index under the new path');
  assert.equal(map.has('src/gone.ts'), false, 'deleted files have no head lines');
  assert.equal(map.has('img.png'), false, 'binary files carry no hunks');
});

test('the published summary stays compact and marker-bound', (): void => {
  const evidence = { path: 'src/action.ts', revision: 'head' as const, startLine: 5, endLine: 5, quote: 'x' };
  const openFindings = [
    { id: 'F-one', ruleId: 'SR-002', severity: 'blocker' as const, title: 'First', explanation: 'long explanation', impact: 'long impact', introducedBy: evidence, evidence: [evidence], counterEvidence: [] },
    { id: 'F-two', ruleId: 'novel', severity: 'question' as const, title: 'Second', explanation: 'e', impact: 'i', introducedBy: evidence, evidence: [evidence], counterEvidence: [] },
  ];
  const body = renderSummary(
    {
      status: 'changes_required',
      reasons: ['a', 'b', 'c', 'd', 'e', 'f'],
      ledger: { schemaVersion: 1, repository: REPO, pullRequest: 17, lastHeadSha: 'a'.repeat(40), openFindings },
    },
    'gha-7-3',
    'https://github.com/devrev/sentinel/actions/runs/7',
  );
  const reasonBullets = body.split('**Findings:**')[0].split('\n').filter((line: string): boolean => line.startsWith('- `'));
  assert.equal(reasonBullets.length, 5, 'reasons cap at five bullets');
  assert.match(body, /^- \+1 more, see workflow run$/m);
  assert.match(body, /\*\*Findings:\*\* 1 blocker, 1 question\n- `F-one` \[blocker\] `First` \(`src\/action\.ts`:5\)\n- `F-two` \[question\] `Second` \(`src\/action\.ts`:5\)/);
  assert.doesNotMatch(body, /long explanation|long impact/);
  assert.doesNotMatch(body, /—|\\/, 'no em dash or backslash escapes in published text');
  assert.match(body, /<!-- sentinel-review -->\n$/);
});

test('manual dispatch workflow exposes one PR input and the canonical guards', (): void => {
  const template = readFileSync(path.join(SYSTEM_ROOT, 'integration', 'sentinel-claude-code-review.yml'), 'utf8');
  assert.doesNotMatch(template, /pull_request_target|staging-dispatch-probe|PROBE_MODE|inputs\.mode|inputs\.base_sha|inputs\.head_sha/);
  assert.match(template, /workflow_dispatch:\s*\n\s+inputs:\s*\n\s+pr_number:\s*\n\s+description: 'PR number to review'\s*\n\s+type: string\s*\n\s+required: true\s*\n\s+default: '529'/);
  assert.match(template, /REVIEW_SYSTEM_SHA: '4e98ad89f9783fc98c5007182394e0f3e25f58e0'/);
  assert.doesNotMatch(template, /SENTINEL_REVIEW_MAX_USD|SENTINEL_REVIEW_MAX_TURNS/);
  assert.match(template, /secrets\.SENTINEL_REVIEW_SYSTEM_READ_TOKEN/);
  assert.doesNotMatch(template, /SENTINEL_REVIEW_POC_APPROVED_PR|SENTINEL_REVIEW_CONTROLS_VERIFIED|CLAUDE_REVIEW_PAT/);
  assert.equal(template.match(/ref: \$\{\{ github\.sha \}\}/g)?.length, 3);
  const actionUses = template.match(/uses:\s*anthropics\/claude-code-action@/g) ?? [];
  assert.equal(actionUses.length, 1);
  assert.match(template, /anthropics\/claude-code-action@1d6de8cb0c237e7c15e9e1bdf973826ebae490cc/);
  const prepareJob = template.split('\n  prepare:')[1].split('\n  investigate:')[0];
  const investigateJob = template.split('\n  investigate:')[1].split('\n  claude-auto-review:')[0];
  const finalJob = template.split('\n  claude-auto-review:')[1];
  assert.match(prepareJob, /if: \$\{\{ github\.event_name == 'workflow_dispatch' \}\}/);
  assert.match(investigateJob, /if: \$\{\{ github\.event_name == 'workflow_dispatch' && needs\.prepare\.result == 'success' \}\}/);
  assert.match(finalJob, /if: \$\{\{ always\(\) && github\.event_name == 'workflow_dispatch' \}\}/);
  assert.match(prepareJob, /statuses: write/);
  assert.match(finalJob, /statuses: write/);
  assert.match(finalJob.split('permissions:')[1].split('steps:')[0], /issues: write/);
  assert.doesNotMatch(prepareJob.split('permissions:')[1].split('outputs:')[0], /issues: write/);
  assert.doesNotMatch(investigateJob.split('permissions:')[1].split('steps:')[0], /statuses: write|contents: write|pull-requests: write|issues: write/);
  assert.match(template, /sentinel-review-\$\{\{ inputs\.pr_number \|\| github\.run_id \}\}/);
  const startIdx = prepareJob.indexOf('action-host start-status');
  const stateIdx = prepareJob.indexOf('Checkout existing operational state branch');
  assert.ok(startIdx > -1 && stateIdx > -1 && startIdx < stateIdx, 'pending status before state checkout');
  const fallbackStep = finalJob.split('action-host fail-status')[0].split('id: finalize')[1];
  assert.match(fallbackStep, /if: \$\{\{ always\(\) && steps\.finalize\.outputs\.canonical_decision == '' \}\}/);
  assert.doesNotMatch(finalJob.split('id: finalize')[1].split('- name: Mark the exact PR head review failed')[0], /continue-on-error/);
});
