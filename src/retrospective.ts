import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { closeSync, openSync, writeSync } from 'node:fs';
import { canonicalJson, prStore, readLedger, readRuns, withPrLock } from './state.ts';
import type { PrStore } from './state.ts';

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const REPOSITORY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export interface CloseEvent {
  action: 'closed';
  merged: boolean;
  headSha: string;
  eventId: string;
}

export interface RetrospectiveDraft {
  schemaVersion: 1;
  kind: 'sentinel-retrospective-draft';
  status: 'needs-human-verification';
  repository: string;
  pullRequest: number;
  event: CloseEvent;
  mode: 'merged' | 'closed-unmerged';
  reviewHistory: { runId: string; headSha: string; status: string; recordedAt: string }[];
  unresolvedFindingIds: string[];
  limitations: string[];
  candidates: unknown[];
  prompts: { review: string; retrospective: string };
  policyDigest: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateCloseEvent(input: unknown): CloseEvent {
  function check(condition: boolean, reason: string): asserts condition {
    if (!condition) throw new Error(`Retrospective event validation failed: ${reason}`);
  }
  check(isObject(input), 'not an object');
  check(Object.keys(input).sort().join(',') === 'action,eventId,headSha,merged', 'unexpected or missing fields');
  check(input.action === 'closed', 'action must be "closed"');
  check(typeof input.merged === 'boolean', 'merged must be boolean');
  check(typeof input.headSha === 'string' && SHA_PATTERN.test(input.headSha), 'headSha must be a 40-char SHA');
  check(typeof input.eventId === 'string' && EVENT_ID_PATTERN.test(input.eventId), 'eventId invalid');
  return input as unknown as CloseEvent;
}

export interface RetrospectiveOutcome {
  draft: RetrospectiveDraft;
  draftPath: string;
  replayed: boolean;
}

export function prepareRetrospective(
  stateRoot: string,
  repository: string,
  pullRequest: number,
  event: CloseEvent,
  policyDigest: string,
): RetrospectiveOutcome {
  if (!REPOSITORY_KEY_PATTERN.test(repository)) throw new Error(`Unsafe repository identifier: ${repository}`);
  const store: PrStore = prStore(stateRoot, repository, pullRequest);
  return withPrLock(store, (): RetrospectiveOutcome => {
    mkdirSync(store.retrospectivesDir, { recursive: true });
    const draftPath = path.join(store.retrospectivesDir, `${event.eventId}.json`);
    if (existsSync(draftPath)) {
      const existing = JSON.parse(readFileSync(draftPath, 'utf8')) as RetrospectiveDraft;
      if (canonicalJson(existing.event) !== canonicalJson(event)) {
        throw new Error(`Retrospective event ${event.eventId} already persisted with different content at ${draftPath}.`);
      }
      return { draft: existing, draftPath, replayed: true };
    }
    const runs = readRuns(store);
    const ledger = readLedger(store);
    const limitations: string[] = [];
    if (runs.length === 0) {
      limitations.push('No recorded review runs exist for this PR; retrospective covers an empty history.');
    }
    const lastRun = runs[runs.length - 1];
    const lastHeadSha = lastRun?.snapshot.identity.headSha ?? null;
    if (lastHeadSha !== null && event.headSha !== lastHeadSha) {
      limitations.push(`Event headSha ${event.headSha} does not match the last recorded reviewed head ${lastHeadSha}; coverage of the final revision is not confirmed.`);
    }
    if (ledger.lastHeadSha !== null && lastHeadSha !== null && ledger.lastHeadSha !== lastHeadSha) {
      limitations.push(`Latest recorded run head ${lastHeadSha} was never marked fully reviewed (ledger lastHeadSha ${ledger.lastHeadSha}).`);
    }
    const draft: RetrospectiveDraft = {
      schemaVersion: 1,
      kind: 'sentinel-retrospective-draft',
      status: 'needs-human-verification',
      repository,
      pullRequest,
      event,
      mode: event.merged ? 'merged' : 'closed-unmerged',
      reviewHistory: runs.map((run) => ({
        runId: run.runId,
        headSha: run.snapshot.identity.headSha,
        status: run.decision.status,
        recordedAt: run.recordedAt,
      })),
      unresolvedFindingIds: ledger.openFindings.map((finding) => finding.id),
      limitations,
      candidates: [],
      prompts: {
        review: 'policy/review.prompt.md',
        retrospective: 'policy/retrospective.prompt.md',
      },
      policyDigest,
    };
    const fd = openSync(draftPath, 'wx');
    writeSync(fd, `${JSON.stringify(draft, null, 2)}\n`);
    closeSync(fd);
    return { draft, draftPath, replayed: false };
  }, 'retrospective');
}
