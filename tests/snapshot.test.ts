import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { collectSnapshot, validateSnapshot } from '../src/snapshot.ts';
import { ALLOWED_REPOSITORY, loadTestPolicy, makeRepo, seedPolicyContext } from './helpers.ts';
import type { RepoFixture } from './helpers.ts';

const PR = 42;

function baseOptions(repo: RepoFixture, overrides: Record<string, unknown> = {}) {
  return {
    checkout: repo.dir,
    repository: ALLOWED_REPOSITORY,
    pullRequest: PR,
    baseRef: 'base',
    headRef: 'head',
    runId: 'run-snapshot',
    ...overrides,
  };
}

test('cumulative diff covers merge base to head while delta covers only the latest push', (): void => {
  const repo = makeRepo();
  repo.write('src/a.ts', 'export const a = 1;\n');
  repo.write('src/b.ts', 'export const b = 1;\n');
  const base = repo.commit('base');
  repo.git(['branch', 'base']);
  repo.write('src/a.ts', 'export const a = 2;\n');
  const head1 = repo.commit('first push');
  repo.write('src/b.ts', 'export const b = 2;\n');
  const head2 = repo.commit('second push');
  repo.git(['branch', '-f', 'head', 'HEAD']);
  void head1; void head2;
  const snapshot = collectSnapshot(baseOptions(repo, { previousHeadRef: head1 }), loadTestPolicy({ contextPaths: [] }));
  assert.equal(snapshot.identity.mergeBaseSha, base);
  assert.match(snapshot.cumulativeDiff, /src\/a\.ts/);
  assert.match(snapshot.cumulativeDiff, /src\/b\.ts/);
  assert.ok(snapshot.deltaDiff !== null);
  assert.doesNotMatch(snapshot.deltaDiff as string, /src\/a\.ts/);
  assert.match(snapshot.deltaDiff as string, /src\/b\.ts/);
  assert.equal(snapshot.previousHeadSha, head1);
  assert.equal(snapshot.complete, true);
});

test('unchanged reverse caller is captured through the import graph', (): void => {
  const repo = makeRepo();
  repo.write('src/dep.ts', 'export const value = 1;\n');
  repo.write('src/caller.ts', 'import { value } from "./dep";\nexport const seen = value;\n');
  const base = repo.commit('base');
  repo.git(['branch', 'base']);
  repo.write('src/dep.ts', 'export const value = 2;\n');
  repo.commit('change dep');
  repo.git(['branch', '-f', 'head', 'HEAD']);
  void base;
  const snapshot = collectSnapshot(baseOptions(repo), loadTestPolicy({ contextPaths: [] }));
  const caller = snapshot.files.find((file) => file.path === 'src/caller.ts' && file.revision === 'head');
  assert.ok(caller, 'unchanged caller must be included as head context');
  assert.match(caller.content, /seen = value/);
  assert.ok(snapshot.dependencyEdges.some((edge) => edge.from === 'src/caller.ts' && edge.to === 'src/dep.ts'));
});

test('tsconfig path aliases and re-export chains resolve transitively', (): void => {
  const repo = makeRepo();
  repo.write('tsconfig.json', '{"compilerOptions":{"paths":{"@app/*":["./src/*"]}}}\n');
  repo.write('src/leaf.ts', 'export const leaf = 1;\n');
  repo.write('src/mid.ts', 'export * from "./leaf";\n');
  repo.write('src/top.ts', 'import { leaf } from "@app/mid";\nexport const top = leaf;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  repo.write('src/leaf.ts', 'export const leaf = 2;\n');
  repo.commit('change leaf');
  repo.git(['branch', '-f', 'head', 'HEAD']);
  const snapshot = collectSnapshot(baseOptions(repo), loadTestPolicy({ contextPaths: [] }));
  assert.ok(snapshot.dependencyEdges.some((edge) => edge.from === 'src/top.ts' && edge.to === 'src/mid.ts'));
  assert.ok(snapshot.dependencyEdges.some((edge) => edge.from === 'src/mid.ts' && edge.to === 'src/leaf.ts'));
  assert.ok(snapshot.files.some((file) => file.path === 'src/top.ts'), 'reverse caller through alias must be captured');
  assert.ok(snapshot.files.some((file) => file.path === 'src/mid.ts'), 're-export hop must be captured');
});

test('deleted and renamed sources keep their before content and paths', (): void => {
  const repo = makeRepo();
  repo.write('src/victim.ts', 'export const victim = 1;\n');
  repo.write('src/old.ts', 'export const thing = 1;\nexport const other = 1;\nexport const more = 1;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  repo.remove('src/victim.ts');
  repo.git(['mv', 'src/old.ts', 'src/new.ts']);
  repo.write('src/new.ts', 'export const thing = 2;\nexport const other = 1;\nexport const more = 1;\n');
  repo.commit('delete and rename');
  repo.git(['branch', '-f', 'head', 'HEAD']);
  const snapshot = collectSnapshot(baseOptions(repo), loadTestPolicy({ contextPaths: [] }));
  const deleted = snapshot.changes.find((change) => change.path === 'src/victim.ts');
  const renamed = snapshot.changes.find((change) => change.path === 'src/new.ts');
  assert.equal(deleted?.status, 'deleted');
  assert.equal(renamed?.status, 'renamed');
  assert.equal(renamed?.previousPath, 'src/old.ts');
  assert.ok(snapshot.files.some((file) => file.path === 'src/victim.ts' && file.revision === 'base'));
  assert.ok(!snapshot.files.some((file) => file.path === 'src/victim.ts' && file.revision === 'head'));
  assert.ok(snapshot.files.some((file) => file.path === 'src/old.ts' && file.revision === 'base'));
  assert.ok(snapshot.files.some((file) => file.path === 'src/new.ts' && file.revision === 'head'));
});


test('document size thresholds warn above 800 and stop above 1500 cumulative changed lines', (): void => {
  const repoWithLines = (count: number): RepoFixture => {
    const repo = makeRepo();
    repo.write('src/large.ts', '');
    repo.commit('base');
    repo.git(['branch', 'base']);
    repo.write('src/large.ts', Array.from({ length: count }, (_value, index) => `export const line${index} = ${index};`).join('\n') + '\n');
    repo.commit('head');
    repo.git(['branch', '-f', 'head', 'HEAD']);
    return repo;
  };
  for (const [count, outcome] of [[800, 'within_threshold'], [801, 'split_recommended'], [1500, 'split_recommended']] as const) {
    const snapshot = collectSnapshot(baseOptions(repoWithLines(count)), loadTestPolicy({ contextPaths: [] }));
    assert.equal(snapshot.size.changedLines, count);
    assert.equal(snapshot.size.outcome, outcome);
  }
  const oversized = repoWithLines(1501);
  assert.throws(() => collectSnapshot(baseOptions(oversized), loadTestPolicy({ contextPaths: [] })), /exceeding the agreed 1500-line limit|No review packet/);
});

test('repository git attributes cannot classify text changes out of the size gate', (): void => {
  const small = makeRepo();
  small.write('.gitattributes', '*.ts -diff\n');
  small.write('src/a.ts', 'export const a = 1;\n');
  small.commit('base');
  small.git(['branch', 'base']);
  small.write('src/a.ts', 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n');
  small.commit('head');
  small.git(['branch', '-f', 'head', 'HEAD']);
  const counted = collectSnapshot(baseOptions(small), loadTestPolicy({ contextPaths: [] }));
  assert.equal(counted.size.changedLines, 2, 'attribute-marked text must still produce real line counts');

  const repo = makeRepo();
  repo.write('.gitattributes', '*.ts -diff\n');
  repo.write('src/large.ts', 'export const base = 1;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  repo.write('src/large.ts', `${'export const line = 1;\n'.repeat(1501)}`);
  repo.commit('head');
  repo.git(['branch', '-f', 'head', 'HEAD']);
  assert.throws(
    () => collectSnapshot(baseOptions(repo), loadTestPolicy({ contextPaths: [] })),
    /1500-line limit|exceeding the agreed/,
  );
});

test('uncommitted attribute sources cannot hide numeric counts either', (): void => {
  const repo = makeRepo();
  repo.write('src/large.ts', 'export const base = 1;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  writeFileSync(path.join(repo.dir, '.git', 'info', 'attributes'), '*.ts -diff\n');
  repo.write('src/large.ts', `${'export const line = 1;\n'.repeat(1501)}`);
  repo.commit('head');
  repo.git(['branch', '-f', 'head', 'HEAD']);
  assert.throws(
    () => collectSnapshot(baseOptions(repo), loadTestPolicy({ contextPaths: [] })),
    /no changed-line count|cannot pass the cumulative size gate|1500-line limit/,
  );
});

test('pure renames do not count as changed lines', (): void => {
  const repo = makeRepo();
  repo.write('src/old.ts', Array.from({ length: 1600 }, (_value, index) => `export const line${index} = ${index};`).join('\n') + '\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  repo.git(['mv', 'src/old.ts', 'src/new.ts']);
  repo.commit('rename');
  repo.git(['branch', '-f', 'head', 'HEAD']);
  const snapshot = collectSnapshot(baseOptions(repo), loadTestPolicy({ contextPaths: [] }));
  assert.equal(snapshot.size.changedLines, 0);
  assert.equal(snapshot.size.outcome, 'within_threshold');
});

test('additions and deletions both count toward the cumulative size threshold', (): void => {
  const repo = makeRepo();
  repo.write('src/large.ts', Array.from({ length: 800 }, (_value, index) => `export const line${index} = ${index};`).join('\n') + '\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  repo.write('src/large.ts', 'export const replacement = 1;\n');
  repo.write('src/added.ts', Array.from({ length: 700 }, (_value, index) => `export const added${index} = ${index};`).join('\n') + '\n');
  repo.commit('head');
  repo.git(['branch', '-f', 'head', 'HEAD']);
  assert.throws(() => collectSnapshot(baseOptions(repo), loadTestPolicy({ contextPaths: [] })), /1501 changed lines/);
});

test('tampered or oversized snapshot size assessments are rejected', (): void => {
  const repo = makeRepo();
  repo.write('src/a.ts', 'export const a = 1;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  repo.write('src/a.ts', 'export const a = 2;\n');
  repo.commit('head');
  repo.git(['branch', '-f', 'head', 'HEAD']);
  const loaded = loadTestPolicy({ contextPaths: [] });
  const snapshot = collectSnapshot(baseOptions(repo), loaded);
  const oversized = JSON.parse(JSON.stringify(snapshot));
  oversized.size.changedLines = 1501;
  oversized.size.outcome = 'split_recommended';
  assert.throws(() => validateSnapshot(oversized, loaded), /size assessment outcome|blocking threshold/);
  const mismatched = JSON.parse(JSON.stringify(snapshot));
  mismatched.size.warnChangedLines = 900;
  assert.throws(() => validateSnapshot(mismatched, loaded), /size assessment invalid/);
});
test('uncommitted working-tree edits never enter the packet', (): void => {
  const repo = makeRepo();
  repo.write('src/a.ts', 'export const a = 1;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  repo.write('src/a.ts', 'export const a = 2;\n');
  repo.commit('head');
  repo.git(['branch', '-f', 'head', 'HEAD']);
  repo.write('src/a.ts', 'export const a = 999; // dirty uncommitted\n');
  repo.write('src/untracked.ts', 'export const leaked = true;\n');
  const snapshot = collectSnapshot(baseOptions(repo), loadTestPolicy({ contextPaths: [] }));
  const file = snapshot.files.find((item) => item.path === 'src/a.ts' && item.revision === 'head');
  assert.ok(file);
  assert.match(file.content, /a = 2/);
  assert.doesNotMatch(file.content, /999/);
  assert.ok(!snapshot.files.some((item) => item.path === 'src/untracked.ts'));
});

test('malicious refs, unsafe context paths, and forbidden repositories are refused', (): void => {
  const repo = makeRepo();
  repo.write('src/a.ts', 'export const a = 1;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  repo.git(['branch', '-f', 'head', 'HEAD']);
  const loaded = loadTestPolicy({ contextPaths: [] });
  assert.throws(() => collectSnapshot(baseOptions(repo, { baseRef: '--help' }), loaded), /Unsafe base ref/);
  assert.throws(() => collectSnapshot(baseOptions(repo, { headRef: '-HEAD' }), loaded), /Unsafe head ref/);
  assert.throws(() => collectSnapshot(baseOptions(repo, { repository: 'devrev/sentinel' }), loaded), /allowlist/);
  assert.throws(() => collectSnapshot(baseOptions(repo, { additionalContextPaths: ['../escape.ts'] }), loaded), /Unsafe additional context path/);
  assert.throws(() => collectSnapshot(baseOptions(repo, { additionalContextPaths: ['.env'] }), loaded), /Forbidden additional context path/);
});

test('context budget exhaustion is an explicit incomplete limitation, never silent truncation', (): void => {
  const repo = makeRepo();
  repo.write('src/a.ts', 'export const a = 1;\n');
  repo.write('src/b.ts', 'import { a } from "./a";\nexport const b = a;\n');
  repo.write('src/c.ts', 'import { b } from "./b";\nexport const c = b;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  repo.write('src/a.ts', 'export const a = 2;\n');
  repo.commit('head');
  repo.git(['branch', '-f', 'head', 'HEAD']);
  const loaded = loadTestPolicy({ contextPaths: [], limits: { maxFiles: 2, maxSourceBytes: 4_000_000, maxDiffBytes: 1_000_000, warnChangedLines: 800, blockChangedLines: 1500 } });
  const snapshot = collectSnapshot(baseOptions(repo), loaded);
  assert.equal(snapshot.complete, false);
  assert.ok(snapshot.limitations.some((line) => line.includes('Context budget exhausted')));
});

test('binary and symlink sources are excluded with explicit limitations', (): void => {
  const repo = makeRepo();
  repo.write('src/keep.ts', 'export const keep = 1;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  repo.write('src/bin.ts', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]));
  repo.link('keep.ts', 'src/link.ts');
  repo.commit('add binary and symlink');
  repo.git(['branch', '-f', 'head', 'HEAD']);
  const snapshot = collectSnapshot(baseOptions(repo), loadTestPolicy({ contextPaths: [] }));
  assert.equal(snapshot.complete, false);
  assert.ok(snapshot.limitations.some((line) => line.includes('Binary file src/bin.ts')));
  assert.ok(snapshot.limitations.some((line) => line.includes('Symlink src/link.ts')));
  assert.ok(!snapshot.files.some((file) => file.path === 'src/bin.ts'));
});

test('policy context is read at merge base even when head changed it and the worktree is dirty', (): void => {
  const repo = makeRepo();
  repo.write('CLAUDE.md', 'base guidance\n');
  repo.write('src/a.ts', 'export const a = 1;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  repo.write('CLAUDE.md', 'head guidance\n');
  repo.write('src/a.ts', 'export const a = 2;\n');
  repo.commit('head changes guidance');
  repo.git(['branch', '-f', 'head', 'HEAD']);
  writeFileSync(path.join(repo.dir, 'CLAUDE.md'), 'dirty uncommitted guidance\n');
  const loaded = loadTestPolicy({ contextPaths: ['CLAUDE.md'] });
  const snapshot = collectSnapshot(baseOptions(repo), loaded);
  const contextFile = snapshot.files.find((file) => file.path === 'CLAUDE.md' && file.revision === 'base');
  assert.ok(contextFile);
  assert.match(contextFile.content, /base guidance/);
  assert.doesNotMatch(contextFile.content, /dirty uncommitted/);
});

test('prior-finding context seeds add forward context without becoming changed paths', (): void => {
  const repo = makeRepo();
  repo.write('src/finding.ts', 'import { helper } from "./helper";\nexport const found = helper;\n');
  repo.write('src/helper.ts', 'export const helper = 1;\n');
  repo.write('src/other.ts', 'export const other = 1;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  repo.write('src/other.ts', 'export const other = 2;\n');
  repo.commit('head');
  repo.git(['branch', '-f', 'head', 'HEAD']);
  const snapshot = collectSnapshot(
    baseOptions(repo, { additionalContextPaths: ['src/finding.ts'] }),
    loadTestPolicy({ contextPaths: [] }),
  );
  assert.ok(snapshot.files.some((file) => file.path === 'src/finding.ts'), 'seed file must be captured');
  assert.ok(snapshot.files.some((file) => file.path === 'src/helper.ts'), 'seed forward dependency must be captured');
  assert.ok(!snapshot.changes.some((change) => change.path === 'src/finding.ts'));
});

test('rebased previous head produces an informational two-tree delta without incompleteness', (): void => {
  const repo = makeRepo();
  repo.write('src/a.ts', 'export const a = 1;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  repo.write('src/a.ts', 'export const a = 2;\n');
  const oldHead = repo.commit('first head');
  repo.git(['checkout', '-b', 'rebased', 'base']);
  repo.write('src/b.ts', 'export const b = 1;\n');
  const newHead = repo.commit('rebased head');
  repo.git(['branch', '-f', 'head', 'HEAD']);
  const snapshot = collectSnapshot(
    baseOptions(repo, { previousHeadRef: oldHead }),
    loadTestPolicy({ contextPaths: [] }),
  );
  assert.equal(snapshot.identity.headSha, newHead);
  assert.ok(snapshot.deltaDiff !== null);
  assert.match(snapshot.deltaDiff as string, /informational/);
  assert.equal(snapshot.complete, true);
});

test('a committed secret-like changed path refuses the packet without leaking content', (): void => {
  const repo = makeRepo();
  repo.write('src/a.ts', 'export const a = 1;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  repo.write('src/a.ts', 'export const a = 2;\n');
  repo.write('.env', 'TOKEN_VALUE_123=shh\n');
  repo.commit('head with secret');
  repo.git(['branch', '-f', 'head', 'HEAD']);
  let captured: unknown = null;
  try {
    collectSnapshot(baseOptions(repo), loadTestPolicy({ contextPaths: [] }));
  } catch (error) {
    captured = error;
  }
  assert.ok(captured instanceof Error);
  assert.match((captured as Error).message, /Preparation refused/);
  assert.match((captured as Error).message, /\.env/);
  assert.doesNotMatch((captured as Error).message, /TOKEN_VALUE_123|shh/);
});

test('a secret present only in the previous-head delta still refuses the packet', (): void => {
  const repo = makeRepo();
  repo.write('src/a.ts', 'export const a = 1;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  repo.write('.env', 'TOKEN_VALUE_123=shh\n');
  const oldHead = repo.commit('head adds secret');
  repo.remove('.env');
  repo.write('src/a.ts', 'export const a = 2;\n');
  repo.commit('head removes secret');
  repo.git(['branch', '-f', 'head', 'HEAD']);
  const withoutDelta = collectSnapshot(baseOptions(repo), loadTestPolicy({ contextPaths: [] }));
  assert.equal(withoutDelta.complete, true);
  assert.throws(
    () => collectSnapshot(baseOptions(repo, { previousHeadRef: oldHead }), loadTestPolicy({ contextPaths: [] })),
    /Preparation refused[\s\S]*\.env/,
  );
});

test('unresolved internal imports are explicit limitations; external packages are not', (): void => {
  const repo = makeRepo();
  repo.write('src/a.ts', 'import { x } from "./missing";\nimport { z } from "playwright";\nexport const a = x ?? z;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  repo.write('src/a.ts', 'import { x } from "./missing";\nimport { z } from "playwright";\nexport const a = (x ?? z) + 1;\n');
  repo.commit('head');
  repo.git(['branch', '-f', 'head', 'HEAD']);
  const snapshot = collectSnapshot(baseOptions(repo), loadTestPolicy({ contextPaths: [] }));
  assert.equal(snapshot.complete, false);
  assert.ok(snapshot.limitations.some((line) => line.includes('Unresolved internal imports') && line.includes('./missing')));
  assert.ok(!snapshot.limitations.some((line) => line.includes('playwright')));
});

test('policy context files missing from the repository produce explicit limitations', (): void => {
  const repo = makeRepo();
  repo.write('src/a.ts', 'export const a = 1;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  repo.write('src/a.ts', 'export const a = 2;\n');
  repo.commit('head');
  repo.git(['branch', '-f', 'head', 'HEAD']);
  const snapshot = collectSnapshot(baseOptions(repo), loadTestPolicy());
  assert.equal(snapshot.complete, false);
  assert.ok(snapshot.limitations.some((line) => line.includes('CLAUDE.md')));
});

test('unchanged JavaScript and hidden-directory consumers are captured through the import graph', (): void => {
  const repo = makeRepo();
  repo.write('src/dep.ts', 'export const value = 1;\n');
  repo.write('src/caller.js', 'import { value } from "./dep";\nexport const seen = value;\n');
  repo.write('.generated/hidden.ts', 'import { value } from "../src/dep";\nexport const hidden = value;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  repo.write('src/dep.ts', 'export const value = 2;\n');
  repo.commit('head');
  repo.git(['branch', '-f', 'head', 'HEAD']);
  const snapshot = collectSnapshot(baseOptions(repo), loadTestPolicy({ contextPaths: [] }));
  assert.ok(snapshot.files.some((file) => file.path === 'src/caller.js'), 'unchanged .js consumer must be captured');
  assert.ok(snapshot.dependencyEdges.some((edge) => edge.from === 'src/caller.js' && edge.to === 'src/dep.ts'));
  assert.ok(snapshot.files.some((file) => file.path === '.generated/hidden.ts'), 'consumer in a dot-prefixed directory must be captured');
  assert.ok(snapshot.dependencyEdges.some((edge) => edge.from === '.generated/hidden.ts' && edge.to === 'src/dep.ts'));
});

test('policy context forward dependencies are selected and dependency-closed', (): void => {
  const repo = makeRepo();
  repo.write('playwright.config.ts', 'import { setup } from "./src/setup";\nexport const config = setup;\n');
  repo.write('src/setup.ts', 'export const setup = {};\n');
  repo.write('src/a.ts', 'export const a = 1;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  repo.write('src/a.ts', 'export const a = 2;\n');
  repo.commit('head');
  repo.git(['branch', '-f', 'head', 'HEAD']);
  const loaded = loadTestPolicy({ contextPaths: ['playwright.config.ts'] });
  const snapshot = collectSnapshot(baseOptions(repo), loaded);
  assert.equal(snapshot.complete, true);
  assert.ok(snapshot.files.some((file) => file.path === 'src/setup.ts'), 'policy context forward dependency must be captured');
  assert.ok(snapshot.dependencyEdges.some((edge) => edge.from === 'playwright.config.ts' && edge.to === 'src/setup.ts'));
});

test('seeded fixture satisfies the real trusted policy context set', (): void => {
  const repo = makeRepo();
  const loaded = loadTestPolicy();
  seedPolicyContext(repo, loaded);
  repo.write('src/a.ts', 'export const a = 1;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  repo.write('src/a.ts', 'export const a = 2;\n');
  repo.commit('head');
  repo.git(['branch', '-f', 'head', 'HEAD']);
  const snapshot = collectSnapshot(baseOptions(repo), loaded);
  assert.equal(snapshot.complete, true);
  for (const contextPath of loaded.policy.contextPaths) {
    assert.ok(snapshot.files.some((file) => file.path === contextPath && file.revision === 'base'), `missing context ${contextPath}`);
  }
});

test('validateSnapshot accepts collector output and rejects tampering', (): void => {
  const repo = makeRepo();
  repo.write('src/a.ts', 'export const a = 1;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  repo.write('src/a.ts', 'export const a = 2;\n');
  repo.commit('head');
  repo.git(['branch', '-f', 'head', 'HEAD']);
  const loaded = loadTestPolicy({ contextPaths: [] });
  const snapshot = collectSnapshot(baseOptions(repo), loaded);
  const parsed = validateSnapshot(JSON.parse(JSON.stringify(snapshot)), loaded);
  assert.equal(parsed.identity.headSha, snapshot.identity.headSha);
  const tamperedDigest = JSON.parse(JSON.stringify(snapshot));
  tamperedDigest.identity.policyDigest = '0'.repeat(64);
  assert.throws(() => validateSnapshot(tamperedDigest, loaded), /policyDigest/);
  const tamperedRepo = JSON.parse(JSON.stringify(snapshot));
  tamperedRepo.identity.repository = 'devrev/sentinel';
  assert.throws(() => validateSnapshot(tamperedRepo, loaded), /allowlist/);
  const extraField = { ...JSON.parse(JSON.stringify(snapshot)), verdict: 'clean' };
  assert.throws(() => validateSnapshot(extraField, loaded), /top-level fields/);
});
