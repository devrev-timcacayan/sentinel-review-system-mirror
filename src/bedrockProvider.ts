import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { validateProviderConfig } from './reviewBudget.ts';
import { parseStrictJson } from './strictJson.ts';
import type { ProviderReply, ProviderRequest, ReviewProvider, ReviewProviderConfig } from './providerTypes.ts';

export type AwsExecutor = (args: string[], env: Record<string, string>, timeoutMs: number, stdinPath: string) => Promise<{ stdout: string; stderr: string }>;

export interface BedrockOptions {
  execute: boolean;
  maxSpendMicros: number;
}

interface ExecOutcome {
  stdout: string;
  stderr: string;
}

function defaultExecutor(args: string[], env: Record<string, string>, timeoutMs: number): Promise<ExecOutcome> {
  return new Promise((resolve, reject): void => {
    execFile('aws', args, {
      env: { ...process.env, ...env },
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
    }, (error, stdout, stderr): void => {
      if (error) {
        const wrapped = error as Error & { stderr?: string };
        wrapped.stderr = stderr;
        reject(wrapped);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function endpointFor(region: string): string {
  const suffix = region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com';
  return `https://bedrock-runtime.${region}.${suffix}`;
}

function requireVerification(config: ReviewProviderConfig): void {
  const expiresAt = Date.parse(config.verification?.expiresAt ?? '');
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error('Review execution blocked: provider verification expired before this call.');
  }
}

export function createBedrockProvider(
  configInput: unknown,
  options: BedrockOptions,
  injected?: { executeAws?: AwsExecutor; trustedModelId?: string },
): ReviewProvider {
  const config = validateProviderConfig(configInput, injected?.trustedModelId ?? (configInput as { modelId?: string }).modelId ?? '');
  if (config.provider !== 'bedrock') throw new Error('Review execution blocked: bedrock adapter requires a bedrock provider configuration.');
  if (options.execute !== true) throw new Error('Review execution blocked: bedrock requires explicit execute:true.');
  if (!Number.isSafeInteger(options.maxSpendMicros) || options.maxSpendMicros <= 0) {
    throw new Error('Review execution blocked: a positive explicit maxSpendMicros cap is required.');
  }
  requireVerification(config);
  const executeAws = injected?.executeAws ?? defaultExecutor;
  const region = config.region as string;
  const endpoint = endpointFor(region);
  const env = {
    AWS_PAGER: '',
    AWS_CLI_AUTO_PROMPT: 'off',
    AWS_MAX_ATTEMPTS: '1',
    AWS_RETRY_MODE: 'standard',
    AWS_EC2_METADATA_DISABLED: 'true',
  };

  const call = async (operation: string, payload: unknown, artifactDirectory: string, label: string): Promise<Record<string, unknown>> => {
    requireVerification(config);
    const payloadPath = path.join(artifactDirectory, `${label}-payload.json`);
    mkdirSync(path.dirname(payloadPath), { recursive: true });
    writeFileSync(payloadPath, JSON.stringify(payload), { mode: 0o600 });
    const args = [
      '--no-cli-pager', '--region', region, '--endpoint-url', endpoint,
      '--cli-read-timeout', String(Math.ceil(config.timeoutMs / 1000)),
      'bedrock-runtime', operation, '--cli-input-json', `file://${path.resolve(payloadPath)}`, '--output', 'json',
    ];
    let outcome: ExecOutcome;
    try {
      outcome = await executeAws(args, env, config.timeoutMs, payloadPath);
    } catch (error) {
      const detail = (error as Error & { stderr?: string }).stderr ?? (error as Error).message;
      writeFileSync(path.join(artifactDirectory, `${label}-stderr.txt`), detail, { mode: 0o600 });
      throw error;
    }
    if (outcome.stderr.trim().length > 0) {
      writeFileSync(path.join(artifactDirectory, `${label}-stderr.txt`), outcome.stderr, { mode: 0o600 });
    }
    writeFileSync(path.join(artifactDirectory, `${label}-response.json`), outcome.stdout, { mode: 0o600 });
    let parsed: unknown;
    try {
      parsed = parseStrictJson(outcome.stdout);
    } catch (error) {
      throw new Error(`Bedrock ${operation} returned unparseable JSON: ${(error as Error).message}`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Bedrock ${operation} returned a non-object response.`);
    }
    return parsed as Record<string, unknown>;
  };

  return {
    config,
    countTokens: async (request: ProviderRequest, artifactDirectory: string): Promise<number> => {
      if (config.tokenCountMode === 'estimate') {
        const bytes = Buffer.byteLength(request.system, 'utf8') + Buffer.byteLength(request.user, 'utf8');
        return Math.ceil(bytes / 2);
      }
      const payload = {
        modelId: config.countTokensModelId ?? request.modelId,
        input: {
          converse: {
            system: [{ text: request.system }],
            messages: [{ role: 'user', content: [{ text: request.user }] }],
          },
        },
      };
      const response = await call('count-tokens', payload, artifactDirectory, 'count-tokens');
      const inputTokens = response.inputTokens;
      if (!Number.isSafeInteger(inputTokens) || (inputTokens as number) < 0) {
        throw new Error('Bedrock count-tokens returned invalid inputTokens.');
      }
      return inputTokens as number;
    },
    invoke: async (request: ProviderRequest, artifactDirectory: string): Promise<ProviderReply> => {
      const payload = {
        modelId: request.modelId,
        system: [{ text: request.system }],
        messages: [{ role: 'user', content: [{ text: request.user }] }],
        inferenceConfig: { maxTokens: request.maxOutputTokens },
      };
      const response = await call('converse', payload, artifactDirectory, 'converse');
      const output = response.output as Record<string, unknown> | undefined;
      const message = output?.message as Record<string, unknown> | undefined;
      if (message?.role !== 'assistant' || !Array.isArray(message.content)) {
        throw new Error('Bedrock converse returned no assistant message.');
      }
      const texts: string[] = [];
      for (const block of message.content as unknown[]) {
        const keys = block === null || typeof block !== 'object' || Array.isArray(block)
          ? [] : Object.keys(block as Record<string, unknown>);
        if (keys.length === 1 && keys[0] === 'reasoningContent') continue;
        if (keys.length !== 1 || keys[0] !== 'text' || typeof (block as Record<string, unknown>).text !== 'string') {
          throw new Error('Bedrock converse returned a non-text content block.');
        }
        texts.push((block as Record<string, unknown>).text as string);
      }
      if (texts.length === 0) throw new Error('Bedrock converse returned no text content block.');
      const usage = response.usage as Record<string, unknown> | undefined;
      const inputTokens = usage?.inputTokens;
      const outputTokens = usage?.outputTokens;
      if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens)
        || (inputTokens as number) < 0 || (outputTokens as number) < 0) {
        throw new Error('Bedrock converse returned invalid usage accounting.');
      }
      const cacheRead = usage?.cacheReadInputTokens ?? 0;
      const cacheWrite = usage?.cacheWriteInputTokens ?? 0;
      if (cacheRead !== 0 || cacheWrite !== 0) {
        throw new Error('Bedrock converse reported cache token usage that is unsupported by the verified price.');
      }
      const stopReason = response.stopReason;
      if (typeof stopReason !== 'string' || stopReason.length === 0) {
        throw new Error('Bedrock converse returned no stopReason.');
      }
      return {
        text: texts.join(''),
        stopReason,
        inputTokens: inputTokens as number,
        outputTokens: outputTokens as number,
      };
    },
  };
}
