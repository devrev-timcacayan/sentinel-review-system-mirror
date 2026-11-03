import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReviewSnapshot } from '../src/contracts.ts';
import { loadPolicy } from '../src/policy.ts';
import { collectSnapshot, validateSnapshot } from '../src/snapshot.ts';

const SYSTEM_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ARTIFACT_ROOT = path.join(SYSTEM_ROOT, '.artifacts');
const SOURCE_REPOSITORY = path.join(ARTIFACT_ROOT, 'historical-source.git');
const EXECUTION_REPOSITORY = 'devrev-timcacayan/sentinel-mirror';
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const CASE_ID_PATTERN = /^pr-[0-9]+-[a-z-]+$/;

interface ReplayCase {
  id: string;
  pr: number;
  head: string;
  base: string;
}

interface PacketSummary {
  changedPaths: number;
  sourceEntries: number;
  dependencyEdges: number;
  complete: boolean;
  limitations: string[];
}

interface ReplayResult {
  id: string;
  status: 'prepared' | 'size-refused' | 'revision-unavailable' | 'error';
  baseline: PacketSummary | null;
  current?: PacketSummary;
  allCapturedSourcesMatchGit?: boolean;
  detail?: string;
}

function readCases(): ReplayCase[] {
  const input: unknown = JSON.parse(readFileSync(path.join(ARTIFACT_ROOT, 'historical-selection.json'), 'utf8'));
  assert.ok(typeof input === 'object' && input !== null && 'cases' in input && Array.isArray(input.cases));
  const cases: ReplayCase[] = [];
  for (const item of input.cases as unknown[]) {
    assert.ok(typeof item === 'object' && item !== null);
    assert.ok('id' in item && typeof item.id === 'string' && CASE_ID_PATTERN.test(item.id));
    assert.ok('pr' in item && typeof item.pr === 'number' && Number.isSafeInteger(item.pr) && item.pr > 0);
    assert.ok('head' in item && typeof item.head === 'string' && SHA_PATTERN.test(item.head));
    assert.ok('base' in item && typeof item.base === 'string' && SHA_PATTERN.test(item.base));
    cases.push({ id: item.id, pr: item.pr, head: item.head, base: item.base });
  }
  return cases;
}

function hasCommit(sha: string): boolean {
  return spawnSync('git', ['-C', SOURCE_REPOSITORY, 'cat-file', '-e', `${sha}^{commit}`]).status === 0;
}

function readBaselines(): Map<string, PacketSummary> {
  const input: unknown = JSON.parse(readFileSync(path.join(ARTIFACT_ROOT, 'historical-packet-checks.json'), 'utf8'));
  assert.ok(typeof input === 'object' && input !== null && 'cases' in input && Array.isArray(input.cases));
  const baselines = new Map<string, PacketSummary>();
  for (const item of input.cases as unknown[]) {
    assert.ok(typeof item === 'object' && item !== null && 'status' in item);
    if (item.status !== 'packet-source-validated') continue;
    assert.ok('id' in item && typeof item.id === 'string');
    assert.ok('changedPaths' in item && typeof item.changedPaths === 'number');
    assert.ok('sourceEntries' in item && typeof item.sourceEntries === 'number');
    assert.ok('dependencyEdges' in item && typeof item.dependencyEdges === 'number');
    assert.ok('snapshotComplete' in item && typeof item.snapshotComplete === 'boolean');
    assert.ok('limitations' in item && Array.isArray(item.limitations) && item.limitations.every((value: unknown): boolean => typeof value === 'string'));
    baselines.set(item.id, {
      changedPaths: item.changedPaths,
      sourceEntries: item.sourceEntries,
      dependencyEdges: item.dependencyEdges,
      complete: item.snapshotComplete,
      limitations: item.limitations,
    });
  }
  return baselines;
}

function summarize(snapshot: ReviewSnapshot): PacketSummary {
  return {
    changedPaths: snapshot.changes.length,
    sourceEntries: snapshot.files.length,
    dependencyEdges: snapshot.dependencyEdges.length,
    complete: snapshot.complete,
    limitations: snapshot.limitations,
  };
}

function verifySources(snapshot: ReviewSnapshot): void {
  for (const source of snapshot.files) {
    const sha = source.revision === 'head' ? snapshot.identity.headSha : snapshot.identity.mergeBaseSha;
    const expected = execFileSync('git', ['-C', SOURCE_REPOSITORY, 'cat-file', 'blob', `${sha}:${source.path}`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(source.content, expected, `Source differs from ${sha}:${source.path}`);
  }
  if (snapshot.complete) {
    const captured = new Set(snapshot.files.map((source): string => source.path));
    for (const edge of snapshot.dependencyEdges) {
      assert.ok(captured.has(edge.from) && captured.has(edge.to), `Complete snapshot has unavailable edge ${edge.from} -> ${edge.to}`);
    }
  }
}

function main(): void {
  assert.ok(existsSync(SOURCE_REPOSITORY), 'Historical Git object store is required; this tool never fetches.');
  const loaded = loadPolicy(SYSTEM_ROOT);
  const outputRoot = path.join(ARTIFACT_ROOT, `context-replay-${loaded.digest.slice(0, 16)}`);
  const baselines = readBaselines();
  mkdirSync(outputRoot);
  const results: ReplayResult[] = [];
  for (const item of readCases()) {
    const baseline = baselines.get(item.id) ?? null;
    if (!hasCommit(item.head) || !hasCommit(item.base)) {
      results.push({ id: item.id, status: 'revision-unavailable', baseline, detail: 'Exact selected head or base is unavailable. No substitution made.' });
      continue;
    }
    try {
      const snapshot = collectSnapshot({
        checkout: SOURCE_REPOSITORY,
        repository: EXECUTION_REPOSITORY,
        pullRequest: item.pr,
        baseRef: item.base,
        headRef: item.head,
        runId: `context-${item.id}`,
      }, loaded);
      validateSnapshot(snapshot, loaded);
      assert.equal(snapshot.identity.headSha, item.head);
      assert.equal(snapshot.identity.baseSha, item.base);
      assert.equal(snapshot.identity.policyDigest, loaded.digest);
      const mergeBaseSha = execFileSync('git', ['-C', SOURCE_REPOSITORY, 'merge-base', item.base, item.head], { encoding: 'utf8' }).trim();
      assert.equal(snapshot.identity.mergeBaseSha, mergeBaseSha);
      verifySources(snapshot);
      const caseRoot = path.join(outputRoot, item.id);
      mkdirSync(caseRoot);
      writeFileSync(path.join(caseRoot, 'snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx' });
      results.push({ id: item.id, status: 'prepared', baseline, current: summarize(snapshot), allCapturedSourcesMatchGit: true });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const sizeRefused = /^Preparation refused: cumulative PR has \d+ changed lines, exceeding the agreed 1500-line limit\./.test(detail);
      results.push({ id: item.id, status: sizeRefused ? 'size-refused' : 'error', baseline, detail });
    }
  }
  const report = {
    schemaVersion: 1,
    scope: 'Collector replay only. No model execution, semantic verdict, state mutation, or GitHub action.',
    sourceRepository: 'devrev/sentinel',
    executionRepository: EXECUTION_REPOSITORY,
    policyDigest: loaded.digest,
    limits: loaded.policy.limits,
    baselineScope: 'Previously captured pre-size-gate packet checks, read as frozen measurements and never recomputed.',
    results,
  };
  writeFileSync(path.join(outputRoot, 'results.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ outputRoot, ...report }, null, 2));
  if (results.some((result): boolean => result.status === 'error')) process.exitCode = 1;
}

main();
