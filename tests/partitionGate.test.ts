import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Evidence, Finding, PartitionedReviewReport, ReviewLedger, ReviewPolicy, ReviewSnapshot } from '../src/contracts.ts';
import { evaluateReview } from '../src/gate.ts';
import { computeManifestDigest, projectPartition, sourceKey, validatePartitionManifest } from '../src/partitionContract.ts';
import { buildReviewBundle } from '../src/partitionPlanner.ts';
import { readLedger, prStore, recordReview } from '../src/state.ts';
import { loadTestPolicy, makeReport, makeSnapshotFixture } from './helpers.ts';

function actionEvidence(): Evidence {
  return { path: 'src/action.ts', revision: 'head', startLine: 1, endLine: 1, quote: 'export const required = false;' };
}

function finding(): Finding {
  return {
    id: 'F-setup',
    ruleId: 'SR-002',
    severity: 'blocker',
    title: 'Required setup is bypassed',
    explanation: 'Synthetic finding used to exercise structured gate behavior.',
    impact: 'Required setup can be bypassed by consumers.',
    introducedBy: actionEvidence(),
    evidence: [actionEvidence()],
    counterEvidence: ['This test checks gate consistency, not model reasoning.'],
  };
}

function fixture(withPrior: boolean = false): {
  snapshot: ReviewSnapshot;
  envelope: PartitionedReviewReport;
  previous: ReviewLedger;
  policy: ReviewPolicy;
} {
  const loaded = loadTestPolicy({ contextPaths: [] });
  const policy = { ...loaded.policy, limits: { ...loaded.policy.limits, maxFiles: 3 } };
  const input = makeSnapshotFixture(loaded);
  for (const name of ['consumerB', 'consumerC']) {
    input.files.push({ path: `tests/${name}.ts`, revision: 'head', content: 'export const observed = true;\n' });
    input.dependencyEdges.push({ from: `tests/${name}.ts`, to: 'src/action.ts' });
  }
  input.contextPlan.selections = [...new Set(input.files.map((file): string => file.path))].map((filePath): { path: string; reasons: string[] } => ({
    path: filePath, reasons: [filePath === 'src/action.ts' ? 'changed' : 'caller'],
  }));
  const previous: ReviewLedger = {
    schemaVersion: 1,
    repository: input.identity.repository,
    pullRequest: input.identity.pullRequest,
    lastHeadSha: withPrior ? 'e'.repeat(40) : null,
    openFindings: withPrior ? [finding()] : [],
  };
  input.previousHeadSha = previous.lastHeadSha;
  const snapshot = buildReviewBundle(input, policy);
  assert.equal(snapshot.partitionManifest!.partitions.length, 3);
  const envelope: PartitionedReviewReport = {
    schemaVersion: 1,
    kind: 'partitioned-review',
    manifestDigest: snapshot.partitionManifest!.digest,
    synthetic: false,
    reports: snapshot.partitionManifest!.partitions.map((partition) => ({
      partitionId: partition.id,
      report: makeReport(projectPartition(snapshot, partition), withPrior ? {
        findings: [finding()],
        reconciliations: [{ findingId: 'F-setup', outcome: 'open', rationale: 'Still open in this synthetic attestation.', evidence: [actionEvidence()] }],
      } : {}),
    })),
  };
  return { snapshot, envelope, previous, policy };
}

function rebind(snapshot: ReviewSnapshot): void {
  const manifest = snapshot.partitionManifest!;
  manifest.digest = computeManifestDigest(snapshot, {
    schemaVersion: 1, sharedSourceKeys: manifest.sharedSourceKeys, partitions: manifest.partitions,
  });
}

test('every complete partition combines global caller coverage before passing', (): void => {
  const { snapshot, envelope, previous, policy } = fixture();
  const decision = evaluateReview(snapshot, envelope, previous, policy);
  assert.equal(decision.status, 'pass', decision.reasons.join('\n'));
  assert.equal(decision.ledger.lastHeadSha, snapshot.identity.headSha);
  validatePartitionManifest(snapshot, policy);
});

test('a projected partition and a manifest-stripped oversized parent cannot clear the PR', (): void => {
  const { snapshot, envelope, previous, policy } = fixture();
  const projected = projectPartition(snapshot, snapshot.partitionManifest!.partitions[0]);
  assert.equal(evaluateReview(projected, envelope.reports[0].report, previous, policy).status, 'incomplete');
  const stripped = structuredClone(snapshot);
  delete stripped.partitionManifest;
  assert.ok(stripped.files.length > policy.limits.maxFiles);
  assert.equal(evaluateReview(stripped, makeReport(stripped), previous, policy).status, 'incomplete');
  assert.equal(evaluateReview(snapshot, makeReport(snapshot), previous, policy).status, 'incomplete');
});

test('missing, duplicate, unknown, or stale partition envelopes cannot pass', (): void => {
  for (const mutation of [
    (input: PartitionedReviewReport): void => { input.reports.pop(); },
    (input: PartitionedReviewReport): void => { input.reports.push(structuredClone(input.reports[0])); },
    (input: PartitionedReviewReport): void => { input.reports[0].partitionId = 'part-999'; },
    (input: PartitionedReviewReport): void => { input.manifestDigest = '0'.repeat(64); },
  ]) {
    const { snapshot, envelope, previous, policy } = fixture(true);
    mutation(envelope);
    const decision = evaluateReview(snapshot, envelope, previous, policy);
    assert.equal(decision.status, 'incomplete');
    assert.deepEqual(decision.ledger.openFindings, previous.openFindings);
    assert.equal(decision.ledger.lastHeadSha, previous.lastHeadSha);
  }
});

test('every nested report must match every exact parent identity field', (): void => {
  for (const mutation of [
    { headSha: 'b'.repeat(40) }, { baseSha: 'b'.repeat(40) }, { mergeBaseSha: 'b'.repeat(40) },
    { policyDigest: 'f'.repeat(64) }, { model: 'different-model' }, { runId: 'different-run' },
    { pullRequest: 18 }, { repository: 'devrev/sentinel' },
  ]) {
    const { snapshot, envelope, previous, policy } = fixture(true);
    Object.assign(envelope.reports[0].report.identity, mutation);
    const decision = evaluateReview(snapshot, envelope, previous, policy);
    assert.equal(decision.status, 'incomplete');
    assert.equal(decision.ledger.openFindings[0].severity, 'blocker');
    assert.equal(decision.ledger.lastHeadSha, previous.lastHeadSha);
  }
});

test('incomplete or blocked partitions keep the aggregate incomplete', (): void => {
  for (const mutation of [
    (input: PartitionedReviewReport): void => { input.reports[0].report.complete = false; },
    (input: PartitionedReviewReport): void => { input.reports[0].report.coverage[0].assessment = 'blocked'; },
  ]) {
    const { snapshot, envelope, previous, policy } = fixture();
    mutation(envelope);
    assert.equal(evaluateReview(snapshot, envelope, previous, policy).status, 'incomplete');
  }
});

test('a partition finding whose quote never verifies is dropped from a clean aggregate', (): void => {
  const { snapshot, envelope, previous, policy } = fixture();
  envelope.reports[0].report.findings = [finding()];
  envelope.reports[0].report.findings[0].introducedBy.quote = 'invented quote';
  const decision = evaluateReview(snapshot, envelope, previous, policy);
  assert.equal(decision.status, 'needs_attention');
  assert.equal(decision.ledger.openFindings.length, 0);
  assert.equal(decision.unverifiedFindings?.length, 1);
  assert.equal(decision.unverifiedFindings?.[0].finding.id, 'F-setup');
});

test('a citation outside its partition scope is re-verified against the full snapshot', (): void => {
  const { snapshot, envelope, previous, policy } = fixture();
  const firstPart = snapshot.partitionManifest!.partitions[0];
  const foreign = snapshot.files.find((file): boolean => !firstPart.sourceKeys.includes(sourceKey(file)))!;
  envelope.reports[0].report.findings = [{
    ...finding(),
    evidence: [{ path: foreign.path, revision: foreign.revision, startLine: 1, endLine: 1, quote: foreign.content.split('\n')[0] }],
  }];
  // The partition packet cannot see the file, but the aggregate gate verifies
  // the same quote against the captured snapshot and keeps the finding.
  const decision = evaluateReview(snapshot, envelope, previous, policy);
  assert.equal(decision.status, 'changes_required');
  assert.equal(decision.ledger.openFindings[0].id, 'F-setup');
});

test('one evidenced blocker survives other clean partitions', (): void => {
  const { snapshot, envelope, previous, policy } = fixture();
  envelope.reports[0].report.findings = [finding()];
  const decision = evaluateReview(snapshot, envelope, previous, policy);
  assert.equal(decision.status, 'changes_required');
  assert.equal(decision.ledger.openFindings[0].id, 'F-setup');
});

test('conflicting finding details or severities cannot choose the permissive result', (): void => {
  for (const mutation of [{ title: 'Different mechanism' }, { severity: 'advisory' as const }]) {
    const { snapshot, envelope, previous, policy } = fixture();
    envelope.reports[0].report.findings = [finding()];
    envelope.reports[1].report.findings = [{ ...finding(), ...mutation }];
    const decision = evaluateReview(snapshot, envelope, previous, policy);
    assert.equal(decision.status, 'incomplete');
    assert.equal(decision.ledger.openFindings[0].severity, 'blocker');
  }
});

test('accepted withdrawals cannot clear a prior blocker until all partitions agree', (): void => {
  const { snapshot, envelope, previous, policy } = fixture(true);
  envelope.reports[0].report.findings = [];
  envelope.reports[0].report.reconciliations[0] = {
    findingId: 'F-setup', outcome: 'withdrawn', rationale: 'Synthetic accepted challenge.', evidence: [actionEvidence()],
  };
  const conflict = evaluateReview(snapshot, envelope, previous, policy);
  assert.equal(conflict.status, 'incomplete');
  assert.deepEqual(conflict.ledger.openFindings, previous.openFindings);
  for (const row of envelope.reports) {
    row.report.findings = [];
    row.report.reconciliations = structuredClone(envelope.reports[0].report.reconciliations);
  }
  const agreed = evaluateReview(snapshot, envelope, previous, policy);
  assert.equal(agreed.status, 'pass', agreed.reasons.join('\n'));
  assert.deepEqual(agreed.ledger.openFindings, []);
  envelope.reports.pop();
  assert.deepEqual(evaluateReview(snapshot, envelope, previous, policy).ledger.openFindings, previous.openFindings);
});

test('snapshot content and membership are bound even when all reports claim complete', (): void => {
  for (const mutate of [
    (snapshot: ReviewSnapshot): void => { snapshot.files[0].content += '// changed\n'; },
    (snapshot: ReviewSnapshot): void => { snapshot.partitionManifest!.partitions[0].sourceKeys.pop(); },
  ]) {
    const { snapshot, envelope, previous, policy } = fixture(true);
    mutate(snapshot);
    assert.equal(evaluateReview(snapshot, envelope, previous, policy).status, 'incomplete');
  }
});

test('rehashed invalid plans cannot omit shared sources, closure, coverage, or budgets', (): void => {
  for (const mutate of [
    (snapshot: ReviewSnapshot): void => { snapshot.partitionManifest!.partitions[0].sourceKeys.shift(); },
    (snapshot: ReviewSnapshot): void => { snapshot.partitionManifest!.partitions.pop(); },
    (snapshot: ReviewSnapshot): void => { snapshot.partitionManifest!.partitions[0].sourceKeys.push('head:absent.ts'); },
    (snapshot: ReviewSnapshot): void => { snapshot.partitionManifest!.partitions[0].sourceKeys = snapshot.files.map(sourceKey); },
  ]) {
    const { snapshot, previous, policy } = fixture();
    mutate(snapshot);
    rebind(snapshot);
    const envelope: PartitionedReviewReport = {
      schemaVersion: 1, kind: 'partitioned-review', manifestDigest: snapshot.partitionManifest!.digest, synthetic: false, reports: [],
    };
    const decision = evaluateReview(snapshot, envelope, previous, policy);
    assert.equal(decision.status, 'incomplete');
    assert.ok(decision.reasons.some((reason): boolean => reason.includes('Invalid partition manifest')), decision.reasons.join('\n'));
  }
});

test('immutable state stores the whole bundle envelope and idempotently replays it', (): void => {
  const { snapshot, envelope, previous, policy } = fixture();
  const root = mkdtempSync(path.join(tmpdir(), 'srs-partition-state-'));
  const first = recordReview(root, snapshot, envelope, policy);
  assert.equal(first.decision.status, 'pass');
  assert.equal(first.replayed, false);
  assert.equal(recordReview(root, snapshot, envelope, policy).replayed, true);
  const ledger = readLedger(prStore(root, snapshot.identity.repository, snapshot.identity.pullRequest));
  assert.equal(ledger.lastHeadSha, snapshot.identity.headSha);
  assert.equal(previous.lastHeadSha, null);
});

test('nested reports are bound to their assigned partition scope and context', (): void => {
  const { snapshot, envelope, previous, policy } = fixture();
  const unscoped = structuredClone(envelope);
  delete (unscoped.reports[0].report as { partitionScope?: unknown }).partitionScope;
  assert.equal(evaluateReview(snapshot, unscoped, previous, policy).status, 'incomplete');

  const wrongScope = structuredClone(envelope);
  wrongScope.reports[0].report.partitionScope = {
    manifestDigest: snapshot.partitionManifest!.digest,
    partitionId: snapshot.partitionManifest!.partitions[1].id,
  };
  assert.equal(evaluateReview(snapshot, wrongScope, previous, policy).status, 'incomplete');

  const copied = structuredClone(envelope);
  copied.reports[1].report = structuredClone(copied.reports[0].report);
  const decision = evaluateReview(snapshot, copied, previous, policy);
  assert.equal(decision.status, 'incomplete', 'a report copied into a second partition row must not stand');
});

test('each partition must acknowledge its uniquely assigned context roots', (): void => {
  const loaded = loadTestPolicy({ contextPaths: [] });
  const policy = { ...loaded.policy, limits: { ...loaded.policy.limits, maxFiles: 4 } };
  const input = makeSnapshotFixture(loaded);
  for (const name of ['consumerB', 'consumerC', 'consumerD']) {
    input.files.push({ path: `tests/${name}.ts`, revision: 'head', content: 'export const observed = true;\n' });
  }
  input.dependencyEdges.push(
    { from: 'tests/consumerB.ts', to: 'src/action.ts' },
    { from: 'tests/consumerC.ts', to: 'src/action.ts' },
    { from: 'tests/consumerD.ts', to: 'tests/consumerB.ts' },
  );
  input.contextPlan.selections = [...new Set(input.files.map((file): string => file.path))].map((filePath): { path: string; reasons: string[] } => ({
    path: filePath, reasons: [filePath === 'src/action.ts' ? 'changed' : 'caller'],
  }));
  const previous: ReviewLedger = {
    schemaVersion: 1, repository: input.identity.repository, pullRequest: input.identity.pullRequest,
    lastHeadSha: null, openFindings: [],
  };
  const snapshot = buildReviewBundle(input, policy);
  const envelope: PartitionedReviewReport = {
    schemaVersion: 1, kind: 'partitioned-review', manifestDigest: snapshot.partitionManifest!.digest, synthetic: false,
    reports: snapshot.partitionManifest!.partitions.map((partition) => ({
      partitionId: partition.id,
      report: makeReport(projectPartition(snapshot, partition)),
    })),
  };
  const transitive = snapshot.partitionManifest!.partitions.find((partition): boolean => partition.sourceKeys.includes('head:tests/consumerD.ts'))!;
  const decision = evaluateReview(snapshot, envelope, previous, policy);
  assert.equal(decision.status, 'incomplete');
  assert.ok(
    decision.reasons.some((reason): boolean => reason.includes('context root') && reason.includes('tests/consumerD.ts')),
    decision.reasons.join('\n'),
  );
  const covered = structuredClone(envelope);
  for (const entry of covered.reports.find((row): boolean => row.partitionId === transitive.id)!.report.coverage) {
    entry.relatedPaths = [...entry.relatedPaths, 'tests/consumerD.ts'];
  }
  assert.equal(evaluateReview(snapshot, covered, previous, policy).status, 'pass');
});

test('synthetic review output is refused at the recording boundary', (): void => {
  const { snapshot, envelope, previous, policy } = fixture();
  const root = mkdtempSync(path.join(tmpdir(), 'srs-synthetic-'));
  const synthetic = { ...envelope, synthetic: true };
  assert.throws(() => recordReview(root, snapshot, synthetic, policy), /synthetic/);
  const store = prStore(root, snapshot.identity.repository, snapshot.identity.pullRequest);
  assert.equal(readLedger(store).lastHeadSha, null, 'synthetic output must not advance operational state');
  assert.equal(evaluateReview(snapshot, envelope, previous, policy).status, 'pass');
});

test('dependency closure and the unique parent byte cap remain mandatory after rehashing', (): void => {
  const { snapshot, policy, previous } = fixture();
  delete snapshot.partitionManifest;
  snapshot.files.push({ path: 'src/contextHelper.ts', revision: 'head', content: 'export const helper = true;\n' });
  snapshot.dependencyEdges.push({ from: 'tests/consumerB.ts', to: 'src/contextHelper.ts' });
  const wider = { ...policy, limits: { ...policy.limits, maxFiles: 4 } };
  const bundle = buildReviewBundle(snapshot, wider);
  const part = bundle.partitionManifest!.partitions.find((item): boolean => item.sourceKeys.includes('head:tests/consumerB.ts'))!;
  part.sourceKeys = part.sourceKeys.filter((key): boolean => key !== 'head:src/contextHelper.ts');
  rebind(bundle);
  assert.throws(() => validatePartitionManifest(bundle, wider), /dependency-closed/);
  const { snapshot: valid, envelope } = fixture();
  const smaller = { ...policy, limits: { ...policy.limits, maxSourceBytes: 1 } };
  assert.equal(evaluateReview(valid, envelope, previous, smaller).status, 'incomplete');
});

test('even a one-part bundle requires its matching wrapped report', (): void => {
  const { snapshot, policy, previous } = fixture();
  delete snapshot.partitionManifest;
  const wider = { ...policy, limits: { ...policy.limits, maxFiles: 20 } };
  const bundle = buildReviewBundle(snapshot, wider);
  assert.equal(bundle.partitionManifest!.partitions.length, 1);
  const partition = bundle.partitionManifest!.partitions[0];
  const report = makeReport(projectPartition(bundle, partition));
  const envelope: PartitionedReviewReport = {
    schemaVersion: 1, kind: 'partitioned-review', manifestDigest: bundle.partitionManifest!.digest,
    synthetic: false,
    reports: [{ partitionId: partition.id, report }],
  };
  assert.equal(evaluateReview(bundle, report, previous, wider).status, 'incomplete');
  assert.equal(evaluateReview(bundle, envelope, previous, wider).status, 'pass');
  envelope.reports = [];
  assert.equal(evaluateReview(bundle, envelope, previous, wider).status, 'incomplete');
});

test('partial persisted bundles cannot clear a previous blocker or advance the reviewed SHA', (): void => {
  const loaded = loadTestPolicy({ contextPaths: [] });
  const policy = { ...loaded.policy, limits: { ...loaded.policy.limits, maxFiles: 3 } };
  const first = makeSnapshotFixture(loaded, { runId: 'first' });
  const root = mkdtempSync(path.join(tmpdir(), 'srs-partition-rounds-'));
  const initial = recordReview(root, first, makeReport(first, { findings: [finding()] }), policy);
  assert.equal(initial.decision.status, 'changes_required');
  const { snapshot, envelope } = fixture(true);
  snapshot.identity.runId = 'partial';
  snapshot.identity.headSha = 'b'.repeat(40);
  snapshot.previousHeadSha = first.identity.headSha;
  rebind(snapshot);
  envelope.manifestDigest = snapshot.partitionManifest!.digest;
  for (const row of envelope.reports) {
    row.report.identity = structuredClone(snapshot.identity);
    row.report.partitionScope = { manifestDigest: snapshot.partitionManifest!.digest, partitionId: row.partitionId };
    row.report.findings = [];
    row.report.reconciliations = [{
      findingId: 'F-setup', outcome: 'withdrawn', rationale: 'Synthetic accepted challenge.', evidence: [actionEvidence()],
    }];
  }
  const partial = structuredClone(envelope);
  partial.reports.pop();
  const incomplete = recordReview(root, snapshot, partial, policy);
  assert.equal(incomplete.decision.status, 'incomplete');
  const store = prStore(root, snapshot.identity.repository, snapshot.identity.pullRequest);
  assert.equal(readLedger(store).lastHeadSha, first.identity.headSha);
  assert.equal(readLedger(store).openFindings[0].severity, 'blocker');
  assert.throws(() => recordReview(root, snapshot, envelope, policy), /different content/);
  snapshot.identity.runId = 'complete';
  rebind(snapshot);
  envelope.manifestDigest = snapshot.partitionManifest!.digest;
  for (const row of envelope.reports) {
    row.report.identity = structuredClone(snapshot.identity);
    row.report.partitionScope = { manifestDigest: snapshot.partitionManifest!.digest, partitionId: row.partitionId };
  }
  assert.equal(recordReview(root, snapshot, envelope, policy).decision.status, 'pass');
  assert.equal(readLedger(store).lastHeadSha, snapshot.identity.headSha);
  assert.deepEqual(readLedger(store).openFindings, []);
});
