import { readFileSync } from 'node:fs';
import { parseStrictJson } from './strictJson.ts';
import type { ProviderReply, ProviderRequest, ReviewProvider, ReviewProviderConfig } from './providerTypes.ts';

interface MockStep {
  partitionId: string;
  phase: 'review' | 'repair';
  inputTokens: number;
  reply: ProviderReply;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(`Mock provider fixture invalid: ${message}`);
}

function parseFixture(path: string): { config: ReviewProviderConfig; steps: Map<string, MockStep> } {
  let input: unknown;
  try {
    input = parseStrictJson(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${path}: ${(error as Error).message}`);
  }
  if (!isObject(input)) fail('root must be an object');
  const expected = ['schemaVersion', 'kind', 'config', 'steps'];
  if (Object.keys(input).length !== expected.length || !expected.every((key) => key in input)) fail('unexpected fields');
  if (input.schemaVersion !== 1 || input.kind !== 'mock-review-provider') fail('schemaVersion/kind');
  if (!isObject(input.config)) fail('config must be an object');
  if (input.config.provider !== 'mock') fail('config.provider must be mock; a fixture cannot impersonate a real provider');
  if (!Array.isArray(input.steps)) fail('steps must be an array');
  const steps = new Map<string, MockStep>();
  for (const step of input.steps as unknown[]) {
    if (!isObject(step)) fail('step must be an object');
    const stepKeys = ['partitionId', 'phase', 'inputTokens', 'reply'];
    if (Object.keys(step).length !== stepKeys.length || !stepKeys.every((key) => key in step)) fail('step fields');
    if (typeof step.partitionId !== 'string' || (step.phase !== 'review' && step.phase !== 'repair')) fail('step identity');
    if (!Number.isSafeInteger(step.inputTokens) || (step.inputTokens as number) < 0) fail('step inputTokens');
    const reply = step.reply;
    if (!isObject(reply)) fail('step reply must be an object');
    const replyKeys = ['text', 'stopReason', 'inputTokens', 'outputTokens'];
    if (Object.keys(reply).length !== replyKeys.length || !replyKeys.every((key) => key in reply)) fail('reply fields');
    if (typeof reply.text !== 'string' || typeof reply.stopReason !== 'string') fail('reply text/stopReason');
    if (!Number.isSafeInteger(reply.inputTokens) || !Number.isSafeInteger(reply.outputTokens)
      || (reply.inputTokens as number) < 0 || (reply.outputTokens as number) < 0) fail('reply token usage');
    const id = `${step.partitionId}:${step.phase}`;
    if (steps.has(id)) fail(`duplicate step ${id}`);
    steps.set(id, { partitionId: step.partitionId, phase: step.phase, inputTokens: step.inputTokens as number, reply: structuredClone(reply) as unknown as ProviderReply });
  }
  return { config: structuredClone(input.config) as unknown as ReviewProviderConfig, steps };
}

export function createMockProvider(fixturePath: string): ReviewProvider {
  const fixture = parseFixture(fixturePath);
  const lookup = (request: ProviderRequest): MockStep => {
    const step = fixture.steps.get(`${request.partitionId}:${request.phase}`);
    if (!step) throw new Error(`Mock provider has no fixture step for ${request.partitionId}/${request.phase}.`);
    return step;
  };
  return {
    config: fixture.config,
    countTokens: (request: ProviderRequest): Promise<number> => Promise.resolve(lookup(request).inputTokens),
    invoke: (request: ProviderRequest): Promise<ProviderReply> => Promise.resolve(structuredClone(lookup(request).reply)),
  };
}
