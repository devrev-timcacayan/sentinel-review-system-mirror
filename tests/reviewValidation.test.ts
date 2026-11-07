import assert from 'node:assert/strict';
import test from 'node:test';
import type { Evidence, Finding, ReviewLedger, ReviewReport } from '../src/contracts.ts';
import { evaluateReview } from '../src/gate.ts';
import { inspectModelResponse, isCitationOnlyRepair } from '../src/reviewValidation.ts';
import { parseStrictJson } from '../src/strictJson.ts';
import { loadTestPolicy, makeReport, makeSnapshotFixture } from './helpers.ts';

function fixture(): {
  loaded: ReturnType<typeof loadTestPolicy>;
  snapshot: ReturnType<typeof makeSnapshotFixture>;
  previous: ReviewLedger;
  report: ReviewReport;
} {
  const loaded = loadTestPolicy();
  const snapshot = makeSnapshotFixture(loaded);
  snapshot.partitionScope = { manifestDigest: 'd'.repeat(64), partitionId: 'part-001' };
  const previous: ReviewLedger = {
    schemaVersion: 1, repository: snapshot.identity.repository, pullRequest: snapshot.identity.pullRequest,
    lastHeadSha: null, openFindings: [],
  };
  const evidence: Evidence = {
    path: 'src/action.ts', revision: 'head', startLine: 1, endLine: 1, quote: 'export const required = false;',
  };
  const finding: Finding = {
    id: 'F-setup', ruleId: 'SR-002', severity: 'blocker',
    title: 'Synthetic setup finding', explanation: 'Exercises evidence validation, not semantic model quality.',
    impact: 'Synthetic required setup can be bypassed.', introducedBy: evidence,
    evidence: [structuredClone(evidence)], counterEvidence: ['Synthetic fixture only.'],
  };
  return { loaded, snapshot, previous, report: makeReport(snapshot, { findings: [finding] }) };
}

function response(report: ReviewReport): string {
  return JSON.stringify({ partitionId: 'part-001', report });
}

test('strict JSON rejects duplicate keys including escaped equivalents and nested overrides', (): void => {
  for (const text of [
    '{"complete":false,"complete":true}',
    '{"r\\u0065port":1,"report":2}',
    '{"rows":[{"severity":"blocker","severity":"advisory"}]}',
  ]) {
    assert.throws(() => parseStrictJson(text), /Duplicate JSON object key/);
  }
  const valid = { text: 'Braces { }, quotes ", escaped backslashes \\ and arrays [ ]', rows: [{ a: 1 }, { a: 2 }] };
  assert.deepEqual(parseStrictJson(JSON.stringify(valid)), valid);
  assert.throws(() => parseStrictJson('```json\n{}\n```'));
  assert.throws(() => parseStrictJson(`${'['.repeat(130)}0${']'.repeat(130)}`), /nesting/);
});

test('a valid scoped report may contain a blocker but cannot independently clear the PR', (): void => {
  const { loaded, snapshot, previous, report } = fixture();
  const inspection = inspectModelResponse(response(report), snapshot, previous, loaded.policy);
  assert.equal(inspection.accepted, true);
  assert.equal(inspection.repairable, false);
  assert.equal(evaluateReview(snapshot, report, previous, loaded.policy).status, 'incomplete');
});

test('strict wrapping rejects prose, fences, duplicate report fields, extra fields, and wrong partition IDs', (): void => {
  const { loaded, snapshot, previous, report } = fixture();
  for (const text of [
    `Explanation: ${response(report)}`,
    `\`\`\`json\n${response(report)}\n\`\`\``,
    `{"partitionId":"part-001","report":null,"report":${JSON.stringify(report)}}`,
    JSON.stringify({ partitionId: 'part-002', report }),
    JSON.stringify({ partitionId: 'part-001', report, verdict: 'pass' }),
  ]) {
    const inspection = inspectModelResponse(text, snapshot, previous, loaded.policy);
    assert.equal(inspection.accepted, false);
    assert.equal(inspection.repairable, false);
  }
});

test('a drifted finding citation is re-anchored deterministically, not sent to repair', (): void => {
  const { loaded, snapshot, previous, report } = fixture();
  const broken = structuredClone(report);
  broken.findings[0].evidence[0].startLine = 99;
  broken.findings[0].evidence[0].endLine = 99;
  const inspection = inspectModelResponse(response(broken), snapshot, previous, loaded.policy);
  assert.equal(inspection.accepted, true);
  assert.equal(inspection.repairable, false);
  assert.deepEqual(inspection.citationAdjustments, [{
    kind: 'finding',
    findingId: 'F-setup',
    path: 'src/action.ts',
    revision: 'head',
    from: { startLine: 99, endLine: 99 },
    to: { startLine: 1, endLine: 1 },
  }]);
  assert.equal(isCitationOnlyRepair(broken, report), true);
  assert.equal(inspectModelResponse(response(report), snapshot, previous, loaded.policy).accepted, true);
});

test('a finding whose quote never matches is dropped without a repair call', (): void => {
  const { loaded, snapshot, previous, report } = fixture();
  const broken = structuredClone(report);
  broken.findings[0].evidence[0].quote = 'NOT THE REAL LINE';
  const inspection = inspectModelResponse(response(broken), snapshot, previous, loaded.policy);
  assert.equal(inspection.accepted, true);
  assert.equal(inspection.repairable, false);
  assert.equal(inspection.unverifiedFindings.length, 1);
  assert.equal(inspection.unverifiedFindings[0].finding.id, 'F-setup');
});

test('a resolution citation-only failure is repairable through the title-form reason', (): void => {
  const { loaded, snapshot, previous, report } = fixture();
  const prior = structuredClone(report.findings[0]);
  previous.openFindings = [prior];
  const badEvidence = structuredClone(prior.introducedBy);
  badEvidence.quote = 'NOT THE REAL LINE';
  report.findings = [];
  report.reconciliations = [{
    findingId: 'F-setup', outcome: 'withdrawn', rationale: 'No longer applies.', evidence: [badEvidence],
  }];
  const inspection = inspectModelResponse(response(report), snapshot, previous, loaded.policy);
  assert.equal(inspection.accepted, false);
  assert.equal(inspection.repairable, true);
});

test('identity, coverage, schema, reviewer limitations, and incomplete results cannot request repair', (): void => {
  for (const mutate of [
    (report: ReviewReport): void => { report.identity.headSha = 'b'.repeat(40); },
    (report: ReviewReport): void => { report.identity.policyDigest = 'e'.repeat(64); },
    (report: ReviewReport): void => { report.coverage.pop(); },
    (report: ReviewReport): void => { report.complete = false; },
    (report: ReviewReport): void => { report.limitations.push('Missing runtime wiring.'); },
  ]) {
    const { loaded, snapshot, previous, report } = fixture();
    mutate(report);
    const inspection = inspectModelResponse(response(report), snapshot, previous, loaded.policy);
    assert.equal(inspection.accepted, false);
    assert.equal(inspection.repairable, false);
  }
});

test('citation repair cannot delete or weaken findings, alter scope, or change their meaning', (): void => {
  const { report } = fixture();
  for (const mutate of [
    (next: ReviewReport): void => { next.findings = []; },
    (next: ReviewReport): void => { next.findings[0].severity = 'advisory'; },
    (next: ReviewReport): void => { next.findings[0].id = 'F-new'; },
    (next: ReviewReport): void => { next.findings[0].ruleId = 'novel'; },
    (next: ReviewReport): void => { next.findings[0].explanation = 'A different claim.'; },
    (next: ReviewReport): void => { next.findings[0].introducedBy.path = 'src/other.ts'; },
    (next: ReviewReport): void => { next.findings[0].evidence[0].revision = 'base'; },
    (next: ReviewReport): void => { next.findings[0].evidence.push(structuredClone(next.findings[0].introducedBy)); },
    (next: ReviewReport): void => { next.identity.runId = 'different-run'; },
    (next: ReviewReport): void => { next.coverage[0].relatedPaths = []; },
    (next: ReviewReport): void => { next.complete = false; },
  ]) {
    const changed = structuredClone(report);
    mutate(changed);
    assert.equal(isCitationOnlyRepair(report, changed), false);
  }
});

test('reconciliation outcome, evidence membership, and narrative stay protected during citation repair', (): void => {
  const { report } = fixture();
  report.reconciliations = [{
    findingId: 'F-old', outcome: 'open', rationale: 'Synthetic prior finding.',
    evidence: [structuredClone(report.findings[0].introducedBy)],
  }];
  for (const mutate of [
    (next: ReviewReport): void => { next.reconciliations[0].outcome = 'withdrawn'; },
    (next: ReviewReport): void => { next.reconciliations[0].rationale = 'Now withdrawn.'; },
    (next: ReviewReport): void => { next.reconciliations[0].evidence = []; },
  ]) {
    const changed = structuredClone(report);
    mutate(changed);
    assert.equal(isCitationOnlyRepair(report, changed), false);
  }
});
