import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildReviewBundle } from '../src/partitionPlanner.ts';
import { projectPartition, sourceKey } from '../src/partitionContract.ts';
import { ALLOWED_REPOSITORY, SYSTEM_ROOT, loadTestPolicy, makeRepo, makeReport, seedPolicyContext } from './helpers.ts';
import type { ReviewPolicy, ReviewSnapshot, SourceFile } from '../src/contracts.ts';

const CLI = path.resolve(fileURLToPath(new URL('../src/cli.ts', import.meta.url)));

function makePolicy(maxFiles = 4, maxSourceBytes = 4_000_000): ReviewPolicy {
  return {
    schemaVersion: 1,
    repositories: [ALLOWED_REPOSITORY],
    model: 'test-model',
    dimensions: ['test-validity', 'reliability-impact', 'maintainability'],
    limits: { maxFiles, maxSourceBytes, maxDiffBytes: 1_000_000, warnChangedLines: 800, blockChangedLines: 1500 },
    contextPaths: [],
    rules: [],
  };
}

const file = (filePath: string, revision: 'base' | 'head', content = 'export const x = 1;\n'): SourceFile =>
  ({ path: filePath, revision, content });

function makeSnapshot(overrides: Partial<ReviewSnapshot> = {}): ReviewSnapshot {
  const files: SourceFile[] = [
    file('src/a.ts', 'base', 'export const a = 1;\n'),
    file('src/a.ts', 'head', 'export const a = 2;\n'),
    file('src/b.ts', 'head', 'import { a } from "./a";\nexport const b = a;\n'),
    file('src/c.ts', 'head', 'import { a } from "./a";\nexport const c = a;\n'),
    file('src/d.ts', 'head', 'import { c } from "./c";\nexport const d = c;\n'),
  ];
  return {
    schemaVersion: 1,
    identity: {
      repository: ALLOWED_REPOSITORY,
      pullRequest: 5,
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      mergeBaseSha: 'b'.repeat(40),
      policyDigest: 'c'.repeat(64),
      model: 'test-model',
      runId: 'run-1',
    },
    previousHeadSha: null,
    changes: [{ path: 'src/a.ts', status: 'modified' }],
    size: { changedLines: 1, warnChangedLines: 800, blockChangedLines: 1500, outcome: 'within_threshold' },
    files,
    dependencyEdges: [
      { from: 'src/b.ts', to: 'src/a.ts' },
      { from: 'src/c.ts', to: 'src/a.ts' },
      { from: 'src/d.ts', to: 'src/c.ts' },
    ],
    contextPlan: {
      strategy: 'symbol-aware-reverse-v1',
      selections: [
        { path: 'src/a.ts', reasons: ['changed'] },
        { path: 'src/b.ts', reasons: ['caller of src/a.ts'] },
        { path: 'src/c.ts', reasons: ['caller of src/a.ts'] },
        { path: 'src/d.ts', reasons: ['forward-dependency'] },
      ],
      fallbacks: [],
    },
    cumulativeDiff: '-a1\n+a2\n',
    deltaDiff: null,
    complete: true,
    limitations: [],
    ...overrides,
  };
}

test('deterministic dependency-closed grouping covers every source key without exceeding maxFiles', (): void => {
  const policy = makePolicy(4);
  const first = buildReviewBundle(makeSnapshot(), policy);
  const second = buildReviewBundle(makeSnapshot(), policy);
  const manifest = first.partitionManifest;
  assert.ok(manifest, 'manifest must be attached');
  assert.deepEqual(manifest, second.partitionManifest, 'planning must be deterministic');
  assert.equal(manifest.partitions.length, 2);
  const allKeys = new Set(makeSnapshot().files.map(sourceKey));
  const covered = new Set(manifest.partitions.flatMap((partition) => partition.sourceKeys));
  assert.deepEqual([...covered].sort(), [...allKeys].sort(), 'every parent source key must be assigned');
  for (const partition of manifest.partitions) {
    assert.ok(partition.sourceKeys.length <= 4, 'no partition exceeds maxFiles');
    for (const shared of manifest.sharedSourceKeys) {
      assert.ok(partition.sourceKeys.includes(shared), 'required shared context must appear in every part');
    }
  }
  assert.deepEqual(manifest.sharedSourceKeys, ['base:src/a.ts', 'head:src/a.ts']);
});

test('shared set includes changed before/after and forward closure of changed paths', (): void => {
  const policy = makePolicy(10);
  const snapshot = makeSnapshot({
    files: [
      file('src/a.ts', 'base'), file('src/a.ts', 'head'),
      file('src/dep.ts', 'base'), file('src/dep.ts', 'head'),
    ],
    dependencyEdges: [{ from: 'src/a.ts', to: 'src/dep.ts' }],
    contextPlan: { strategy: 'symbol-aware-reverse-v1', selections: [{ path: 'src/a.ts', reasons: ['changed'] }], fallbacks: [] },
  });
  const manifest = buildReviewBundle(snapshot, policy).partitionManifest;
  assert.ok(manifest);
  assert.deepEqual(manifest.sharedSourceKeys.sort(), ['base:src/a.ts', 'base:src/dep.ts', 'head:src/a.ts', 'head:src/dep.ts'].sort());
  assert.equal(manifest.partitions.length, 1, 'everything fitting in shared plus units yields one part');
});

test('prior-finding context paths are part of required shared keys', (): void => {
  const policy = makePolicy(10);
  const snapshot = makeSnapshot();
  snapshot.contextPlan.selections.push({ path: 'src/finding.ts', reasons: ['prior-finding-context'] });
  snapshot.files.push(file('src/finding.ts', 'head'));
  const manifest = buildReviewBundle(snapshot, policy).partitionManifest;
  assert.ok(manifest?.sharedSourceKeys.includes('head:src/finding.ts'));
});

test('one unsplittable root unit refuses with the explicit root and required count', (): void => {
  const policy = makePolicy(3);
  assert.throws(
    () => buildReviewBundle(makeSnapshot(), policy),
    /Partition preparation incomplete: context root src\/d\.ts requires 4 source entries, exceeding maxFiles 3\./,
  );
});

test('incomplete or limited parent, projected partition, and oversized parents refuse', (): void => {
  const policy = makePolicy(4);
  assert.throws(
    () => buildReviewBundle(makeSnapshot({ complete: false, limitations: ['Context budget exhausted'] }), policy),
    /Partition preparation incomplete: parent snapshot is incomplete/,
  );
  const projected = makeSnapshot();
  projected.partitionScope = { manifestDigest: 'f'.repeat(64), partitionId: 'part-001' };
  assert.throws(() => buildReviewBundle(projected, policy), /projected partition/);
  const huge = makeSnapshot({ files: [file('src/a.ts', 'head', 'x'.repeat(4_000_001))] });
  assert.throws(() => buildReviewBundle(huge, policy), /exceeding the 4000000-byte budget/);
});

test('input snapshot object is not mutated by planning', (): void => {
  const snapshot = makeSnapshot();
  buildReviewBundle(snapshot, makePolicy(4));
  assert.equal(snapshot.partitionManifest, undefined);
  assert.equal(snapshot.partitionScope, undefined);
});

test('projected parts stay within maxFiles and carry no full parent source', (): void => {
  const policy = makePolicy(4);
  const parent = buildReviewBundle(makeSnapshot(), policy);
  const manifest = parent.partitionManifest;
  assert.ok(manifest);
  for (const partition of manifest.partitions) {
    const projected = projectPartition(parent, partition);
    assert.ok(projected.files.length <= 4);
    assert.ok(projected.files.every((file) => partition.sourceKeys.includes(sourceKey(file))));
    assert.equal(projected.partitionManifest, undefined);
    assert.equal(projected.partitionScope?.manifestDigest, manifest.digest);
    assert.equal(projected.partitionScope?.partitionId, partition.id);
    assert.ok(
      projected.files.length < parent.files.length || manifest.partitions.length === 1,
      'a projected part never re-embeds the whole parent',
    );
  }
});

test('prepare-bundle writes bounded part requests, manifest request, and full operator snapshot', (): void => {
  const repo = makeRepo();
  seedPolicyContext(repo, loadTestPolicy());
  repo.write('src/a.ts', 'export const a = 1;\n');
  repo.write('src/b.ts', 'import { a } from "./a";\nexport const b = a;\n');
  repo.write('src/c.ts', 'import { a } from "./a";\nexport const c = a;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  repo.write('src/a.ts', 'export const a = 2;\n');
  repo.commit('head');
  repo.git(['branch', '-f', 'head', 'HEAD']);
  const out = path.join(repo.dir, '.out-bundle');
  const args = ['prepare-bundle', '--checkout', repo.dir, '--repository', ALLOWED_REPOSITORY, '--pr', '9', '--base', 'base', '--head', 'head', '--run-id', 'bundle-1', '--out', out, '--state-root', path.join(repo.dir, '.state-test'), '--system-root', SYSTEM_ROOT];
  const first = spawnSync(process.execPath, ['--experimental-strip-types', CLI, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(first.status, 0, first.stderr);
  const summary = JSON.parse(first.stdout);
  assert.equal(summary.status, 'prepared');
  assert.equal(summary.kind, 'partitioned-review-bundle');
  const request = JSON.parse(readFileSync(path.join(out, 'review-request.json'), 'utf8'));
  assert.equal(request.kind, 'partitioned-review-bundle');
  assert.ok(Array.isArray(request.parts) && request.parts.length >= 1);
  assert.equal(request.snapshot, undefined, 'manifest request must not embed the parent snapshot');
  const parent = JSON.parse(readFileSync(path.join(out, 'snapshot.json'), 'utf8'));
  assert.ok(parent.partitionManifest, 'operator snapshot carries the manifest');
  for (const partPath of request.parts) {
    const part = JSON.parse(readFileSync(partPath, 'utf8'));
    assert.equal(part.kind, 'partition-review-request');
    assert.match(part.partitionId, /^part-\d{3}$/);
    assert.equal(part.manifestDigest, parent.partitionManifest.digest);
    assert.ok(part.snapshot.files.length <= 200, 'each part payload stays within the per-packet maxFiles budget');
    assert.ok(part.snapshot.files.length < parent.files.length || parent.partitionManifest.partitions.length === 1);
    assert.ok(part.snapshot.partitionScope);
    assert.ok(part.prompt.includes('\n\n'));
  }
  const second = spawnSync(process.execPath, ['--experimental-strip-types', CLI, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(second.status, 0, second.stderr);
  const secondSummary = JSON.parse(second.stdout);
  assert.equal(secondSummary.snapshot.result, 'unchanged', 're-preparation must be idempotent');
});

test('prepare-bundle exits 3 and writes no model requests when the parent is incomplete', (): void => {
  const repo = makeRepo();
  repo.write('src/a.ts', 'import { missing } from "./missing";\nexport const a = missing;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  repo.write('src/a.ts', 'import { missing } from "./missing";\nexport const a = 2;\n');
  repo.commit('head');
  repo.git(['branch', '-f', 'head', 'HEAD']);
  const out = path.join(repo.dir, '.out-incomplete');
  const result = spawnSync(process.execPath, ['--experimental-strip-types', CLI,
    'prepare-bundle', '--checkout', repo.dir, '--repository', ALLOWED_REPOSITORY, '--pr', '9',
    '--base', 'base', '--head', 'head', '--run-id', 'bundle-bad', '--out', out, '--state-root', path.join(repo.dir, '.state-test'), '--system-root', SYSTEM_ROOT],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(result.status, 3, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, 'incomplete');
  assert.ok(summary.limitations.length > 0);
  assert.equal(existsSync(path.join(out, 'review-request.json')), false, 'no model request may be published');
  assert.equal(existsSync(path.join(out, 'snapshot.json')), false);
});

const CLI_ARGS = ['--experimental-strip-types', CLI] as const;

function cli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const checkoutIndex = args.indexOf('--checkout');
  const isolated = [...args];
  if (checkoutIndex >= 0 && !args.includes('--state-root')) {
    isolated.push('--state-root', path.join(args[checkoutIndex + 1] as string, '.state-test'));
  }
  return spawnSync(process.execPath, [...CLI_ARGS, ...isolated], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function makeBundleRepo(): { dir: string; git: (args: string[]) => unknown } {
  const repo = makeRepo();
  seedPolicyContext(repo, loadTestPolicy());
  repo.write('src/root.ts', 'export const root = 1;\n');
  for (let index = 1; index <= 205; index += 1) {
    repo.write(`tests/caller${String(index).padStart(3, '0')}.ts`, `import { root } from "../src/root";\nexport const seen${index} = root;\n`);
  }
  repo.commit('base');
  repo.git(['branch', 'base']);
  repo.write('src/root.ts', 'export const root = 2;\n');
  repo.commit('head');
  repo.git(['branch', '-f', 'head', 'HEAD']);
  return repo;
}

test('bundle partitions a >200-file selection; ordinary prepare stays incomplete', (): void => {
  const repo = makeBundleRepo();
  const single = cli(['prepare', '--checkout', repo.dir, '--repository', ALLOWED_REPOSITORY, '--pr', '11', '--base', 'base', '--head', 'head', '--run-id', 'p-single', '--out', path.join(repo.dir, '.out-single'), '--system-root', SYSTEM_ROOT]);
  assert.equal(single.status, 0, single.stderr);
  assert.equal(JSON.parse(single.stdout).complete, false, 'ordinary prepare must stay incomplete beyond maxFiles');

  const out = path.join(repo.dir, '.out-bundle-big');
  const bundle = cli(['prepare-bundle', '--checkout', repo.dir, '--repository', ALLOWED_REPOSITORY, '--pr', '11', '--base', 'base', '--head', 'head', '--run-id', 'p-bundle', '--out', out, '--system-root', SYSTEM_ROOT]);
  assert.equal(bundle.status, 0, bundle.stderr);
  const summary = JSON.parse(bundle.stdout);
  assert.ok(summary.partCount >= 2, 'expected at least two part requests');
  const parent = JSON.parse(readFileSync(path.join(out, 'snapshot.json'), 'utf8'));
  const manifest = parent.partitionManifest;
  const parentKeys = new Set(parent.files.map((file: SourceFile) => sourceKey(file)));
  const covered = new Set<string>();
  const policyFiles = loadTestPolicy().policy.contextPaths;
  const request = JSON.parse(readFileSync(path.join(out, 'review-request.json'), 'utf8'));
  for (const partPath of request.parts) {
    const part = JSON.parse(readFileSync(partPath, 'utf8'));
    assert.ok(part.snapshot.files.length <= 200, 'part payload within per-packet budget');
    assert.ok(part.snapshot.partitionScope, 'part payload carries partition scope');
    assert.equal(part.snapshot.partitionManifest, undefined, 'part payload never embeds the parent manifest');
    const keys = new Set<string>((part.snapshot.files as SourceFile[]).map((file: SourceFile): string => sourceKey(file)));
    assert.ok(keys.has('head:src/root.ts') && keys.has('base:src/root.ts'), 'both changed root revisions shared');
    for (const contextPath of policyFiles) assert.ok(keys.has(`base:${contextPath}`), `policy context ${contextPath} shared`);
    for (const key of keys) covered.add(key);
  }
  assert.deepEqual([...covered].sort(), [...parentKeys].sort(), 'membership union covers the full parent');
});

test('partial envelope stays incomplete; full envelope records once and replays idempotently', (): void => {
  const repo = makeBundleRepo();
  const stateRoot = path.join(repo.dir, '.state-test');
  const out1 = path.join(repo.dir, '.out-env1');
  assert.equal(cli(['prepare-bundle', '--checkout', repo.dir, '--repository', ALLOWED_REPOSITORY, '--pr', '12', '--base', 'base', '--head', 'head', '--run-id', 'env-1', '--out', out1, '--state-root', stateRoot, '--system-root', SYSTEM_ROOT]).status, 0);
  const snapshotPath = path.join(out1, 'snapshot.json');
  const request = JSON.parse(readFileSync(path.join(out1, 'review-request.json'), 'utf8'));
  const manifestDigest = request.manifest.digest;
  const rows = request.parts.map((partPath: string) => {
    const part = JSON.parse(readFileSync(partPath, 'utf8'));
    return { partitionId: part.partitionId as string, report: makeReport(part.snapshot) };
  });
  const envelope = { schemaVersion: 1, kind: 'partitioned-review', manifestDigest, reports: rows };
  const partial = { ...envelope, reports: rows.slice(0, -1) };
  const envelopePath = path.join(out1, 'envelope.json');
  writeFileSync(envelopePath, JSON.stringify(partial, null, 2));
  const partialRecord = cli(['record', '--snapshot', snapshotPath, '--report', envelopePath, '--state-root', stateRoot, '--system-root', SYSTEM_ROOT]);
  assert.equal(partialRecord.status, 3, `partial envelope must stay incomplete: ${partialRecord.stderr}`);
  const ledgerPath = path.join(stateRoot, 'repos', 'devrev-timcacayan', 'sentinel-mirror', 'prs', '12', 'ledger.json');
  assert.equal(JSON.parse(readFileSync(ledgerPath, 'utf8')).lastHeadSha, null, 'partial envelope cannot advance the ledger head');

  const out2 = path.join(repo.dir, '.out-env2');
  assert.equal(cli(['prepare-bundle', '--checkout', repo.dir, '--repository', ALLOWED_REPOSITORY, '--pr', '12', '--base', 'base', '--head', 'head', '--run-id', 'env-2', '--out', out2, '--state-root', stateRoot, '--system-root', SYSTEM_ROOT]).status, 0);
  const snapshotPath2 = path.join(out2, 'snapshot.json');
  const request2 = JSON.parse(readFileSync(path.join(out2, 'review-request.json'), 'utf8'));
  const rows2 = request2.parts.map((partPath: string) => {
    const part = JSON.parse(readFileSync(partPath, 'utf8'));
    return { partitionId: part.partitionId as string, report: makeReport(part.snapshot) };
  });
  const envelopePath2 = path.join(out2, 'envelope.json');
  writeFileSync(envelopePath2, JSON.stringify({ schemaVersion: 1, kind: 'partitioned-review', manifestDigest: request2.manifest.digest, reports: rows2 }, null, 2));
  const fullRecord = cli(['record', '--snapshot', snapshotPath2, '--report', envelopePath2, '--state-root', stateRoot, '--system-root', SYSTEM_ROOT]);
  assert.equal(fullRecord.status, 0, `full mock envelope should pass: ${fullRecord.stderr}${fullRecord.stdout}`);
  const parent2 = JSON.parse(readFileSync(snapshotPath2, 'utf8'));
  assert.equal(JSON.parse(readFileSync(ledgerPath, 'utf8')).lastHeadSha, parent2.identity.headSha, 'one global ledger head persisted');
  const replay = cli(['record', '--snapshot', snapshotPath2, '--report', envelopePath2, '--state-root', stateRoot, '--system-root', SYSTEM_ROOT]);
  assert.equal(replay.status, 0, 'replayed identical envelope is an idempotent no-op');
});

test('prepare-bundle refuses before publishing when the change exceeds 1500 lines', (): void => {
  const repo = makeRepo();
  seedPolicyContext(repo, loadTestPolicy());
  repo.write('src/a.ts', 'export const a = 1;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  repo.write('src/big.ts', `${'export const line = 1;\n'.repeat(1501)}`);
  repo.commit('head');
  repo.git(['branch', '-f', 'head', 'HEAD']);
  const out = path.join(repo.dir, '.out-oversized');
  const result = cli(['prepare-bundle', '--checkout', repo.dir, '--repository', ALLOWED_REPOSITORY, '--pr', '13', '--base', 'base', '--head', 'head', '--run-id', 'big', '--out', out, '--system-root', SYSTEM_ROOT]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /1500-line limit|exceeding the agreed/);
  assert.equal(existsSync(path.join(out, 'snapshot.json')), false, 'no operator snapshot may be published');
  assert.equal(existsSync(path.join(out, 'review-request.json')), false);
});
