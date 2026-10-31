import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReviewProviderConfig } from '../src/providerTypes.ts';
import { assertTokenFit, parseSpendLimit, requestCostMicros, ReviewSpendBudget, validateProviderConfig } from '../src/reviewBudget.ts';

function mockConfig(): ReviewProviderConfig {
  return {
    schemaVersion: 1,
    provider: 'mock',
    modelId: 'test-model',
    contextTokens: 1000,
    maxOutputTokens: 100,
    inputMicrosPerMillionTokens: 2_000_000,
    outputMicrosPerMillionTokens: 9_000_000,
    timeoutMs: 1000,
  };
}

function verifiedConfig(): ReviewProviderConfig {
  return {
    ...mockConfig(),
    provider: 'bedrock',
    region: 'us-east-1',
    verification: {
      by: 'synthetic-test-operator',
      at: '2026-01-01T00:00:00Z',
      expiresAt: '2026-03-01T00:00:00Z',
      evidence: 'Synthetic test data, not a declaration of real model limits or prices.',
    },
  };
}

const FIXED_NOW = Date.parse('2026-02-01T00:00:00Z');

test('USD limits parse exactly into integer microdollars without floating point rounding', (): void => {
  assert.equal(parseSpendLimit('0'), 0);
  assert.equal(parseSpendLimit('1.000001'), 1_000_001);
  assert.equal(parseSpendLimit('0.000001'), 1);
  assert.equal(parseSpendLimit('9007199254.740991'), Number.MAX_SAFE_INTEGER);
  for (const invalid of ['-1', '1e3', '$1', ' 1', '1 ', '.5', '01', '1.0000001', 'NaN', 'Infinity', '9007199254.740992']) {
    assert.throws(() => parseSpendLimit(invalid), /Review execution blocked/);
  }
});

test('token prices use integer ceiling arithmetic, including sub-microdollar charges', (): void => {
  const config = mockConfig();
  assert.equal(requestCostMicros(config, 0, 0), 0);
  assert.equal(requestCostMicros(config, 1, 1), 11);
  assert.equal(requestCostMicros(config, 100, 100), 1100);
  const tiny = { ...config, inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1 };
  assert.equal(requestCostMicros(tiny, 1, 1), 2);
  assert.equal(requestCostMicros(tiny, 1_000_001, 0), 2);
  for (const invalid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => requestCostMicros(config, invalid, 1));
  }
  assert.throws(() => requestCostMicros(config, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER), /safe integer precision/);
});

test('reserved output is included in the verified context limit and source cannot be clipped', (): void => {
  assert.doesNotThrow(() => assertTokenFit(mockConfig(), 900));
  assert.throws(() => assertTokenFit(mockConfig(), 901), /no source may be truncated/);
  for (const invalid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => assertTokenFit(mockConfig(), invalid), /token counter/);
  }
});

test('all held initial-call reservations prevent a repair from spending their budget', (): void => {
  const budget = new ReviewSpendBudget(2200);
  budget.reserve(1100);
  budget.reserve(1100);
  assert.throws(() => budget.reserve(1), /spending limit/);
  budget.settle(1100, 1100);
  assert.throws(() => budget.reserve(1), /spending limit/);
  budget.settle(1100, 0);
  assert.deepEqual(budget.snapshot(), { spentMicros: '1100', reservedMicros: '0', limitMicros: '2200' });
});

test('unused output reservations can be released without making estimated charges disappear', (): void => {
  const budget = new ReviewSpendBudget(1100);
  budget.reserve(1100);
  budget.settle(1100, 11);
  budget.reserve(1089);
  assert.throws(() => budget.reserve(1));
  assert.deepEqual(budget.snapshot(), { spentMicros: '11', reservedMicros: '1089', limitMicros: '1100' });
});

test('invalid settlement cannot release funds, and an overrun prevents more calls', (): void => {
  const budget = new ReviewSpendBudget(10);
  budget.reserve(10);
  assert.throws(() => budget.settle(11, 0), /invalid cost settlement/);
  assert.deepEqual(budget.snapshot(), { spentMicros: '0', reservedMicros: '10', limitMicros: '10' });
  assert.throws(() => budget.settle(10, 11), /provider usage exceeded/);
  assert.deepEqual(budget.snapshot(), { spentMicros: '11', reservedMicros: '0', limitMicros: '10' });
  assert.throws(() => budget.reserve(0), /spending limit/);
});

test('overrun accounting remains exact beyond Number.MAX_SAFE_INTEGER', (): void => {
  const budget = new ReviewSpendBudget(Number.MAX_SAFE_INTEGER);
  budget.reserve(Number.MAX_SAFE_INTEGER - 1);
  budget.settle(Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER - 1);
  budget.reserve(1);
  assert.throws(() => budget.settle(1, Number.MAX_SAFE_INTEGER), /provider usage exceeded/);
  assert.equal(budget.snapshot().spentMicros, '18014398509481981');
});

test('provider verification binds the exact policy model and an unexpired human attestation', (): void => {
  const config = verifiedConfig();
  assert.deepEqual(validateProviderConfig(config, 'test-model', FIXED_NOW), config);
  for (const mutation of [
    { modelId: 'other-model' },
    { region: 'us-east-1 --endpoint-url attacker' },
    { verification: undefined },
    { verification: { ...config.verification!, by: '' } },
    { verification: { ...config.verification!, at: '2026-02-02T00:00:00Z' } },
    { verification: { ...config.verification!, expiresAt: '2026-01-31T00:00:00Z' } },
    { inputMicrosPerMillionTokens: 0 },
    { outputMicrosPerMillionTokens: -1 },
    { contextTokens: 1 },
    { timeoutMs: 2_147_483_648 },
    { extraConfiguration: true },
  ]) {
    assert.throws(() => validateProviderConfig({ ...config, ...mutation }, 'test-model', FIXED_NOW), /Review execution blocked/);
  }
});

test('mock mode cannot claim AWS region or human provider verification', (): void => {
  assert.deepEqual(validateProviderConfig(mockConfig(), 'test-model'), mockConfig());
  assert.throws(() => validateProviderConfig({ ...mockConfig(), region: 'us-east-1' }, 'test-model'));
  assert.throws(() => validateProviderConfig({ ...mockConfig(), verification: verifiedConfig().verification }, 'test-model'));
});
