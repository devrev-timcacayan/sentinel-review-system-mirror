import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBedrockProvider } from '../src/bedrockProvider.ts';
import type { ProviderRequest } from '../src/providerTypes.ts';
import { loadTestPolicy } from './helpers.ts';

const MODEL = loadTestPolicy().policy.model;

function bedrockConfig(expiresInMs = 3_600_000): Record<string, unknown> {
  return {
    schemaVersion: 1,
    provider: 'bedrock',
    modelId: MODEL,
    region: 'us-east-1',
    contextTokens: 200_000,
    maxOutputTokens: 8_000,
    inputMicrosPerMillionTokens: 3_000,
    outputMicrosPerMillionTokens: 15_000,
    timeoutMs: 30_000,
    verification: {
      by: 'operator',
      at: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
      evidence: 'offline review of provider docs',
    },
  };
}

const REQUEST: ProviderRequest = {
  partitionId: 'part-001',
  phase: 'review',
  modelId: MODEL,
  maxOutputTokens: 8_000,
  system: 'system prompt',
  user: '{"kind":"partition-review"}',
};

function artifactDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'srs-bedrock-'));
}

test('count-tokens sends the exact payload through pinned regional endpoint args', async (): Promise<void> => {
  const calls: { args: string[]; env: Record<string, string> }[] = [];
  const dir = artifactDir();
  const provider = createBedrockProvider(bedrockConfig(), { execute: true, maxSpendMicros: 1_000_000 }, {
    trustedModelId: MODEL,
    executeAws: async (args, env): Promise<{ stdout: string; stderr: string }> => {
      calls.push({ args, env });
      return { stdout: '{"inputTokens": 123}', stderr: '' };
    },
  });
  const count = await provider.countTokens(REQUEST, dir);
  assert.equal(count, 123);
  const { args, env } = calls[0];
  assert.ok(args.includes('--no-cli-pager'));
  assert.ok(args.includes('bedrock-runtime') && args.includes('count-tokens'));
  assert.ok(args.includes('--region') && args.includes('us-east-1'));
  assert.ok(args.includes('https://bedrock-runtime.us-east-1.amazonaws.com'), 'endpoint pinned to the configured region');
  assert.equal(args[args.indexOf('--cli-read-timeout') + 1], '30', 'CLI read timeout derived from the verified timeoutMs');
  assert.ok(args.some((arg) => arg.startsWith('file://')), 'payload passed as immutable file reference');
  assert.equal(env.AWS_MAX_ATTEMPTS, '1');
  assert.equal(env.AWS_CLI_AUTO_PROMPT, 'off');
  const payloadPath = args.find((arg) => arg.startsWith('file://'))!.slice('file://'.length);
  const payload = JSON.parse(readFileSync(payloadPath, 'utf8'));
  assert.deepEqual(payload, {
    modelId: MODEL,
    input: { converse: { system: [{ text: 'system prompt' }], messages: [{ role: 'user', content: [{ text: '{"kind":"partition-review"}' }] }] } },
  });
});

test('converse returns concatenated text and never sends temperature or tools', async (): Promise<void> => {
  const dir = artifactDir();
  const provider = createBedrockProvider(bedrockConfig(), { execute: true, maxSpendMicros: 1_000_000 }, {
    trustedModelId: MODEL,
    executeAws: async (args): Promise<{ stdout: string; stderr: string }> => {
      const payloadPath = args.find((arg) => arg.startsWith('file://'))!.slice('file://'.length);
      const payload = JSON.parse(readFileSync(payloadPath, 'utf8'));
      assert.deepEqual(payload.inferenceConfig, { maxTokens: 8_000 });
      assert.equal(payload.temperature, undefined);
      assert.equal(payload.tools, undefined);
      return {
        stdout: JSON.stringify({
          output: { message: { role: 'assistant', content: [{ text: 'part ' }, { text: 'two' }] } },
          usage: { inputTokens: 55, outputTokens: 9 },
          stopReason: 'end_turn',
        }),
        stderr: '',
      };
    },
  });
  const reply = await provider.invoke(REQUEST, dir);
  assert.equal(reply.text, 'part two');
  assert.deepEqual({ inputTokens: reply.inputTokens, outputTokens: reply.outputTokens, stopReason: reply.stopReason }, { inputTokens: 55, outputTokens: 9, stopReason: 'end_turn' });
});

test('cache token usage, malformed usage, and non-text blocks are refused', async (): Promise<void> => {
  const dir = artifactDir();
  const make = (stdout: string): ReturnType<typeof createBedrockProvider> => createBedrockProvider(bedrockConfig(), { execute: true, maxSpendMicros: 1_000_000 }, {
    trustedModelId: MODEL,
    executeAws: async (): Promise<{ stdout: string; stderr: string }> => ({ stdout, stderr: '' }),
  });
  await assert.rejects(
    () => make(JSON.stringify({ output: { message: { role: 'assistant', content: [{ text: 'x' }] } }, usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 4 }, stopReason: 'end_turn' })).invoke(REQUEST, dir),
    /cache token usage/,
  );
  await assert.rejects(
    () => make(JSON.stringify({ output: { message: { role: 'assistant', content: [{ text: 'x' }] } }, usage: { inputTokens: -1, outputTokens: 1 }, stopReason: 'end_turn' })).invoke(REQUEST, dir),
    /invalid usage/,
  );
  await assert.rejects(
    () => make(JSON.stringify({ output: { message: { role: 'assistant', content: [{ toolUse: {} }] } }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'tool_use' })).invoke(REQUEST, dir),
    /non-text content block/,
  );
});

test('constructor refuses without execute, without a positive cap, and on expired verification', (): void => {
  assert.throws(() => createBedrockProvider(bedrockConfig(), { execute: false, maxSpendMicros: 1 }, { trustedModelId: MODEL }), /execute:true/);
  assert.throws(() => createBedrockProvider(bedrockConfig(), { execute: true, maxSpendMicros: 0 }, { trustedModelId: MODEL }), /positive explicit maxSpendMicros/);
  assert.throws(() => createBedrockProvider(bedrockConfig(-1), { execute: true, maxSpendMicros: 1 }, { trustedModelId: MODEL }), /verification|expired/);
});

test('no process spawns without the injected executor being invoked', (): void => {
  const provider = createBedrockProvider(bedrockConfig(), { execute: true, maxSpendMicros: 1 }, { trustedModelId: MODEL });
  assert.equal(typeof provider.countTokens, 'function');
  assert.equal(existsSync(path.join(tmpdir(), 'nonexistent-srs')), false);
});
