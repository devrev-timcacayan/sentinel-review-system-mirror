import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DIMENSIONS } from '../src/contracts.ts';
import type { Evidence, Finding, ReviewLedger, ReviewPolicy, ReviewReport, ReviewSnapshot } from '../src/contracts.ts';
import { evaluateReview } from '../src/gate.ts';

const POLICY: ReviewPolicy = JSON.parse(readFileSync(new URL('../policy/review-system.json', import.meta.url), 'utf8')) as ReviewPolicy;
const FIRST_SHA = 'a'.repeat(40);
const NEXT_SHA = 'b'.repeat(40);
const BASE_SHA = 'c'.repeat(40);

function evidence(path: string = 'src/action.ts', revision: 'base' | 'head' = 'head'): Evidence {
  return { path, revision, startLine: 1, endLine: 1, quote: revision === 'head' ? 'export const required = false;' : 'export const required = true;' };
}

function blocker(): Finding {
  return {
    id: 'F-setup',
    ruleId: 'SR-002',
    severity: 'blocker',
    title: 'Required setup is bypassed',
    explanation: 'The changed exported prerequisite can disable the required setup.',
    impact: 'The consumer can continue without creating its required data.',
    introducedBy: evidence(),
    evidence: [evidence(), evidence('tests/consumer.ts')],
    counterEvidence: ['The consumer is captured as unchanged context; its source is not a new test.'],
  };
}

function fixture(): { snapshot: ReviewSnapshot; report: ReviewReport; previous: ReviewLedger } {
  const snapshot: ReviewSnapshot = {
    schemaVersion: 1,
    identity: {
      repository: 'devrev-timcacayan/sentinel-mirror',
      pullRequest: 17,
      headSha: FIRST_SHA,
      baseSha: BASE_SHA,
      mergeBaseSha: BASE_SHA,
      policyDigest: 'd'.repeat(64),
      model: POLICY.model,
      runId: 'run-1',
    },
    previousHeadSha: null,
    changes: [{ path: 'src/action.ts', status: 'modified' }],
    size: { changedLines: 2, warnChangedLines: 800, blockChangedLines: 1500, outcome: 'within_threshold' },
    files: [
      { path: 'src/action.ts', revision: 'base', content: 'export const required = true;\n' },
      { path: 'src/action.ts', revision: 'head', content: 'export const required = false;\n' },
      { path: 'tests/consumer.ts', revision: 'head', content: 'export const required = false;\n' },
    ],
    dependencyEdges: [{ from: 'tests/consumer.ts', to: 'src/action.ts' }],
    contextPlan: { strategy: 'symbol-aware-reverse-v1', selections: [{ path: 'src/action.ts', reasons: ['changed'] }], fallbacks: [] },
    cumulativeDiff: '-export const required = true;\n+export const required = false;\n',
    deltaDiff: null,
    complete: true,
    limitations: [],
  };
  const report: ReviewReport = {
    schemaVersion: 1,
    identity: structuredClone(snapshot.identity),
    complete: true,
    limitations: [],
    coverage: DIMENSIONS.map((dimension) => ({
      path: 'src/action.ts',
      dimension,
      assessment: 'reviewed',
      rationale: 'Compared the current export, previous contract, and unchanged consumer.',
      relatedPaths: ['tests/consumer.ts'],
    })),
    findings: [],
    reconciliations: [],
  };
  const previous: ReviewLedger = {
    schemaVersion: 1,
    repository: snapshot.identity.repository,
    pullRequest: snapshot.identity.pullRequest,
    lastHeadSha: null,
    openFindings: [],
  };
  return { snapshot, report, previous };
}

test('complete structurally consistent review can pass without compulsory criticism', (): void => {
  const { snapshot, report, previous } = fixture();
  const decision = evaluateReview(snapshot, report, previous, POLICY);
  assert.equal(decision.status, 'pass');
  assert.equal(decision.ledger.lastHeadSha, FIRST_SHA);
});


test('a forged oversized or inconsistent size assessment cannot pass', (): void => {
  for (const size of [
    { changedLines: 1501, warnChangedLines: 800, blockChangedLines: 1500, outcome: 'split_recommended' as const },
    { changedLines: 801, warnChangedLines: 800, blockChangedLines: 1500, outcome: 'within_threshold' as const },
    { changedLines: 2, warnChangedLines: 900, blockChangedLines: 1500, outcome: 'within_threshold' as const },
  ]) {
    const { snapshot, report, previous } = fixture();
    snapshot.size = size;
    assert.equal(evaluateReview(snapshot, report, previous, POLICY).status, 'incomplete');
  }
});
test('evidenced blocker requires changes independent of reviewer verdict prose', (): void => {
  const { snapshot, report, previous } = fixture();
  report.findings = [blocker()];
  assert.equal(evaluateReview(snapshot, report, previous, POLICY).status, 'changes_required');
});

test('advisory and uncertain questions do not become blockers', (): void => {
  for (const severity of ['advisory', 'question'] as const) {
    const { snapshot, report, previous } = fixture();
    report.findings = [{ ...blocker(), severity }];
    assert.equal(evaluateReview(snapshot, report, previous, POLICY).status, 'pass');
  }
});

test('every provenance field must match the captured review identity', (): void => {
  const mutations: Partial<ReviewReport['identity']>[] = [
    { headSha: NEXT_SHA }, { baseSha: NEXT_SHA }, { mergeBaseSha: NEXT_SHA },
    { repository: 'devrev/other-repo' }, { pullRequest: 18 }, { model: 'other-model' },
    { policyDigest: 'e'.repeat(64) }, { runId: 'old-run' },
  ];
  for (const mutation of mutations) {
    const { snapshot, report, previous } = fixture();
    Object.assign(report.identity, mutation);
    assert.equal(evaluateReview(snapshot, report, previous, POLICY).status, 'incomplete');
  }
});

test('a repository outside the policy allowlist is refused', (): void => {
  const { snapshot, report, previous } = fixture();
  snapshot.identity.repository = 'devrev/other-repo';
  report.identity.repository = 'devrev/other-repo';
  previous.repository = 'devrev/other-repo';
  assert.equal(evaluateReview(snapshot, report, previous, POLICY).status, 'incomplete');
});

test('free-text clean markers cannot substitute for a structured report', (): void => {
  const { snapshot, previous } = fixture();
  for (const input of [null, [], 'REVIEW_VERDICT: CLEAN', { verdict: 'CLEAN' }, { complete: true }]) {
    assert.equal(evaluateReview(snapshot, input, previous, POLICY).status, 'incomplete');
  }
});

test('unknown output fields are rejected rather than silently interpreted', (): void => {
  const { snapshot, report, previous } = fixture();
  assert.equal(evaluateReview(snapshot, { ...report, verdict: 'pass' }, previous, POLICY).status, 'incomplete');
});

test('missing dimensions or duplicate coverage cannot pass', (): void => {
  const missing = fixture();
  missing.report.coverage.pop();
  assert.equal(evaluateReview(missing.snapshot, missing.report, missing.previous, POLICY).status, 'incomplete');
  const duplicate = fixture();
  duplicate.report.coverage.push(structuredClone(duplicate.report.coverage[0]));
  assert.equal(evaluateReview(duplicate.snapshot, duplicate.report, duplicate.previous, POLICY).status, 'incomplete');
});

test('omitted unchanged caller prevents complete impact coverage', (): void => {
  const { snapshot, report, previous } = fixture();
  const impact = report.coverage.find((entry): boolean => entry.dimension === 'reliability-impact');
  assert.ok(impact);
  impact.relatedPaths = [];
  const decision = evaluateReview(snapshot, report, previous, POLICY);
  assert.equal(decision.status, 'incomplete');
  assert.ok(decision.reasons.some((reason: string): boolean => reason.includes('tests/consumer.ts')));
});

test('dependency impact cannot be declared not applicable', (): void => {
  const { snapshot, report, previous } = fixture();
  const impact = report.coverage.find((entry): boolean => entry.dimension === 'reliability-impact');
  assert.ok(impact);
  impact.assessment = 'not_applicable';
  assert.equal(evaluateReview(snapshot, report, previous, POLICY).status, 'incomplete');
});

test('blocked or limited source/reviewer coverage is never a pass', (): void => {
  const mutations = [
    (snapshot: ReviewSnapshot, report: ReviewReport): void => { snapshot.complete = false; },
    (snapshot: ReviewSnapshot, report: ReviewReport): void => { snapshot.limitations = ['Context budget exceeded.']; },
    (snapshot: ReviewSnapshot, report: ReviewReport): void => { report.complete = false; },
    (snapshot: ReviewSnapshot, report: ReviewReport): void => { report.limitations = ['Runtime fixture wiring was unavailable.']; },
    (snapshot: ReviewSnapshot, report: ReviewReport): void => { report.coverage[0].assessment = 'blocked'; },
  ];
  for (const mutate of mutations) {
    const { snapshot, report, previous } = fixture();
    mutate(snapshot, report);
    assert.equal(evaluateReview(snapshot, report, previous, POLICY).status, 'incomplete');
  }
});

test('finding evidence must match captured lines and revision exactly', (): void => {
  for (const bad of [{ quote: 'invented evidence' }, { startLine: 99, endLine: 99 }, { path: '../outside.ts' }, { revision: 'base' as const }]) {
    const { snapshot, report, previous } = fixture();
    report.findings = [blocker()];
    Object.assign(report.findings[0].evidence[0], bad);
    assert.equal(evaluateReview(snapshot, report, previous, POLICY).status, 'incomplete');
  }
});

test('unrelated pre-existing context does not establish a PR blocker', (): void => {
  const { snapshot, report, previous } = fixture();
  report.findings = [{ ...blocker(), introducedBy: evidence('tests/consumer.ts') }];
  assert.equal(evaluateReview(snapshot, report, previous, POLICY).status, 'incomplete');
});

test('new rules cannot silently become blocking policy', (): void => {
  const { snapshot, report, previous } = fixture();
  report.findings = [{ ...blocker(), ruleId: 'novel' }];
  assert.equal(evaluateReview(snapshot, report, previous, POLICY).status, 'incomplete');
  report.findings[0].severity = 'advisory';
  assert.equal(evaluateReview(snapshot, report, previous, POLICY).status, 'pass');
  report.findings[0].ruleId = 'invented-rule';
  assert.equal(evaluateReview(snapshot, report, previous, POLICY).status, 'incomplete');
});

test('an omitted previous blocker remains open rather than vanishing on a new push', (): void => {
  const { snapshot, report, previous } = fixture();
  previous.openFindings = [blocker()];
  previous.lastHeadSha = FIRST_SHA;
  snapshot.previousHeadSha = FIRST_SHA;
  snapshot.identity.headSha = NEXT_SHA;
  snapshot.identity.runId = 'run-2';
  report.identity = structuredClone(snapshot.identity);
  const decision = evaluateReview(snapshot, report, previous, POLICY);
  assert.equal(decision.status, 'incomplete');
  assert.equal(decision.ledger.openFindings[0].id, 'F-setup');
});

test('a carried finding blocks even when its affected source did not change in the latest delta', (): void => {
  const { snapshot, report, previous } = fixture();
  previous.openFindings = [blocker()];
  previous.lastHeadSha = FIRST_SHA;
  snapshot.previousHeadSha = FIRST_SHA;
  snapshot.deltaDiff = 'diff --git a/other.ts b/other.ts\n';
  snapshot.identity.headSha = NEXT_SHA;
  snapshot.identity.runId = 'run-2';
  report.identity = structuredClone(snapshot.identity);
  report.findings = [blocker()];
  report.reconciliations = [{ findingId: 'F-setup', outcome: 'open', rationale: 'The setup mechanism is still present.', evidence: [evidence()] }];
  assert.equal(evaluateReview(snapshot, report, previous, POLICY).status, 'changes_required');
});

test('a previous finding requires code evidence to close', (): void => {
  const { snapshot, report, previous } = fixture();
  previous.openFindings = [blocker()];
  report.reconciliations = [{
    findingId: 'F-setup',
    outcome: 'fixed',
    rationale: 'The current contract was checked against the consumer.',
    evidence: [evidence()],
  }];
  const decision = evaluateReview(snapshot, report, previous, POLICY);
  assert.equal(decision.status, 'pass');
  assert.deepEqual(decision.ledger.openFindings, []);
  report.reconciliations[0].evidence = [];
  assert.equal(evaluateReview(snapshot, report, previous, POLICY).status, 'incomplete');
});

test('incomplete reviews cannot retire prior findings', (): void => {
  const { snapshot, report, previous } = fixture();
  previous.openFindings = [blocker()];
  report.reconciliations = [{ findingId: 'F-setup', outcome: 'fixed', rationale: 'Candidate fix inspected.', evidence: [evidence()] }];
  report.complete = false;
  const decision = evaluateReview(snapshot, report, previous, POLICY);
  assert.equal(decision.status, 'incomplete');
  assert.equal(decision.ledger.openFindings.length, 1);
});

test('new valid blockers are retained even when unrelated coverage is incomplete', (): void => {
  const { snapshot, report, previous } = fixture();
  report.findings = [blocker()];
  report.complete = false;
  const decision = evaluateReview(snapshot, report, previous, POLICY);
  assert.equal(decision.status, 'incomplete');
  assert.equal(decision.ledger.openFindings.length, 1);
  assert.equal(decision.ledger.lastHeadSha, null);
});

test('reconciliation cannot downgrade a blocker or change its rule', (): void => {
  const { snapshot, report, previous } = fixture();
  previous.openFindings = [blocker()];
  report.findings = [{ ...blocker(), severity: 'advisory' }];
  report.reconciliations = [{ findingId: 'F-setup', outcome: 'open', rationale: 'Still present.', evidence: [evidence()] }];
  assert.equal(evaluateReview(snapshot, report, previous, POLICY).status, 'incomplete');
});

test('omitting reconciliation cannot persist a downgraded blocker for the next run', (): void => {
  for (const mutation of [{ severity: 'advisory' as const }, { ruleId: 'SR-001' }]) {
    const { snapshot, report, previous } = fixture();
    previous.openFindings = [blocker()];
    report.complete = false;
    report.findings = [{ ...blocker(), ...mutation }];
    const decision = evaluateReview(snapshot, report, previous, POLICY);
    assert.equal(decision.status, 'incomplete');
    assert.deepEqual(decision.ledger, previous);
    assert.equal(decision.ledger.openFindings[0].severity, 'blocker');
    assert.equal(decision.ledger.openFindings[0].ruleId, 'SR-002');
  }
});

test('resolved and open copies of the same finding conflict', (): void => {
  const { snapshot, report, previous } = fixture();
  previous.openFindings = [blocker()];
  report.findings = [blocker()];
  report.reconciliations = [{ findingId: 'F-setup', outcome: 'fixed', rationale: 'Claimed fixed.', evidence: [evidence()] }];
  assert.equal(evaluateReview(snapshot, report, previous, POLICY).status, 'incomplete');
});

test('stale prior-state snapshots cannot overwrite newer review state', (): void => {
  const { snapshot, report, previous } = fixture();
  previous.lastHeadSha = NEXT_SHA;
  previous.openFindings = [blocker()];
  const decision = evaluateReview(snapshot, report, previous, POLICY);
  assert.equal(decision.status, 'incomplete');
  assert.deepEqual(decision.ledger, previous);
});

test('deleted files require captured before source and can establish deletion regressions', (): void => {
  const { snapshot, report, previous } = fixture();
  snapshot.changes[0].status = 'deleted';
  snapshot.files = snapshot.files.filter((file): boolean => file.path !== 'src/action.ts' || file.revision === 'base');
  report.findings = [{ ...blocker(), introducedBy: evidence('src/action.ts', 'base'), evidence: [evidence('src/action.ts', 'base')] }];
  assert.equal(evaluateReview(snapshot, report, previous, POLICY).status, 'changes_required');
  snapshot.files = snapshot.files.filter((file): boolean => file.path !== 'src/action.ts');
  assert.equal(evaluateReview(snapshot, report, previous, POLICY).status, 'incomplete');
});

test('duplicate IDs and unavailable claimed context are rejected', (): void => {
  const { snapshot, report, previous } = fixture();
  report.findings = [blocker(), blocker()];
  assert.equal(evaluateReview(snapshot, report, previous, POLICY).status, 'incomplete');
  report.findings = [];
  report.coverage[0].relatedPaths.push('missing.ts');
  assert.equal(evaluateReview(snapshot, report, previous, POLICY).status, 'incomplete');
});

test('gate evaluation does not mutate report or previous findings', (): void => {
  const { snapshot, report, previous } = fixture();
  previous.openFindings = [blocker()];
  const before = structuredClone({ snapshot, report, previous });
  evaluateReview(snapshot, report, previous, POLICY);
  assert.deepEqual({ snapshot, report, previous }, before);
});
