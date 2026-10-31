import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { evaluateReview } from './gate.ts';
import type { GateDecision, ReviewLedger, ReviewPolicy, ReviewSnapshot } from './contracts.ts';

const REPOSITORY_KEY_PATTERN = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9][A-Za-z0-9_.-]*)$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const DECISION_STATUSES = new Set(['pass', 'changes_required', 'incomplete']);
const SEVERITIES = new Set(['blocker', 'advisory', 'question']);

export interface PrStore {
  repository: string;
  pullRequest: number;
  dir: string;
  runsDir: string;
  journalPath: string;
  ledgerPath: string;
  lockPath: string;
  retrospectivesDir: string;
}

export interface RunRecord {
  schemaVersion: 1;
  runId: string;
  recordedAt: string;
  snapshot: ReviewSnapshot;
  report: unknown;
  decision: GateDecision;
}

export interface PrLock {
  release(): void;
}

export function defaultStateRoot(systemRoot: string): string {
  return path.join(path.resolve(systemRoot), '.state');
}

export function prStore(stateRoot: string, repository: string, pullRequest: number): PrStore {
  const match = REPOSITORY_KEY_PATTERN.exec(repository);
  if (!match) throw new Error(`Unsafe repository identifier: ${repository}`);
  if (!Number.isSafeInteger(pullRequest) || pullRequest <= 0) {
    throw new Error(`Unsafe pull request identifier: ${pullRequest}`);
  }
  const dir = path.join(path.resolve(stateRoot), 'repos', match[1], match[2], 'prs', String(pullRequest));
  return {
    repository,
    pullRequest,
    dir,
    runsDir: path.join(dir, 'runs'),
    journalPath: path.join(dir, 'journal.jsonl'),
    ledgerPath: path.join(dir, 'ledger.json'),
    lockPath: path.join(dir, 'review.lock'),
    retrospectivesDir: path.join(dir, 'retrospectives'),
  };
}

export class StateCorruptionError extends Error {}

function stateError(store: PrStore, reason: string, origin: string): StateCorruptionError {
  return new StateCorruptionError(
    `Persisted review state requires manual recovery for ${store.repository}#${store.pullRequest} at ${store.dir}: ${reason} (${origin}). `
    + 'Inspect the immutable run records and journal; this tool never auto-repairs or deletes state.',
  );
}

export function acquirePrLock(store: PrStore, purpose: string = 'review-run'): PrLock {
  mkdirSync(store.dir, { recursive: true });
  const token = randomUUID();
  let fd: number;
  try {
    fd = openSync(store.lockPath, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      let holder = 'unknown holder';
      try {
        holder = readFileSync(store.lockPath, 'utf8').trim();
      } catch {
        holder = 'unreadable lock file';
      }
      throw new Error(
        `PR lock already held at ${store.lockPath} (${holder}). `
        + 'If the holder process is gone, inspect and remove that file manually; this tool never breaks locks automatically.',
      );
    }
    throw error;
  }
  try {
    writeSync(fd, `${JSON.stringify({ pid: process.pid, token, purpose, createdAt: new Date().toISOString() })}\n`);
  } finally {
    closeSync(fd);
  }
  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      try {
        const held = JSON.parse(readFileSync(store.lockPath, 'utf8')) as { token?: string };
        if (held.token === token) unlinkSync(store.lockPath);
      } catch {
        // Lock vanished or was replaced; only ever remove our own token.
      }
    },
  };
}

export function withPrLock<T>(store: PrStore, fn: () => T, purpose?: string): T {
  const lock = acquirePrLock(store, purpose);
  try {
    return fn();
  } finally {
    lock.release();
  }
}

function emptyLedger(repository: string, pullRequest: number): ReviewLedger {
  return { schemaVersion: 1, repository, pullRequest, lastHeadSha: null, openFindings: [] };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateLedgerShape(value: unknown, store: PrStore, origin: string): ReviewLedger {
  function check(condition: boolean, reason: string): asserts condition {
    if (!condition) throw stateError(store, `invalid ledger: ${reason}`, origin);
  }
  check(isObject(value), 'not an object');
  check(value.schemaVersion === 1, 'schemaVersion must be 1');
  check(value.repository === store.repository, `repository ${String(value.repository)} != ${store.repository}`);
  check(value.pullRequest === store.pullRequest, `pullRequest ${String(value.pullRequest)} != ${store.pullRequest}`);
  check(
    value.lastHeadSha === null || (typeof value.lastHeadSha === 'string' && SHA_PATTERN.test(value.lastHeadSha)),
    'lastHeadSha must be null or a 40-char SHA',
  );
  check(Array.isArray(value.openFindings), 'openFindings must be an array');
  for (const finding of value.openFindings as unknown[]) {
    check(isObject(finding), 'openFindings entry is not an object');
    check(typeof finding.id === 'string' && finding.id.trim().length > 0, 'openFindings entry missing id');
    check(SEVERITIES.has(String(finding.severity)), `openFindings entry has invalid severity ${String(finding.severity)}`);
  }
  return value as unknown as ReviewLedger;
}

function validateRunRecord(value: unknown, store: PrStore, origin: string): RunRecord {
  function check(condition: boolean, reason: string): asserts condition {
    if (!condition) throw stateError(store, `invalid run record: ${reason}`, origin);
  }
  check(isObject(value), 'not an object');
  check(value.schemaVersion === 1, 'schemaVersion must be 1');
  check(typeof value.runId === 'string' && RUN_ID_PATTERN.test(value.runId), `runId ${String(value.runId)} is unsafe`);
  check(typeof value.recordedAt === 'string' && value.recordedAt.trim().length > 0, 'recordedAt missing');
  check(isObject(value.snapshot), 'snapshot missing');
  const snapshotIdentity = value.snapshot.identity;
  check(isObject(snapshotIdentity), 'snapshot.identity missing');
  check(snapshotIdentity.repository === store.repository, `snapshot repository ${String(snapshotIdentity.repository)} != ${store.repository}`);
  check(snapshotIdentity.pullRequest === store.pullRequest, `snapshot pullRequest ${String(snapshotIdentity.pullRequest)} != ${store.pullRequest}`);
  check(snapshotIdentity.runId === value.runId, `snapshot runId ${String(snapshotIdentity.runId)} != record runId ${String(value.runId)}`);
  check(isObject(value.decision), 'decision missing');
  check(DECISION_STATUSES.has(String(value.decision.status)), `decision status ${String(value.decision.status)} invalid`);
  validateLedgerShape(value.decision.ledger, store, `${origin} decision.ledger`);
  return value as unknown as RunRecord;
}

export function readRuns(store: PrStore): RunRecord[] {
  if (!existsSync(store.runsDir)) return [];
  const runs: RunRecord[] = [];
  for (const name of readdirSync(store.runsDir).sort()) {
    if (!name.endsWith('.json')) continue;
    const runPath = path.join(store.runsDir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(runPath, 'utf8'));
    } catch (error) {
      throw stateError(store, `unparseable run record ${name}: ${(error as Error).message}`, runPath);
    }
    const record = validateRunRecord(parsed, store, runPath);
    if (name !== `${record.runId}.json`) {
      throw stateError(store, `run record filename ${name} does not match runId ${record.runId}`, runPath);
    }
    if (runs.some((existing: RunRecord): boolean => existing.runId === record.runId)) {
      throw stateError(store, `duplicate runId ${record.runId} across run records`, store.runsDir);
    }
    runs.push(record);
  }
  runs.sort((left: RunRecord, right: RunRecord): number => left.recordedAt.localeCompare(right.recordedAt) || left.runId.localeCompare(right.runId));
  return runs;
}

interface JournalEntry {
  runId: string;
  recordedAt: string;
  ledger: ReviewLedger;
}

function readJournal(store: PrStore, runs: RunRecord[]): JournalEntry[] | null {
  if (!existsSync(store.journalPath)) return null;
  const lines = readFileSync(store.journalPath, 'utf8').split('\n').filter((line: string): boolean => line.trim().length > 0);
  const entries: JournalEntry[] = [];
  lines.forEach((line: string, index: number): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw stateError(store, `unparseable journal line ${index + 1}: ${(error as Error).message}`, store.journalPath);
    }
    if (!isObject(parsed)) throw stateError(store, `journal line ${index + 1} is not an object`, store.journalPath);
    if (typeof parsed.runId !== 'string' || !RUN_ID_PATTERN.test(parsed.runId)) {
      throw stateError(store, `journal line ${index + 1} has unsafe runId`, store.journalPath);
    }
    if (typeof parsed.recordedAt !== 'string' || parsed.recordedAt.trim().length === 0) {
      throw stateError(store, `journal line ${index + 1} missing recordedAt`, store.journalPath);
    }
    entries.push({
      runId: parsed.runId,
      recordedAt: parsed.recordedAt,
      ledger: validateLedgerShape(parsed.ledger, store, `${store.journalPath} line ${index + 1}`),
    });
  });
  const runsById = new Map(runs.map((run: RunRecord): [string, RunRecord] => [run.runId, run]));
  const journaled = new Set<string>();
  for (const entry of entries) {
    const record = runsById.get(entry.runId);
    if (!record) {
      throw stateError(store, `journal references run ${entry.runId} with no matching immutable record`, store.journalPath);
    }
    if (journaled.has(entry.runId)) {
      throw stateError(store, `journal contains a duplicate entry for run ${entry.runId}`, store.journalPath);
    }
    if (entry.recordedAt !== record.recordedAt) {
      throw stateError(store, `journal recordedAt for run ${entry.runId} diverges from its immutable record`, store.journalPath);
    }
    if (canonicalJson(entry.ledger) !== canonicalJson(record.decision.ledger)) {
      throw stateError(store, `journal ledger for run ${entry.runId} diverges from its immutable record`, store.journalPath);
    }
    journaled.add(entry.runId);
  }
  for (const run of runs) {
    if (!journaled.has(run.runId)) {
      throw stateError(store, `immutable run ${run.runId} was never journaled`, store.runsDir);
    }
  }
  return entries;
}

interface ConsistentState {
  runs: RunRecord[];
  journal: JournalEntry[] | null;
  ledger: ReviewLedger;
}

function loadConsistentState(store: PrStore): ConsistentState {
  const runs = readRuns(store);
  const journal = readJournal(store, runs);
  let ledger: ReviewLedger | null = null;
  if (journal !== null && journal.length > 0) {
    ledger = journal[journal.length - 1].ledger;
  } else if (journal === null && runs.length > 0) {
    ledger = runs[runs.length - 1].decision.ledger;
  }
  let cached: ReviewLedger | null = null;
  let cacheCorrupt = false;
  if (existsSync(store.ledgerPath)) {
    try {
      cached = validateLedgerShape(JSON.parse(readFileSync(store.ledgerPath, 'utf8')), store, store.ledgerPath);
    } catch (error) {
      if (ledger !== null) {
        cached = null;
        cacheCorrupt = true;
      } else if (error instanceof StateCorruptionError) {
        throw error;
      } else {
        throw stateError(store, `unusable ledger cache: ${(error as Error).message}`, store.ledgerPath);
      }
    }
  }
  if (ledger === null && cached !== null) ledger = cached;
  if (ledger === null && (journal !== null || cacheCorrupt)) {
    throw stateError(store, 'persisted state exists but no complete valid ledger can be derived', store.dir);
  }
  if (ledger === null) ledger = emptyLedger(store.repository, store.pullRequest);
  return { runs, journal, ledger };
}

export function readLedger(store: PrStore): ReviewLedger {
  return loadConsistentState(store).ledger;
}

export function readRun(store: PrStore, runId: string): RunRecord | null {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error(`Unsafe run id: ${runId}`);
  const runPath = path.join(store.runsDir, `${runId}.json`);
  if (!existsSync(runPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(runPath, 'utf8'));
  } catch (error) {
    throw stateError(store, `unparseable run record ${runId}.json: ${(error as Error).message}`, runPath);
  }
  return validateRunRecord(parsed, store, runPath);
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a]: [string, unknown], [b]: [string, unknown]): number => a.localeCompare(b));
    return `{${entries.map(([key, item]: [string, unknown]): string => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function writeFileExclusive(filePath: string, content: string): void {
  const fd = openSync(filePath, 'wx');
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

function appendFile(filePath: string, content: string): void {
  const fd = openSync(filePath, 'a');
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

function writeLedgerCache(store: PrStore, ledger: ReviewLedger): void {
  const temp = `${store.ledgerPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileExclusive(temp, `${JSON.stringify(ledger, null, 2)}\n`);
  renameSync(temp, store.ledgerPath);
}

export interface RecordOutcome {
  decision: GateDecision;
  replayed: boolean;
}

export function recordReview(
  stateRoot: string,
  snapshot: ReviewSnapshot,
  report: unknown,
  policy: ReviewPolicy,
): RecordOutcome {
  const store = prStore(stateRoot, snapshot.identity.repository, snapshot.identity.pullRequest);
  return withPrLock(store, (): RecordOutcome => {
    mkdirSync(store.runsDir, { recursive: true });
    const runId = snapshot.identity.runId;
    if (!RUN_ID_PATTERN.test(runId)) throw new Error(`Unsafe run id: ${runId}`);
    const runPath = path.join(store.runsDir, `${runId}.json`);
    const state = loadConsistentState(store);
    if (state.journal === null && state.runs.length > 0) {
      throw stateError(
        store,
        `journal is missing while ${state.runs.length} immutable run(s) exist; read-only ledger recovery is permitted, but recording further runs is refused until the journal is manually restored`,
        store.journalPath,
      );
    }
    const existing = readRun(store, runId);
    if (existing !== null) {
      const identical = canonicalJson(existing.snapshot) === canonicalJson(snapshot)
        && canonicalJson(existing.report) === canonicalJson(report);
      if (!identical) {
        throw new Error(`Run ${runId} already exists with different content; refusing to overwrite the immutable record at ${runPath}.`);
      }
      return { decision: existing.decision, replayed: true };
    }
    const previous = state.ledger;
    const decision = evaluateReview(snapshot, report, previous, policy);
    const record: RunRecord = {
      schemaVersion: 1,
      runId,
      recordedAt: new Date().toISOString(),
      snapshot,
      report,
      decision,
    };
    writeFileExclusive(runPath, `${JSON.stringify(record, null, 2)}\n`);
    appendFile(store.journalPath, `${JSON.stringify({ runId, recordedAt: record.recordedAt, ledger: decision.ledger })}\n`);
    writeLedgerCache(store, decision.ledger);
    return { decision, replayed: false };
  }, 'record');
}
