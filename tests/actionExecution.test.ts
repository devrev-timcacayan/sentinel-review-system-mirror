import assert from 'node:assert/strict';
import test from 'node:test';
import { isVerifiedActionExecution, verifyActionExecution } from '../src/actionExecution.ts';
import type { ActionExecutionInputs } from '../src/actionExecution.ts';

const EXPECTED = {
  model: 'global.anthropic.claude-sonnet-5-5',
  runId: 'gha-123-1',
  maxTurns: 10,
  maxBudgetUsd: 1,
  maxDurationMs: 120_000,
};

function fixture(): { inputs: ActionExecutionInputs; messages: Record<string, unknown>[] } {
  const messages = [
    {
      type: 'system', subtype: 'init', session_id: 'session-1', model: EXPECTED.model,
    },
    {
      type: 'result', subtype: 'success', is_error: false, session_id: 'session-1',
      permission_denials: [], modelUsage: { [EXPECTED.model]: {} },
      num_turns: 2, total_cost_usd: 0.25, duration_ms: 1000,
      structured_output: { schemaVersion: 1 },
    },
  ];
  return {
    messages,
    inputs: {
      actionOutcome: 'success',
      actionConclusion: 'success',
      sessionId: 'session-1',
      structuredOutput: '{"schemaVersion":1}',
      executionText: JSON.stringify(messages),
    },
  };
}

test('action evidence binds a complete single session and preserves checked usage values', (): void => {
  const { inputs } = fixture();
  const receipt = verifyActionExecution(inputs, EXPECTED);
  assert.deepEqual(receipt, {
    mode: 'action', synthetic: false, conclusion: 'success', termination: 'completed',
    model: 'global.anthropic.claude-sonnet-5-5', runId: 'gha-123-1',
    sessionId: 'session-1', numTurns: 2, estimatedCostUsd: 0.25, durationMs: 1000,
  });
  assert.equal(isVerifiedActionExecution(receipt), true);
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(isVerifiedActionExecution(JSON.parse(JSON.stringify(receipt))), false);
  assert.equal(isVerifiedActionExecution({ mode: 'action', synthetic: false, conclusion: 'success' }), false);
});

test('a successful-looking report cannot override failed action outputs or another session', (): void => {
  for (const mutation of [
    { actionOutcome: 'failure' }, { actionConclusion: 'failure' }, { sessionId: 'other-session' },
    { structuredOutput: '{"schemaVersion":2}' }, { sessionId: '' },
    { executionText: '{}' }, { executionText: '[]' }, { executionText: '{bad json' },
  ]) {
    const { inputs } = fixture();
    assert.throws(() => verifyActionExecution({ ...inputs, ...mutation }, EXPECTED));
  }
});

test('terminal execution evidence rejects exhausted limits, errors, model fallback and permission gaps', (): void => {
  for (const mutation of [
    { subtype: 'error_max_budget_usd' }, { subtype: 'error_max_turns' }, { is_error: true },
    { session_id: 'other-session' }, { num_turns: 11 }, { num_turns: -1 },
    { total_cost_usd: 1.01 }, { total_cost_usd: -0.01 }, { duration_ms: 120_001 },
    { permission_denials: [{}] }, { permission_denials: undefined },
    { modelUsage: {} }, { modelUsage: { 'other-model': {} } },
    { structured_output: null },
  ]) {
    const { inputs, messages } = fixture();
    messages[1] = { ...messages[1], ...mutation };
    assert.throws(() => verifyActionExecution({ ...inputs, executionText: JSON.stringify(messages) }, EXPECTED));
  }
});

test('initialization and terminal result must belong to exactly one complete execution', (): void => {
  const { inputs, messages } = fixture();
  for (const trace of [
    [messages[0], messages[0], messages[1]],
    [messages[0], messages[1], messages[1]],
    [messages[0], messages[1], { type: 'assistant' }],
    [{ type: 'assistant' }, ...messages],
    [{ ...messages[0], model: 'other-model' }, messages[1]],
  ]) {
    assert.throws(() => verifyActionExecution({ ...inputs, executionText: JSON.stringify(trace) }, EXPECTED));
  }
});

test('null turn/budget caps allow any finite actual usage but still enforce every other bound', (): void => {
  const model = 'global.anthropic.claude-sonnet-5-5';
  const report = { schemaVersion: 1, complete: true };
  const receipt = verifyActionExecution(
    { actionOutcome: 'success', actionConclusion: 'success', sessionId: 's-1', structuredOutput: JSON.stringify(report), executionText: JSON.stringify([
      { type: 'system', subtype: 'init', session_id: 's-1', model },
      { type: 'result', subtype: 'success', is_error: false, session_id: 's-1', permission_denials: [], modelUsage: { [model]: {} }, num_turns: 50, total_cost_usd: 6.25, duration_ms: 120_000, structured_output: report },
    ]) },
    { model, runId: 'r', maxTurns: null, maxBudgetUsd: null, maxDurationMs: 900_000 },
  );
  assert.equal(receipt.numTurns, 50);
  assert.equal(receipt.estimatedCostUsd, 6.25);
  for (const bad of [
    { num_turns: 0 }, { num_turns: -1 }, { num_turns: 1.5 }, { total_cost_usd: -0.1 }, { total_cost_usd: 'x' }, { duration_ms: 900_001 },
  ]) {
    const trace = JSON.stringify([
      { type: 'system', subtype: 'init', session_id: 's-1', model },
      { type: 'result', subtype: 'success', is_error: false, session_id: 's-1', permission_denials: [], modelUsage: { [model]: {} }, num_turns: 1, total_cost_usd: 0.1, duration_ms: 1, structured_output: report, ...bad },
    ]);
    assert.throws(() => verifyActionExecution(
      { actionOutcome: 'success', actionConclusion: 'success', sessionId: 's-1', structuredOutput: JSON.stringify(report), executionText: trace },
      { model, runId: 'r', maxTurns: null, maxBudgetUsd: null, maxDurationMs: 900_000 },
    ), JSON.stringify(bad));
  }
});
