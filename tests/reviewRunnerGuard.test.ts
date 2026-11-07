import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ALLOWED_REPOSITORY, loadTestPolicy, makeReport } from './helpers.ts';
import type { Finding, Reconciliation, ReviewLedger, ReviewSnapshot } from '../src/contracts.ts';
import type { ProviderReply, ProviderRequest, ReviewProvider, ReviewProviderConfig } from '../src/providerTypes.ts';
import { buildReviewBundle } from '../src/partitionPlanner.ts';
import { projectPartition } from '../src/partitionContract.ts';
import { runPartitionReview } from '../src/reviewRunner.ts';
import { createBedrockProvider } from '../src/bedrockProvider.ts';

const CONFIG: ReviewProviderConfig = {
  schemaVersion: 1,
  provider: 'mock',
  modelId: 'global.anthropic.claude-sonnet-5-5',
  contextTokens: 10000,
  maxOutputTokens: 1000,
  inputMicrosPerMillionTokens: 1000000,
  outputMicrosPerMillionTokens: 1000000,
  timeoutMs: 1000,
};

function ledger(): ReviewLedger {
  return { schemaVersion: 1, repository: ALLOWED_REPOSITORY, pullRequest: 31, lastHeadSha: null, openFindings: [] };
}

function parent(partCount: number): { snapshot: ReviewSnapshot; loaded: ReturnType<typeof loadTestPolicy> } {
  const files = [
    { path: 'src/root.ts', revision: 'base' as const, content: 'export const root = 1;\n' },
    { path: 'src/root.ts', revision: 'head' as const, content: 'export const root = 2;\n' },
  ];
  const edges = [];
  for (let index = 1; index <= partCount; index += 1) {
    files.push({ path: `src/caller${index}.ts`, revision: 'head' as const, content: 'import { root } from "./root";\n' });
    edges.push({ from: `src/caller${index}.ts`, to: 'src/root.ts' });
  }
  const loaded = loadTestPolicy({ contextPaths: [] });
  loaded.policy.limits.maxFiles = 3;
  const base: ReviewSnapshot = {
    schemaVersion: 1,
    identity: { repository: ALLOWED_REPOSITORY, pullRequest: 31, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), mergeBaseSha: 'b'.repeat(40), policyDigest: loaded.digest, model: loaded.policy.model, runId: 'guard' },
    previousHeadSha: null,
    changes: [{ path: 'src/root.ts', status: 'modified' }],
    size: { changedLines: 1, blockChangedLines: 1500 },
    files,
    dependencyEdges: edges,
    contextPlan: { strategy: 'symbol-aware-reverse-v1', selections: [...new Set(files.map((file) => file.path))].map((filePath) => ({ path: filePath, reasons: ['synthetic-context'] })), fallbacks: [] },
    cumulativeDiff: '-1\n+2\n',
    deltaDiff: null,
    complete: true,
    limitations: [],
  };
  return { snapshot: buildReviewBundle(base, loaded.policy), loaded };
}

function wrapped(snapshot: ReviewSnapshot, partitionId: string, report: unknown): ProviderReply {
  const partition = snapshot.partitionManifest!.partitions.find((part) => part.id === partitionId)!;
  return { text: JSON.stringify({ partitionId, report: report ?? makeReport(projectPartition(snapshot, partition)) }), stopReason: 'end_turn', inputTokens: 10, outputTokens: 5 };
}

function provider(count: (request: ProviderRequest) => Promise<number>, invoke: (request: ProviderRequest) => Promise<ProviderReply>): ReviewProvider {
  return { config: CONFIG, countTokens: count, invoke };
}

test('a counting or reservation failure releases every held uninvoked reservation', async (): Promise<void> => {
  const { snapshot, loaded } = parent(2);
  let counts = 0;
  let invokes = 0;
  const result = await runPartitionReview(snapshot, ledger(), loaded, provider(
    async (): Promise<number> => {
      counts += 1;
      if (counts === 2) throw new Error('count transport failed');
      return 10;
    },
    async (): Promise<never> => { invokes += 1; throw new Error('unreachable'); },
  ), { outputDirectory: path.join(mkdtempSync(path.join(tmpdir(), 'srs-guard-')), 'out'), maxSpendMicros: 1000000, execute: false });
  assert.equal(invokes, 0);
  assert.equal(result.budget.reservedMicros, '0');
  assert.equal(result.decision.status, 'incomplete');
});

test('a failed repair reservation releases at zero and never touches held reservations', async (): Promise<void> => {
  const { snapshot, loaded } = parent(2);
  const [first] = snapshot.partitionManifest!.partitions;
  const prior: Finding = {
    id: 'f-prior',
    ruleId: 'novel',
    severity: 'advisory',
    title: 'prior issue',
    explanation: 'ex',
    impact: 'im',
    introducedBy: { path: 'src/root.ts', revision: 'head', startLine: 1, endLine: 1, quote: 'export const root = 2;' },
    evidence: [{ path: 'src/root.ts', revision: 'head', startLine: 1, endLine: 1, quote: 'export const root = 2;' }],
    counterEvidence: [],
  };
  const reconciliation = (quote: string): Reconciliation => ({
    findingId: 'f-prior',
    outcome: 'withdrawn',
    rationale: 'no longer applies',
    evidence: [{ path: 'src/root.ts', revision: 'head', startLine: 1, endLine: 1, quote }],
  });
  const repairable = makeReport(projectPartition(snapshot, first), {
    findings: [],
    reconciliations: [reconciliation('INVENTED QUOTE')],
  });
  const secondPart = snapshot.partitionManifest!.partitions[1];
  const clean = makeReport(projectPartition(snapshot, secondPart), {
    findings: [],
    reconciliations: [reconciliation('export const root = 2;')],
  });
  let invokes = 0;
  const result = await runPartitionReview(
    snapshot,
    { ...ledger(), openFindings: [structuredClone(prior)] },
    loaded,
    provider(
      async (request: ProviderRequest): Promise<number> => (request.phase === 'repair' ? 5 : 10),
      async (request: ProviderRequest): Promise<ProviderReply> => {
        invokes += 1;
        return wrapped(snapshot, request.partitionId, request.partitionId === first.id ? repairable : clean);
      },
    ),
    { outputDirectory: path.join(mkdtempSync(path.join(tmpdir(), 'srs-guard1b-')), 'out'), maxSpendMicros: 2020, execute: false },
  );
  const repair = result.attempts.find((attempt) => attempt.phase === 'repair');
  assert.ok(repair, 'the repair attempt must be recorded');
  assert.equal(repair.status, 'failed');
  assert.equal(invokes, 1, 'remaining invokes stop after the failed reservation');
  assert.equal(result.budget.reservedMicros, '0', 'the held initial reservation must release cleanly');
  assert.equal(result.budget.spentMicros, '15', 'no phantom spend may be charged against another call');
  assert.equal(result.uncertainCharges, false, 'a pre-invocation failure is certain, not uncertain');
});

test('a structurally parsed non-repairable report is retained and remaining invokes stop', async (): Promise<void> => {
  const { snapshot, loaded } = parent(2);
  const [first, second] = snapshot.partitionManifest!.partitions;
  const incomplete = { ...makeReport(projectPartition(snapshot, first)), complete: false, limitations: ['Missing runtime wiring.'] };
  let invokes = 0;
  const result = await runPartitionReview(snapshot, ledger(), loaded, provider(
    async (): Promise<number> => 10,
    async (request): Promise<ProviderReply> => {
      invokes += 1;
      return wrapped(snapshot, request.partitionId, request.partitionId === first.id ? incomplete : undefined);
    },
  ), { outputDirectory: path.join(mkdtempSync(path.join(tmpdir(), 'srs-guard2-')), 'out'), maxSpendMicros: 1000000, execute: false });
  assert.equal(invokes, 1);
  assert.equal(second ? 1 : 0, 1);
  assert.equal(result.report.reports.length, 1);
  assert.equal(result.report.reports[0].report.complete, false);
  assert.equal(result.budget.reservedMicros, '0');
});

test('non-string reply text is invalid usage, conservatively charged, and never repaired', async (): Promise<void> => {
  const { snapshot, loaded } = parent(2);
  let invokes = 0;
  const result = await runPartitionReview(snapshot, ledger(), loaded, provider(
    async (): Promise<number> => 10,
    async (): Promise<ProviderReply> => {
      invokes += 1;
      return { text: 123, stopReason: 'end_turn', inputTokens: 10, outputTokens: 5 } as unknown as ProviderReply;
    },
  ), { outputDirectory: path.join(mkdtempSync(path.join(tmpdir(), 'srs-guard3-')), 'out'), maxSpendMicros: 1000000, execute: false });
  assert.equal(invokes, 1);
  assert.equal(result.uncertainCharges, true);
  assert.equal(result.attempts[0].settledCostMicros, result.attempts[0].reservedCostMicros);
  assert.equal(result.attempts.some((attempt) => attempt.phase === 'repair'), false);
});

test('run artifacts are private and the audited provider profile carries the validated configuration', async (): Promise<void> => {
  const { snapshot, loaded } = parent(1);
  const outputDirectory = path.join(mkdtempSync(path.join(tmpdir(), 'srs-guard4-')), 'out');
  const result = await runPartitionReview(snapshot, ledger(), loaded, provider(
    async (): Promise<number> => 10,
    async (request): Promise<ProviderReply> => wrapped(snapshot, request.partitionId, undefined),
  ), { outputDirectory, maxSpendMicros: 1000000, execute: false });
  assert.equal(statSync(outputDirectory).mode & 0o777, 0o700);
  assert.equal(statSync(result.executionPath).mode & 0o777, 0o600);
  assert.equal(statSync(result.reportPath).mode & 0o777, 0o600);
  const profile = JSON.parse(readFileSync(path.join(outputDirectory, 'provider-profile.json'), 'utf8')) as { config?: ReviewProviderConfig };
  assert.deepEqual(profile.config, CONFIG);
});

test('the Bedrock adapter rejects mixed content blocks and preserves executor stderr', async (): Promise<void> => {
  const config: ReviewProviderConfig = {
    ...CONFIG,
    provider: 'bedrock',
    region: 'us-east-1',
    verification: { by: 'test', at: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), evidence: 'synthetic' },
  };
  const request: ProviderRequest = { partitionId: 'part-001', phase: 'review', modelId: CONFIG.modelId, maxOutputTokens: 100, system: 's', user: '{}' };
  const mixed = createBedrockProvider(config, { execute: true, maxSpendMicros: 1 }, {
    trustedModelId: CONFIG.modelId,
    executeAws: async (): Promise<{ stdout: string; stderr: string }> => ({
      stdout: JSON.stringify({ output: { message: { role: 'assistant', content: [{ text: 'x', extra: true }] } }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn' }),
      stderr: '',
    }),
  });
  await assert.rejects(() => mixed.invoke(request, mkdtempSync(path.join(tmpdir(), 'srs-aws-'))), /non-text/);
  const failed = createBedrockProvider(config, { execute: true, maxSpendMicros: 1 }, {
    trustedModelId: CONFIG.modelId,
    executeAws: async (): Promise<never> => { throw Object.assign(new Error('aws failed'), { stderr: 'simulated stderr' }); },
  });
  const dir = mkdtempSync(path.join(tmpdir(), 'srs-aws-fail-'));
  await assert.rejects(() => failed.invoke(request, dir), /aws failed/);
  assert.equal(readFileSync(path.join(dir, 'converse-stderr.txt'), 'utf8'), 'simulated stderr');
});
