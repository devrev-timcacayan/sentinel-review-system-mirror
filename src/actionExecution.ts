import { canonicalJson } from './partitionContract.ts';
import { parseStrictJson } from './strictJson.ts';

export interface ActionExecutionInputs {
  actionOutcome: string;
  actionConclusion: string;
  sessionId: string;
  structuredOutput: string;
  executionText: string;
}

export interface ActionExecutionExpectations {
  model: string;
  runId: string;
  maxTurns: number;
  maxBudgetUsd: number;
  maxDurationMs: number;
}

export interface VerifiedActionExecution {
  mode: 'action';
  synthetic: false;
  conclusion: 'success';
  termination: 'completed';
  model: string;
  runId: string;
  sessionId: string;
  numTurns: number;
  estimatedCostUsd: number;
  durationMs: number;
}

const VERIFIED = new WeakSet<object>();

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireEvidence(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Action execution rejected: ${message}`);
}

export function isVerifiedActionExecution(value: unknown): value is VerifiedActionExecution {
  return object(value) && VERIFIED.has(value);
}

// This checks consistency of outputs from the trusted action step, not a signature.
// The workflow must supply these inputs directly, never from PR uploads/comments.
export function verifyActionExecution(
  inputs: ActionExecutionInputs,
  expected: ActionExecutionExpectations,
): VerifiedActionExecution {
  requireEvidence(Number.isSafeInteger(expected.maxTurns) && expected.maxTurns > 0, 'invalid turn limit');
  requireEvidence(Number.isFinite(expected.maxBudgetUsd) && expected.maxBudgetUsd > 0, 'invalid estimated-cost limit');
  requireEvidence(Number.isFinite(expected.maxDurationMs) && expected.maxDurationMs > 0, 'invalid duration limit');
  requireEvidence(inputs.actionOutcome === 'success' && inputs.actionConclusion === 'success', 'action did not succeed');
  requireEvidence(inputs.sessionId.trim().length > 0, 'missing session ID');
  const messages: unknown = parseStrictJson(inputs.executionText);
  requireEvidence(Array.isArray(messages), 'execution trace must be an SDK message array');
  const initializations = messages.filter((message: unknown): boolean =>
    object(message) && message.type === 'system' && message.subtype === 'init');
  const results = messages.filter((message: unknown): boolean => object(message) && message.type === 'result');
  requireEvidence(initializations.length === 1 && results.length === 1, 'expected one initialization and one terminal result');
  const initialization: unknown = initializations[0];
  const result: unknown = results[0];
  requireEvidence(object(initialization) && object(result), 'invalid trace objects');
  requireEvidence(messages[0] === initialization && messages.at(-1) === result, 'trace is not a complete single execution');
  requireEvidence(initialization.session_id === inputs.sessionId && result.session_id === inputs.sessionId, 'session mismatch');
  requireEvidence(initialization.model === expected.model, 'resolved model differs from policy');
  requireEvidence(result.subtype === 'success' && result.is_error === false, 'terminal result failed or exhausted a limit');
  requireEvidence(Array.isArray(result.permission_denials) && result.permission_denials.length === 0, 'missing permissions evidence or denied investigation');
  requireEvidence(object(result.modelUsage) && Object.keys(result.modelUsage).length > 0, 'missing model usage identity');
  requireEvidence(Object.keys(result.modelUsage).every((model: string): boolean => model === expected.model), 'unexpected model or fallback usage');
  requireEvidence(Number.isSafeInteger(result.num_turns) && Number(result.num_turns) > 0
    && Number(result.num_turns) <= expected.maxTurns, 'invalid or exceeded turn limit');
  requireEvidence(typeof result.total_cost_usd === 'number' && Number.isFinite(result.total_cost_usd)
    && result.total_cost_usd >= 0 && result.total_cost_usd <= expected.maxBudgetUsd, 'invalid or exceeded estimated cost');
  requireEvidence(typeof result.duration_ms === 'number' && Number.isFinite(result.duration_ms)
    && result.duration_ms >= 0 && result.duration_ms <= expected.maxDurationMs, 'invalid or exceeded duration');
  const report: unknown = parseStrictJson(inputs.structuredOutput);
  requireEvidence(object(report) && object(result.structured_output), 'missing structured report');
  requireEvidence(canonicalJson(report) === canonicalJson(result.structured_output), 'output differs from the terminal structured report');
  const verified: VerifiedActionExecution = {
    mode: 'action',
    synthetic: false,
    conclusion: 'success',
    termination: 'completed',
    model: expected.model,
    runId: expected.runId,
    sessionId: inputs.sessionId,
    numTurns: Number(result.num_turns),
    estimatedCostUsd: result.total_cost_usd,
    durationMs: result.duration_ms,
  };
  VERIFIED.add(verified);
  return Object.freeze(verified);
}
