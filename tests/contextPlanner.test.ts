import assert from 'node:assert/strict';
import test from 'node:test';
import { collectSnapshot, validateSnapshot } from '../src/snapshot.ts';
import type { CollectSnapshotOptions } from '../src/snapshot.ts';
import { planReviewContext } from '../src/contextPlanner.ts';
import { ALLOWED_REPOSITORY, loadTestPolicy, makeRepo } from './helpers.ts';
import type { RepoFixture } from './helpers.ts';
import type { ReviewSnapshot } from '../src/contracts.ts';

const PR = 77;

function baseOptions(repo: RepoFixture, overrides: Record<string, unknown> = {}): CollectSnapshotOptions {
  return {
    checkout: repo.dir,
    repository: ALLOWED_REPOSITORY,
    pullRequest: PR,
    baseRef: 'base',
    headRef: 'head',
    runId: 'run-planner',
    ...overrides,
  };
}

function fixtureRepo(): RepoFixture {
  const repo = makeRepo();
  repo.write('src/pages/computer/computerDesktop.page.ts', 'export class ComputerDesktopPage {\n  work(): void {}\n}\n');
  repo.write('src/fixtures/page.fixtures.ts', 'import { test as base } from "@playwright/test";\nexport const pageTest = base.extend({});\nexport const pageExpect = base.expect;\n');
  repo.write('src/fixtures/component.fixture.ts', 'import { test as base } from "@playwright/test";\nexport const componentTest = base.extend({});\nexport const componentExpect = base.expect;\n');
  repo.write('src/fixtures/computer.fixture.ts', 'import { test as base } from "@playwright/test";\nexport const computerTest = base.extend({});\nexport const computerExpect = base.expect;\n');
  repo.write('src/fixtures/desktop.fixtures.ts', 'import { test as base } from "@playwright/test";\nimport { ComputerDesktopPage } from "../pages/computer/computerDesktop.page";\nexport const desktopTest = base.extend({ page: async ({ page }: { page: object }, use: (p: ComputerDesktopPage) => Promise<void>) => { await use(new ComputerDesktopPage()); } });\nexport const crossPlatformTest = base.extend({});\n');
  repo.write('src/fixtures/index.fixtures.ts', [
    'import { mergeExpects, mergeTests, type Expect } from "@playwright/test";',
    'import { pageTest, pageExpect } from "./page.fixtures";',
    'import { componentTest, componentExpect } from "./component.fixture";',
    'import { computerTest, computerExpect } from "./computer.fixture";',
    'import { desktopTest, crossPlatformTest } from "./desktop.fixtures";',
    'export const test = mergeTests(pageTest, componentTest, computerTest);',
    'export const expect: Expect = mergeExpects(pageExpect, componentExpect, computerExpect);',
    'export { expect as expectExternal } from "@playwright/test";',
    'export { desktopTest, crossPlatformTest };',
    '',
  ].join('\n'));
  repo.write('tests/web/webJourney.test.ts', 'import { test } from "../../src/fixtures/index.fixtures";\ntest("web journey", async () => {});\n');
  repo.write('tests/desktop/desktopJourney.test.ts', 'import { desktopTest } from "../../src/fixtures/index.fixtures";\ndesktopTest("desktop journey", async () => {});\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  return repo;
}

function changed(repo: RepoFixture, rel: string, content: string): void {
  repo.write(rel, content);
  repo.commit('head');
  repo.git(['branch', '-f', 'head', 'HEAD']);
}

function filePaths(snapshot: ReviewSnapshot): Set<string> {
  return new Set(snapshot.files.map((file) => file.path));
}

function selectedPaths(snapshot: ReviewSnapshot): Set<string> {
  return new Set(snapshot.contextPlan.selections.map((selection) => selection.path));
}

test('barrel consumer narrows to the affected fixture export, providers stay via forward deps', (): void => {
  const repo = fixtureRepo();
  changed(repo, 'src/pages/computer/computerDesktop.page.ts', 'export class ComputerDesktopPage {\n  work(): void {}\n  extra(): void {}\n}\n');
  const snapshot = collectSnapshot(baseOptions(repo), loadTestPolicy({ contextPaths: [] }));
  const paths = filePaths(snapshot);
  assert.ok(paths.has('src/fixtures/desktop.fixtures.ts'), 'desktop fixture provider must be captured');
  assert.ok(paths.has('src/fixtures/index.fixtures.ts'), 'barrel must be captured');
  assert.ok(paths.has('tests/desktop/desktopJourney.test.ts'), 'desktop consumer must be captured');
  assert.ok(paths.has('src/fixtures/page.fixtures.ts'), 'full forward providers of the barrel are captured');
  assert.ok(paths.has('src/fixtures/component.fixture.ts'), 'full forward providers of the barrel are captured');
  assert.ok(paths.has('src/fixtures/computer.fixture.ts'), 'full forward providers of the barrel are captured');
  assert.ok(!paths.has('tests/web/webJourney.test.ts'), 'unrelated import {test} web consumer must be excluded');
  assert.ok(selectedPaths(snapshot).has('tests/desktop/desktopJourney.test.ts'));
  assert.ok(!selectedPaths(snapshot).has('tests/web/webJourney.test.ts'));
  assert.ok(snapshot.contextPlan.selections.every((entry) => entry.reasons.length > 0));
  assert.ok(!snapshot.limitations.some((line) => line.includes('@playwright/test')), 'external re-export must not be reported as unresolved internal context');
});

test('named re-export aliases and export-star chains preserve real consumers', (): void => {
  const repo = makeRepo();
  repo.write('src/leaf.ts', 'export const leaf = 1;\nexport const other = 1;\n');
  repo.write('src/mid.ts', 'export * from "./leaf";\n');
  repo.write('src/alias.ts', 'export { leaf as renamed } from "./mid";\nexport { other } from "./mid";\n');
  repo.write('src/useRenamed.ts', 'import { renamed } from "./alias";\nexport const seen = renamed;\n');
  repo.write('src/useOther.ts', 'import { other } from "./alias";\nexport const seenOther = other;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  changed(repo, 'src/leaf.ts', 'export const leaf = 2;\nexport const other = 1;\n');
  const snapshot = collectSnapshot(baseOptions(repo), loadTestPolicy({ contextPaths: [] }));
  const paths = selectedPaths(snapshot);
  assert.ok(paths.has('src/mid.ts'));
  assert.ok(paths.has('src/alias.ts'));
  assert.ok(paths.has('src/useRenamed.ts'), 'consumer of renamed alias must be captured');
  assert.ok(paths.has('src/useOther.ts'), 'consumer of second export must be captured (changed file seeds all symbols)');
});

test('helper-local alias reference keeps the exported caller', (): void => {
  const repo = makeRepo();
  repo.write('src/dep.ts', 'export function depFn(): number { return 1; }\n');
  repo.write('src/helper.ts', 'import { depFn } from "./dep";\nconst alias = depFn;\nexport const run = (): number => alias();\n');
  repo.write('src/user.ts', 'import { run } from "./helper";\nexport const out = run();\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  changed(repo, 'src/dep.ts', 'export function depFn(): number { return 2; }\n');
  const snapshot = collectSnapshot(baseOptions(repo), loadTestPolicy({ contextPaths: [] }));
  const paths = selectedPaths(snapshot);
  assert.ok(paths.has('src/helper.ts'), 'alias-declaring helper must be captured');
  assert.ok(paths.has('src/user.ts'), 'consumer of the exported caller must be captured');
});

test('side-effect imports stay callers with fallback evidence', (): void => {
  const repo = makeRepo();
  repo.write('src/dep.ts', 'export const dep = 1;\n');
  repo.write('src/effect.ts', 'import "./dep";\nexport const effect = 1;\n');
  repo.write('src/named.ts', 'import { dep } from "./dep";\nexport const named = dep;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  changed(repo, 'src/dep.ts', 'export const dep = 2;\n');
  const snapshot = collectSnapshot(baseOptions(repo), loadTestPolicy({ contextPaths: [] }));
  const paths = selectedPaths(snapshot);
  assert.ok(paths.has('src/effect.ts'), 'side-effect importer remains a caller');
  assert.ok(paths.has('src/named.ts'));
  assert.ok(
    snapshot.contextPlan.fallbacks.some((entry) => entry.path === 'src/effect.ts' && entry.reason.includes('side-effect')),
    'side-effect consumer must record fallback evidence',
  );
});

test('import-time executable code forces broad reverse impact to unrelated export consumers', (): void => {
  const repo = makeRepo();
  repo.write('src/dep.ts', 'export const x = 1;\n');
  repo.write('src/effectful.ts', 'import { x } from "./dep";\nexport const a = x;\nexport const b = 2;\nconsole.log("boot");\n');
  repo.write('src/consumerOfB.ts', 'import { b } from "./effectful";\nexport const seen = b;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  changed(repo, 'src/dep.ts', 'export const x = 2;\n');
  const snapshot = collectSnapshot(baseOptions(repo), loadTestPolicy({ contextPaths: [] }));
  const paths = selectedPaths(snapshot);
  assert.ok(paths.has('src/effectful.ts'));
  assert.ok(paths.has('src/consumerOfB.ts'), 'consumer of an unrelated export must be captured when the middle module is effectful');
});

test('deleted and renamed base sources preserve their callers', (): void => {
  const repo = makeRepo();
  repo.write('src/victim.ts', 'export const victim = 1;\n');
  repo.write('src/victimUser.ts', 'import { victim } from "./victim";\nexport const seenVictim = victim;\n');
  repo.write('src/old.ts', 'export const thing = 1;\nexport const more = 1;\nexport const extra = 1;\n');
  repo.write('src/oldUser.ts', 'import { thing } from "./old";\nexport const seenThing = thing;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  repo.remove('src/victim.ts');
  repo.git(['mv', 'src/old.ts', 'src/new.ts']);
  repo.write('src/new.ts', 'export const thing = 2;\nexport const more = 1;\nexport const extra = 1;\n');
  repo.commit('delete and rename');
  repo.git(['branch', '-f', 'head', 'HEAD']);
  const snapshot = collectSnapshot(baseOptions(repo), loadTestPolicy({ contextPaths: [] }));
  const paths = filePaths(snapshot);
  assert.ok(paths.has('src/victimUser.ts'), 'caller of a deleted file must be captured');
  assert.ok(snapshot.files.some((file) => file.path === 'src/victim.ts' && file.revision === 'base'), 'deleted file keeps base source');
  assert.ok(paths.has('src/oldUser.ts'), 'caller of a renamed file must be captured');
});

test('prior-finding context seeds keep forward closure', (): void => {
  const repo = makeRepo();
  repo.write('src/finding.ts', 'import { helper } from "./helper";\nexport const found = helper;\n');
  repo.write('src/helper.ts', 'export const helper = 1;\n');
  repo.write('src/other.ts', 'export const other = 1;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  changed(repo, 'src/other.ts', 'export const other = 2;\n');
  const snapshot = collectSnapshot(
    baseOptions(repo, { additionalContextPaths: ['src/finding.ts'] }),
    loadTestPolicy({ contextPaths: [] }),
  );
  const paths = selectedPaths(snapshot);
  assert.ok(paths.has('src/finding.ts'));
  assert.ok(paths.has('src/helper.ts'), 'seed forward dependency must be captured');
  const entry = snapshot.contextPlan.selections.find((selection) => selection.path === 'src/finding.ts');
  assert.ok(entry?.reasons.some((reason) => reason.includes('prior-finding')));
});

test('plan evidence validates strictly and output is deterministic', (): void => {
  const repo = makeRepo();
  repo.write('src/a.ts', 'export const a = 1;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  changed(repo, 'src/a.ts', 'export const a = 2;\n');
  const loaded = loadTestPolicy({ contextPaths: [] });
  const first = collectSnapshot(baseOptions(repo), loaded);
  const second = collectSnapshot(baseOptions(repo), loaded);
  assert.deepEqual(first.contextPlan, second.contextPlan);
  const tampered = JSON.parse(JSON.stringify(first));
  tampered.contextPlan.strategy = 'invented';
  assert.throws(() => validateSnapshot(tampered, loaded), /strategy/);
  const tampered2 = JSON.parse(JSON.stringify(first));
  tampered2.contextPlan.selections.push({ path: '../escape', reasons: ['x'] });
  assert.throws(() => validateSnapshot(tampered2, loaded), /unsafe|path/);
  const tampered3 = JSON.parse(JSON.stringify(first));
  tampered3.contextPlan.extra = {};
  assert.throws(() => validateSnapshot(tampered3, loaded), /top-level fields|malformed/);
});

test('budget exhaustion remains an explicit incomplete result', (): void => {
  const repo = fixtureRepo();
  changed(repo, 'src/pages/computer/computerDesktop.page.ts', 'export class ComputerDesktopPage {\n  work(): void {}\n  bigger(): void {}\n}\n');
  const loaded = loadTestPolicy({ contextPaths: [], limits: { maxFiles: 3, maxSourceBytes: 4_000_000, maxPartSourceBytes: 4_000_000, maxDiffBytes: 1_000_000, warnChangedLines: 800, blockChangedLines: 1500 } });
  const snapshot = collectSnapshot(baseOptions(repo), loaded);
  assert.equal(snapshot.complete, false);
  assert.ok(snapshot.limitations.some((line) => line.includes('Context budget exhausted')));
  assert.ok(selectedPaths(snapshot).size > 3, 'full plan records selections even when the budget omits their source');
});

test('require() bindings propagate as opaque consumption and keep downstream consumers', (): void => {
  const repo = makeRepo();
  repo.write('src/leaf.ts', 'export const value = 1;\n');
  repo.write('src/bridge.ts', 'const dep = require("./leaf");\nexport const value = dep.value;\n');
  repo.write('src/consumer.ts', 'import { value } from "./bridge";\nexport const seen = value;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  changed(repo, 'src/leaf.ts', 'export const value = 2;\n');
  const snapshot = collectSnapshot(baseOptions(repo), loadTestPolicy({ contextPaths: [] }));
  const paths = selectedPaths(snapshot);
  assert.ok(paths.has('src/bridge.ts'), 'require consumer must be captured');
  assert.ok(paths.has('src/consumer.ts'), 'downstream consumer must be retained through broad reachability');
  assert.ok(snapshot.contextPlan.fallbacks.some((entry) => entry.path === 'src/bridge.ts' && entry.reason.includes('require')));
});

test('dynamic import() bindings propagate as opaque consumption', (): void => {
  const repo = makeRepo();
  repo.write('src/leaf.ts', 'export const value = 1;\n');
  repo.write('src/bridge.ts', 'export async function load() { return import("./leaf"); }\n');
  repo.write('src/consumer.ts', 'import { load } from "./bridge";\nexport const seen = load;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  changed(repo, 'src/leaf.ts', 'export const value = 2;\n');
  const snapshot = collectSnapshot(baseOptions(repo), loadTestPolicy({ contextPaths: [] }));
  const paths = selectedPaths(snapshot);
  assert.ok(paths.has('src/bridge.ts'));
  assert.ok(paths.has('src/consumer.ts'), 'consumer of the dynamic-importing declaration must be retained');
  assert.ok(snapshot.contextPlan.fallbacks.some((entry) => entry.path === 'src/bridge.ts' && entry.reason.includes('dynamic')));
});

test('namespace re-export chains propagate the re-exported name with fallback evidence', (): void => {
  const repo = makeRepo();
  repo.write('src/leaf.ts', 'export const value = 1;\n');
  repo.write('src/middle.ts', 'import { value } from "./leaf";\nexport const used = value;\nexport const other = 2;\n');
  repo.write('src/barrel.ts', 'export * as ns from "./middle";\n');
  repo.write('src/consumer.ts', 'import { ns } from "./barrel";\nexport const seen = ns.used;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  changed(repo, 'src/leaf.ts', 'export const value = 2;\n');
  const snapshot = collectSnapshot(baseOptions(repo), loadTestPolicy({ contextPaths: [] }));
  const paths = selectedPaths(snapshot);
  assert.ok(paths.has('src/middle.ts'));
  assert.ok(paths.has('src/barrel.ts'), 'namespace re-export barrel must be captured');
  assert.ok(paths.has('src/consumer.ts'), 'consumer of the namespace must be captured');
  assert.ok(snapshot.contextPlan.fallbacks.some((entry) => entry.path === 'src/barrel.ts' && entry.reason.includes('namespace')));
});

test('namespace import and import-equals consumers keep downstream reachability', (): void => {
  const repo = makeRepo();
  repo.write('src/leaf.ts', 'export const value = 1;\n');
  repo.write('src/nsUser.ts', 'import * as leaf from "./leaf";\nexport const seen = leaf.value;\n');
  repo.write('src/eqUser.ts', 'import leaf = require("./leaf");\nexport const seenEq = leaf.value;\n');
  repo.write('src/nsDown.ts', 'import { seen } from "./nsUser";\nexport const d1 = seen;\n');
  repo.write('src/eqDown.ts', 'import { seenEq } from "./eqUser";\nexport const d2 = seenEq;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  changed(repo, 'src/leaf.ts', 'export const value = 2;\n');
  const snapshot = collectSnapshot(baseOptions(repo), loadTestPolicy({ contextPaths: [] }));
  const paths = selectedPaths(snapshot);
  for (const path of ['src/nsUser.ts', 'src/eqUser.ts', 'src/nsDown.ts', 'src/eqDown.ts']) {
    assert.ok(paths.has(path), `${path} must be captured`);
  }
  assert.ok(snapshot.contextPlan.fallbacks.some((entry) => entry.path === 'src/nsUser.ts' && entry.reason.includes('namespace')));
  assert.ok(snapshot.contextPlan.fallbacks.some((entry) => entry.path === 'src/eqUser.ts' && entry.reason.includes('import-equals')));
});

test('computed property keys and type annotations keep dependencies', (): void => {
  const repo = makeRepo();
  repo.write('src/leaf.ts', 'export const key = "k";\nexport type Shape = { v: number };\n');
  repo.write('src/user.ts', 'import { key, type Shape } from "./leaf";\nexport const result = { [key]: 1 };\nexport const typed: Shape = { v: 1 };\n');
  repo.write('src/consumer.ts', 'import { result } from "./user";\nexport const seen = result;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  changed(repo, 'src/leaf.ts', 'export const key = "z";\nexport type Shape = { v: number };\n');
  const snapshot = collectSnapshot(baseOptions(repo), loadTestPolicy({ contextPaths: [] }));
  const paths = selectedPaths(snapshot);
  assert.ok(paths.has('src/user.ts'));
  assert.ok(paths.has('src/consumer.ts'), 'consumer of the computed-key export must be captured');
  assert.equal(snapshot.complete, true);
});

test('changed non-source data seeds file-level reverse consumers', (): void => {
  const repo = makeRepo();
  repo.write('src/data.json', '{"key": 1}\n');
  repo.write('src/reader.ts', 'import data from "./data.json";\nexport const value = data.key;\n');
  repo.write('src/consumer.ts', 'import { value } from "./reader";\nexport const seen = value;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  changed(repo, 'src/data.json', '{"key": 2}\n');
  const snapshot = collectSnapshot(baseOptions(repo), loadTestPolicy({ contextPaths: [] }));
  const paths = selectedPaths(snapshot);
  assert.ok(paths.has('src/reader.ts'), 'importer of changed non-source data must be captured');
  assert.ok(paths.has('src/consumer.ts'), 'downstream consumer must be captured');
});

test('import-time effects and side-effect imports widen downstream reachability to unrelated exports', (): void => {
  const repo = makeRepo();
  repo.write('src/leaf.ts', 'export const value = 1;\n');
  repo.write('src/effected.ts', 'import { value } from "./leaf";\nregister(value);\nexport const constant = 2;\n');
  repo.write('src/sidey.ts', 'import "./leaf";\nexport const constant = 3;\n');
  repo.write('src/consumerA.ts', 'import { constant } from "./effected";\nexport const a = constant;\n');
  repo.write('src/consumerB.ts', 'import { constant } from "./sidey";\nexport const b = constant;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  changed(repo, 'src/leaf.ts', 'export const value = 2;\n');
  const snapshot = collectSnapshot(baseOptions(repo), loadTestPolicy({ contextPaths: [] }));
  const paths = selectedPaths(snapshot);
  assert.ok(paths.has('src/effected.ts'));
  assert.ok(paths.has('src/sidey.ts'));
  assert.ok(paths.has('src/consumerA.ts'), 'consumer of an unrelated export of an effectful module must be retained');
  assert.ok(paths.has('src/consumerB.ts'), 'consumer of an unrelated export of a side-effect importer must be retained');
  assert.ok(snapshot.contextPlan.fallbacks.some((entry) => entry.path === 'src/effected.ts' && entry.reason.includes('executable')));
  assert.ok(snapshot.contextPlan.fallbacks.some((entry) => entry.path === 'src/sidey.ts' && entry.reason.includes('side-effect')));
});

test('commonjs module.exports assignments are opaque yet keep consumers', (): void => {
  const repo = makeRepo();
  repo.write('src/leaf.ts', 'export const value = 1;\n');
  repo.write('src/cjs.ts', 'const { value } = require("./leaf");\nmodule.exports = { wrapped: value };\n');
  repo.write('src/consumer.ts', 'import wrapped from "./cjs";\nexport const seen = wrapped;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  changed(repo, 'src/leaf.ts', 'export const value = 2;\n');
  const snapshot = collectSnapshot(baseOptions(repo), loadTestPolicy({ contextPaths: [] }));
  const paths = selectedPaths(snapshot);
  assert.ok(paths.has('src/cjs.ts'));
  assert.ok(paths.has('src/consumer.ts'), 'default consumer of an opaque CommonJS module must be retained');
  assert.ok(snapshot.contextPlan.fallbacks.some((entry) => entry.path === 'src/cjs.ts' && entry.reason.includes('CommonJS')));
});

test('parameter defaults and enum/class/default-export effects are treated conservatively', (): void => {
  const repo = makeRepo();
  repo.write('src/leaf.ts', 'export const value = 1;\n');
  repo.write('src/defaults.ts', 'import { value } from "./leaf";\nexport function f(p: number = value): number { return p; }\n');
  repo.write('src/enumEff.ts', 'import { value } from "./leaf";\nexport enum E { A = boot(value) }\n');
  repo.write('src/consumerA.ts', 'import { f } from "./defaults";\nexport const a = f();\n');
  repo.write('src/consumerB.ts', 'import { E } from "./enumEff";\nexport const b = E.A;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  changed(repo, 'src/leaf.ts', 'export const value = 2;\n');
  const snapshot = collectSnapshot(baseOptions(repo), loadTestPolicy({ contextPaths: [] }));
  const paths = selectedPaths(snapshot);
  assert.ok(paths.has('src/defaults.ts'), 'parameter default must keep the dependency');
  assert.ok(paths.has('src/consumerA.ts'));
  assert.ok(paths.has('src/enumEff.ts'), 'enum initializer effect keeps the module reachable');
  assert.ok(paths.has('src/consumerB.ts'));
});

test('pure planner unions reverse impact across revisions before forward closure', (): void => {
  const revA = {
    sources: new Map<string, string>([
      ['src/seed.ts', 'export const s = 1;\n'],
      ['src/p.ts', 'import { s } from "./seed";\nexport const p = s;\n'],
    ]),
    edges: [{ from: 'src/p.ts', to: 'src/seed.ts' }] as const,
    resolveImport: (): string | null => null,
  };
  const revB = {
    sources: new Map<string, string>([
      ['src/seed.ts', 'export const s = 1;\n'],
      ['src/p.ts', 'import { q } from "./q";\nexport const p = q;\n'],
      ['src/q.ts', 'export const q = 1;\n'],
    ]),
    edges: [
      { from: 'src/p.ts', to: 'src/q.ts' },
    ] as const,
    resolveImport: (): string | null => null,
  };
  const result = planReviewContext({
    revisions: [revA, revB],
    changes: [{ path: 'src/seed.ts', status: 'modified' }],
    additionalContextPaths: [],
  });
  assert.ok(result.selectedPaths.includes('src/p.ts'));
  assert.ok(result.selectedPaths.includes('src/q.ts'), 'forward dependency unique to revision B must be captured after union');
  assert.ok(result.dependencyEdges.some((edge) => edge.from === 'src/p.ts' && edge.to === 'src/q.ts'));
});

test('unmodeled raw edges fall back to opaque file-level consumption', (): void => {
  const rev = {
    sources: new Map<string, string>([
      ['src/seed.ts', 'export const s = 1;\n'],
      ['src/f.ts', 'export const marker = 1;\n'],
      ['src/down.ts', 'import { marker } from "./f";\nexport const d = marker;\n'],
    ]),
    edges: [
      { from: 'src/f.ts', to: 'src/seed.ts' },
      { from: 'src/down.ts', to: 'src/f.ts' },
    ] as const,
    resolveImport: (importer: string, specifier: string): string | null => {
      const joined = specifier.replace('./', importer.split('/').slice(0, -1).concat('').join('/'));
      return joined.endsWith('.ts') ? joined : `${joined}.ts`;
    },
  };
  const result = planReviewContext({
    revisions: [rev],
    changes: [{ path: 'src/seed.ts', status: 'modified' }],
    additionalContextPaths: [],
  });
  assert.ok(result.selectedPaths.includes('src/f.ts'), 'raw edge consumer must be captured even without a parsed binding');
  assert.ok(result.selectedPaths.includes('src/down.ts'), 'opaque reachability propagates downstream');
  assert.ok(result.evidence.fallbacks.some((entry) => entry.path === 'src/f.ts' && entry.reason.includes('not represented')));
});

test('tsx sources parse and parse diagnostics trigger the broad fallback', (): void => {
  const repo = makeRepo();
  repo.write('src/leaf.ts', 'export const value = 1;\n');
  repo.write('src/view.tsx', 'import { value } from "./leaf";\nexport const View = () => <div>{value}</div>;\n');
  repo.write('src/consumer.ts', 'import { View } from "./view";\nexport const seen = View;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  changed(repo, 'src/leaf.ts', 'export const value = 2;\n');
  const snapshot = collectSnapshot(baseOptions(repo), loadTestPolicy({ contextPaths: [] }));
  const paths = selectedPaths(snapshot);
  assert.ok(paths.has('src/view.tsx'), 'tsx consumer must be captured');
  assert.ok(paths.has('src/consumer.ts'));
});

test('import-time effects propagate reachability across named imports and re-exports', (): void => {
  const repo = makeRepo();
  repo.write('src/leaf.ts', 'export const value = 1;\n');
  repo.write('src/middle.ts', 'import { value } from "./leaf";\nregister(value);\nexport const marker = 1;\n');
  repo.write('src/barrelRe.ts', 'export { marker } from "./middle";\nexport const unrelated = 2;\n');
  repo.write('src/barrelIm.ts', 'import { marker } from "./middle";\nexport const unrelated = 3;\nexport { marker };\n');
  repo.write('src/consumerRe.ts', 'import { unrelated } from "./barrelRe";\nexport const a = unrelated;\n');
  repo.write('src/consumerIm.ts', 'import { unrelated } from "./barrelIm";\nexport const b = unrelated;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  changed(repo, 'src/leaf.ts', 'export const value = 2;\n');
  const snapshot = collectSnapshot(baseOptions(repo), loadTestPolicy({ contextPaths: [] }));
  const paths = selectedPaths(snapshot);
  for (const path of ['src/middle.ts', 'src/barrelRe.ts', 'src/barrelIm.ts', 'src/consumerRe.ts', 'src/consumerIm.ts']) {
    assert.ok(paths.has(path), `${path} must be reachable through import-time effects`);
  }
  assert.ok(snapshot.contextPlan.fallbacks.some((entry) => entry.path === 'src/middle.ts' && entry.reason.includes('import-time')));
  assert.ok(snapshot.contextPlan.fallbacks.some((entry) => entry.path === 'src/barrelRe.ts' && entry.reason.includes('import-time')));
});

test('import-time taint crosses export-star barrels without named exports', (): void => {
  const repo = makeRepo();
  repo.write('src/leaf.ts', 'export const value = 1;\n');
  repo.write('src/middle.ts', 'import { value } from "./leaf";\nregister(value);\nexport const marker = 1;\n');
  repo.write('src/barrel.ts', 'export * from "./middle";\n');
  repo.write('src/consumer.ts', 'import { marker } from "./barrel";\nexport const seen = marker;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  changed(repo, 'src/leaf.ts', 'export const value = 2;\n');
  const snapshot = collectSnapshot(baseOptions(repo), loadTestPolicy({ contextPaths: [] }));
  const paths = selectedPaths(snapshot);
  assert.ok(paths.has('src/barrel.ts'));
  assert.ok(paths.has('src/consumer.ts'));
});

test('nested parameter and variable destructuring defaults keep dependencies', (): void => {
  const repo = makeRepo();
  repo.write('src/leaf.ts', 'export const value = 1;\n');
  repo.write('src/middle.ts', 'import { value } from "./leaf";\nexport function run({ setting = value } = {}): number { return setting; }\nexport const nested = (({ pair: [first = value] }: { pair: number[] }) => first)({ pair: [] });\n');
  repo.write('src/consumer.ts', 'import { run } from "./middle";\nexport const seen = run();\n');
  repo.write('src/consumerNested.ts', 'import { nested } from "./middle";\nexport const seenN = nested;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  changed(repo, 'src/leaf.ts', 'export const value = 2;\n');
  const snapshot = collectSnapshot(baseOptions(repo), loadTestPolicy({ contextPaths: [] }));
  const paths = selectedPaths(snapshot);
  assert.ok(paths.has('src/middle.ts'));
  assert.ok(paths.has('src/consumer.ts'), 'consumer of the defaulted-parameter export must be captured');
  assert.ok(paths.has('src/consumerNested.ts'), 'consumer of the nested-destructuring export must be captured');
});

test('class heritage and static initializer effects widen downstream reachability', (): void => {
  const repo = makeRepo();
  repo.write('src/leaf.ts', 'export const value = 1;\n');
  repo.write('src/heritage.ts', 'import { value } from "./leaf";\nexport class C extends boot(value) {}\nexport const unrelated = 1;\n');
  repo.write('src/staticf.ts', 'import { value } from "./leaf";\nexport class D { static x = boot(value); }\nexport const unrelated = 2;\n');
  repo.write('src/consumerA.ts', 'import { unrelated } from "./heritage";\nexport const a = unrelated;\n');
  repo.write('src/consumerB.ts', 'import { unrelated } from "./staticf";\nexport const b = unrelated;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  changed(repo, 'src/leaf.ts', 'export const value = 2;\n');
  const snapshot = collectSnapshot(baseOptions(repo), loadTestPolicy({ contextPaths: [] }));
  const paths = selectedPaths(snapshot);
  assert.ok(paths.has('src/consumerA.ts'), 'consumer of unrelated export of a class-heritage-effect module must be retained');
  assert.ok(paths.has('src/consumerB.ts'), 'consumer of unrelated export of a static-initializer module must be retained');
});

test('export-default expression effects and default-import consumers are retained', (): void => {
  const repo = makeRepo();
  repo.write('src/leaf.ts', 'export const value = 1;\n');
  repo.write('src/defEff.ts', 'import { value } from "./leaf";\nexport default boot(value);\nexport const unrelated = 1;\n');
  repo.write('src/def.ts', 'import { value } from "./leaf";\nexport default value;\n');
  repo.write('src/consumerA.ts', 'import { unrelated } from "./defEff";\nexport const a = unrelated;\n');
  repo.write('src/consumerB.ts', 'import def from "./def";\nexport const b = def;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  changed(repo, 'src/leaf.ts', 'export const value = 2;\n');
  const snapshot = collectSnapshot(baseOptions(repo), loadTestPolicy({ contextPaths: [] }));
  const paths = selectedPaths(snapshot);
  assert.ok(paths.has('src/consumerA.ts'), 'consumer of unrelated export beside an effectful default expression must be retained');
  assert.ok(paths.has('src/consumerB.ts'), 'default-import consumer must be captured');
});

test('parse diagnostics mark the module model partial and keep consumers via fallback', (): void => {
  const repo = makeRepo();
  repo.write('src/leaf.ts', 'export const value = 1;\n');
  repo.write('src/broken.ts', 'import { value } from "./leaf";\nexport const marker = value;\nexport const broken = ;\n');
  repo.write('src/consumer.ts', 'import { marker } from "./broken";\nexport const seen = marker;\n');
  repo.commit('base');
  repo.git(['branch', 'base']);
  changed(repo, 'src/leaf.ts', 'export const value = 2;\n');
  const snapshot = collectSnapshot(baseOptions(repo), loadTestPolicy({ contextPaths: [] }));
  const paths = selectedPaths(snapshot);
  assert.ok(paths.has('src/broken.ts'));
  assert.ok(paths.has('src/consumer.ts'), 'consumer of a module with parse diagnostics must be retained via broad reachability');
  assert.ok(snapshot.contextPlan.fallbacks.some((entry) => entry.path === 'src/broken.ts' && entry.reason.includes('parse diagnostics')));
});
