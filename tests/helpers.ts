import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIMENSIONS } from '../src/contracts.ts';
import type { ReviewReport, ReviewSnapshot } from '../src/contracts.ts';
import { loadPolicy } from '../src/policy.ts';
import type { LoadedPolicy } from '../src/policy.ts';

export const SYSTEM_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const ALLOWED_REPOSITORY = 'devrev-timcacayan/sentinel-mirror';

export function loadTestPolicy(overrides: Partial<LoadedPolicy['policy']> = {}): LoadedPolicy {
  const loaded = loadPolicy(SYSTEM_ROOT);
  return { ...loaded, policy: { ...loaded.policy, ...overrides } };
}

export interface RepoFixture {
  dir: string;
  git(args: string[]): string;
  write(rel: string, content: string | Buffer): void;
  remove(rel: string): void;
  link(target: string, rel: string): void;
  commit(message?: string): string;
  sha(ref: string): string;
}

export function makeRepo(): RepoFixture {
  const dir = mkdtempSync(path.join(tmpdir(), 'srs-repo-'));
  const git = (args: string[]): string =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
  execFileSync('git', ['init', '-b', 'main', dir]);
  const fixture: RepoFixture = {
    dir,
    git,
    write(rel: string, content: string | Buffer): void {
      const absolute = path.join(dir, rel);
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, content);
    },
    remove(rel: string): void {
      rmSync(path.join(dir, rel), { force: true });
    },
    link(target: string, rel: string): void {
      const absolute = path.join(dir, rel);
      mkdirSync(path.dirname(absolute), { recursive: true });
      symlinkSync(target, absolute);
    },
    commit(message: string = 'commit'): string {
      git(['add', '-A']);
      git(['-c', 'user.email=sentinel-test@example.invalid', '-c', 'user.name=Sentinel Test', 'commit', '-m', message]);
      return fixture.sha('HEAD');
    },
    sha(ref: string): string {
      return git(['rev-parse', ref]);
    },
  };
  return fixture;
}

export function seedPolicyContext(repo: RepoFixture, loaded: LoadedPolicy): void {
  for (const contextPath of loaded.policy.contextPaths) {
    if (contextPath === 'tsconfig.json') repo.write(contextPath, '{"compilerOptions":{}}\n');
    else if (contextPath === 'package.json') repo.write(contextPath, '{"name":"fixture","private":true}\n');
    else repo.write(contextPath, `# stub ${contextPath}\n`);
  }
}

export function makeReport(snapshot: ReviewSnapshot, overrides: Partial<ReviewReport> = {}): ReviewReport {
  const sourcePaths = new Set(snapshot.files.map((file) => file.path));
  const coverage = snapshot.changes.flatMap((change) => {
    const relevant = new Set([change.path, ...(change.previousPath ? [change.previousPath] : [])]);
    const neighbors = [...new Set(snapshot.dependencyEdges.flatMap((edge) => [
      ...(relevant.has(edge.from) ? [edge.to] : []),
      ...(relevant.has(edge.to) ? [edge.from] : []),
    ]).filter((p) => !relevant.has(p) && sourcePaths.has(p)))].sort();
    return DIMENSIONS.map((dimension) => ({
      path: change.path,
      dimension,
      assessment: 'reviewed' as const,
      rationale: 'Compared head and base source plus dependency context.',
      relatedPaths: neighbors,
    }));
  });
  return {
    schemaVersion: 1,
    identity: structuredClone(snapshot.identity),
    ...(snapshot.partitionScope ? { partitionScope: structuredClone(snapshot.partitionScope) } : {}),
    complete: true,
    limitations: [],
    coverage,
    findings: [],
    reconciliations: [],
    ...overrides,
  };
}

export interface StateFixtureOptions {
  headSha?: string;
  previousHeadSha?: string | null;
  runId?: string;
}

export function makeSnapshotFixture(loaded: LoadedPolicy, options: StateFixtureOptions = {}): ReviewSnapshot {
  const headSha = options.headSha ?? 'a'.repeat(40);
  const baseSha = 'c'.repeat(40);
  return {
    schemaVersion: 1,
    identity: {
      repository: ALLOWED_REPOSITORY,
      pullRequest: 17,
      headSha,
      baseSha,
      mergeBaseSha: baseSha,
      policyDigest: loaded.digest,
      model: loaded.policy.model,
      runId: options.runId ?? 'run-1',
    },
    previousHeadSha: options.previousHeadSha === undefined ? null : options.previousHeadSha,
    changes: [{ path: 'src/action.ts', status: 'modified' }],
    size: { changedLines: 2, blockChangedLines: 1500 },
    files: [
      { path: 'src/action.ts', revision: 'base', content: 'export const required = true;\n' },
      { path: 'src/action.ts', revision: 'head', content: 'export const required = false;\n' },
      { path: 'tests/consumer.ts', revision: 'head', content: 'export const required = false;\n' },
    ],
    dependencyEdges: [{ from: 'tests/consumer.ts', to: 'src/action.ts' }],
    contextPlan: {
      strategy: 'symbol-aware-reverse-v1',
      selections: [{ path: 'src/action.ts', reasons: ['changed'] }],
      fallbacks: [],
    },
    cumulativeDiff: '-export const required = true;\n+export const required = false;\n',
    deltaDiff: null,
    complete: true,
    limitations: [],
  };
}
