import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildReviewBundle } from '../src/partitionPlanner.ts';
import { projectPartition } from '../src/partitionContract.ts';
import { ALLOWED_REPOSITORY, SYSTEM_ROOT, loadTestPolicy, makeReport } from './helpers.ts';
import type { ReviewLedger, ReviewSnapshot } from '../src/contracts.ts';

const CLI = path.resolve(fileURLToPath(new URL('../src/reviewCli.ts', import.meta.url)));
const RECORD_CLI = path.resolve(fileURLToPath(new URL('../src/cli.ts', import.meta.url)));

function cli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, ['--experimental-strip-types', CLI, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function recordCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, ['--experimental-strip-types', RECORD_CLI, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function fixture(): { bundleDir: string; snapshot: ReviewSnapshot; ledger: ReviewLedger } {
  const loaded = loadTestPolicy({ contextPaths: [] });
  const snapshot: ReviewSnapshot = {
    schemaVersion: 1,
    identity: {
      repository: ALLOWED_REPOSITORY, pullRequest: 21, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
      mergeBaseSha: 'b'.repeat(40), policyDigest: loaded.digest, model: loaded.policy.model, runId: 'cli-1',
    },
    previousHeadSha: null,
    changes: [{ path: 'src/a.ts', status: 'modified' }],
    size: { changedLines: 1, warnChangedLines: 800, blockChangedLines: 1500, outcome: 'within_threshold' },
    files: [
      { path: 'src/a.ts', revision: 'base', content: 'export const x = 1;\n' },
      { path: 'src/a.ts', revision: 'head', content: 'export const x = 2;\n' },
    ],
    dependencyEdges: [],
    contextPlan: { strategy: 'symbol-aware-reverse-v1', selections: [{ path: 'src/a.ts', reasons: ['changed'] }], fallbacks: [] },
    cumulativeDiff: 'x', deltaDiff: null, complete: true, limitations: [],
  };
  const parent = buildReviewBundle(snapshot, loaded.policy);
  const ledger: ReviewLedger = { schemaVersion: 1, repository: ALLOWED_REPOSITORY, pullRequest: 21, lastHeadSha: null, openFindings: [] };
  const bundleDir = mkdtempSync(path.join(tmpdir(), 'srs-bundle-'));
  writeFileSync(path.join(bundleDir, 'snapshot.json'), JSON.stringify(parent, null, 2));
  writeFileSync(path.join(bundleDir, 'review-request.json'), JSON.stringify({
    schemaVersion: 1, kind: 'partitioned-review-bundle', identity: parent.identity,
    manifest: parent.partitionManifest, parts: ['parts/part-001.review-request.json'], priorLedger: ledger,
  }, null, 2));
  return { bundleDir, snapshot: parent, ledger };
}

function responsesFile(snapshot: ReviewSnapshot): string {
  const parts = snapshot.partitionManifest!.partitions;
  const filePath = path.join(mkdtempSync(path.join(tmpdir(), 'srs-resp-')), 'responses.json');
  writeFileSync(filePath, JSON.stringify({
    schemaVersion: 1,
    kind: 'mock-review-provider',
    config: {
      schemaVersion: 1, provider: 'mock', modelId: loadTestPolicy().policy.model,
      contextTokens: 200_000, maxOutputTokens: 8_000,
      inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0, timeoutMs: 5_000,
    },
    steps: parts.map((partition) => ({
      partitionId: partition.id, phase: 'review', inputTokens: 120,
      reply: {
        text: JSON.stringify({ partitionId: partition.id, report: makeReport(projectPartition(snapshot, partition)) }),
        stopReason: 'end_turn', inputTokens: 100, outputTokens: 40,
      },
    })),
  }));
  return filePath;
}

test('mock end-to-end run writes synthetic artifacts and exits 0 on a clean gate', (): void => {
  const { bundleDir, snapshot } = fixture();
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'srs-cli-')), 'out');
  const result = cli(['--bundle', bundleDir, '--out', out, '--provider', 'mock', '--responses', responsesFile(snapshot), '--system-root', SYSTEM_ROOT]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.synthetic, true);
  assert.equal(summary.status, 'pass');
  assert.ok(existsSync(path.join(out, 'mock-report.json')));
  assert.equal(existsSync(path.join(out, 'report.json')), false);
  const execution = JSON.parse(readFileSync(path.join(out, 'execution.json'), 'utf8'));
  assert.equal(execution.synthetic, true);
});

test('mock review output cannot be recorded into operational state', (): void => {
  const { bundleDir, snapshot } = fixture();
  const outputDir = path.join(mkdtempSync(path.join(tmpdir(), 'srs-mock-record-out-')), 'out');
  const stateRoot = path.join(mkdtempSync(path.join(tmpdir(), 'srs-mock-record-state-')), 'state');
  const review = cli(['--bundle', bundleDir, '--out', outputDir, '--provider', 'mock', '--responses', responsesFile(snapshot), '--system-root', SYSTEM_ROOT]);
  assert.equal(review.status, 0, review.stderr + review.stdout);
  const reviewSummary = JSON.parse(review.stdout);
  assert.equal(reviewSummary.synthetic, true);
  const mockReportPath = path.join(outputDir, 'mock-report.json');
  assert.ok(existsSync(mockReportPath));
  assert.equal(JSON.parse(readFileSync(mockReportPath, 'utf8')).synthetic, true);

  const record = recordCli([
    'record', '--snapshot', path.join(outputDir, 'snapshot.json'), '--report', mockReportPath,
    '--state-root', stateRoot, '--system-root', SYSTEM_ROOT,
  ]);
  assert.equal(record.status, 1, record.stderr + record.stdout);
  assert.match(record.stderr, /Refusing to record synthetic review output/);

  const storePath = path.join(stateRoot, 'repos', ...ALLOWED_REPOSITORY.split('/'), 'prs', String(snapshot.identity.pullRequest));
  assert.equal(existsSync(path.join(storePath, 'journal.jsonl')), false);
  assert.equal(existsSync(path.join(storePath, 'ledger.json')), false);
  const runsPath = path.join(storePath, 'runs');
  assert.deepEqual(existsSync(runsPath) ? readdirSync(runsPath) : [], []);
});

test('flag validation refuses before any provider call', (): void => {
  const { bundleDir, snapshot } = fixture();
  const missing = cli(['--bundle', bundleDir, '--out', path.join(mkdtempSync(path.join(tmpdir(), 'x')), 'o'), '--provider', 'mock', '--system-root', SYSTEM_ROOT]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /requires --responses/);
  const forbidden = cli(['--bundle', bundleDir, '--out', path.join(mkdtempSync(path.join(tmpdir(), 'x')), 'o'), '--provider', 'mock', '--responses', responsesFile(snapshot), '--execute', '--system-root', SYSTEM_ROOT]);
  assert.equal(forbidden.status, 1);
  assert.match(forbidden.stderr, /forbids/);
  const badBedrock = cli(['--bundle', bundleDir, '--out', path.join(mkdtempSync(path.join(tmpdir(), 'x')), 'o'), '--provider', 'bedrock', '--system-root', SYSTEM_ROOT]);
  assert.equal(badBedrock.status, 3);
  assert.match(badBedrock.stderr, /requires --provider-config/);
});

test('a bundle whose request manifest does not match the parent is refused', (): void => {
  const { bundleDir } = fixture();
  const requestPath = path.join(bundleDir, 'review-request.json');
  const request = JSON.parse(readFileSync(requestPath, 'utf8'));
  request.manifest = { ...request.manifest, digest: 'f'.repeat(64) };
  writeFileSync(requestPath, JSON.stringify(request));
  const result = cli(['--bundle', bundleDir, '--out', path.join(mkdtempSync(path.join(tmpdir(), 'x')), 'o'), '--provider', 'mock', '--responses', '/tmp/none.json', '--system-root', SYSTEM_ROOT]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /do not match/);
});
