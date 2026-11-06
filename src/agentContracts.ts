import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isFinding } from './gate.ts';
import type {
  Change,
  DependencyEdge,
  GateDecision,
  ReviewIdentity,
  ReviewLedger,
  SizeAssessment,
} from './contracts.ts';

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

// Extra trusted inputs for the offline agent path, hashed alongside the packet
// policy digest under a domain separator so an agent digest can never collide
// with, or be mistaken for, a packet-mode digest.
export const AGENT_TRUSTED_PATHS = [
  'policy/agent.prompt.md',
  'src/agentSchema.ts',
  'src/agentContracts.ts',
  'src/agentReview.ts',
  'src/agentCli.ts',
  'src/actionControls.ts',
  'src/actionExecution.ts',
  'src/actionHost.ts',
  'src/actionState.ts',
] as const;

export interface AgentValidationLimits {
  maxFiles: number;
  maxSourceBytes: number;
  maxReadBytes: number;
}

// Synthetic prior-state checkpoint supplied by offline orchestration. stateVersion is
// an opaque, nonempty, bounded identifier that must change after every recorded
// attempt; a ledger alone cannot distinguish intervening same-head attempts.
export interface AgentPriorCheckpoint {
  schemaVersion: 1;
  repository: string;
  pullRequest: number;
  stateVersion: string;
  ledger: ReviewLedger;
}

export interface AgentReviewRequest {
  schemaVersion: 1;
  kind: 'agent-review';
  mode: 'offline' | 'action';
  synthetic: boolean;
  operational: boolean;
  reviewSystemSha: string;
  priorStateVersion: string;
  priorLedger: ReviewLedger;
  validationLimits: AgentValidationLimits;
  identity: ReviewIdentity;
  previousHeadSha: string | null;
  changes: Change[];
  size: SizeAssessment;
  cumulativeDiff: string;
  deltaDiff: string | null;
  dependencyEdges: DependencyEdge[];
  complete: boolean;
  limitations: string[];
}

// Synthetic host attestation about one action invocation. Offline only; this is
// test input, not authentication of a real execution.
export interface AgentExecutionAttestation {
  schemaVersion: 1;
  mode: 'offline';
  synthetic: true;
  conclusion: 'success' | 'failure';
  termination: 'completed' | 'interrupted' | 'timeout' | 'budget_exhausted' | 'turn_exhausted';
  model: string;
  runId: string;
}

// Synthetic live-PR identity checkpoint supplied by orchestration at validation time.
export interface AgentCurrentAttestation {
  repository: string;
  pullRequest: number;
  headSha: string;
  baseSha: string;
  runId: string;
  reviewSystemSha: string;
}

export interface AgentDecisionEnvelope {
  schemaVersion: 1;
  kind: 'offline-agent-decision' | 'action-agent-decision';
  synthetic: boolean;
  operational: boolean;
  decision: GateDecision;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key: string): boolean => key in value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isSafeRepoPath(value: unknown): value is string {
  return isText(value)
    && !value.startsWith('/')
    && !value.includes('\\')
    && !value.includes('\0')
    && !value.includes('\n')
    && !value.includes('\r')
    && !value.split('/').some((part: string): boolean => part === '..' || part === '.' || part === '');
}

function isSha(value: unknown): value is string {
  return typeof value === 'string' && SHA_PATTERN.test(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown): boolean => typeof item === 'string');
}

function check(condition: boolean, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}

export function isReviewLedger(value: unknown): value is ReviewLedger {
  if (!isObject(value) || !hasKeys(value, ['schemaVersion', 'repository', 'pullRequest', 'lastHeadSha', 'openFindings'])) {
    return false;
  }
  if (value.schemaVersion !== 1 || !isText(value.repository)) return false;
  if (!Number.isSafeInteger(value.pullRequest) || Number(value.pullRequest) <= 0) return false;
  if (!(value.lastHeadSha === null || isSha(value.lastHeadSha))) return false;
  if (!Array.isArray(value.openFindings) || !value.openFindings.every(isFinding)) return false;
  const ids = new Set<string>();
  for (const finding of value.openFindings as { id: string }[]) {
    if (ids.has(finding.id)) return false;
    ids.add(finding.id);
  }
  return true;
}

export function validateAgentPriorCheckpoint(input: unknown): AgentPriorCheckpoint {
  check(isObject(input), 'prior-state is not an object');
  check(
    hasKeys(input, ['schemaVersion', 'repository', 'pullRequest', 'stateVersion', 'ledger']),
    'prior-state has unexpected or missing fields',
  );
  check(input.schemaVersion === 1, 'prior-state schemaVersion must be 1');
  check(isText(input.repository), 'prior-state repository invalid');
  check(Number.isSafeInteger(input.pullRequest) && Number(input.pullRequest) > 0, 'prior-state pullRequest invalid');
  check(
    typeof input.stateVersion === 'string' && SAFE_ID_PATTERN.test(input.stateVersion),
    'prior-state stateVersion must be a nonempty bounded identifier',
  );
  check(isReviewLedger(input.ledger), 'prior-state ledger is invalid');
  check(input.ledger.repository === input.repository, 'prior-state ledger repository does not match the checkpoint repository');
  check(input.ledger.pullRequest === input.pullRequest, 'prior-state ledger pullRequest does not match the checkpoint pullRequest');
  return input as unknown as AgentPriorCheckpoint;
}

export function validateAgentValidationLimits(input: unknown): AgentValidationLimits {
  check(isObject(input), 'validation-limits is not an object');
  check(hasKeys(input, ['maxFiles', 'maxSourceBytes', 'maxReadBytes']), 'validation-limits has unexpected or missing fields');
  for (const key of ['maxFiles', 'maxSourceBytes', 'maxReadBytes'] as const) {
    check(
      Number.isSafeInteger(input[key]) && Number(input[key]) > 0,
      `validation-limits ${key} must be a positive integer`,
    );
  }
  return input as unknown as AgentValidationLimits;
}

export function validateAgentExecution(input: unknown): AgentExecutionAttestation {
  check(isObject(input), 'execution is not an object');
  check(
    hasKeys(input, ['schemaVersion', 'mode', 'synthetic', 'conclusion', 'termination', 'model', 'runId']),
    'execution has unexpected or missing fields',
  );
  check(input.schemaVersion === 1, 'execution schemaVersion must be 1');
  check(input.mode === 'offline', 'execution mode must be offline');
  check(input.synthetic === true, 'execution synthetic must be true');
  check(['success', 'failure'].includes(String(input.conclusion)), 'execution conclusion invalid');
  check(
    ['completed', 'interrupted', 'timeout', 'budget_exhausted', 'turn_exhausted'].includes(String(input.termination)),
    'execution termination invalid',
  );
  check(isText(input.model), 'execution model invalid');
  check(typeof input.runId === 'string' && SAFE_ID_PATTERN.test(input.runId), 'execution runId invalid');
  return input as unknown as AgentExecutionAttestation;
}

export function validateAgentCurrent(input: unknown): AgentCurrentAttestation {
  check(isObject(input), 'current is not an object');
  check(
    hasKeys(input, ['repository', 'pullRequest', 'headSha', 'baseSha', 'runId', 'reviewSystemSha']),
    'current has unexpected or missing fields',
  );
  check(isText(input.repository), 'current repository invalid');
  check(Number.isSafeInteger(input.pullRequest) && Number(input.pullRequest) > 0, 'current pullRequest invalid');
  check(isSha(input.headSha), 'current headSha must be a 40-char SHA');
  check(isSha(input.baseSha), 'current baseSha must be a 40-char SHA');
  check(typeof input.runId === 'string' && SAFE_ID_PATTERN.test(input.runId), 'current runId invalid');
  check(isSha(input.reviewSystemSha), 'current reviewSystemSha must be a 40-char SHA');
  return input as unknown as AgentCurrentAttestation;
}

function isChange(value: unknown): value is Change {
  if (!isObject(value)) return false;
  const expected = value.previousPath !== undefined ? ['path', 'status', 'previousPath'] : ['path', 'status'];
  return hasKeys(value, expected)
    && isSafeRepoPath(value.path)
    && ['added', 'modified', 'deleted', 'renamed'].includes(String(value.status))
    && (value.previousPath === undefined || isSafeRepoPath(value.previousPath));
}

function isDependencyEdge(value: unknown): value is DependencyEdge {
  return isObject(value) && hasKeys(value, ['from', 'to']) && isSafeRepoPath(value.from) && isSafeRepoPath(value.to);
}

function isSizeAssessment(value: unknown): value is SizeAssessment {
  return isObject(value)
    && hasKeys(value, ['changedLines', 'blockChangedLines'])
    && Number.isSafeInteger(value.changedLines) && Number(value.changedLines) >= 0
    && Number.isSafeInteger(value.blockChangedLines) && Number(value.blockChangedLines) > 0;
}

function isIdentityShape(value: unknown): value is ReviewIdentity {
  return isObject(value)
    && hasKeys(value, ['repository', 'pullRequest', 'headSha', 'baseSha', 'mergeBaseSha', 'policyDigest', 'model', 'runId'])
    && isText(value.repository)
    && Number.isSafeInteger(value.pullRequest) && Number(value.pullRequest) > 0
    && isSha(value.headSha) && isSha(value.baseSha) && isSha(value.mergeBaseSha)
    && typeof value.policyDigest === 'string' && DIGEST_PATTERN.test(value.policyDigest)
    && isText(value.model)
    && typeof value.runId === 'string' && SAFE_ID_PATTERN.test(value.runId);
}

function validateRequestShape(input: unknown, expected: 'offline' | 'action'): AgentReviewRequest {
  check(isObject(input), 'request is not an object');
  check(
    hasKeys(input, [
      'schemaVersion', 'kind', 'mode', 'synthetic', 'operational', 'reviewSystemSha', 'priorStateVersion',
      'priorLedger', 'validationLimits', 'identity', 'previousHeadSha', 'changes', 'size', 'cumulativeDiff',
      'deltaDiff', 'dependencyEdges', 'complete', 'limitations',
    ]),
    'request has unexpected or missing fields',
  );
  check(input.schemaVersion === 1, 'request schemaVersion must be 1');
  check(input.kind === 'agent-review', 'request kind must be agent-review');
  check(input.mode === expected, `request mode must be ${expected}`);
  const synthetic = expected === 'offline';
  check(input.synthetic === synthetic, `request synthetic must be ${synthetic}`);
  check(input.operational === !synthetic, `request operational must be ${!synthetic}`);
  check(isSha(input.reviewSystemSha), 'request reviewSystemSha must be a 40-char SHA');
  check(
    typeof input.priorStateVersion === 'string' && SAFE_ID_PATTERN.test(input.priorStateVersion),
    'request priorStateVersion must be a nonempty bounded identifier',
  );
  check(isReviewLedger(input.priorLedger), 'request priorLedger is invalid');
  check(isObject(input.validationLimits), 'request validationLimits invalid');
  try {
    validateAgentValidationLimits(input.validationLimits);
  } catch (error) {
    check(false, `request ${(error as Error).message}`);
  }
  check(isIdentityShape(input.identity), 'request identity is invalid');
  check(input.previousHeadSha === null || isSha(input.previousHeadSha), 'request previousHeadSha must be null or a 40-char SHA');
  check(Array.isArray(input.changes) && input.changes.every(isChange), 'request changes are invalid');
  check(isSizeAssessment(input.size), 'request size assessment is invalid');
  check(typeof input.cumulativeDiff === 'string', 'request cumulativeDiff must be a string');
  check(input.deltaDiff === null || typeof input.deltaDiff === 'string', 'request deltaDiff must be null or a string');
  check(
    Array.isArray(input.dependencyEdges) && input.dependencyEdges.every(isDependencyEdge),
    'request dependencyEdges are invalid',
  );
  check(typeof input.complete === 'boolean', 'request complete must be boolean');
  check(isStringArray(input.limitations), 'request limitations must be a string array');
  return input as unknown as AgentReviewRequest;
}

export function validateAgentRequest(input: unknown): AgentReviewRequest {
  return validateRequestShape(input, 'offline');
}

export function validateActionRequest(input: unknown): AgentReviewRequest {
  return validateRequestShape(input, 'action');
}

export function agentPolicyDigest(packetDigest: string, files: Map<string, Buffer>): string {
  if (!DIGEST_PATTERN.test(packetDigest)) throw new Error('Agent digest requires the trusted packet digest.');
  const hash = createHash('sha256');
  hash.update('sentinel-agent-review-v1\0');
  hash.update(packetDigest);
  for (const trustedPath of [...AGENT_TRUSTED_PATHS].sort()) {
    const content = files.get(trustedPath);
    if (content === undefined) throw new Error(`Trusted agent input missing for digest: ${trustedPath}`);
    hash.update(`${trustedPath.length}:${trustedPath}`);
    hash.update(`${content.length}:`);
    hash.update(content);
  }
  return hash.digest('hex');
}

export interface AgentTrust {
  digest: string;
  agentPrompt: string;
}

export function loadAgentTrust(systemRoot: string, packetDigest: string): AgentTrust {
  const root = path.resolve(systemRoot);
  const files = new Map<string, Buffer>();
  for (const trustedPath of AGENT_TRUSTED_PATHS) {
    const resolved = path.resolve(path.join(root, trustedPath));
    if (!resolved.startsWith(root + path.sep)) throw new Error(`Trusted agent path escapes system root: ${trustedPath}`);
    files.set(trustedPath, readFileSync(resolved));
  }
  return {
    digest: agentPolicyDigest(packetDigest, files),
    agentPrompt: files.get('policy/agent.prompt.md')?.toString('utf8') ?? '',
  };
}
