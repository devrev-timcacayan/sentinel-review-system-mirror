import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import type { Finding, ReviewReport } from '../src/contracts.ts';
import { acquirePrLock, migrateLegacyJournal, prStore, readLedger, recordReview, StateCorruptionError, withPrLock } from '../src/state.ts';
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

test('persisted findings require their complete evidence shape before ledger consumers use them', (): void => {
  const root = stateRoot();
  const loaded = loadTestPolicy();
  const snapshot = makeSnapshotFixture(loaded);
  recordReview(root, snapshot, reportWithBlocker(snapshot), loaded.policy);
  const store = prStore(root, ALLOWED_REPOSITORY, 17);
  const runPath = path.join(store.runsDir, 'run-1.json');
  const original = JSON.parse(readFileSync(runPath, 'utf8'));
  const malformedFindings: Array<[string, (finding: Record<string, unknown>) => void]> = [
    ['introducedBy', (finding) => { delete finding.introducedBy; }],
    ['ruleId', (finding) => { delete finding.ruleId; }],
    ['evidence array', (finding) => { finding.evidence = []; }],
    ['counterEvidence', (finding) => { delete finding.counterEvidence; }],
    ['coordinates', (finding) => { (finding.introducedBy as Record<string, unknown>).startLine = 0; }],
    ['path', (finding) => { (finding.introducedBy as Record<string, unknown>).path = '../outside.ts'; }],
  ];

  unlinkSync(store.journalPath);
  for (const [field, corrupt] of malformedFindings) {
    const record = structuredClone(original);
    corrupt(record.decision.ledger.openFindings[0]);
    writeFileSync(runPath, JSON.stringify(record));
    assert.throws(
      () => readLedger(store),
      (error: unknown) => error instanceof StateCorruptionError
        && /manual recovery/.test(error.message)
        && error.message.includes(runPath),
      `malformed ${field} must identify the authoritative origin`,
    );
  }
});

test('duplicate persisted finding IDs require recovery', (): void => {
  const root = stateRoot();
  const loaded = loadTestPolicy();
  const snapshot = makeSnapshotFixture(loaded);
  recordReview(root, snapshot, reportWithBlocker(snapshot), loaded.policy);
  const store = prStore(root, ALLOWED_REPOSITORY, 17);
  const runPath = path.join(store.runsDir, 'run-1.json');
  const record = JSON.parse(readFileSync(runPath, 'utf8'));
  record.decision.ledger.openFindings.push(structuredClone(record.decision.ledger.openFindings[0]));
  writeFileSync(runPath, JSON.stringify(record));
  unlinkSync(store.journalPath);

  assert.throws(() => readLedger(store), (error: unknown) => error instanceof StateCorruptionError
    && /duplicate finding ID/.test(error.message)
    && error.message.includes(runPath));
});

test('recording completes short filesystem writes without truncating UTF-8 state', (): void => {
  const root = stateRoot();
  const moduleUrl = pathToFileURL(fileURLToPath(new URL('../src/state.ts', import.meta.url))).href;
  const helpersUrl = pathToFileURL(fileURLToPath(new URL('./helpers.ts', import.meta.url))).href;
  const child = spawnSync(process.execPath, [
    '--experimental-strip-types',
    '--input-type=module',
    '-e',
    `import fs from 'node:fs';
     import { syncBuiltinESMExports } from 'node:module';
     import { recordReview, prStore, readLedger } from ${JSON.stringify(moduleUrl)};
     import { loadTestPolicy, makeReport, makeSnapshotFixture, ALLOWED_REPOSITORY } from ${JSON.stringify(helpersUrl)};
     const originalWriteSync = fs.writeSync.bind(fs);
     fs.writeSync = (fd, data, ...args) => {
       if (typeof data === 'string') {
         const [position, encoding] = args;
         return originalWriteSync(fd, data.slice(0, 5), position, encoding);
       }
       const offset = args[0] ?? 0;
       const length = args[1] ?? data.length - offset;
       return originalWriteSync(fd, data, offset, Math.min(length, 5), args[2]);
     };
     syncBuiltinESMExports();
     const loaded = loadTestPolicy();
     const snapshot = makeSnapshotFixture(loaded);
     const report = makeReport(snapshot, { findings: [
       { id: 'F-utf8', ruleId: 'SR-002', severity: 'blocker', title: 'Unicode evidence 🚀',
         explanation: 'Unicode finding explanation.', impact: 'Unicode impact.',
         introducedBy: { path: 'src/action.ts', revision: 'head', startLine: 1, endLine: 1, quote: 'export const required = false;' },
         evidence: [{ path: 'src/action.ts', revision: 'head', startLine: 1, endLine: 1, quote: 'export const required = false;' }],
         counterEvidence: ['Unicode counter-evidence ✓'] },
     ] });
     recordReview(${JSON.stringify(root)}, snapshot, report, loaded.policy);
     const ledger = readLedger(prStore(${JSON.stringify(root)}, ALLOWED_REPOSITORY, 17));
     if (ledger.openFindings[0]?.title !== 'Unicode evidence 🚀') process.exit(19);`,
  ], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 0, `short-write child failed: ${child.stdout} ${child.stderr}`);
  const store = prStore(root, ALLOWED_REPOSITORY, 17);
  const record = JSON.parse(readFileSync(path.join(store.runsDir, 'run-1.json'), 'utf8'));
  assert.equal(record.report.findings[0].title, 'Unicode evidence 🚀');
  assert.equal(readLedger(store).openFindings[0]?.counterEvidence[0], 'Unicode counter-evidence ✓');
});

test('zero-progress filesystem writes fail promptly at the public record boundary', (): void => {
  const root = stateRoot();
  const moduleUrl = pathToFileURL(fileURLToPath(new URL('../src/state.ts', import.meta.url))).href;
  const helpersUrl = pathToFileURL(fileURLToPath(new URL('./helpers.ts', import.meta.url))).href;
  const child = spawnSync(process.execPath, [
    '--experimental-strip-types',
    '--input-type=module',
    '-e',
    `import fs from 'node:fs';
     import { syncBuiltinESMExports } from 'node:module';
     import { recordReview, prStore, readLedger } from ${JSON.stringify(moduleUrl)};
     import { loadTestPolicy, makeReport, makeSnapshotFixture, ALLOWED_REPOSITORY } from ${JSON.stringify(helpersUrl)};
     const originalOpenSync = fs.openSync.bind(fs);
     const originalWriteSync = fs.writeSync.bind(fs);
     const targets = new Set();
     fs.openSync = (filePath, flags, ...args) => {
       const fd = originalOpenSync(filePath, flags, ...args);
       if (String(filePath).endsWith('/journal.jsonl')) targets.add(fd);
       return fd;
     };
     fs.writeSync = (fd, ...args) => targets.has(fd) ? 0 : originalWriteSync(fd, ...args);
     syncBuiltinESMExports();
     const loaded = loadTestPolicy();
     const snapshot = makeSnapshotFixture(loaded);
     try { recordReview(${JSON.stringify(root)}, snapshot, makeReport(snapshot), loaded.policy); process.exit(21); }
     catch (error) { if (!/File write made no progress/.test(error.message)) throw error; }
     try { readLedger(prStore(${JSON.stringify(root)}, ALLOWED_REPOSITORY, 17)); process.exit(22); }
     catch (error) { if (!/manual recovery/.test(error.message)) throw error; }`,
  ], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 0, `zero-write child failed: ${child.stdout} ${child.stderr}`);
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

test('an identical replay after intervening state is flagged superseded, not a fresh pass', (): void => {
  const root = stateRoot();
  const loaded = loadTestPolicy();
  const first = makeSnapshotFixture(loaded);
  const clean = recordReview(root, first, makeReport(first), loaded.policy);
  assert.equal(clean.decision.status, 'pass');
  const second = makeSnapshotFixture(loaded, { headSha: NEXT_SHA, previousHeadSha: FIRST_SHA, runId: 'run-2' });
  const blocked = recordReview(root, second, reportWithBlocker(second), loaded.policy);
  assert.equal(blocked.decision.status, 'changes_required');
  const replay = recordReview(root, first, makeReport(first), loaded.policy);
  assert.equal(replay.replayed, true);
  assert.equal(replay.superseded, true, 'a newer ledger must prevent the old pass from standing as current state');
  assert.equal(replay.decision.status, 'pass', 'the historical decision is returned as historical data only');
  assert.equal(readLedger(prStore(root, ALLOWED_REPOSITORY, 17)).openFindings.length, 1);
});

test('an intervening incomplete run supersedes an older pass even when the ledger is unchanged', (): void => {
  const root = stateRoot();
  const loaded = loadTestPolicy();
  const first = makeSnapshotFixture(loaded);
  recordReview(root, first, makeReport(first), loaded.policy);
  const second = makeSnapshotFixture(loaded, { headSha: FIRST_SHA, previousHeadSha: FIRST_SHA, runId: 'run-2' });
  const stalled = recordReview(root, second, makeReport(second, { complete: false, limitations: ['Required context unavailable.'] }), loaded.policy);
  assert.equal(stalled.decision.status, 'incomplete');
  assert.equal(readLedger(prStore(root, ALLOWED_REPOSITORY, 17)).lastHeadSha, FIRST_SHA);
  const replay = recordReview(root, first, makeReport(first), loaded.policy);
  assert.equal(replay.replayed, true);
  assert.equal(replay.superseded, true, 'the newer journaled run supersedes the old pass even without ledger drift');
});

test('migration refuses a reordered current journal without changing its bytes', (): void => {
  const root = stateRoot();
  const loaded = loadTestPolicy();
  const first = makeSnapshotFixture(loaded);
  recordReview(root, first, makeReport(first), loaded.policy);
  const second = makeSnapshotFixture(loaded, { headSha: NEXT_SHA, previousHeadSha: FIRST_SHA, runId: 'run-2' });
  recordReview(root, second, reportWithBlocker(second), loaded.policy);
  const store = prStore(root, ALLOWED_REPOSITORY, 17);
  const lines = readFileSync(store.journalPath, 'utf8').split('\n').filter((line) => line.trim().length > 0);
  const corrupt = `${lines[1]}\n${lines[0]}\n`;
  writeFileSync(store.journalPath, corrupt);

  assert.throws(() => migrateLegacyJournal(store), /sequence|previous ledger|manual recovery/);
  assert.equal(readFileSync(store.journalPath, 'utf8'), corrupt);
});

test('migration leaves a valid current journal untouched without a backup', (): void => {
  const root = stateRoot();
  const loaded = loadTestPolicy();
  const snapshot = makeSnapshotFixture(loaded);
  recordReview(root, snapshot, makeReport(snapshot), loaded.policy);
  const store = prStore(root, ALLOWED_REPOSITORY, 17);
  const before = readFileSync(store.journalPath);
  const beforeInode = statSync(store.journalPath).ino;
  const migration = migrateLegacyJournal(store);

  assert.deepEqual(migration, { migrated: 1, alreadyCurrent: true, status: 'already-current', backupPath: null });
  assert.deepEqual(readFileSync(store.journalPath), before);
  assert.equal(statSync(store.journalPath).ino, beforeInode);
});

test('migration refuses partial sequencing fields and retains original bytes', (): void => {
  const root = stateRoot();
  const loaded = loadTestPolicy();
  const snapshot = makeSnapshotFixture(loaded);
  recordReview(root, snapshot, makeReport(snapshot), loaded.policy);
  const store = prStore(root, ALLOWED_REPOSITORY, 17);
  const entry = JSON.parse(readFileSync(store.journalPath, 'utf8')) as Record<string, unknown>;
  delete entry.previousLedger;
  const corrupt = `${JSON.stringify(entry)}\n`;
  writeFileSync(store.journalPath, corrupt);

  assert.throws(() => migrateLegacyJournal(store), /partial sequencing|manual recovery/);
  assert.equal(readFileSync(store.journalPath, 'utf8'), corrupt);
});

test('migration refuses malformed current sequence values without changing journal bytes', (): void => {
  const root = stateRoot();
  const loaded = loadTestPolicy();
  const snapshot = makeSnapshotFixture(loaded);
  recordReview(root, snapshot, makeReport(snapshot), loaded.policy);
  const store = prStore(root, ALLOWED_REPOSITORY, 17);
  const entry = JSON.parse(readFileSync(store.journalPath, 'utf8'));
  entry.seq = '1';
  const corrupt = `${JSON.stringify(entry)}\n`;
  writeFileSync(store.journalPath, corrupt);

  assert.throws(() => migrateLegacyJournal(store), /invalid sequence|manual recovery/);
  assert.equal(readFileSync(store.journalPath, 'utf8'), corrupt);
});

test('migration refuses mixed legacy and current journal lines without modifying either', (): void => {
  const root = stateRoot();
  const loaded = loadTestPolicy();
  const first = makeSnapshotFixture(loaded);
  recordReview(root, first, makeReport(first), loaded.policy);
  const second = makeSnapshotFixture(loaded, { headSha: NEXT_SHA, previousHeadSha: FIRST_SHA, runId: 'run-2' });
  recordReview(root, second, makeReport(second), loaded.policy);
  const store = prStore(root, ALLOWED_REPOSITORY, 17);
  const lines = readFileSync(store.journalPath, 'utf8').split('\n').filter((line) => line.trim().length > 0);
  const current = JSON.parse(lines[1]);
  const legacy = JSON.parse(lines[0]);
  delete legacy.seq;
  delete legacy.previousLedger;
  const mixed = `${JSON.stringify(legacy)}\n${JSON.stringify(current)}\n`;
  writeFileSync(store.journalPath, mixed);

  assert.throws(() => migrateLegacyJournal(store), /mixes legacy and current|manual recovery/);
  assert.equal(readFileSync(store.journalPath, 'utf8'), mixed);
});

test('legacy journals upgrade through explicit migration preserving history', (): void => {
  const root = stateRoot();
  const loaded = loadTestPolicy();
  const first = makeSnapshotFixture(loaded);
  recordReview(root, first, makeReport(first), loaded.policy);
  const second = makeSnapshotFixture(loaded, { headSha: NEXT_SHA, previousHeadSha: FIRST_SHA, runId: 'run-2' });
  recordReview(root, second, reportWithBlocker(second), loaded.policy);
  const store = prStore(root, ALLOWED_REPOSITORY, 17);
  const lines = readFileSync(store.journalPath, 'utf8').split('\n').filter((line) => line.trim().length > 0);
  writeFileSync(store.journalPath, lines.map((line) => {
    const entry = JSON.parse(line) as Record<string, unknown>;
    delete entry.seq;
    delete entry.previousLedger;
    return JSON.stringify(entry);
  }).join('\n') + '\n');
  assert.throws(() => readLedger(store), /sequencing|journal-migrate|manual recovery/);
  const original = readFileSync(store.journalPath);
  const migrated = migrateLegacyJournal(store);
  assert.equal(migrated.migrated, 2);
  assert.equal(migrated.alreadyCurrent, false);
  assert.equal(migrated.status, 'migrated');
  assert.equal(migrated.backupPath === null, false);
  assert.equal(readLedger(store).openFindings.length, 1);
  assert.equal(readFileSync(migrated.backupPath as string).equals(original), true);
  assert.equal(statSync(migrated.backupPath as string).mode & 0o777, 0o600);
  const swapped = readFileSync(store.journalPath, 'utf8').split('\n').filter((line) => line.trim().length > 0);
  writeFileSync(store.journalPath, `${swapped[1]}\n${swapped[0]}\n`);
  assert.throws(() => readLedger(store), /monotonic|sequence|manual recovery/);
});

test('legacy migration refuses resolved finding history without altering the journal', (): void => {
  const root = stateRoot();
  const loaded = loadTestPolicy();
  const first = makeSnapshotFixture(loaded);
  recordReview(root, first, reportWithBlocker(first), loaded.policy);
  const second = makeSnapshotFixture(loaded, { headSha: NEXT_SHA, previousHeadSha: FIRST_SHA, runId: 'run-2' });
  const fixedSource = second.files.find((file) => file.path === 'src/action.ts' && file.revision === 'head');
  assert.ok(fixedSource);
  fixedSource.content = 'export const required = true;\n';
  second.changes = [];
  second.cumulativeDiff = '';
  second.size.changedLines = 0;
  const evidence = { path: 'src/action.ts', revision: 'head' as const, startLine: 1, endLine: 1, quote: 'export const required = true;' };
  const resolution = makeReport(second, { reconciliations: [
    { findingId: 'F-setup', outcome: 'fixed', rationale: 'The unsafe setup path was corrected.', evidence: [evidence] },
  ] });
  const outcome = recordReview(root, second, resolution, loaded.policy);
  assert.equal(outcome.decision.status, 'pass');
  assert.equal(outcome.decision.ledger.openFindings.length, 0);

  const store = prStore(root, ALLOWED_REPOSITORY, 17);
  const legacy = readFileSync(store.journalPath, 'utf8').split('\n').filter((line) => line.trim().length > 0).map((line) => {
    const entry = JSON.parse(line);
    delete entry.seq;
    delete entry.previousLedger;
    return JSON.stringify(entry);
  }).join('\n') + '\n';
  writeFileSync(store.journalPath, legacy);
  const original = readFileSync(store.journalPath);

  assert.throws(() => migrateLegacyJournal(store), /no transition compatible|manual recovery/);
  assert.deepEqual(readFileSync(store.journalPath), original);
  assert.equal(readdirSync(store.dir).some((name) => name.endsWith('.legacy.bak')), false);
});

test('legacy migration keeps an incomplete transition and its prior blocker intact', (): void => {
  const root = stateRoot();
  const loaded = loadTestPolicy();
  const first = makeSnapshotFixture(loaded);
  recordReview(root, first, reportWithBlocker(first), loaded.policy);
  const second = makeSnapshotFixture(loaded, { headSha: NEXT_SHA, previousHeadSha: FIRST_SHA, runId: 'run-2' });
  const incomplete = recordReview(root, second, { verdict: 'malformed' }, loaded.policy);
  assert.equal(incomplete.decision.status, 'incomplete');
  assert.equal(incomplete.decision.ledger.openFindings[0]?.id, 'F-setup');

  const store = prStore(root, ALLOWED_REPOSITORY, 17);
  const lines = readFileSync(store.journalPath, 'utf8').split('\n').filter((line) => line.trim().length > 0);
  writeFileSync(store.journalPath, lines.map((line) => {
    const entry = JSON.parse(line);
    delete entry.seq;
    delete entry.previousLedger;
    return JSON.stringify(entry);
  }).join('\n') + '\n');
  const migration = migrateLegacyJournal(store);

  assert.equal(migration.status, 'migrated');
  assert.equal(readLedger(store).openFindings[0]?.id, 'F-setup');
});

test('reordering otherwise-valid journal lines fails closed', (): void => {
  const root = stateRoot();
  const loaded = loadTestPolicy();
  const first = makeSnapshotFixture(loaded);
  recordReview(root, first, makeReport(first), loaded.policy);
  const second = makeSnapshotFixture(loaded, { headSha: NEXT_SHA, previousHeadSha: FIRST_SHA, runId: 'run-2' });
  recordReview(root, second, reportWithBlocker(second), loaded.policy);
  const store = prStore(root, ALLOWED_REPOSITORY, 17);
  assert.equal(readLedger(store).openFindings.length, 1);
  const lines = readFileSync(store.journalPath, 'utf8').split('\n').filter((line) => line.trim().length > 0);
  writeFileSync(store.journalPath, `${lines[1]}\n${lines[0]}\n`);
  assert.throws(() => readLedger(store), /monotonic|sequence|manual recovery/);
  assert.throws(() => recordReview(root, first, makeReport(first), loaded.policy), /monotonic|sequence|manual recovery/);
});

test('legacy migration refuses same-head ambiguity, reordered runs, and missing history', (): void => {
  const loaded = loadTestPolicy();
  const root = stateRoot();
  const first = makeSnapshotFixture(loaded, { previousHeadSha: null, runId: 'run-1' });
  recordReview(root, first, { verdict: 'malformed' }, loaded.policy);
  const sameHead = makeSnapshotFixture(loaded, { headSha: NEXT_SHA, previousHeadSha: null, runId: 'run-2' });
  recordReview(root, sameHead, { verdict: 'malformed' }, loaded.policy);
  const store = prStore(root, ALLOWED_REPOSITORY, 17);
  const lines = readFileSync(store.journalPath, 'utf8').split('\n').filter((line) => line.trim().length > 0);
  writeFileSync(store.journalPath, lines.map((line) => {
    const entry = JSON.parse(line);
    delete entry.seq;
    delete entry.previousLedger;
    return JSON.stringify(entry);
  }).join('\n') + '\n');
  const ambiguous = readFileSync(store.journalPath, 'utf8');
  assert.throws(() => migrateLegacyJournal(store), /ambiguous/);
  assert.equal(readFileSync(store.journalPath, 'utf8'), ambiguous);

  const otherRoot = stateRoot();
  const ordered = makeSnapshotFixture(loaded);
  recordReview(otherRoot, ordered, makeReport(ordered), loaded.policy);
  const next = makeSnapshotFixture(loaded, { headSha: NEXT_SHA, previousHeadSha: FIRST_SHA, runId: 'run-2' });
  recordReview(otherRoot, next, makeReport(next), loaded.policy);
  const otherStore = prStore(otherRoot, ALLOWED_REPOSITORY, 17);
  const orderedLines = readFileSync(otherStore.journalPath, 'utf8').split('\n').filter((line) => line.trim().length > 0);
  writeFileSync(otherStore.journalPath, orderedLines.map((line) => {
    const entry = JSON.parse(line);
    delete entry.seq;
    delete entry.previousLedger;
    return JSON.stringify(entry);
  }).reverse().join('\n') + '\n');
  const reversed = readFileSync(otherStore.journalPath, 'utf8');
  assert.throws(() => migrateLegacyJournal(otherStore), /contradicts|no transition|manual recovery/);
  assert.equal(readFileSync(otherStore.journalPath, 'utf8'), reversed);

  const emptyRoot = stateRoot();
  const emptyStore = prStore(emptyRoot, ALLOWED_REPOSITORY, 17);
  mkdirSync(emptyStore.dir, { recursive: true });
  writeFileSync(emptyStore.journalPath, '\n');
  assert.throws(() => migrateLegacyJournal(emptyStore), /empty|manual recovery/);
});

test('a valid ledger cache without journal or runs requires manual recovery', (): void => {
  const root = stateRoot();
  const loaded = loadTestPolicy();
  const snapshot = makeSnapshotFixture(loaded);
  recordReview(root, snapshot, reportWithBlocker(snapshot), loaded.policy);
  const store = prStore(root, ALLOWED_REPOSITORY, 17);
  const cache = readFileSync(store.ledgerPath, 'utf8');
  unlinkSync(store.journalPath);
  rmRuns(store.runsDir);
  writeFileSync(store.ledgerPath, cache);
  assert.throws(() => readLedger(store), /without any journal or run history|manual recovery/);
  assert.throws(() => recordReview(root, snapshot, makeReport(snapshot), loaded.policy), /without any journal or run history|manual recovery/);
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
