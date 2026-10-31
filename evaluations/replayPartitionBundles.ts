import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PartitionedReviewReport, ReviewLedger, ReviewReport, ReviewSnapshot } from '../src/contracts.ts';
import { evaluateReview } from '../src/gate.ts';
import { projectPartition, validatePartitionManifest } from '../src/partitionContract.ts';
import { buildReviewBundle } from '../src/partitionPlanner.ts';
import { loadPolicy } from '../src/policy.ts';
import { collectSnapshot, validateSnapshot } from '../src/snapshot.ts';

const SYSTEM_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ARTIFACT_ROOT = path.join(SYSTEM_ROOT, '.artifacts');
const SOURCE_REPOSITORY = path.join(ARTIFACT_ROOT, 'historical-source.git');

interface HistoricalCase {
  id: string;
  pr: number;
  head: string;
  base: string;
}

interface BundleResult {
  id: string;
  status: 'source-bundle-prepared' | 'context-incomplete' | 'size-refused' | 'revision-unavailable' | 'error';
  identity?: ReviewSnapshot['identity'];
  changedLines?: number;
  uniqueSourceEntries?: number;
  uniqueSourceBytes?: number;
  totalPartitionSourceBytes?: number;
  partitions?: { id: string; sourceEntries: number; sourceBytes: number }[];
  allUniqueSourcesMatchGit?: boolean;
  syntheticGateProbe?: { allParts: string; missingOnePart: string; scope: string };
  detail?: string;
}

function readCases(): HistoricalCase[] {
  const input = JSON.parse(readFileSync(path.join(ARTIFACT_ROOT, 'historical-selection.json'), 'utf8')) as { cases: HistoricalCase[] };
  assert.ok(Array.isArray(input.cases));
  for (const item of input.cases) {
    assert.match(item.id, /^pr-[0-9]+-[a-z-]+$/);
    assert.ok(Number.isSafeInteger(item.pr) && item.pr > 0);
    assert.match(item.head, /^[0-9a-f]{40}$/);
    assert.match(item.base, /^[0-9a-f]{40}$/);
  }
  return input.cases;
}

function hasCommit(sha: string): boolean {
  return spawnSync('git', ['-C', SOURCE_REPOSITORY, 'cat-file', '-e', `${sha}^{commit}`]).status === 0;
}

function verifySourceObjects(snapshot: ReviewSnapshot): void {
  for (const source of snapshot.files) {
    const sha = source.revision === 'head' ? snapshot.identity.headSha : snapshot.identity.mergeBaseSha;
    const expected = execFileSync('git', ['-C', SOURCE_REPOSITORY, 'cat-file', 'blob', `${sha}:${source.path}`], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(source.content, expected, `Captured source differs from ${sha}:${source.path}`);
  }
}

function sourceBytes(snapshot: ReviewSnapshot): number {
  return snapshot.files.reduce((total, source): number => total + Buffer.byteLength(source.content), 0);
}

function syntheticReport(snapshot: ReviewSnapshot): ReviewReport {
  return {
    schemaVersion: 1,
    identity: structuredClone(snapshot.identity),
    ...(snapshot.partitionScope ? { partitionScope: structuredClone(snapshot.partitionScope) } : {}),
    complete: true,
    limitations: [],
    findings: [],
    reconciliations: [],
    coverage: snapshot.changes.flatMap((change) => {
      const own = new Set([change.path, ...(change.previousPath ? [change.previousPath] : [])]);
      const relatedPaths = [...new Set([
        ...snapshot.dependencyEdges.flatMap((edge): string[] => [
          ...(own.has(edge.from) ? [edge.to] : []),
          ...(own.has(edge.to) ? [edge.from] : []),
        ]),
        ...snapshot.files.map((file): string => file.path),
      ].filter((filePath): boolean => !own.has(filePath)))].sort();
      return (['test-validity', 'reliability-impact', 'maintainability'] as const).map((dimension) => ({
        path: change.path,
        dimension,
        assessment: 'reviewed' as const,
        rationale: 'Synthetic structural gate probe only. No semantic review was executed.',
        relatedPaths,
      }));
    }),
  };
}

function main(): void {
  assert.ok(existsSync(SOURCE_REPOSITORY), 'Local historical Git objects required; this tool never fetches.');
  const loaded = loadPolicy(SYSTEM_ROOT);
  const priorMeasurements: unknown = JSON.parse(readFileSync(path.join(SYSTEM_ROOT, 'evaluations/context-planner-results.json'), 'utf8'));
  const outputRoot = path.join(ARTIFACT_ROOT, `partition-replay-${loaded.digest.slice(0, 16)}`);
  mkdirSync(outputRoot);
  const results: BundleResult[] = [];
  for (const item of readCases()) {
    if (!hasCommit(item.head) || !hasCommit(item.base)) {
      results.push({ id: item.id, status: 'revision-unavailable', detail: 'Exact selected revision unavailable. No substitution.' });
      continue;
    }
    try {
      const parent = collectSnapshot({
        checkout: SOURCE_REPOSITORY,
        repository: 'devrev-timcacayan/sentinel-mirror',
        pullRequest: item.pr,
        baseRef: item.base,
        headRef: item.head,
        runId: `partition-${item.id}`,
      }, loaded, 'bundle');
      assert.equal(parent.identity.headSha, item.head);
      assert.equal(parent.identity.baseSha, item.base);
      assert.equal(parent.identity.policyDigest, loaded.digest);
      const mergeBase = execFileSync('git', ['-C', SOURCE_REPOSITORY, 'merge-base', item.base, item.head], { encoding: 'utf8' }).trim();
      assert.equal(parent.identity.mergeBaseSha, mergeBase);
      verifySourceObjects(parent);
      const caseRoot = path.join(outputRoot, item.id);
      mkdirSync(caseRoot);
      if (!parent.complete || parent.limitations.length > 0) {
        writeFileSync(path.join(caseRoot, 'diagnostic-snapshot.json'), `${JSON.stringify(parent, null, 2)}\n`, { flag: 'wx' });
        results.push({
          id: item.id, status: 'context-incomplete', identity: parent.identity,
          changedLines: parent.size.changedLines, uniqueSourceEntries: parent.files.length,
          uniqueSourceBytes: sourceBytes(parent), allUniqueSourcesMatchGit: true,
          detail: parent.limitations.join('\n'),
        });
        continue;
      }
      const snapshot = buildReviewBundle(parent, loaded.policy);
      validateSnapshot(snapshot, loaded);
      validatePartitionManifest(snapshot, loaded.policy);
      const partitions = snapshot.partitionManifest!.partitions;
      const envelope: PartitionedReviewReport = {
        schemaVersion: 1, kind: 'partitioned-review', manifestDigest: snapshot.partitionManifest!.digest,
        synthetic: true,
        reports: partitions.map((partition) => ({
          partitionId: partition.id, report: syntheticReport(projectPartition(snapshot, partition)),
        })),
      };
      const previous: ReviewLedger = {
        schemaVersion: 1, repository: snapshot.identity.repository, pullRequest: snapshot.identity.pullRequest,
        lastHeadSha: null, openFindings: [],
      };
      const complete = evaluateReview(snapshot, envelope, previous, loaded.policy);
      assert.equal(complete.status, 'pass', `Synthetic all-parts probe: ${complete.reasons.join('; ')}`);
      const partial = structuredClone(envelope);
      partial.reports.pop();
      const missing = evaluateReview(snapshot, partial, previous, loaded.policy);
      assert.equal(missing.status, 'incomplete', 'Missing-part structural probe must stay incomplete.');
      const measurements = partitions.map((partition) => {
        const projected = projectPartition(snapshot, partition);
        assert.ok(projected.files.length <= loaded.policy.limits.maxFiles);
        assert.ok(sourceBytes(projected) <= loaded.policy.limits.maxSourceBytes);
        assert.equal(evaluateReview(projected, syntheticReport(projected), previous, loaded.policy).status, 'incomplete');
        writeFileSync(path.join(caseRoot, `${partition.id}.snapshot.json`), `${JSON.stringify(projected, null, 2)}\n`, { flag: 'wx' });
        return { id: partition.id, sourceEntries: projected.files.length, sourceBytes: sourceBytes(projected) };
      });
      writeFileSync(path.join(caseRoot, 'snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx' });
      writeFileSync(path.join(caseRoot, 'synthetic-reports.json'), `${JSON.stringify(envelope, null, 2)}\n`, { flag: 'wx' });
      results.push({
        id: item.id, status: 'source-bundle-prepared', identity: snapshot.identity,
        changedLines: snapshot.size.changedLines, uniqueSourceEntries: snapshot.files.length,
        uniqueSourceBytes: sourceBytes(snapshot),
        totalPartitionSourceBytes: measurements.reduce((total, part): number => total + part.sourceBytes, 0),
        partitions: measurements, allUniqueSourcesMatchGit: true,
        syntheticGateProbe: {
          allParts: complete.status, missingOnePart: missing.status,
          scope: 'Synthetic contract checks only. Neither result is a semantic review or approval.',
        },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const status = /^Preparation refused: cumulative PR has \d+ changed lines, exceeding the agreed /.test(detail)
        ? 'size-refused'
        : detail.startsWith('Partition preparation incomplete:') ? 'context-incomplete' : 'error';
      results.push({ id: item.id, status, detail });
    }
  }
  const report = {
    schemaVersion: 1,
    scope: 'Local source-bundle preparation and synthetic structural gate probes. No model, semantic review, state mutation, or GitHub action.',
    policyDigest: loaded.digest,
    limits: loaded.policy.limits,
    budgetSemantics: 'maxFiles per model packet; maxSourceBytes across unique parent sources. Shared context repeats across packets.',
    priorMeasurements,
    results,
  };
  writeFileSync(path.join(outputRoot, 'results.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ outputRoot, ...report }, null, 2));
  if (results.some((result): boolean => result.status === 'error')) process.exitCode = 1;
}

main();
