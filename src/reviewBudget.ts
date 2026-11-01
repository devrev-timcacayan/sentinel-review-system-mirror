import type { ReviewProviderConfig } from './providerTypes.ts';

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Review execution blocked: ${message}`);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function integer(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

export function validateProviderConfig(
  input: unknown,
  modelId: string,
  now: number = Date.now(),
): ReviewProviderConfig {
  requireCondition(object(input), 'provider configuration must be an object.');
  const fields = ['schemaVersion', 'provider', 'modelId', 'contextTokens', 'maxOutputTokens',
    'inputMicrosPerMillionTokens', 'outputMicrosPerMillionTokens', 'timeoutMs',
    ...(input.countTokensModelId !== undefined ? ['countTokensModelId'] : []),
    ...(input.region !== undefined ? ['region'] : []), ...(input.verification !== undefined ? ['verification'] : [])];
  requireCondition(Object.keys(input).length === fields.length && fields.every((key): boolean => key in input), 'unexpected provider configuration fields.');
  requireCondition(input.schemaVersion === 1 && (input.provider === 'mock' || input.provider === 'bedrock'), 'unsupported provider configuration.');
  requireCondition(input.modelId === modelId, 'provider model must exactly match trusted review policy; no fallback is allowed.');
  if (input.countTokensModelId !== undefined) {
    requireCondition(typeof input.countTokensModelId === 'string' && input.countTokensModelId.trim().length > 0, 'countTokensModelId must be a non-empty model identity.');
  }
  for (const field of ['contextTokens', 'maxOutputTokens', 'timeoutMs']) {
    requireCondition(integer(input[field], 1), `${field} must be a positive safe integer.`);
  }
  requireCondition(Number(input.timeoutMs) <= 2_147_483_647, 'timeout exceeds the supported timer range.');
  requireCondition(Number(input.maxOutputTokens) < Number(input.contextTokens), 'output limit must leave room for input.');
  for (const field of ['inputMicrosPerMillionTokens', 'outputMicrosPerMillionTokens']) {
    requireCondition(integer(input[field], input.provider === 'bedrock' ? 1 : 0), `${field} must be an explicit integer price in microdollars per million tokens.`);
  }
  if (input.provider === 'bedrock') {
    requireCondition(typeof input.region === 'string' && /^[a-z]{2}(?:-[a-z]+)+-[0-9]+$/.test(input.region), 'an explicit AWS region is required.');
    const verification = input.verification;
    requireCondition(object(verification), 'human-verified model limits, pricing, and provider routing are required.');
    requireCondition(Object.keys(verification).length === 4
      && ['by', 'at', 'expiresAt', 'evidence'].every((key): boolean => typeof verification[key] === 'string' && String(verification[key]).trim().length > 0),
    'verification must contain by, at, expiresAt, and evidence.');
    const verifiedAt = Date.parse(String(verification.at));
    const expiresAt = Date.parse(String(verification.expiresAt));
    requireCondition(Number.isFinite(verifiedAt) && Number.isFinite(expiresAt)
      && verifiedAt <= now && expiresAt > now && verifiedAt < expiresAt, 'provider verification is invalid, future-dated, or expired.');
  } else {
    requireCondition(input.region === undefined && input.verification === undefined, 'mock configuration must not claim AWS verification.');
  }
  return structuredClone(input) as unknown as ReviewProviderConfig;
}

export function parseSpendLimit(text: string): number {
  requireCondition(/^(0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(text), 'spending limit must be non-negative USD with at most six decimal places.');
  const [whole, fraction = ''] = text.split('.');
  const value = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  requireCondition(value <= BigInt(Number.MAX_SAFE_INTEGER), 'spending limit exceeds safe integer precision.');
  return Number(value);
}

function tokenCharge(tokens: number, rate: number): bigint {
  requireCondition(integer(tokens, 0) && integer(rate, 0), 'invalid token usage or price.');
  return (BigInt(tokens) * BigInt(rate) + 999_999n) / 1_000_000n;
}

export function requestCostMicros(config: ReviewProviderConfig, inputTokens: number, outputTokens: number): number {
  const cost = tokenCharge(inputTokens, config.inputMicrosPerMillionTokens)
    + tokenCharge(outputTokens, config.outputMicrosPerMillionTokens);
  requireCondition(cost <= BigInt(Number.MAX_SAFE_INTEGER), 'request cost exceeds safe integer precision.');
  return Number(cost);
}

export function assertTokenFit(config: ReviewProviderConfig, inputTokens: number): void {
  requireCondition(integer(inputTokens, 0), 'token counter returned invalid usage.');
  requireCondition(BigInt(inputTokens) + BigInt(config.maxOutputTokens) <= BigInt(config.contextTokens),
    'complete request plus reserved output exceeds the verified context limit; no source may be truncated.');
}

export class ReviewSpendBudget {
  private reserved = 0n;
  private spent = 0n;
  private readonly cap: bigint;

  constructor(limitMicros: number) {
    requireCondition(integer(limitMicros, 0), 'explicit spending limit is required.');
    this.cap = BigInt(limitMicros);
  }

  public reserve(micros: number): void {
    requireCondition(integer(micros, 0), 'invalid cost reservation.');
    requireCondition(this.spent + this.reserved + BigInt(micros) <= this.cap, 'spending limit cannot cover this request.');
    this.reserved += BigInt(micros);
  }

  public settle(reservedMicros: number, actualMicros: number): void {
    requireCondition(integer(reservedMicros, 0) && integer(actualMicros, 0)
      && BigInt(reservedMicros) <= this.reserved, 'invalid cost settlement.');
    this.reserved -= BigInt(reservedMicros);
    this.spent += BigInt(actualMicros);
    requireCondition(actualMicros <= reservedMicros && this.spent + this.reserved <= this.cap,
      'provider usage exceeded its reservation; stop execution and inspect actual billing.');
  }

  public snapshot(): { spentMicros: string; reservedMicros: string; limitMicros: string } {
    return { spentMicros: this.spent.toString(), reservedMicros: this.reserved.toString(), limitMicros: this.cap.toString() };
  }
}
