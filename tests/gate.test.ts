import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DIMENSIONS } from '../src/contracts.ts';
import type { Evidence, Finding, ReviewLedger, ReviewPolicy, ReviewReport, ReviewSnapshot } from '../src/contracts.ts';
import { evaluateReview, evaluateSingleReview } from '../src/gate.ts';
import type { FixedEvidenceOutsideScope, ResolvedBlockerOverlap } from '../src/gate.ts';

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
    size: { changedLines: 2, blockChangedLines: 1500 },
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
    { changedLines: 1501, blockChangedLines: 1500 },
    { changedLines: 1500, blockChangedLines: 900 },
    { changedLines: 2, blockChangedLines: 0 },
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

test('advisory and uncertain questions need attention without becoming blockers', (): void => {
  for (const severity of ['advisory', 'question'] as const) {
    const { snapshot, report, previous } = fixture();
    report.findings = [{ ...blocker(), severity }];
    const decision = evaluateReview(snapshot, report, previous, POLICY);
    assert.equal(decision.status, 'needs_attention');
    assert.deepEqual(decision.reasons, ['1 open item(s) need a reviewer decision']);
  }
});

test('pass means nothing is open: blocker, open item, and clean verdicts are distinct', (): void => {
  const blockerRun = fixture();
  blockerRun.report.findings = [blocker()];
  assert.equal(evaluateReview(blockerRun.snapshot, blockerRun.report, blockerRun.previous, POLICY).status, 'changes_required');
  const attentionRun = fixture();
  attentionRun.report.findings = [{ ...blocker(), id: 'F-note', ruleId: 'SR-004', severity: 'question' }];
  assert.equal(evaluateReview(attentionRun.snapshot, attentionRun.report, attentionRun.previous, POLICY).status, 'needs_attention');
  const cleanRun = fixture();
  cleanRun.report.findings = [];
  assert.equal(evaluateReview(cleanRun.snapshot, cleanRun.report, cleanRun.previous, POLICY).status, 'pass');
});

test('an unverified-only report is needs_attention, never a clean pass', (): void => {
  const { snapshot, report, previous } = fixture();
  report.findings = [blocker()];
  report.findings[0].evidence[0].quote = 'invented evidence';
  const decision = evaluateReview(snapshot, report, previous, POLICY);
  assert.equal(decision.status, 'needs_attention');
  assert.deepEqual(decision.reasons, ['1 finding(s) could not be verified and were excluded from the verdict']);
  assert.equal(decision.ledger.openFindings.length, 0);
  assert.equal(decision.unverifiedFindings?.length, 1);
});

test('a dropped re-citation counts once, as the still-open item, not also as excluded', (): void => {
  const { snapshot, report, previous } = priorFixture();
  previous.openFindings = [{ ...blocker(), severity: 'advisory' }];
  report.findings = [{
    ...blocker(), severity: 'advisory',
    evidence: [{ path: 'src/action.ts', revision: 'head', startLine: 1, endLine: 1, quote: 'invented quote' }],
  }];
  report.reconciliations = [{ findingId: 'F-setup', outcome: 'open', rationale: 'Still applies.', evidence: [evidence()] }];
  const decision = evaluateReview(snapshot, report, previous, POLICY);
  assert.equal(decision.status, 'needs_attention');
  assert.deepEqual(decision.reasons, ['1 open item(s) need a reviewer decision']);
  assert.equal(decision.ledger.openFindings.length, 1);
  assert.equal(decision.unverifiedFindings?.length, 1, 'the failed re-citation stays audit-visible');
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

test('a finding whose evidence cannot be verified is dropped, never the verdict', (): void => {
  for (const bad of [{ quote: 'invented evidence' }, { revision: 'base' as const }]) {
    const { snapshot, report, previous } = fixture();
    report.findings = [blocker()];
    Object.assign(report.findings[0].evidence[0], bad);
    const decision = evaluateReview(snapshot, report, previous, POLICY);
    // An unverified finding never enters the ledger or blocks, but it still
    // publishes as a pending item, so the verdict is needs_attention not pass.
    assert.equal(decision.status, 'needs_attention');
    assert.equal(decision.ledger.openFindings.length, 0, 'an unverified blocker never enters the ledger');
    assert.equal(decision.unverifiedFindings?.length, 1);
    assert.equal(decision.unverifiedFindings?.[0].finding.id, 'F-setup');
    assert.equal(decision.unverifiedFindings?.[0].reason, 'quote does not appear in the cited source');
  }
  // Evidence that is malformed rather than unverifiable still rejects the report.
  const { snapshot, report, previous } = fixture();
  report.findings = [blocker()];
  Object.assign(report.findings[0].evidence[0], { path: '../outside.ts' });
  assert.equal(evaluateReview(snapshot, report, previous, POLICY).status, 'incomplete');
});

test('a drifted citation re-anchors to its unique match in the same file and revision', (): void => {
  const { snapshot, report, previous } = fixture();
  report.findings = [blocker()];
  report.findings[0].evidence[0].startLine = 99;
  report.findings[0].evidence[0].endLine = 99;
  const decision = evaluateReview(snapshot, report, previous, POLICY);
  assert.equal(decision.status, 'changes_required');
  assert.deepEqual(decision.citationAdjustments, [{
    kind: 'finding',
    findingId: 'F-setup',
    path: 'src/action.ts',
    revision: 'head',
    from: { startLine: 99, endLine: 99 },
    to: { startLine: 1, endLine: 1 },
  }]);
  // The input report is never mutated; the ledger carries the corrected range.
  assert.equal(report.findings[0].evidence[0].startLine, 99);
  assert.equal(decision.ledger.openFindings[0].evidence[0].startLine, 1);
});

test('a multi-line quote re-anchors to its unique match one line up', (): void => {
  const { snapshot, report, previous } = fixture();
  snapshot.files[1].content = 'export const a = 1;\nexport const required = false;\nexport const b = 2;\n';
  report.findings = [blocker()];
  const item = report.findings[0].evidence[0];
  item.startLine = 3;
  item.endLine = 4;
  item.quote = 'export const required = false;\nexport const b = 2;';
  const decision = evaluateReview(snapshot, report, previous, POLICY);
  assert.equal(decision.status, 'changes_required');
  // introducedBy drifted to line 2 as well; both pieces record their re-anchor.
  assert.deepEqual(decision.citationAdjustments, [
    {
      kind: 'finding',
      findingId: 'F-setup',
      path: 'src/action.ts',
      revision: 'head',
      from: { startLine: 1, endLine: 1 },
      to: { startLine: 2, endLine: 2 },
    },
    {
      kind: 'finding',
      findingId: 'F-setup',
      path: 'src/action.ts',
      revision: 'head',
      from: { startLine: 3, endLine: 4 },
      to: { startLine: 2, endLine: 3 },
    },
  ]);
});

test('an ambiguous or empty-match quote is dropped, never guessed', (): void => {
  const { snapshot, report, previous } = fixture();
  snapshot.files[2].content = 'export const required = false;\nexport const required = false;\n';
  report.findings = [blocker()];
  const item = report.findings[0].evidence[1];
  item.startLine = 3;
  item.endLine = 3;
  const decision = evaluateReview(snapshot, report, previous, POLICY);
  assert.equal(decision.status, 'needs_attention');
  assert.equal(decision.unverifiedFindings?.[0].reason, 'quote matches multiple locations in the cited source');
});

test('reconciliation evidence re-anchors but resolutions stay fail-closed on unverifiable quotes', (): void => {
  const { snapshot, report, previous } = fixture();
  previous.openFindings = [blocker()];
  previous.lastHeadSha = FIRST_SHA;
  snapshot.previousHeadSha = FIRST_SHA;
  snapshot.identity.headSha = NEXT_SHA;
  snapshot.identity.runId = 'run-2';
  report.identity = structuredClone(snapshot.identity);
  report.findings = [blocker()];
  report.reconciliations = [{
    findingId: 'F-setup',
    outcome: 'open',
    rationale: 'Still applies at the new head.',
    evidence: [{ path: 'src/action.ts', revision: 'head', startLine: 99, endLine: 99, quote: 'export const required = false;' }],
  }];
  const decision = evaluateReview(snapshot, report, previous, POLICY);
  assert.equal(decision.status, 'changes_required');
  assert.equal(decision.citationAdjustments?.[0].kind, 'reconciliation');
  const { snapshot: s2, report: r2, previous: p2 } = fixture();
  p2.openFindings = [blocker()];
  p2.lastHeadSha = FIRST_SHA;
  s2.previousHeadSha = FIRST_SHA;
  s2.identity.headSha = NEXT_SHA;
  s2.identity.runId = 'run-2';
  r2.identity = structuredClone(s2.identity);
  r2.findings = [blocker()];
  r2.reconciliations = [{
    findingId: 'F-setup',
    outcome: 'withdrawn',
    rationale: 'No longer applies at the new head.',
    evidence: [{ path: 'src/action.ts', revision: 'head', startLine: 1, endLine: 1, quote: 'invented quote' }],
  }];
  const failed = evaluateReview(s2, r2, p2, POLICY);
  assert.equal(failed.status, 'incomplete');
  assert.match(failed.reasons.join(' '), /unavailable code evidence/);
});

test('unverifiable still-open support evidence is recorded, not fatal', (): void => {
  const { snapshot, report, previous } = fixture();
  previous.openFindings = [blocker()];
  previous.lastHeadSha = FIRST_SHA;
  snapshot.previousHeadSha = FIRST_SHA;
  snapshot.identity.headSha = NEXT_SHA;
  snapshot.identity.runId = 'run-2';
  report.identity = structuredClone(snapshot.identity);
  report.findings = [blocker()];
  report.reconciliations = [{
    findingId: 'F-setup',
    outcome: 'open',
    rationale: 'Still applies at the new head.',
    evidence: [{ path: 'src/action.ts', revision: 'head', startLine: 1, endLine: 1, quote: 'invented quote' }],
  }];
  const decision = evaluateReview(snapshot, report, previous, POLICY);
  // 'open' asserts only what the default already is: the prior stays open on
  // its original record whether or not the support evidence verifies.
  assert.equal(decision.status, 'changes_required');
  assert.equal(decision.unverifiedFindings?.length, 1);
  assert.equal(decision.unverifiedFindings?.[0].finding.id, 'F-setup');
  assert.match(decision.unverifiedFindings?.[0].reason ?? '', /still-open reconciliation evidence/);
});

test('an unverified finding cannot stand in for a prior blocker reconciliation', (): void => {
  const { snapshot, report, previous } = fixture();
  previous.openFindings = [blocker()];
  previous.lastHeadSha = FIRST_SHA;
  snapshot.previousHeadSha = FIRST_SHA;
  snapshot.identity.headSha = NEXT_SHA;
  snapshot.identity.runId = 'run-2';
  report.identity = structuredClone(snapshot.identity);
  report.findings = [blocker()];
  report.findings[0].evidence[0].quote = 'invented evidence';
  report.reconciliations = [{
    findingId: 'F-setup',
    outcome: 'open',
    rationale: 'Still open.',
    evidence: [evidence()],
  }];
  const decision = evaluateReview(snapshot, report, previous, POLICY);
  assert.equal(decision.status, 'changes_required', 'the dropped re-citation cannot clear the still-open prior blocker');
  assert.equal(decision.unverifiedFindings?.length, 1);
});

test('finding evidence tolerates dropped leading whitespace but rejects content drift', (): void => {
  const { snapshot, report, previous } = fixture();
  report.findings = [blocker()];
  // Model-copied code commonly loses leading indentation; content still must match.
  report.findings[0].evidence[0] = { path: 'src/action.ts', revision: 'head', startLine: 1, endLine: 1, quote: 'export const required = false;' };
  assert.notEqual(evaluateReview(snapshot, report, previous, POLICY).status, 'incomplete');
  const { snapshot: s2, report: r2, previous: p2 } = fixture();
  r2.findings = [blocker()];
  r2.findings[0].evidence[0].quote = 'export const required = true;';
  const drifted = evaluateReview(s2, r2, p2, POLICY);
  assert.equal(drifted.status, 'needs_attention');
  assert.equal(drifted.unverifiedFindings?.length, 1);
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
  assert.equal(evaluateReview(snapshot, report, previous, POLICY).status, 'needs_attention');
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

const PRIOR_SHA = 'e'.repeat(40);

// A previous review exists, so the snapshot carries a real previous-head
// delta: one line in src/action.ts changed between the prior head and this one.
function priorFixture(): { snapshot: ReviewSnapshot; report: ReviewReport; previous: ReviewLedger } {
  const { snapshot, report, previous } = fixture();
  previous.openFindings = [blocker()];
  previous.lastHeadSha = PRIOR_SHA;
  snapshot.previousHeadSha = PRIOR_SHA;
  snapshot.deltaDiff = [
    'diff --git a/src/action.ts b/src/action.ts',
    '--- a/src/action.ts',
    '+++ b/src/action.ts',
    '@@ -1,1 +1,1 @@',
    '-export const required = true;',
    '+export const required = false;',
    '',
  ].join('\n');
  return { snapshot, report, previous };
}

test('a previous finding requires code evidence to close', (): void => {
  const { snapshot, report, previous } = priorFixture();
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

test('a withdrawal citing code outside the finding cannot retire a blocker', (): void => {
  const { snapshot, report, previous } = fixture();
  previous.openFindings = [blocker()];
  snapshot.changes.push({ path: 'src/other.ts', status: 'modified' });
  snapshot.files.push(
    { path: 'src/other.ts', revision: 'base', content: 'export const other = 1;\n' },
    { path: 'src/other.ts', revision: 'head', content: 'export const other = 2;\n' },
  );
  report.coverage.push(...DIMENSIONS.map((dimension) => ({
    path: 'src/other.ts', dimension, assessment: 'reviewed' as const, rationale: 'Reviewed.', relatedPaths: [],
  })));
  report.reconciliations = [{
    findingId: 'F-setup', outcome: 'withdrawn', rationale: 'Claimed obsolete.',
    evidence: [{ path: 'src/other.ts', revision: 'head', startLine: 1, endLine: 1, quote: 'export const other = 2;' }],
  }];
  const decision = evaluateReview(snapshot, report, previous, POLICY);
  assert.equal(decision.status, 'incomplete');
  assert.match(decision.reasons[0], /withdraws it without evidence on the finding's code/);
  assert.equal(decision.ledger.openFindings[0].id, 'F-setup');
});

// Known gap until a later batch binds author /sentinel recheck replies: a
// withdrawal citing any line in the finding's file is still accepted.
test('a withdrawal citing the finding file is still accepted (known gap until recheck)', (): void => {
  const { snapshot, report, previous } = fixture();
  previous.openFindings = [blocker()];
  report.reconciliations = [{ findingId: 'F-setup', outcome: 'withdrawn', rationale: 'Acceptable design.', evidence: [evidence()] }];
  assert.equal(evaluateReview(snapshot, report, previous, POLICY).status, 'pass');
});

test('a fixed outcome requires a previous-head delta', (): void => {
  const { snapshot, report, previous } = fixture();
  previous.openFindings = [blocker()];
  report.reconciliations = [{ findingId: 'F-setup', outcome: 'fixed', rationale: 'Claimed fixed.', evidence: [evidence()] }];
  const decision = evaluateReview(snapshot, report, previous, POLICY);
  assert.equal(decision.status, 'incomplete');
  assert.match(decision.reasons[0], /marks it fixed but no previous-head delta exists/);
});

test('a fix requires evidence on lines changed since the last reviewed head', (): void => {
  const { snapshot, report, previous } = priorFixture();
  snapshot.deltaDiff = [
    'diff --git a/src/action.ts b/src/action.ts',
    '--- a/src/action.ts',
    '+++ b/src/action.ts',
    '@@ -2,1 +2,1 @@',
    '-old',
    '+new',
    '',
  ].join('\n');
  report.reconciliations = [{
    findingId: 'F-setup', outcome: 'fixed', rationale: 'Claimed fixed.',
    evidence: [evidence()],
  }];
  const decision = evaluateReview(snapshot, report, previous, POLICY);
  assert.equal(decision.status, 'incomplete');
  assert.match(decision.reasons[0], /marks it fixed without evidence on lines changed since the last reviewed head/);
});

test('a fix citing a delta-changed line in the finding file is accepted', (): void => {
  const { snapshot, report, previous } = priorFixture();
  report.reconciliations = [{ findingId: 'F-setup', outcome: 'fixed', rationale: 'Repaired.', evidence: [evidence()] }];
  assert.equal(evaluateReview(snapshot, report, previous, POLICY).status, 'pass');
});

test('a fix may cite a changed helper line plus binding evidence on the finding file', (): void => {
  const { snapshot, report, previous } = priorFixture();
  snapshot.deltaDiff += [
    'diff --git a/src/helper.ts b/src/helper.ts',
    '--- a/src/helper.ts',
    '+++ b/src/helper.ts',
    '@@ -1,1 +1,1 @@',
    '-export const helper = 1;',
    '+export const helper = 2;',
    '',
  ].join('\n');
  snapshot.files.push({ path: 'src/helper.ts', revision: 'head', content: 'export const helper = 2;\n' });
  report.reconciliations = [{
    findingId: 'F-setup', outcome: 'fixed', rationale: 'The mechanism moved into the helper.',
    evidence: [{ path: 'src/helper.ts', revision: 'head', startLine: 1, endLine: 1, quote: 'export const helper = 2;' }, evidence()],
  }];
  assert.equal(evaluateReview(snapshot, report, previous, POLICY).status, 'pass');
});

test('a fix citing only changed helper lines cannot clear the finding', (): void => {
  const { snapshot, report, previous } = priorFixture();
  snapshot.deltaDiff += [
    'diff --git a/src/helper.ts b/src/helper.ts',
    '--- a/src/helper.ts',
    '+++ b/src/helper.ts',
    '@@ -1,1 +1,1 @@',
    '-export const helper = 1;',
    '+export const helper = 2;',
    '',
  ].join('\n');
  snapshot.files.push({ path: 'src/helper.ts', revision: 'head', content: 'export const helper = 2;\n' });
  report.reconciliations = [{
    findingId: 'F-setup', outcome: 'fixed', rationale: 'Fixed elsewhere.',
    evidence: [{ path: 'src/helper.ts', revision: 'head', startLine: 1, endLine: 1, quote: 'export const helper = 2;' }],
  }];
  const decision = evaluateReview(snapshot, report, previous, POLICY);
  assert.equal(decision.status, 'incomplete');
  assert.match(decision.reasons[0], /marks it fixed without evidence on the finding's code/);
});

test('a fix after a deletion-only change accepts the adjacent head line', (): void => {
  const { snapshot, report, previous } = priorFixture();
  snapshot.deltaDiff = [
    'diff --git a/src/action.ts b/src/action.ts',
    '--- a/src/action.ts',
    '+++ b/src/action.ts',
    '@@ -1,3 +1,1 @@',
    ' export const required = false;',
    '-export const extra1 = 1;',
    '-export const extra2 = 2;',
    '',
  ].join('\n');
  report.reconciliations = [{
    findingId: 'F-setup', outcome: 'fixed', rationale: 'The bypass path was deleted.',
    evidence: [evidence()],
  }];
  assert.equal(evaluateReview(snapshot, report, previous, POLICY).status, 'pass');
});

test('a fix on a file deleted in the delta accepts base evidence on that path', (): void => {
  const { snapshot, report, previous } = priorFixture();
  snapshot.changes[0].status = 'deleted';
  snapshot.files = snapshot.files.filter((file) => file.path !== 'src/action.ts' || file.revision === 'base');
  snapshot.deltaDiff = [
    'diff --git a/src/action.ts b/src/action.ts',
    '--- a/src/action.ts',
    '+++ /dev/null',
    '@@ -1,1 +0,0 @@',
    '-export const required = true;',
    '',
  ].join('\n');
  report.reconciliations = [{
    findingId: 'F-setup', outcome: 'fixed', rationale: 'The offending file was removed.',
    evidence: [evidence('src/action.ts', 'base')],
  }];
  const decision = evaluateReview(snapshot, report, previous, POLICY);
  assert.equal(decision.status, 'pass', decision.reasons.join('\n'));
  assert.deepEqual(decision.ledger.openFindings, []);
});

test('a fix on a renamed file accepts head evidence on the new path', (): void => {
  const { snapshot, report, previous } = priorFixture();
  snapshot.changes[0] = { path: 'src/new-action.ts', status: 'renamed', previousPath: 'src/action.ts' };
  const head = snapshot.files.find((file) => file.path === 'src/action.ts' && file.revision === 'head');
  assert.ok(head);
  head.path = 'src/new-action.ts';
  snapshot.deltaDiff = [
    'diff --git a/src/action.ts b/src/new-action.ts',
    '--- a/src/action.ts',
    '+++ b/src/new-action.ts',
    '@@ -1,1 +1,1 @@',
    '-export const required = true;',
    '+export const required = false;',
    '',
  ].join('\n');
  for (const entry of report.coverage) entry.path = 'src/new-action.ts';
  report.reconciliations = [{
    findingId: 'F-setup', outcome: 'fixed', rationale: 'The mechanism moved and was repaired.',
    evidence: [evidence('src/new-action.ts')],
  }];
  const decision = evaluateReview(snapshot, report, previous, POLICY);
  assert.equal(decision.status, 'pass', decision.reasons.join('\n'));
});

test('a withdrawn blocker cannot reappear under any rule at a matching or nearby site', (): void => {
  const { snapshot, report, previous } = priorFixture();
  report.findings = [{ ...blocker(), id: 'F-new', ruleId: 'novel', severity: 'advisory' }];
  report.reconciliations = [{ findingId: 'F-setup', outcome: 'withdrawn', rationale: 'Withdrawn.', evidence: [evidence()] }];
  const decision = evaluateReview(snapshot, report, previous, POLICY);
  assert.equal(decision.status, 'incomplete');
  assert.match(decision.reasons[0], /re-raises withdrawn blocker ".*" at lower severity/);
  assert.equal(decision.ledger.openFindings[0].severity, 'blocker');
});

test('a withdrawn blocker re-raised within ten shifted lines is refused', (): void => {
  const { snapshot, report, previous } = priorFixture();
  const headFile = snapshot.files.find((file) => file.path === 'src/action.ts' && file.revision === 'head');
  assert.ok(headFile);
  headFile.content = `${['export const required = false;', ...Array.from({ length: 29 }, (_v, i) => `export const filler${i + 2} = ${i + 2};`)].join('\n')}\n`;
  // Fourteen inserted lines push the prior line-1 citation to line 15.
  snapshot.deltaDiff = [
    'diff --git a/src/action.ts b/src/action.ts',
    '--- a/src/action.ts',
    '+++ b/src/action.ts',
    '@@ -0,0 +1,14 @@',
    ...Array.from({ length: 14 }, (_v, i) => `+export const filler${i + 2} = ${i + 2};`),
    '',
  ].join('\n');
  report.findings = [{
    ...blocker(), id: 'F-new', ruleId: 'SR-004', severity: 'advisory',
    introducedBy: { path: 'src/action.ts', revision: 'head', startLine: 20, endLine: 20, quote: 'export const filler20 = 20;' },
    evidence: [{ path: 'src/action.ts', revision: 'head', startLine: 20, endLine: 20, quote: 'export const filler20 = 20;' }],
  }];
  report.reconciliations = [{ findingId: 'F-setup', outcome: 'withdrawn', rationale: 'Withdrawn.', evidence: [evidence()] }];
  const decision = evaluateReview(snapshot, report, previous, POLICY);
  assert.equal(decision.status, 'incomplete');
  assert.match(decision.reasons[0], /re-raises withdrawn blocker/);

  const { snapshot: s2, report: r2, previous: p2 } = priorFixture();
  const head2 = s2.files.find((file) => file.path === 'src/action.ts' && file.revision === 'head');
  assert.ok(head2);
  head2.content = headFile.content;
  s2.deltaDiff = snapshot.deltaDiff;
  r2.findings = [{
    ...blocker(), id: 'F-new', ruleId: 'SR-004', severity: 'advisory',
    introducedBy: { path: 'src/action.ts', revision: 'head', startLine: 27, endLine: 27, quote: 'export const filler27 = 27;' },
    evidence: [{ path: 'src/action.ts', revision: 'head', startLine: 27, endLine: 27, quote: 'export const filler27 = 27;' }],
  }];
  r2.reconciliations = [{ findingId: 'F-setup', outcome: 'withdrawn', rationale: 'Withdrawn.', evidence: [evidence()] }];
  assert.equal(evaluateReview(s2, r2, p2, POLICY).status, 'needs_attention');
});

test('a resolved blocker cannot be re-raised under a new id at lower severity', (): void => {
  for (const outcome of ['fixed', 'withdrawn'] as const) {
    const { snapshot, report, previous } = priorFixture();
    report.findings = [{ ...blocker(), id: 'F-new', severity: 'advisory' }];
    report.reconciliations = [{ findingId: 'F-setup', outcome, rationale: 'Resolved.', evidence: [evidence()] }];
    const decision = evaluateReview(snapshot, report, previous, POLICY);
    assert.equal(decision.status, 'incomplete', outcome);
    assert.match(decision.reasons[0], outcome === 'fixed' ? /overlaps resolved blocker ".*" and cannot lower its severity/ : /re-raises withdrawn blocker ".*" at lower severity/, outcome);
    assert.equal(decision.ledger.openFindings[0].severity, 'blocker');
  }
});

test('a fresh blocker on the same mechanism is allowed after a fix', (): void => {
  const { snapshot, report, previous } = priorFixture();
  report.findings = [{ ...blocker(), id: 'F-new' }];
  report.reconciliations = [{ findingId: 'F-setup', outcome: 'fixed', rationale: 'The original defect was repaired.', evidence: [evidence()] }];
  const decision = evaluateReview(snapshot, report, previous, POLICY);
  assert.equal(decision.status, 'changes_required');
  assert.equal(decision.ledger.openFindings[0].id, 'F-new');
});

test('an allowed different-rule overlap after a fix is recorded as a resolution observation', (): void => {
  for (const variant of ['near', 'quote'] as const) {
    const { snapshot, report, previous } = priorFixture();
    const advisory = { ...blocker(), id: 'F-new', ruleId: 'SR-004', severity: 'advisory' as const };
    if (variant === 'near') {
      const headFile = snapshot.files.find((file) => file.path === 'src/action.ts' && file.revision === 'head');
      assert.ok(headFile);
      headFile.content = `export const required = false;\n${Array.from({ length: 8 }, (_v, i) => `export const filler${i + 2} = ${i + 2};`).join('\n')}\n`;
      advisory.introducedBy = { path: 'src/action.ts', revision: 'head', startLine: 6, endLine: 6, quote: 'export const filler6 = 6;' };
      advisory.evidence = [advisory.introducedBy];
    }
    report.findings = [advisory];
    report.reconciliations = [{ findingId: 'F-setup', outcome: 'fixed', rationale: 'Repaired.', evidence: [evidence()] }];
    const observations = { allowedFixedBlockerOverlaps: [] as ResolvedBlockerOverlap[], fixedEvidenceOutsideScope: [] as FixedEvidenceOutsideScope[] };
    const decision = evaluateSingleReview(snapshot, report, previous, POLICY, observations);
    assert.equal(decision.status, 'needs_attention', `${variant}: ${decision.reasons.join('\n')}`);
    assert.equal(observations.allowedFixedBlockerOverlaps.length, 1, variant);
    assert.equal(observations.allowedFixedBlockerOverlaps[0].match, variant);
    assert.equal(observations.allowedFixedBlockerOverlaps[0].priorFindingId, 'F-setup');
    assert.equal(observations.allowedFixedBlockerOverlaps[0].findingId, 'F-new');
  }
});

test('a same-rule advisory overlapping a fixed blocker after shifting is refused', (): void => {
  const { snapshot, report, previous } = priorFixture();
  const headFile = snapshot.files.find((file) => file.path === 'src/action.ts' && file.revision === 'head');
  assert.ok(headFile);
  headFile.content = `${['export const required = false;', ...Array.from({ length: 29 }, (_v, i) => `export const filler${i + 2} = ${i + 2};`)].join('\n')}\n`;
  snapshot.deltaDiff = [
    'diff --git a/src/action.ts b/src/action.ts',
    '--- a/src/action.ts',
    '+++ b/src/action.ts',
    '@@ -0,0 +1,14 @@',
    ...Array.from({ length: 14 }, (_v, i) => `+export const filler${i + 2} = ${i + 2};`),
    '',
  ].join('\n');
  report.findings = [{
    ...blocker(), id: 'F-new', severity: 'advisory',
    introducedBy: { path: 'src/action.ts', revision: 'head', startLine: 15, endLine: 15, quote: 'export const filler15 = 15;' },
    evidence: [{ path: 'src/action.ts', revision: 'head', startLine: 15, endLine: 15, quote: 'export const filler15 = 15;' }],
  }];
  report.reconciliations = [{ findingId: 'F-setup', outcome: 'fixed', rationale: 'Repaired.', evidence: [evidence()] }];
  const decision = evaluateReview(snapshot, report, previous, POLICY);
  assert.equal(decision.status, 'incomplete');
  assert.match(decision.reasons[0], /overlaps resolved blocker ".*" and cannot lower its severity/);
});

test('changed-line evidence outside the finding scope is accepted and logged', (): void => {
  const { snapshot, report, previous } = priorFixture();
  snapshot.deltaDiff += [
    'diff --git a/src/unrelated.ts b/src/unrelated.ts',
    '--- a/src/unrelated.ts',
    '+++ b/src/unrelated.ts',
    '@@ -1,1 +1,1 @@',
    '-export const u = 1;',
    '+export const u = 2;',
    '',
  ].join('\n');
  snapshot.files.push({ path: 'src/unrelated.ts', revision: 'head', content: 'export const u = 2;\n' });
  report.reconciliations = [{
    findingId: 'F-setup', outcome: 'fixed', rationale: 'The mechanism moved to an unrelated file.',
    evidence: [{ path: 'src/unrelated.ts', revision: 'head', startLine: 1, endLine: 1, quote: 'export const u = 2;' }, evidence('tests/consumer.ts')],
  }];
  const observations = { allowedFixedBlockerOverlaps: [] as ResolvedBlockerOverlap[], fixedEvidenceOutsideScope: [] as FixedEvidenceOutsideScope[] };
  const decision = evaluateSingleReview(snapshot, report, previous, POLICY, observations);
  assert.equal(decision.status, 'pass', decision.reasons.join('\n'));
  assert.equal(observations.fixedEvidenceOutsideScope.length, 1);
  assert.equal(observations.fixedEvidenceOutsideScope[0].priorFindingId, 'F-setup');
  assert.deepEqual(observations.fixedEvidenceOutsideScope[0].changedEvidence, [
    { path: 'src/unrelated.ts', revision: 'head', startLine: 1, endLine: 1 },
  ]);
});

test('changed-line evidence in a dependency neighbor or the finding file is not logged', (): void => {
  for (const path of ['tests/consumer.ts', 'src/action.ts'] as const) {
    const { snapshot, report, previous } = priorFixture();
    if (path === 'tests/consumer.ts') {
      snapshot.deltaDiff += [
        'diff --git a/tests/consumer.ts b/tests/consumer.ts',
        '--- a/tests/consumer.ts',
        '+++ b/tests/consumer.ts',
        '@@ -1,1 +1,1 @@',
        '-export const required = true;',
        '+export const required = false;',
        '',
      ].join('\n');
    }
    report.reconciliations = [{
      findingId: 'F-setup', outcome: 'fixed', rationale: 'Repaired.',
      evidence: [evidence(path)],
    }];
    const observations = { allowedFixedBlockerOverlaps: [] as ResolvedBlockerOverlap[], fixedEvidenceOutsideScope: [] as FixedEvidenceOutsideScope[] };
    const decision = evaluateSingleReview(snapshot, report, previous, POLICY, observations);
    assert.equal(decision.status, 'pass', `${path}: ${decision.reasons.join('\n')}`);
    assert.deepEqual(observations.fixedEvidenceOutsideScope, [], path);
  }
});
