import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareRetrospective, validateCloseEvent } from '../src/retrospective.ts';
import { prStore, readRuns, recordReview } from '../src/state.ts';
import { loadTestPolicy, makeReport, makeSnapshotFixture, SYSTEM_ROOT, ALLOWED_REPOSITORY } from './helpers.ts';

const FIRST_SHA = 'a'.repeat(40);
const EVENT_SHA = 'e'.repeat(40);

function stateRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'srs-retro-'));
}

function policyHashes(): Map<string, string> {
  const hashes = new Map<string, string>();
  const dir = path.join(SYSTEM_ROOT, 'policy');
  for (const name of readdirSync(dir)) {
    hashes.set(name, createHash('sha256').update(readFileSync(path.join(dir, name))).digest('hex'));
  }
  return hashes;
}

function seededStore(root: string): void {
  const loaded = loadTestPolicy();
  const snapshot = makeSnapshotFixture(loaded);
  recordReview(root, snapshot, makeReport(snapshot), loaded.policy);
}

test('merged close events produce a needs-human-verification draft with history', (): void => {
  const root = stateRoot();
  const loaded = loadTestPolicy();
  seededStore(root);
  const event = validateCloseEvent({ action: 'closed', merged: true, headSha: FIRST_SHA, eventId: 'evt-1' });
  const { draft, replayed } = prepareRetrospective(root, ALLOWED_REPOSITORY, 17, event, loaded.digest);
  assert.equal(replayed, false);
  assert.equal(draft.status, 'needs-human-verification');
  assert.equal(draft.mode, 'merged');
  assert.deepEqual(draft.candidates, []);
  assert.equal(draft.reviewHistory.length, 1);
  assert.equal(draft.reviewHistory[0]?.runId, 'run-1');
  assert.deepEqual(draft.limitations, []);
  assert.equal(draft.prompts.retrospective, 'policy/retrospective.prompt.md');
  assert.equal(draft.policyDigest, loaded.digest);
});

test('closed-unmerged events are classified distinctly', (): void => {
  const root = stateRoot();
  const loaded = loadTestPolicy();
  seededStore(root);
  const event = validateCloseEvent({ action: 'closed', merged: false, headSha: FIRST_SHA, eventId: 'evt-close' });
  const { draft } = prepareRetrospective(root, ALLOWED_REPOSITORY, 17, event, loaded.digest);
  assert.equal(draft.mode, 'closed-unmerged');
});

test('replaying the identical event is a no-op and conflicting replays are rejected', (): void => {
  const root = stateRoot();
  const loaded = loadTestPolicy();
  seededStore(root);
  const event = validateCloseEvent({ action: 'closed', merged: true, headSha: FIRST_SHA, eventId: 'evt-dup' });
  const first = prepareRetrospective(root, ALLOWED_REPOSITORY, 17, event, loaded.digest);
  const second = prepareRetrospective(root, ALLOWED_REPOSITORY, 17, event, loaded.digest);
  assert.equal(second.replayed, true);
  assert.equal(second.draftPath, first.draftPath);
  const conflicting = validateCloseEvent({ action: 'closed', merged: true, headSha: EVENT_SHA, eventId: 'evt-dup' });
  assert.throws(() => prepareRetrospective(root, ALLOWED_REPOSITORY, 17, conflicting, loaded.digest), /different content/);
});

test('a final SHA that does not match recorded history adds a limitation', (): void => {
  const root = stateRoot();
  const loaded = loadTestPolicy();
  seededStore(root);
  const event = validateCloseEvent({ action: 'closed', merged: true, headSha: EVENT_SHA, eventId: 'evt-mismatch' });
  const { draft } = prepareRetrospective(root, ALLOWED_REPOSITORY, 17, event, loaded.digest);
  assert.ok(draft.limitations.some((line) => line.includes('does not match the last recorded reviewed head')));
});

test('a PR with no recorded runs is an explicit limitation, not a blank draft', (): void => {
  const root = stateRoot();
  const loaded = loadTestPolicy();
  const event = validateCloseEvent({ action: 'closed', merged: true, headSha: EVENT_SHA, eventId: 'evt-empty' });
  const { draft } = prepareRetrospective(root, ALLOWED_REPOSITORY, 17, event, loaded.digest);
  assert.equal(draft.reviewHistory.length, 0);
  assert.ok(draft.limitations.some((line) => line.includes('No recorded review runs')));
});

test('retrospective preparation never writes the trusted policy directory', (): void => {
  const root = stateRoot();
  const loaded = loadTestPolicy();
  seededStore(root);
  const before = policyHashes();
  const event = validateCloseEvent({ action: 'closed', merged: true, headSha: FIRST_SHA, eventId: 'evt-policy-safe' });
  const { draftPath } = prepareRetrospective(root, ALLOWED_REPOSITORY, 17, event, loaded.digest);
  const after = policyHashes();
  assert.deepEqual(after, before);
  assert.ok(draftPath.startsWith(root));
  assert.ok(readRuns(prStore(root, ALLOWED_REPOSITORY, 17)).length >= 1);
});

test('malformed events are rejected strictly', (): void => {
  assert.throws(() => validateCloseEvent({ action: 'opened', merged: true, headSha: EVENT_SHA, eventId: 'e' }), /action/);
  assert.throws(() => validateCloseEvent({ action: 'closed', merged: true, headSha: 'not-a-sha', eventId: 'e' }), /headSha/);
  assert.throws(() => validateCloseEvent({ action: 'closed', merged: true, headSha: EVENT_SHA, eventId: '../e' }), /eventId/);
  assert.throws(() => validateCloseEvent({ action: 'closed', merged: true, headSha: EVENT_SHA, eventId: 'e', extra: 1 }), /fields/);
  assert.throws(() => validateCloseEvent({ action: 'closed', headSha: EVENT_SHA, eventId: 'e' }), /fields/);
});
