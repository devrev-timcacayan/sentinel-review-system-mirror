import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ALLOWED_REPOSITORY, loadTestPolicy, makeRepo, seedPolicyContext } from './helpers.ts';
import type { RepoFixture } from './helpers.ts';
import type { ReviewSnapshot } from '../src/contracts.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

function cli(args: string[]): CliResult {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', CLI, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

interface PreparedRepo {
  repo: RepoFixture;
  baseSha: string;
  headSha: string;
  stateRoot: string;
  outDir: string;
}

function prepareArgs(
  prepared: PreparedRepo,
  options: { overrides?: Record<string, string>; extra?: string[] } = {},
): string[] {
  const flags = new Map<string, string>([
    ['checkout', prepared.repo.dir],
    ['repository', ALLOWED_REPOSITORY],
    ['pr', '17'],
    ['base', prepared.baseSha],
    ['head', prepared.headSha],
    ['run-id', 'run-cli'],
    ['out', prepared.outDir],
    ['state-root', prepared.stateRoot],
  ]);
  for (const [key, value] of Object.entries(options.overrides ?? {})) flags.set(key, value);
  return ['prepare', ...[...flags.entries()].flatMap(([key, value]) => [`--${key}`, value]), ...(options.extra ?? [])];
}

function makePreparedRepo(): PreparedRepo {
  const repo = makeRepo();
  const loaded = loadTestPolicy();
  seedPolicyContext(repo, loaded);
  repo.write('src/a.ts', 'export const a = 1;\n');
  const baseSha = repo.commit('base');
  repo.write('src/a.ts', 'export const a = 2;\n');
  const headSha = repo.commit('head');
  return {
    repo,
    baseSha,
    headSha,
    stateRoot: mkdtempSync(path.join(tmpdir(), 'srs-cli-state-')),
    outDir: mkdtempSync(path.join(tmpdir(), 'srs-cli-out-')),
  };
}

function readSnapshot(prepared: PreparedRepo): ReviewSnapshot {
  return JSON.parse(readFileSync(path.join(prepared.outDir, 'snapshot.json'), 'utf8')) as ReviewSnapshot;
}

function writeReport(prepared: PreparedRepo, report: unknown): string {
  const reportPath = path.join(prepared.outDir, 'report.json');
  writeFileSync(reportPath, `${JSON.stringify(report)}\n`);
  return reportPath;
}

function passingReport(snapshot: ReviewSnapshot): unknown {
  return {
    schemaVersion: 1,
    identity: snapshot.identity,
    complete: true,
    limitations: [],
    coverage: snapshot.changes.flatMap((change) => ['test-validity', 'reliability-impact', 'maintainability'].map((dimension) => ({
      path: change.path,
      dimension,
      assessment: 'reviewed',
      rationale: 'Checked head/base source.',
      relatedPaths: [],
    }))),
    findings: [],
    reconciliations: [],
  };
}

test('prepare writes snapshot and review request with embedded response contract', (): void => {
  const prepared = makePreparedRepo();
  const result = cli(prepareArgs(prepared));
  assert.equal(result.status, 0, result.stderr);
  const snapshot = readSnapshot(prepared);
  assert.equal(snapshot.identity.repository, ALLOWED_REPOSITORY);
  assert.equal(snapshot.identity.pullRequest, 17);
  assert.equal(snapshot.identity.headSha, prepared.headSha);
  assert.equal(snapshot.complete, true);
  const request = JSON.parse(readFileSync(path.join(prepared.outDir, 'review-request.json'), 'utf8'));
  assert.equal(request.policyDigest, snapshot.identity.policyDigest);
  assert.match(request.responseContract, /interface ReviewSnapshot/);
  assert.match(request.prompt, /Sentinel cumulative review contract/);
  assert.deepEqual(request.snapshot, snapshot);
  assert.equal(request.priorLedger.lastHeadSha, null);
});

test('prepare is idempotent for identical packets and refuses to overwrite different data', (): void => {
  const prepared = makePreparedRepo();
  assert.equal(cli(prepareArgs(prepared)).status, 0);
  const again = cli(prepareArgs(prepared));
  assert.equal(again.status, 0, again.stderr);
  const changed = cli(prepareArgs(prepared, { overrides: { 'run-id': 'run-cli-2' } }));
  assert.equal(changed.status, 1);
  assert.match(changed.stderr, /Refusing to overwrite/);
});

test('prepare refuses to publish over different pre-existing packet data', (): void => {
  const prepared = makePreparedRepo();
  assert.equal(cli(prepareArgs(prepared)).status, 0);
  writeFileSync(path.join(prepared.outDir, 'snapshot.json'), '{"tampered":true}\n');
  const result = cli(prepareArgs(prepared));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing to overwrite/);
  assert.equal(readFileSync(path.join(prepared.outDir, 'snapshot.json'), 'utf8'), '{"tampered":true}\n');
});


test('prepare immediately refuses a PR over the agreed line threshold without a packet', (): void => {
  const prepared = makePreparedRepo();
  prepared.repo.write('src/large.ts', Array.from({ length: 1501 }, (_value, index) => `export const line${index} = ${index};`).join('\n') + '\n');
  const oversizedHead = prepared.repo.commit('oversized');
  const outDir = mkdtempSync(path.join(tmpdir(), 'srs-cli-oversized-'));
  const result = cli(prepareArgs(prepared, { overrides: { head: oversizedHead, out: outDir } }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /1501 changed lines|1500-line limit/);
  assert.equal(existsSync(path.join(outDir, 'snapshot.json')), false);
  assert.equal(existsSync(path.join(outDir, 'review-request.json')), false);
});
test('record evaluates under lock, persists, and replays identical submissions', (): void => {
  const prepared = makePreparedRepo();
  assert.equal(cli(prepareArgs(prepared)).status, 0);
  const snapshotPath = path.join(prepared.outDir, 'snapshot.json');
  const reportPath = writeReport(prepared, passingReport(readSnapshot(prepared)));
  const first = cli(['record', '--snapshot', snapshotPath, '--report', reportPath, '--state-root', prepared.stateRoot]);
  assert.equal(first.status, 0, first.stderr);
  const firstOut = JSON.parse(first.stdout);
  assert.equal(firstOut.decision.status, 'pass');
  assert.equal(firstOut.replayed, false);
  const second = cli(['record', '--snapshot', snapshotPath, '--report', reportPath, '--state-root', prepared.stateRoot]);
  assert.equal(second.status, 0);
  assert.equal(JSON.parse(second.stdout).replayed, true);
  const conflictingReport = writeReport(prepared, { different: 'content' });
  const conflict = cli(['record', '--snapshot', snapshotPath, '--report', conflictingReport, '--state-root', prepared.stateRoot]);
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /different content/);
});

test('a replayed historical pass is marked superseded once newer state intervenes', (): void => {
  const prepared = makePreparedRepo();
  assert.equal(cli(prepareArgs(prepared)).status, 0);
  const snapshotPath = path.join(prepared.outDir, 'snapshot.json');
  const reportPath = writeReport(prepared, passingReport(readSnapshot(prepared)));
  assert.equal(cli(['record', '--snapshot', snapshotPath, '--report', reportPath, '--state-root', prepared.stateRoot]).status, 0);

  prepared.repo.write('src/b.ts', 'export const b = 1;\n');
  const head2 = prepared.repo.commit('second push');
  const out2 = mkdtempSync(path.join(tmpdir(), 'srs-cli-out4-'));
  const rerun = cli(prepareArgs(prepared, { overrides: { 'run-id': 'run-cli-2', head: head2, out: out2 } }));
  assert.equal(rerun.status, 0, rerun.stderr);
  const snapshot2 = JSON.parse(readFileSync(path.join(out2, 'snapshot.json'), 'utf8')) as ReviewSnapshot;
  const blockerReport = {
    ...(passingReport(snapshot2) as Record<string, unknown>),
    findings: [{
      id: 'F-2',
      ruleId: 'SR-002',
      severity: 'blocker',
      title: 'Required setup bypassed',
      explanation: 'Mechanism shown.',
      impact: 'Reachable consequence.',
      introducedBy: { path: 'src/b.ts', revision: 'head', startLine: 1, endLine: 1, quote: 'export const b = 1;' },
      evidence: [{ path: 'src/b.ts', revision: 'head', startLine: 1, endLine: 1, quote: 'export const b = 1;' }],
      counterEvidence: ['Checked.'],
    }],
  };
  const blockerPath = path.join(out2, 'report.json');
  writeFileSync(blockerPath, `${JSON.stringify(blockerReport)}\n`);
  const blocked = cli(['record', '--snapshot', path.join(out2, 'snapshot.json'), '--report', blockerPath, '--state-root', prepared.stateRoot]);
  assert.equal(blocked.status, 2, blocked.stderr);

  const replay = cli(['record', '--snapshot', snapshotPath, '--report', reportPath, '--state-root', prepared.stateRoot]);
  assert.equal(replay.status, 3, 'a superseded historical pass must not exit 0');
  const out = JSON.parse(replay.stdout);
  assert.equal(out.replayed, true);
  assert.equal(out.superseded, true);
  assert.equal(out.decision.status, 'pass', 'historical decision returned as data only');
});

test('record exit codes distinguish pass, changes_required, and incomplete', (): void => {
  const prepared = makePreparedRepo();
  assert.equal(cli(prepareArgs(prepared)).status, 0);
  const snapshot = readSnapshot(prepared);
  const snapshotPath = path.join(prepared.outDir, 'snapshot.json');
  const blockerReport = {
    ...(passingReport(snapshot) as Record<string, unknown>),
    findings: [{
      id: 'F-1',
      ruleId: 'SR-002',
      severity: 'blocker',
      title: 'Required setup bypassed',
      explanation: 'Mechanism shown.',
      impact: 'Reachable consequence.',
      introducedBy: { path: 'src/a.ts', revision: 'head', startLine: 1, endLine: 1, quote: 'export const a = 2;' },
      evidence: [{ path: 'src/a.ts', revision: 'head', startLine: 1, endLine: 1, quote: 'export const a = 2;' }],
      counterEvidence: ['Checked.'],
    }],
  };
  const blockerPath = writeReport(prepared, blockerReport);
  const blocked = cli(['record', '--snapshot', snapshotPath, '--report', blockerPath, '--state-root', prepared.stateRoot]);
  assert.equal(blocked.status, 2, blocked.stderr);
  const prepared2 = makePreparedRepo();
  assert.equal(cli(prepareArgs(prepared2)).status, 0);
  const snapshot2 = readSnapshot(prepared2);
  const incompleteReport = { ...(passingReport(snapshot2) as Record<string, unknown>), complete: false, limitations: ['Runtime wiring unavailable.'] };
  const incompletePath = writeReport(prepared2, incompleteReport);
  const incomplete = cli(['record', '--snapshot', path.join(prepared2.outDir, 'snapshot.json'), '--report', incompletePath, '--state-root', prepared2.stateRoot]);
  assert.equal(incomplete.status, 3, incomplete.stderr);
});

test('record rejects tampered snapshot digests and malformed report JSON', (): void => {
  const prepared = makePreparedRepo();
  assert.equal(cli(prepareArgs(prepared)).status, 0);
  const snapshotPath = path.join(prepared.outDir, 'snapshot.json');
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  snapshot.identity.policyDigest = '0'.repeat(64);
  const tamperedPath = path.join(prepared.outDir, 'tampered-snapshot.json');
  writeFileSync(tamperedPath, JSON.stringify(snapshot));
  const reportPath = writeReport(prepared, passingReport(readSnapshot(prepared)));
  const tampered = cli(['record', '--snapshot', tamperedPath, '--report', reportPath, '--state-root', prepared.stateRoot]);
  assert.equal(tampered.status, 1);
  assert.match(tampered.stderr, /policyDigest/);
  const badReport = path.join(prepared.outDir, 'bad-report.json');
  writeFileSync(badReport, '{not json');
  const malformed = cli(['record', '--snapshot', snapshotPath, '--report', badReport, '--state-root', prepared.stateRoot]);
  assert.equal(malformed.status, 1);
});

test('record refuses duplicated JSON keys instead of accepting a permissive last value', (): void => {
  const prepared = makePreparedRepo();
  assert.equal(cli(prepareArgs(prepared)).status, 0);
  const report = JSON.stringify(passingReport(readSnapshot(prepared)))
    .replace('"complete":true', '"complete":false,"complete":true');
  assert.ok(report.includes('"complete":false,"complete":true'));
  const reportPath = path.join(prepared.outDir, 'duplicate-keys.json');
  writeFileSync(reportPath, report);
  const result = cli(['record', '--snapshot', path.join(prepared.outDir, 'snapshot.json'), '--report', reportPath, '--state-root', prepared.stateRoot]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not valid JSON/);
});

test('prepare defaults previous head from the persisted ledger and rejects conflicting overrides', (): void => {
  const prepared = makePreparedRepo();
  assert.equal(cli(prepareArgs(prepared)).status, 0);
  const reportPath = writeReport(prepared, passingReport(readSnapshot(prepared)));
  assert.equal(cli(['record', '--snapshot', path.join(prepared.outDir, 'snapshot.json'), '--report', reportPath, '--state-root', prepared.stateRoot]).status, 0);
  const repo2 = prepared.repo;
  repo2.write('src/b.ts', 'export const b = 1;\n');
  const head2 = repo2.commit('second push');
  const prepared2 = { ...prepared, headSha: head2 };
  const out2 = mkdtempSync(path.join(tmpdir(), 'srs-cli-out2-'));
  const rerun = cli(prepareArgs(prepared2, { overrides: { 'run-id': 'run-cli-2', out: out2 } }));
  assert.equal(rerun.status, 0, rerun.stderr);
  const rerunSnapshot = JSON.parse(readFileSync(path.join(out2, 'snapshot.json'), 'utf8')) as ReviewSnapshot;
  assert.equal(rerunSnapshot.previousHeadSha, prepared.headSha);
  const conflict = cli(prepareArgs(prepared2, { overrides: { 'run-id': 'run-cli-3', 'previous-head': prepared.baseSha, out: mkdtempSync(path.join(tmpdir(), 'srs-cli-out3-')) } }));
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /conflicting|persisted ledger/);
});

test('journal-migrate reports backup and no-op status while refusing a held PR lock', (): void => {
  const prepared = makePreparedRepo();
  assert.equal(cli(prepareArgs(prepared)).status, 0);
  const snapshotPath = path.join(prepared.outDir, 'snapshot.json');
  const reportPath = writeReport(prepared, passingReport(readSnapshot(prepared)));
  assert.equal(cli(['record', '--snapshot', snapshotPath, '--report', reportPath, '--state-root', prepared.stateRoot]).status, 0);
  const journalPath = path.join(prepared.stateRoot, 'repos', ...ALLOWED_REPOSITORY.split('/'), 'prs', '17', 'journal.jsonl');
  const entry = JSON.parse(readFileSync(journalPath, 'utf8'));
  delete entry.seq;
  delete entry.previousLedger;
  writeFileSync(journalPath, `${JSON.stringify(entry)}\n`);

  const migrated = cli(['journal-migrate', '--repository', ALLOWED_REPOSITORY, '--pr', '17', '--state-root', prepared.stateRoot]);
  assert.equal(migrated.status, 0, migrated.stderr);
  const migrationOutput = JSON.parse(migrated.stdout);
  assert.equal(migrationOutput.status, 'migrated');
  assert.equal(typeof migrationOutput.backupPath, 'string');
  assert.equal(readFileSync(migrationOutput.backupPath, 'utf8').includes('"seq"'), false);

  const noop = cli(['journal-migrate', '--repository', ALLOWED_REPOSITORY, '--pr', '17', '--state-root', prepared.stateRoot]);
  assert.equal(noop.status, 0, noop.stderr);
  assert.equal(JSON.parse(noop.stdout).status, 'already-current');
  assert.equal(JSON.parse(noop.stdout).backupPath, null);

  const lockPath = path.join(path.dirname(journalPath), 'review.lock');
  writeFileSync(lockPath, JSON.stringify({ token: 'held-by-test', pid: process.pid }));
  const refused = cli(['journal-migrate', '--repository', ALLOWED_REPOSITORY, '--pr', '17', '--state-root', prepared.stateRoot]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /already held/);
});

test('retrospective writes draft and request without touching policy', (): void => {
  const prepared = makePreparedRepo();
  assert.equal(cli(prepareArgs(prepared)).status, 0);
  const reportPath = writeReport(prepared, passingReport(readSnapshot(prepared)));
  assert.equal(cli(['record', '--snapshot', path.join(prepared.outDir, 'snapshot.json'), '--report', reportPath, '--state-root', prepared.stateRoot]).status, 0);
  const eventPath = path.join(prepared.outDir, 'event.json');
  writeFileSync(eventPath, JSON.stringify({ action: 'closed', merged: true, headSha: prepared.headSha, eventId: 'evt-cli' }));
  const retroOut = mkdtempSync(path.join(tmpdir(), 'srs-cli-retro-'));
  const result = cli(['retrospective', '--repository', ALLOWED_REPOSITORY, '--pr', '17', '--event', eventPath, '--out', retroOut, '--state-root', prepared.stateRoot]);
  assert.equal(result.status, 0, result.stderr);
  const draft = JSON.parse(readFileSync(path.join(retroOut, 'retrospective-draft.json'), 'utf8'));
  assert.equal(draft.status, 'needs-human-verification');
  assert.equal(draft.mode, 'merged');
  assert.equal(draft.reviewHistory.length, 1);
  const request = JSON.parse(readFileSync(path.join(retroOut, 'retrospective-request.json'), 'utf8'));
  assert.match(request.prompt, /retrospective/i);
});

test('unknown args, duplicates, unsafe identifiers, and missing params are refused', (): void => {
  assert.equal(cli(['frobnicate']).status, 1);
  const prepared = makePreparedRepo();
  assert.equal(cli(prepareArgs(prepared, { extra: ['--bogus', 'x'] })).status, 1);
  assert.equal(cli(prepareArgs(prepared, { extra: ['--pr', '18', '--pr', '18'] })).status, 1);
  assert.equal(cli(prepareArgs(prepared, { overrides: { repository: 'devrev/sentinel' } })).status, 1);
  assert.equal(cli(prepareArgs(prepared, { overrides: { repository: '../escape' } })).status, 1);
  const missing = cli(['prepare', '--checkout', prepared.repo.dir]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Missing required/);
  assert.equal(cli(['--help']).status, 0);
});

test('importing the cli module does not execute the command line', async (): Promise<void> => {
  const module = await import('../src/cli.ts');
  assert.equal(typeof module.runCli, 'function');
});
