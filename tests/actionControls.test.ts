import assert from 'node:assert/strict';
import test from 'node:test';
import { ACTION_SETTINGS, actionClaudeArgs, readActionControls } from '../src/actionControls.ts';

const ENV: NodeJS.ProcessEnv = {
  SENTINEL_REVIEW_POC_APPROVED_PR: '17',
  SENTINEL_REVIEW_CONTROLS_VERIFIED: 'true',
  SENTINEL_REVIEW_MAX_TURNS: '10',
  SENTINEL_REVIEW_MAX_USD: '1',
  SENTINEL_REVIEW_TIMEOUT_MINUTES: '2',
  SENTINEL_REVIEW_MAX_FILES: '100',
  SENTINEL_REVIEW_MAX_SOURCE_BYTES: '1000000',
  SENTINEL_REVIEW_MAX_READ_BYTES: '100000',
};

test('action limits have no implicit defaults or implicit paid-PR authorization', (): void => {
  assert.deepEqual(readActionControls(ENV, 17), {
    maxTurns: 10, maxBudgetUsd: 1, timeoutMinutes: 2,
    maxFiles: 100, maxSourceBytes: 1_000_000, maxReadBytes: 100_000,
  });
  assert.throws(() => readActionControls(ENV, 18));
  for (const name of Object.keys(ENV)) assert.throws(() => readActionControls({ ...ENV, [name]: '' }, 17), name);
  for (const value of ['0', '-1', 'NaN', 'Infinity', '1;echo bad', '01', '1e3']) {
    assert.throws(() => readActionControls({ ...ENV, SENTINEL_REVIEW_MAX_TURNS: value }, 17));
  }
  for (const value of ['0', '-1', 'Infinity', '1;echo bad', '01', '1e3']) {
    assert.throws(() => readActionControls({ ...ENV, SENTINEL_REVIEW_MAX_USD: value }, 17));
  }
});

test('action configuration restricts investigation tools and supplies explicit output and cost controls', (): void => {
  const args = actionClaudeArgs(readActionControls(ENV, 17), 'global.anthropic.claude-sonnet-5-5', { type: 'object' });
  assert.match(args, /--max-turns 10 --max-budget-usd 1/);
  assert.match(args, /--json-schema '\{"type":"object"\}'/);
  assert.match(args, /--safe-mode --restricted --tools 'Read,Glob,Grep'/);
  assert.match(args, /--allowedTools 'Read\(\.\/review-source\/\*\*\),Glob,Grep'/);
  assert.match(args, /--strict-mcp-config --mcp-config '\{"mcpServers":\{\}\}'/);
  assert.equal(ACTION_SETTINGS.disableAllHooks, true);
  assert.equal(ACTION_SETTINGS.enableAllProjectMcpServers, false);
  assert.ok(ACTION_SETTINGS.permissions.deny.includes('Bash'));
  assert.ok(ACTION_SETTINGS.permissions.deny.includes('mcp__*'));
});
