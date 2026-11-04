import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validateAgentCurrent, validateAgentExecution, validateAgentPriorCheckpoint, validateAgentRequest, validateAgentValidationLimits } from './agentContracts.ts';
import type { AgentExecutionAttestation } from './agentContracts.ts';
import { prepareAgentReview, validateAgentReview } from './agentReview.ts';
import { defaultSystemRoot, loadPolicy } from './policy.ts';
import { parseStrictJson } from './strictJson.ts';

export class AgentUsageError extends Error {}

const PREPARE_FLAGS = [
  'checkout', 'repository', 'pr', 'base', 'head', 'run-id', 'review-system-sha',
  'prior-state', 'validation-limits', 'out', 'system-root', 'offline',
];
const VALIDATE_FLAGS = [
  'checkout', 'request', 'report', 'execution', 'current', 'prior-state', 'out', 'system-root', 'offline',
];

function parseFlags(args: string[], allowed: string[], required: string[]): Map<string, string> {
  const values = new Map<string, string>();
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (!token.startsWith('--')) throw new AgentUsageError(`Unexpected positional argument: ${token}`);
    const eq = token.indexOf('=');
    const name = token.slice(2, eq < 0 ? undefined : eq);
    if (!allowed.includes(name)) throw new AgentUsageError(`Unknown option: --${name}`);
    if (values.has(name)) throw new AgentUsageError(`Duplicate option: --${name}`);
    let value: string;
    if (eq >= 0) {
      value = token.slice(eq + 1);
    } else {
      index += 1;
      if (index >= args.length || args[index].startsWith('--')) throw new AgentUsageError(`Missing value for --${name}`);
      value = args[index];
    }
    values.set(name, value);
    index += 1;
  }
  for (const name of required) {
    if (!values.has(name)) throw new AgentUsageError(`Missing required option: --${name}`);
  }
  if (values.get('offline') !== 'true') {
    throw new AgentUsageError('This command is offline-only: pass --offline true. Live execution is not implemented.');
  }
  return values;
}

function parsePrNumber(raw: string | undefined): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || String(value) !== String(raw)) {
    throw new AgentUsageError(`Invalid --pr value: ${raw}`);
  }
  return value;
}

function readTextFile(filePath: string, label: string): string {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new AgentUsageError(`Cannot read ${label} file ${filePath}: ${(error as Error).message}`);
  }
}

function parseJsonFile(filePath: string, label: string): unknown {
  const text = readTextFile(filePath, label);
  try {
    return parseStrictJson(text);
  } catch (error) {
    throw new AgentUsageError(`${label} file ${filePath} is not valid JSON: ${(error as Error).message}`);
  }
}

function shaped<T>(filePath: string, label: string, validate: (input: unknown) => T): T {
  let parsed: unknown;
  try {
    parsed = parseJsonFile(filePath, label);
  } catch (error) {
    throw new AgentUsageError(`Cannot load ${label} file ${filePath}: ${(error as Error).message}`);
  }
  try {
    return validate(parsed);
  } catch (error) {
    throw new AgentUsageError(`Invalid ${label} file ${filePath}: ${(error as Error).message}`);
  }
}

export function commandPrepareAgent(args: string[]): number {
  const flags = parseFlags(
    args,
    PREPARE_FLAGS,
    ['checkout', 'repository', 'pr', 'base', 'head', 'run-id', 'review-system-sha', 'prior-state', 'validation-limits', 'out', 'offline'],
  );
  const systemRoot = path.resolve(flags.get('system-root') ?? defaultSystemRoot());
  const loaded = loadPolicy(systemRoot);
  const repository = flags.get('repository') as string;
  if (!loaded.policy.repositories.includes(repository)) {
    throw new AgentUsageError(`Repository ${repository} is outside the trusted policy allowlist (${loaded.policy.repositories.join(', ')}).`);
  }
  const priorState = shaped(flags.get('prior-state') as string, 'prior-state', validateAgentPriorCheckpoint);
  const validationLimits = shaped(flags.get('validation-limits') as string, 'validation-limits', validateAgentValidationLimits);

  const result = prepareAgentReview({
    checkout: path.resolve(flags.get('checkout') as string),
    repository,
    pullRequest: parsePrNumber(flags.get('pr')),
    baseRef: flags.get('base') as string,
    headRef: flags.get('head') as string,
    runId: flags.get('run-id') as string,
    reviewSystemSha: flags.get('review-system-sha') as string,
    priorState,
    validationLimits,
    outDir: flags.get('out') as string,
    systemRoot,
  });

  const { request } = result;
  console.log(JSON.stringify({
    status: result.status,
    kind: 'agent-review',
    mode: 'offline',
    synthetic: true,
    operational: false,
    files: result.files,
    changes: request.changes.length,
    size: request.size,
    dependencyEdges: request.dependencyEdges.length,
    previousHeadSha: request.previousHeadSha,
    complete: request.complete,
    limitations: request.limitations,
  }, null, 2));
  return result.status === 'prepared' ? 0 : 3;
}

export function commandValidateAgent(args: string[]): number {
  const flags = parseFlags(
    args,
    VALIDATE_FLAGS,
    ['checkout', 'request', 'report', 'execution', 'current', 'prior-state', 'out', 'offline'],
  );
  const systemRoot = path.resolve(flags.get('system-root') ?? defaultSystemRoot());
  const request = shaped(flags.get('request') as string, 'request', validateAgentRequest);
  const priorState = shaped(flags.get('prior-state') as string, 'prior-state', validateAgentPriorCheckpoint);
  const current = shaped(flags.get('current') as string, 'current', validateAgentCurrent);

  let execution: AgentExecutionAttestation | null = null;
  let executionError: string | null = null;
  const executionPath = flags.get('execution') as string;
  try {
    execution = validateAgentExecution(parseJsonFile(executionPath, 'execution'));
  } catch (error) {
    executionError = (error as Error).message;
  }

  let reportText: string | null = null;
  try {
    reportText = readFileSync(path.resolve(flags.get('report') as string), 'utf8');
  } catch {
    reportText = null;
  }

  const result = validateAgentReview({
    checkout: path.resolve(flags.get('checkout') as string),
    request,
    reportText,
    execution,
    executionError,
    current,
    priorState,
    outDir: flags.get('out') as string,
    systemRoot,
  });

  console.log(JSON.stringify({
    status: result.status,
    kind: 'offline-agent-decision',
    synthetic: true,
    operational: false,
    files: result.files,
    reasons: result.envelope.decision.reasons,
  }, null, 2));
  if (result.status === 'pass') return 0;
  if (result.status === 'changes_required') return 2;
  return 3;
}
