import assert from 'node:assert/strict';
import test from 'node:test';
import { DIMENSIONS } from '../src/contracts.ts';
import type { Coverage, ReviewLedger, ReviewPolicy, ReviewReport, ReviewSnapshot } from '../src/contracts.ts';
import { evaluateReview } from '../src/gate.ts';
import { loadTestPolicy, makeReport, makeSnapshotFixture } from './helpers.ts';

const ACTION = 'src/action.ts';
const CALLER = 'tests/consumer.ts';
const CONFIG = 'src/config.ts';

function fixture(): {
  snapshot: ReviewSnapshot;
  report: ReviewReport;
  previous: ReviewLedger;
  policy: ReviewPolicy;
} {
  const loaded = loadTestPolicy();
  const snapshot = makeSnapshotFixture(loaded);
  snapshot.changes.push({ path: CALLER, status: 'added' });
  snapshot.files.push({ path: CONFIG, revision: 'head', content: 'export const configured = true;\n' });
  snapshot.dependencyEdges.push({ from: ACTION, to: CONFIG });
  const report = makeReport(snapshot);
  impact(report, ACTION).relatedPaths = [CONFIG];
  const previous: ReviewLedger = {
    schemaVersion: 1,
    repository: snapshot.identity.repository,
    pullRequest: snapshot.identity.pullRequest,
    lastHeadSha: null,
    openFindings: [],
  };
  return { snapshot, report, previous, policy: loaded.policy };
}

function impact(report: ReviewReport, sourcePath: string): Coverage {
  const entry = report.coverage.find((item): boolean =>
    item.path === sourcePath && item.dimension === 'reliability-impact');
  assert.ok(entry);
  return entry;
}

function rename(snapshot: ReviewSnapshot, report: ReviewReport, before: string, after: string): void {
  const change = snapshot.changes.find((item): boolean => item.path === before);
  assert.ok(change);
  if (change.status === 'added') {
    snapshot.files.push({ path: before, revision: 'base', content: 'export const required = true;\n' });
  }
  change.path = after;
  change.status = 'renamed';
  change.previousPath = before;
  for (const file of snapshot.files) {
    if (file.path === before && file.revision === 'head') file.path = after;
  }
  for (const entry of report.coverage) {
    if (entry.path === before) entry.path = after;
  }
}

test('changed-file relationship acknowledged from either endpoint permits a clean review', (): void => {
  for (const acknowledgingPath of [ACTION, CALLER]) {
    const { snapshot, report, previous, policy } = fixture();
    if (acknowledgingPath === ACTION) {
      impact(report, ACTION).relatedPaths.push(CALLER);
      impact(report, CALLER).relatedPaths = [];
    }
    const before = structuredClone({ snapshot, report, previous });
    const decision = evaluateReview(snapshot, report, previous, policy);
    assert.equal(decision.status, 'pass', acknowledgingPath);
    assert.deepEqual(decision.reasons, []);
    assert.equal(decision.ledger.lastHeadSha, snapshot.identity.headSha);
    assert.deepEqual({ snapshot, report, previous }, before);
  }
});

test('A1-shaped gate decision returns changes_required with the verified blocker retained', (): void => {
  const { snapshot, report, previous, policy } = fixture();
  const source = snapshot.files.find((file): boolean => file.path === CALLER && file.revision === 'head');
  assert.ok(source);
  const evidence = { path: CALLER, revision: 'head' as const, startLine: 1, endLine: 1, quote: source.content.trimEnd() };
  report.findings = [{
    id: 'F-oracle',
    ruleId: 'SR-001',
    severity: 'blocker',
    title: 'Synthetic oracle finding',
    explanation: 'Exercises only the A1-shaped gate decision, not GitHub review publication.',
    impact: 'The verified blocker must not be hidden by duplicate relationship bookkeeping.',
    introducedBy: evidence,
    evidence: [evidence],
    counterEvidence: ['This fixture tests gate behavior, not model accuracy.'],
  }];
  const decision = evaluateReview(snapshot, report, previous, policy);
  assert.equal(decision.status, 'changes_required');
  assert.deepEqual(decision.reasons, ['Synthetic oracle finding']);
  assert.deepEqual(decision.ledger.openFindings, report.findings);
});

test('reviewing both changed files without acknowledging their relationship is incomplete', (): void => {
  const { snapshot, report, previous, policy } = fixture();
  impact(report, CALLER).relatedPaths = [];
  const decision = evaluateReview(snapshot, report, previous, policy);
  assert.equal(decision.status, 'incomplete');
  assert.ok(decision.reasons.some((reason): boolean =>
    reason.includes(`omitted dependency/caller ${CALLER} of ${ACTION}`)));
});

test('changed-file reciprocity cannot use blocked, not-applicable, missing, or other-dimension coverage', (): void => {
  for (const invalid of ['blocked', 'not_applicable', 'missing', 'other-dimension', 'duplicate']) {
    const { snapshot, report, previous, policy } = fixture();
    const entry = impact(report, CALLER);
    if (invalid === 'blocked' || invalid === 'not_applicable') entry.assessment = invalid;
    if (invalid === 'missing') report.coverage = report.coverage.filter((item): boolean => item !== entry);
    if (invalid === 'other-dimension') entry.relatedPaths = [];
    if (invalid === 'duplicate') report.coverage.push(structuredClone(entry));
    assert.equal(evaluateReview(snapshot, report, previous, policy).status, 'incomplete', invalid);
  }
});

test('reciprocity does not waive required coverage dimensions on a changed neighbor', (): void => {
  const { snapshot, report, previous, policy } = fixture();
  report.coverage = report.coverage.filter((entry): boolean =>
    entry.path !== CALLER || entry.dimension !== 'maintainability');
  assert.equal(evaluateReview(snapshot, report, previous, policy).status, 'incomplete');
});

test('a changed pair cannot satisfy an omitted unchanged caller or callee', (): void => {
  for (const unchangedKind of ['caller', 'callee']) {
    const { snapshot, report, previous, policy } = fixture();
    const omitted = unchangedKind === 'caller' ? 'tests/unchanged.ts' : CONFIG;
    if (unchangedKind === 'caller') {
      snapshot.files.push({ path: omitted, revision: 'head', content: 'export const observed = true;\n' });
      snapshot.dependencyEdges.push({ from: omitted, to: ACTION });
    } else {
      impact(report, ACTION).relatedPaths = [];
    }
    const decision = evaluateReview(snapshot, report, previous, policy);
    assert.equal(decision.status, 'incomplete', unchangedKind);
    assert.ok(decision.reasons.some((reason): boolean =>
      reason.includes(`omitted dependency/caller ${omitted} of ${ACTION}`)));
  }
});

test('reciprocity maps current coverage paths to unambiguous previous rename paths', (): void => {
  for (const renamedPaths of [[ACTION], [CALLER], [ACTION, CALLER]]) {
    for (const reference of ['current', 'previous']) {
      const { snapshot, report, previous, policy } = fixture();
      const actionPath = renamedPaths.includes(ACTION) ? 'src/renamed-action.ts' : ACTION;
      const callerPath = renamedPaths.includes(CALLER) ? 'tests/renamed-consumer.ts' : CALLER;
      for (const before of renamedPaths) rename(snapshot, report, before, before === ACTION ? actionPath : callerPath);
      impact(report, callerPath).relatedPaths = [reference === 'current' ? actionPath : ACTION];
      assert.equal(evaluateReview(snapshot, report, previous, policy).status, 'pass',
        `${renamedPaths.join(',')}/${reference}`);
    }
  }
});

test('a reused rename path cannot establish ambiguous reciprocal coverage', (): void => {
  const { snapshot, report, previous, policy } = fixture();
  rename(snapshot, report, ACTION, 'src/renamed-action.ts');
  snapshot.changes.push({ path: ACTION, status: 'added' });
  snapshot.files.push({ path: ACTION, revision: 'head', content: 'export const replacement = true;\n' });
  report.coverage.push(...DIMENSIONS.map((dimension): Coverage => ({
    path: ACTION,
    dimension,
    assessment: 'reviewed',
    rationale: 'Reviewed the new file that reuses the old path.',
    relatedPaths: [CONFIG, CALLER],
  })));
  const decision = evaluateReview(snapshot, report, previous, policy);
  assert.equal(decision.status, 'incomplete');
  assert.ok(decision.reasons.some((reason): boolean =>
    reason.includes(`omitted dependency/caller ${CALLER} of src/renamed-action.ts`)));
});

test('reciprocity accepts previous-path references when graph edges use current rename paths', (): void => {
  const { snapshot, report, previous, policy } = fixture();
  rename(snapshot, report, ACTION, 'src/renamed-action.ts');
  rename(snapshot, report, CALLER, 'tests/renamed-consumer.ts');
  snapshot.dependencyEdges = snapshot.dependencyEdges.map((edge) => ({
    from: edge.from === ACTION ? 'src/renamed-action.ts' : edge.from === CALLER ? 'tests/renamed-consumer.ts' : edge.from,
    to: edge.to === ACTION ? 'src/renamed-action.ts' : edge.to,
  }));
  assert.equal(evaluateReview(snapshot, report, previous, policy).status, 'pass');
});
