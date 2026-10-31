import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runPartitionReview } from '../src/reviewRunner.ts';
import { createMockProvider } from '../src/mockProvider.ts';
import { buildReviewBundle } from '../src/partitionPlanner.ts';
import { projectPartition } from '../src/partitionContract.ts';
import { ALLOWED_REPOSITORY, loadTestPolicy, makeReport } from './helpers.ts';
import type { ReviewLedger, ReviewSnapshot } from '../src/contracts.ts';

function emptyLedger(): ReviewLedger {
  return { schemaVersion: 1, repository: ALLOWED_REPOSITORY, pullRequest: 7, lastHeadSha: null, openFindings: [] };
}

const file = (p: string, revision: 'base' | 'head', content = 'export const x = 1;\n') => ({ path: p, revision, content });

function parentWith(parts: number): { snapshot: ReviewSnapshot; loaded: ReturnType<typeof loadTestPolicy> } {
  const files = [file('src/a.ts', 'base'), file('src/a.ts', 'head')];
  const edges: { from: string; to: string }[] = [];
  for (let index = 1; index <= parts; index += 1) {
    files.push(file(`src/c${index}.ts`, 'head', `import { a } from "./a";\nexport const c${index} = a;\n`));
    edges.push({ from: `src/c${index}.ts`, to: 'src/a.ts' });
  }
  const snapshot: ReviewSnapshot = {
    schemaVersion: 1,
    identity: { repository: ALLOWED_REPOSITORY, pullRequest: 7, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), mergeBaseSha: 'b'.repeat(40), policyDigest: '', model: 'global.anthropic.claude-sonnet-5-5', runId: 'r1' },
    previousHeadSha: null,
    changes: [{ path: 'src/a.ts', status: 'modified' }],
    size: { changedLines: 1, warnChangedLines: 800, blockChangedLines: 1500, outcome: 'within_threshold' },
    files,
    dependencyEdges: edges,
    contextPlan: { strategy: 'symbol-aware-reverse-v1', selections: [{ path: 'src/a.ts', reasons: ['changed'] }], fallbacks: [] },
    cumulativeDiff: 'x',
    deltaDiff: null,
    complete: true,
    limitations: [],
  };
  const loaded = loadTestPolicy({ contextPaths: [] });
  snapshot.identity.policyDigest = loaded.digest;
  const parent = buildReviewBundle(snapshot, loaded.policy);
  return { snapshot: parent, loaded };
}

function mockFixture(steps: unknown[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'srs-mock-'));
  const filePath = path.join(dir, 'responses.json');
  writeFileSync(filePath, JSON.stringify({
    schemaVersion: 1,
    kind: 'mock-review-provider',
    config: {
      schemaVersion: 1,
      provider: 'mock',
      modelId: 'global.anthropic.claude-sonnet-5-5',
      contextTokens: 200_000,
      maxOutputTokens: 8_000,
      inputMicrosPerMillionTokens: 0,
      outputMicrosPerMillionTokens: 0,
      timeoutMs: 5_000,
    },
    steps,
  }));
  return filePath;
}

function reply(report: unknown, stopReason = 'end_turn', inputTokens = 100, outputTokens = 50): unknown {
  return { text: JSON.stringify(report), stopReason, inputTokens, outputTokens };
}

test('all-clean mock run aggregates every partition and reports synthetic', async (): Promise<void> => {
  const { snapshot, loaded } = parentWith(2);
  const parts = snapshot.partitionManifest!.partitions;
  const fixture = mockFixture(parts.map((partition) => ({
    partitionId: partition.id,
    phase: 'review',
    inputTokens: 120,
    reply: reply({ partitionId: partition.id, report: makeReportFor(snapshot, partition.id) }),
  })));
  const provider = createMockProvider(fixture);
  const out = mkdtempSync(path.join(tmpdir(), 'srs-run-')) + '/out';
  const result = await runPartitionReview(snapshot, emptyLedger(), loaded, provider, { outputDirectory: out, maxSpendMicros: 1_000_000, execute: false });
  assert.equal(result.synthetic, true);
  assert.equal(result.attempts.filter((attempt) => attempt.status === 'accepted').length, parts.length);
  assert.ok(result.report.reports.length === parts.length || result.decision.status !== 'pass');
  assert.ok(existsSync(path.join(out, 'mock-report.json')));
  assert.equal(existsSync(path.join(out, 'report.json')), false, 'mock must never emit generic report.json');
  assert.ok(existsSync(path.join(out, 'execution.json')));
});

function makeReportFor(snapshot: ReviewSnapshot, partitionId: string): unknown {
  const part = snapshot.partitionManifest!.partitions.find((partition) => partition.id === partitionId)!;
  return makeReport(projectPartition(snapshot, part));
}

test('preflight blocks: existing output dir, scope-tainted snapshot, and ledger mismatch never reach the provider', async (): Promise<void> => {
  const { snapshot, loaded } = parentWith(1);
  const fixture = mockFixture([]);
  const provider = createMockProvider(fixture);
  const out = mkdtempSync(path.join(tmpdir(), 'srs-run2-'));
  await assert.rejects(() => runPartitionReview(snapshot, emptyLedger(), loaded, provider, { outputDirectory: out, maxSpendMicros: 1, execute: false }), /already exists/);
  const badLedger = { ...emptyLedger(), pullRequest: 99 };
  const out2 = mkdtempSync(path.join(tmpdir(), 'srs-run3-')) + '/o';
  const result = await runPartitionReview(snapshot, badLedger, loaded, provider, { outputDirectory: out2, maxSpendMicros: 1_000_000, execute: false });
  assert.equal(result.attempts.length, 0, 'no provider calls when the ledger mismatches');
  assert.equal(result.decision.status, 'incomplete');
});

function mockConfig(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    provider: 'mock',
    modelId: 'global.anthropic.claude-sonnet-5-5',
    contextTokens: 200_000,
    maxOutputTokens: 8_000,
    inputMicrosPerMillionTokens: 0,
    outputMicrosPerMillionTokens: 0,
    timeoutMs: 5_000,
  };
}

test('one citation-only repair succeeds with exactly two calls for that part', async (): Promise<void> => {
  const { snapshot, loaded } = parentWith(1);
  const part = snapshot.partitionManifest!.partitions[0];
  const scoped = projectPartition(snapshot, part);
  const original = makeReport(scoped, {
    findings: [{
      id: 'f-1',
      ruleId: 'novel',
      severity: 'advisory',
      title: 'issue',
      explanation: 'ex',
      impact: 'im',
      introducedBy: { path: 'src/a.ts', revision: 'head', startLine: 1, endLine: 1, quote: 'export const x = 1;' },
      evidence: [{ path: 'src/a.ts', revision: 'head', startLine: 1, endLine: 1, quote: 'NOT THE REAL LINE' }],
      counterEvidence: [],
    }],
  });
  const repaired = structuredClone(original);
  repaired.findings[0].evidence[0].quote = 'export const x = 1;';
  const fixture = mockFixture([
    { partitionId: part.id, phase: 'review', inputTokens: 100, reply: reply({ partitionId: part.id, report: original }) },
    { partitionId: part.id, phase: 'repair', inputTokens: 150, reply: reply({ partitionId: part.id, report: repaired }) },
  ]);
  const result = await runPartitionReview(snapshot, emptyLedger(), loaded, createMockProvider(fixture), {
    outputDirectory: mkdtempSync(path.join(tmpdir(), 'srs-rep-')) + '/o',
    maxSpendMicros: 1_000_000,
    execute: false,
  });
  const phases = result.attempts.filter((attempt) => attempt.partitionId === part.id).map((attempt) => attempt.phase);
  assert.deepEqual(phases, ['review', 'repair'], 'exactly one repair call, never a third');
  assert.equal(result.attempts.find((attempt) => attempt.phase === 'repair')?.status, 'accepted');
});

test('a repair that alters protected fields keeps the original and never calls again', async (): Promise<void> => {
  const { snapshot, loaded } = parentWith(1);
  const part = snapshot.partitionManifest!.partitions[0];
  const scoped = projectPartition(snapshot, part);
  const original = makeReport(scoped, {
    findings: [{
      id: 'f-2',
      ruleId: 'novel',
      severity: 'advisory',
      title: 'issue',
      explanation: 'ex',
      impact: 'im',
      introducedBy: { path: 'src/a.ts', revision: 'head', startLine: 1, endLine: 1, quote: 'export const x = 1;' },
      evidence: [{ path: 'src/a.ts', revision: 'head', startLine: 1, endLine: 1, quote: 'BAD QUOTE' }],
      counterEvidence: [],
    }],
  });
  const tampered = structuredClone(original);
  tampered.findings[0].severity = 'blocker';
  tampered.findings[0].evidence[0].quote = 'export const x = 1;';
  const fixture = mockFixture([
    { partitionId: part.id, phase: 'review', inputTokens: 100, reply: reply({ partitionId: part.id, report: original }) },
    { partitionId: part.id, phase: 'repair', inputTokens: 150, reply: reply({ partitionId: part.id, report: tampered }) },
  ]);
  const result = await runPartitionReview(snapshot, emptyLedger(), loaded, createMockProvider(fixture), {
    outputDirectory: mkdtempSync(path.join(tmpdir(), 'srs-rep2-')) + '/o',
    maxSpendMicros: 1_000_000,
    execute: false,
  });
  assert.equal(result.attempts.length, 2, 'max two calls total for the part');
  const report = result.report.reports.find((row) => row.partitionId === part.id)?.report;
  assert.equal(report?.findings[0]?.severity, 'advisory', 'original report retained, tampered repair rejected');
  assert.equal(result.decision.status !== 'pass', true, 'retained report with its original citation error cannot pass');
});

test('transport failure charges the full reservation, marks uncertain, and stops remaining invokes', async (): Promise<void> => {
  const { snapshot, loaded } = parentWith(2);
  const provider = {
    config: { ...mockConfig(), inputMicrosPerMillionTokens: 1000, outputMicrosPerMillionTokens: 1000 } as never,
    countTokens: async (): Promise<number> => 50,
    invoke: async (): Promise<never> => { throw new Error('transport timeout'); },
  };
  const result = await runPartitionReview(snapshot, emptyLedger(), loaded, provider, {
    outputDirectory: mkdtempSync(path.join(tmpdir(), 'srs-tt-')) + '/o',
    maxSpendMicros: 1_000_000,
    execute: false,
  });
  assert.equal(result.uncertainCharges, true);
  assert.equal(result.attempts.filter((attempt) => attempt.phase === 'review').length, 1, 'remaining invokes stopped');
  assert.equal(result.decision.status, 'incomplete');
  assert.ok(Number(result.budget.spentMicros) > 0, 'full reservation charged conservatively');
});

test('sum of initial reservations over the cap never invokes', async (): Promise<void> => {
  const { snapshot, loaded } = parentWith(2);
  let invoked = 0;
  const provider = {
    config: { ...mockConfig(), inputMicrosPerMillionTokens: 1_000_000_000, outputMicrosPerMillionTokens: 1_000_000_000 } as never,
    countTokens: async (): Promise<number> => 500,
    invoke: async (): Promise<never> => { invoked += 1; throw new Error('unreachable'); },
  };
  const result = await runPartitionReview(snapshot, emptyLedger(), loaded, provider, {
    outputDirectory: mkdtempSync(path.join(tmpdir(), 'srs-cap-')) + '/o',
    maxSpendMicros: 10,
    execute: false,
  });
  assert.equal(invoked, 0, 'no invokes when reservations exceed the cap');
  assert.equal(result.decision.status, 'incomplete');
});

test('non-end_turn replies are terminal and never repaired', async (): Promise<void> => {
  const { snapshot, loaded } = parentWith(1);
  const part = snapshot.partitionManifest!.partitions[0];
  const fixture = mockFixture([
    { partitionId: part.id, phase: 'review', inputTokens: 100, reply: reply({ partitionId: part.id, report: makeReport(projectPartition(snapshot, part)) }, 'max_tokens') },
  ]);
  const result = await runPartitionReview(snapshot, emptyLedger(), loaded, createMockProvider(fixture), {
    outputDirectory: mkdtempSync(path.join(tmpdir(), 'srs-mt-')) + '/o',
    maxSpendMicros: 1_000_000,
    execute: false,
  });
  assert.equal(result.attempts.filter((attempt) => attempt.phase === 'repair').length, 0, 'truncated output is never repaired');
  assert.equal(result.report.reports.length, 0);
  assert.equal(result.decision.status, 'incomplete');
});
