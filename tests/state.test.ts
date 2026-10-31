import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import type { Finding, ReviewReport } from '../src/contracts.ts';
import { acquirePrLock, prStore, readLedger, recordReview, withPrLock } from '../src/state.ts';
import { loadTestPolicy, makeReport, makeSnapshotFixture, ALLOWED_REPOSITORY } from './helpers.ts';

const FIRST_SHA = 'a'.repeat(40);
const NEXT_SHA = 'b'.repeat(40);

function stateRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'srs-state-'));
}

function blocker(): Finding {
  const evidence = { path: 'src/action.ts', revision: 'head' as const, startLine: 1, endLine: 1, quote: 'export const required = false;' };
  return {
    id: 'F-setup',
    ruleId: 'SR-002',
    severity: 'blocker',
    title: 'Required setup is bypassed',
    explanation: 'The changed exported prerequisite can disable the required setup.',
    impact: 'The consumer can continue without creating its required data.',
    introducedBy: evidence,
    evidence: [evidence],
    counterEvidence: ['Captured context checked.'],
  };
}

function reportWithBlocker(snapshot: ReturnType<typeof makeSnapshotFixture>): ReviewReport {
  return makeReport(snapshot, { findings: [blocker()] });
}

test('an open blocker survives a second round that never clears it', (): void => {
  const root = stateRoot();
  const loaded = loadTestPolicy();
  const first = makeSnapshotFixture(loaded);
  const outcome1 = recordReview(root, first, reportWithBlocker(first), loaded.policy);
  assert.equal(outcome1.decision.status, 'changes_required');

  const second = makeSnapshotFixture(loaded, { headSha: NEXT_SHA, previousHeadSha: FIRST_SHA, runId: 'run-2' });
  const report2 = makeReport(second);
  const outcome2 = recordReview(root, second, report2, loaded.policy);
  assert.equal(outcome2.decision.status, 'incomplete');
  assert.equal(outcome2.decision.ledger.openFindings[0]?.id, 'F-setup');
  assert.equal(outcome2.decision.ledger.lastHeadSha, FIRST_SHA);

  const store = prStore(root, ALLOWED_REPOSITORY, 17);
  const ledger = readLedger(store);
  assert.equal(ledger.openFindings.length, 1);
  assert.equal(ledger.openFindings[0]?.id, 'F-setup');
  assert.equal(ledger.lastHeadSha, FIRST_SHA);
});

test('recording the identical run content is a no-op replay', (): void => {
  const root = stateRoot();
  const loaded = loadTestPolicy();
  const snapshot = makeSnapshotFixture(loaded);
  const report = reportWithBlocker(snapshot);
  const first = recordReview(root, snapshot, report, loaded.policy);
  const second = recordReview(root, snapshot, report, loaded.policy);
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.decision, first.decision);
  const store = prStore(root, ALLOWED_REPOSITORY, 17);
  assert.equal(readdirSync(store.runsDir).filter((name) => name.endsWith('.json')).length, 1);
});

test('a conflicting run id is rejected rather than overwriting the immutable record', (): void => {
  const root = stateRoot();
  const loaded = loadTestPolicy();
  const snapshot = makeSnapshotFixture(loaded);
  recordReview(root, snapshot, reportWithBlocker(snapshot), loaded.policy);
  const altered = makeReport(snapshot, { limitations: ['Different report content for the same run.'], complete: false });
  assert.throws(() => recordReview(root, snapshot, altered, loaded.policy), /already exists with different content/);
});

test('repositories and pull requests are isolated state partitions', (): void => {
  const root = stateRoot();
  const loaded = loadTestPolicy();
  const snapshot = makeSnapshotFixture(loaded);
  recordReview(root, snapshot, reportWithBlocker(snapshot), loaded.policy);
  const otherPr = makeSnapshotFixture(loaded, { runId: 'run-9' });
  otherPr.identity.pullRequest = 99;
  const report = makeReport(otherPr);
  const outcome = recordReview(root, otherPr, report, loaded.policy);
  assert.equal(outcome.decision.status, 'pass');
  const ledger17 = readLedger(prStore(root, ALLOWED_REPOSITORY, 17));
  const ledger99 = readLedger(prStore(root, ALLOWED_REPOSITORY, 99));
  assert.equal(ledger17.openFindings.length, 1);
  assert.equal(ledger99.openFindings.length, 0);
});

test('path-traversal identifiers are refused for repository, PR, and run id', (): void => {
  const root = stateRoot();
  assert.throws(() => prStore(root, '../escape', 1), /Unsafe repository/);
  assert.throws(() => prStore(root, 'a/../../x', 1), /Unsafe repository/);
  assert.throws(() => prStore(root, ALLOWED_REPOSITORY, Number.NaN), /Unsafe pull request/);
  const loaded = loadTestPolicy();
  const snapshot = makeSnapshotFixture(loaded, { runId: '../evil' });
  const report = makeReport(snapshot);
  assert.throws(() => recordReview(root, snapshot, report, loaded.policy), /Unsafe run id/);
});

test('concurrent same-PR writers cannot both hold the lock', (): void => {
  const root = stateRoot();
  const store = prStore(root, ALLOWED_REPOSITORY, 17);
  const lock = acquirePrLock(store, 'test');
  try {
    assert.throws(() => acquirePrLock(store), /already held/);
    assert.throws(() => withPrLock(store, (): void => undefined), /already held/);
    const moduleUrl = pathToFileURL(fileURLToPath(new URL('../src/state.ts', import.meta.url))).href;
    const child = spawnSync(process.execPath, [
      '--experimental-strip-types',
      '--input-type=module',
      '-e',
      `import { prStore, acquirePrLock } from ${JSON.stringify(moduleUrl)};
       try { acquirePrLock(prStore(${JSON.stringify(root)}, ${JSON.stringify(ALLOWED_REPOSITORY)}, 17)); console.log('acquired'); }
       catch (error) { console.error('refused'); process.exit(7); }`,
    ], { encoding: 'utf8' });
    assert.equal(child.status, 7, `expected cross-process lock refusal, got: ${child.stdout} ${child.stderr}`);
  } finally {
    lock.release();
  }
  const reacquired = acquirePrLock(store);
  reacquired.release();
});

test('interrupted ledger cache recovers from the ordered run journal', (): void => {
  const root = stateRoot();
  const loaded = loadTestPolicy();
  const snapshot = makeSnapshotFixture(loaded);
  const { decision } = recordReview(root, snapshot, reportWithBlocker(snapshot), loaded.policy);
  const store = prStore(root, ALLOWED_REPOSITORY, 17);
  assert.equal(readLedger(store).openFindings.length, 1);
  unlinkSync(store.ledgerPath);
  assert.equal(readLedger(store).openFindings.length, 1);
  assert.equal(readLedger(store).lastHeadSha, FIRST_SHA);
  writeFileSync(store.ledgerPath, 'corrupt{json');
  assert.equal(readLedger(store).openFindings.length, 1);
  unlinkSync(store.journalPath);
  assert.equal(readLedger(store).openFindings.length, 1);
  assert.equal(readLedger(store).lastHeadSha, FIRST_SHA);
  unlinkSync(store.ledgerPath);
  rmRuns(store.runsDir);
  assert.equal(readLedger(store).openFindings.length, 0);
});

function rmRuns(runsDir: string): void {
  for (const name of readdirSync(runsDir)) unlinkSync(path.join(runsDir, name));
}

test('incomplete gate attempts never clear prior blockers from persisted state', (): void => {
  const root = stateRoot();
  const loaded = loadTestPolicy();
  const first = makeSnapshotFixture(loaded);
  recordReview(root, first, reportWithBlocker(first), loaded.policy);

  const second = makeSnapshotFixture(loaded, { headSha: NEXT_SHA, previousHeadSha: FIRST_SHA, runId: 'run-2' });
  const malformedReport = { verdict: 'CLEAN' };
  const outcome = recordReview(root, second, malformedReport, loaded.policy);
  assert.equal(outcome.decision.status, 'incomplete');
  const ledger = readLedger(prStore(root, ALLOWED_REPOSITORY, 17));
  assert.equal(ledger.openFindings.length, 1);
  assert.equal(ledger.openFindings[0]?.id, 'F-setup');
});

test('a stale snapshot previousHeadSha cannot overwrite newer ledger state', (): void => {
  const root = stateRoot();
  const loaded = loadTestPolicy();
  const first = makeSnapshotFixture(loaded);
  recordReview(root, first, reportWithBlocker(first), loaded.policy);
  const stale = makeSnapshotFixture(loaded, { headSha: NEXT_SHA, previousHeadSha: null, runId: 'run-2' });
  const outcome = recordReview(root, stale, makeReport(stale), loaded.policy);
  assert.equal(outcome.decision.status, 'incomplete');
  const ledger = readLedger(prStore(root, ALLOWED_REPOSITORY, 17));
  assert.equal(ledger.lastHeadSha, FIRST_SHA);
  assert.equal(ledger.openFindings.length, 1);
});

test('a newer immutable run that was never journaled fails closed', (): void => {
  const root = stateRoot();
  const loaded = loadTestPolicy();
  const snapshot = makeSnapshotFixture(loaded);
  recordReview(root, snapshot, reportWithBlocker(snapshot), loaded.policy);
  const store = prStore(root, ALLOWED_REPOSITORY, 17);
  const record = JSON.parse(readFileSync(path.join(store.runsDir, 'run-1.json'), 'utf8'));
  record.runId = 'run-orphan';
  record.recordedAt = '2999-01-01T00:00:00.000Z';
  record.snapshot.identity.runId = 'run-orphan';
  writeFileSync(path.join(store.runsDir, 'run-orphan.json'), `${JSON.stringify(record, null, 2)}\n`);
  assert.throws(() => readLedger(store), /never journaled|manual recovery/);
  assert.throws(
    () => recordReview(root, makeSnapshotFixture(loaded, { headSha: NEXT_SHA, previousHeadSha: FIRST_SHA, runId: 'run-3' }), makeReport(makeSnapshotFixture(loaded, { runId: 'run-3' })), loaded.policy),
    /never journaled|manual recovery/,
  );
});

test('a malformed journal line fails closed despite valid earlier lines', (): void => {
  const root = stateRoot();
  const loaded = loadTestPolicy();
  const snapshot = makeSnapshotFixture(loaded);
  const { decision } = recordReview(root, snapshot, reportWithBlocker(snapshot), loaded.policy);
  const store = prStore(root, ALLOWED_REPOSITORY, 17);
  writeFileSync(store.journalPath, `${readFileSync(store.journalPath, 'utf8')}{corrupt-line\n`);
  assert.throws(() => readLedger(store), /journal line 2|manual recovery/);
  const replay = () => recordReview(root, snapshot, reportWithBlocker(snapshot), loaded.policy);
  assert.throws(replay, /journal line 2|manual recovery/);
  void decision;
});

test('a corrupt only-ledger fails closed instead of returning an empty ledger', (): void => {
  const root = stateRoot();
  const store = prStore(root, ALLOWED_REPOSITORY, 17);
  mkdirSync(store.dir, { recursive: true });
  writeFileSync(store.ledgerPath, '{corrupt-cache');
  assert.throws(() => readLedger(store), /manual recovery|unusable ledger cache/);
});

test('a corrupt run record fails closed instead of being skipped', (): void => {
  const root = stateRoot();
  const loaded = loadTestPolicy();
  const snapshot = makeSnapshotFixture(loaded);
  recordReview(root, snapshot, reportWithBlocker(snapshot), loaded.policy);
  const store = prStore(root, ALLOWED_REPOSITORY, 17);
  writeFileSync(path.join(store.runsDir, 'broken.json'), 'not json at all');
  assert.throws(() => readLedger(store), /unparseable run record|manual recovery/);
  const invalidSeverity = JSON.parse(readFileSync(path.join(store.runsDir, 'run-1.json'), 'utf8'));
  invalidSeverity.decision.ledger.openFindings[0].severity = 'critical';
  writeFileSync(path.join(store.runsDir, 'run-1.json'), JSON.stringify(invalidSeverity));
  unlinkSync(path.join(store.runsDir, 'broken.json'));
  assert.throws(() => readLedger(store), /invalid severity|manual recovery/);
});

test('a duplicated journal entry cannot resurrect an older clean ledger', (): void => {
  const root = stateRoot();
  const loaded = loadTestPolicy();
  const first = makeSnapshotFixture(loaded);
  recordReview(root, first, makeReport(first), loaded.policy);
  const second = makeSnapshotFixture(loaded, { headSha: NEXT_SHA, previousHeadSha: FIRST_SHA, runId: 'run-2' });
  recordReview(root, second, reportWithBlocker(second), loaded.policy);
  const store = prStore(root, ALLOWED_REPOSITORY, 17);
  assert.equal(readLedger(store).openFindings.length, 1);
  const lines = readFileSync(store.journalPath, 'utf8').split('\n').filter((line) => line.trim().length > 0);
  writeFileSync(store.journalPath, `${lines.join('\n')}\n${lines[0]}\n`);
  assert.throws(() => readLedger(store), /duplicate entry|manual recovery/);
  assert.throws(() => recordReview(root, first, makeReport(first), loaded.policy), /duplicate entry|manual recovery/);
});

test('a journal entry with a mismatched recordedAt fails closed', (): void => {
  const root = stateRoot();
  const loaded = loadTestPolicy();
  const snapshot = makeSnapshotFixture(loaded);
  recordReview(root, snapshot, reportWithBlocker(snapshot), loaded.policy);
  const store = prStore(root, ALLOWED_REPOSITORY, 17);
  const entry = JSON.parse(readFileSync(store.journalPath, 'utf8').split('\n')[0]);
  entry.recordedAt = '1970-01-01T00:00:00.000Z';
  writeFileSync(store.journalPath, `${JSON.stringify(entry)}\n`);
  assert.throws(() => readLedger(store), /recordedAt|manual recovery/);
});

test('a run record stored under the wrong filename fails closed', (): void => {
  const root = stateRoot();
  const loaded = loadTestPolicy();
  const snapshot = makeSnapshotFixture(loaded);
  recordReview(root, snapshot, reportWithBlocker(snapshot), loaded.policy);
  const store = prStore(root, ALLOWED_REPOSITORY, 17);
  const content = readFileSync(path.join(store.runsDir, 'run-1.json'), 'utf8');
  writeFileSync(path.join(store.runsDir, 'renamed-copy.json'), content);
  assert.throws(() => readLedger(store), /does not match runId|manual recovery/);
});

test('recording is refused into journal-less state until manual restoration', (): void => {
  const root = stateRoot();
  const loaded = loadTestPolicy();
  const snapshot = makeSnapshotFixture(loaded);
  recordReview(root, snapshot, reportWithBlocker(snapshot), loaded.policy);
  const store = prStore(root, ALLOWED_REPOSITORY, 17);
  unlinkSync(store.journalPath);
  const recovered = readLedger(store);
  assert.equal(recovered.openFindings.length, 1);
  const replay = () => recordReview(root, snapshot, reportWithBlocker(snapshot), loaded.policy);
  assert.throws(replay, /journal is missing|manually restored|manual recovery/);
  const next = makeSnapshotFixture(loaded, { headSha: NEXT_SHA, previousHeadSha: FIRST_SHA, runId: 'run-2' });
  assert.throws(() => recordReview(root, next, makeReport(next), loaded.policy), /journal is missing|manually restored|manual recovery/);
  assert.equal(existsSync(store.journalPath), false);
  assert.equal(readdirSync(store.runsDir).filter((name) => name.endsWith('.json')).length, 1);
});
