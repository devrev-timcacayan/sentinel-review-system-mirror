import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { GateDecision, PartitionedReviewReport, ReviewLedger, ReviewReport, ReviewSnapshot } from './contracts.ts';
import type { LoadedPolicy } from './policy.ts';
import type { ProviderRequest, ReviewProvider } from './providerTypes.ts';
import { evaluateReview } from './gate.ts';
import { validateSnapshot } from './snapshot.ts';
import { canonicalJson, projectPartition, validatePartitionManifest } from './partitionContract.ts';
import { ReviewSpendBudget, assertTokenFit, requestCostMicros, validateProviderConfig } from './reviewBudget.ts';
import { inspectModelResponse, isCitationOnlyRepair } from './reviewValidation.ts';
import { writePacketFile } from './artifactFiles.ts';
import { parseStrictJson } from './strictJson.ts';

export interface AttemptRecord {
  partitionId: string;
  phase: 'review' | 'repair';
  status: 'accepted' | 'rejected' | 'failed';
  requestPath: string;
  requestHash: string;
  responsePath?: string;
  issues: string[];
  countedInputTokens?: number;
  usage?: { inputTokens: number; outputTokens: number };
  reservedCostMicros?: number;
  settledCostMicros?: number;
}

export interface ReviewRunResult {
  synthetic: boolean;
  decision: GateDecision;
  report: PartitionedReviewReport;
  reportPath: string;
  executionPath: string;
  attempts: AttemptRecord[];
  budget: ReturnType<ReviewSpendBudget['snapshot']>;
  uncertainCharges: boolean;
}

function numberContent(content: string): string {
  return content.split('\n').map((line: string, index: number): string => `${index + 1}|${line}`).join('\n');
}

function buildRequest(
  parent: ReviewSnapshot,
  partitionId: string,
  phase: 'review' | 'repair',
  loaded: LoadedPolicy,
  config: { modelId: string; maxOutputTokens: number },
  priorLedger: ReviewLedger,
  extra?: { originalReport: unknown; validationErrors: string[] },
): ProviderRequest {
  const partition = parent.partitionManifest?.partitions.find((part): boolean => part.id === partitionId);
  if (!partition) throw new Error(`Partition ${partitionId} missing from parent manifest.`);
  const scoped = projectPartition(parent, partition);
  const scopedForModel = {
    ...scoped,
    files: scoped.files.map((file) => ({ path: file.path, revision: file.revision, numberedContent: numberContent(file.content) })),
  };
  const user = JSON.stringify({
    schemaVersion: 1,
    kind: phase === 'review' ? 'partition-review' : 'evidence-repair',
    partitionId,
    manifestDigest: parent.partitionManifest?.digest,
    policy: loaded.policy,
    responseContract: loaded.responseContract,
    snapshot: scopedForModel,
    priorLedger,
    ...(phase === 'repair' ? { originalReport: extra?.originalReport, validationErrors: extra?.validationErrors ?? [] } : {}),
  });
  const system = phase === 'review'
    ? `${loaded.reviewPrompt}\n\n${loaded.partitionPrompt}\n\n${loaded.runnerPrompt}`
    : `${loaded.reviewPrompt}\n\n${loaded.partitionPrompt}\n\n${loaded.runnerPrompt}\n\n${loaded.evidenceRepairPrompt}`;
  return {
    partitionId,
    phase,
    modelId: config.modelId,
    maxOutputTokens: config.maxOutputTokens,
    system,
    user,
  };
}

function requestHash(request: ProviderRequest): string {
  return createHash('sha256').update(canonicalJson(request)).digest('hex');
}

export async function runPartitionReview(
  snapshot: ReviewSnapshot,
  priorLedger: ReviewLedger,
  loaded: LoadedPolicy,
  provider: ReviewProvider,
  options: { outputDirectory: string; maxSpendMicros: number; execute: boolean },
): Promise<ReviewRunResult> {
  const synthetic = provider.config.provider === 'mock';
  const outDir = path.resolve(options.outputDirectory);
  if (existsSync(outDir)) throw new Error(`Output directory ${outDir} already exists; refusing automatic rerun.`);
  const parentDirectory = path.dirname(outDir);
  if (parentDirectory !== outDir) mkdirSync(parentDirectory, { recursive: true });
  mkdirSync(outDir, { mode: 0o700 });

  const attempts: AttemptRecord[] = [];
  let uncertainCharges = false;
  const diagnostics: string[] = [];
  const writeJson = (filePath: string, value: unknown): string => {
    const resolved = path.join(outDir, filePath);
    mkdirSync(path.dirname(resolved), { recursive: true });
    writePacketFile(resolved, `${JSON.stringify(value, null, 2)}\n`);
    return resolved;
  };

  let parent: ReviewSnapshot = snapshot;
  let manifestValid = false;
  try {
    parent = validateSnapshot(structuredClone(snapshot), loaded);
    if (!parent.partitionManifest || parent.partitionScope || !parent.complete || parent.limitations.length > 0) {
      diagnostics.push('Parent snapshot must carry a partition manifest, no partition scope, and be complete with zero limitations.');
    } else {
      validatePartitionManifest(parent, loaded.policy);
      manifestValid = true;
    }
  } catch (error) {
    diagnostics.push((error as Error).message);
  }
  if (priorLedger.repository !== snapshot.identity.repository
    || priorLedger.pullRequest !== snapshot.identity.pullRequest
    || snapshot.previousHeadSha !== priorLedger.lastHeadSha) {
    diagnostics.push('Prior ledger repository/PR/head does not match snapshot identity.');
  }
  const priorIds = new Set(priorLedger.openFindings.map((finding) => finding.id));
  if (priorIds.size !== priorLedger.openFindings.length) diagnostics.push('Prior ledger contains duplicate finding IDs.');

  let config: ReturnType<typeof validateProviderConfig> | undefined;
  try {
    config = Object.freeze(validateProviderConfig(provider.config, loaded.policy.model));
  } catch (error) {
    diagnostics.push((error as Error).message);
  }
  if (provider.config.provider === 'bedrock' && options.execute !== true) {
    diagnostics.push('Bedrock execution requires execute:true.');
  }
  if (provider.config.provider === 'mock' && options.execute === true) {
    diagnostics.push('Mock provider cannot execute real calls.');
  }
  if (!Number.isSafeInteger(options.maxSpendMicros) || options.maxSpendMicros <= 0) {
    diagnostics.push('A positive explicit maxSpendMicros cap is required.');
  }

  writeJson('snapshot.json', snapshot);
  writeJson('prior-ledger.json', priorLedger);
  writeJson('provider-profile.json', {
    provider: provider.config.provider,
    modelId: provider.config.modelId,
    synthetic,
    execute: options.execute === true,
    config,
  });

  const budget = new ReviewSpendBudget(diagnostics.length === 0
    ? options.maxSpendMicros
    : (Number.isSafeInteger(options.maxSpendMicros) && options.maxSpendMicros > 0 ? options.maxSpendMicros : 0));
  const envelope: PartitionedReviewReport = {
    schemaVersion: 1,
    kind: 'partitioned-review',
    manifestDigest: parent.partitionManifest?.digest ?? '0'.repeat(64),
    reports: [],
  };

  interface PendingCall {
    request: ProviderRequest;
    requestPath: string;
    hash: string;
    countedInputTokens: number;
    reservedCostMicros: number;
    dir: string;
    reservationSettled: boolean;
  }
  const pending: PendingCall[] = [];
  const failed = { stop: false };

  if (manifestValid && diagnostics.length === 0 && config) {
    for (const partition of parent.partitionManifest?.partitions ?? []) {
      try {
        const dir = `parts/${partition.id}/review`;
        const request = buildRequest(parent, partition.id, 'review', loaded, config, priorLedger);
        const hash = requestHash(request);
        const requestPath = writeJson(`${dir}/request.json`, request);
        const counted = await provider.countTokens(request, path.join(outDir, dir));
        assertTokenFit(config, counted);
        const cost = requestCostMicros(config, counted, config.maxOutputTokens);
        budget.reserve(cost);
        pending.push({ request, requestPath, hash, countedInputTokens: counted, reservedCostMicros: cost, dir, reservationSettled: false });
      } catch (error) {
        diagnostics.push(`${partition.id}: ${(error as Error).message}`);
        failed.stop = true;
        break;
      }
    }
  }

  const releaseRemaining = (): void => {
    for (const call of pending) {
      if (call.reservationSettled) continue;
      call.reservationSettled = true;
      try {
        budget.settle(call.reservedCostMicros, 0);
      } catch {
        // Reserved accounting is already inconsistent; retain the provider-facing diagnostic.
      }
    }
  };

  const activeConfig = config;
  if (activeConfig === undefined) failed.stop = true;
  if (!failed.stop && activeConfig) {
    for (let index = 0; index < pending.length && !failed.stop; index += 1) {
      const call = pending[index];
      const record: AttemptRecord = {
        partitionId: call.request.partitionId,
        phase: 'review',
        status: 'rejected',
        requestPath: call.requestPath,
        requestHash: call.hash,
        issues: [],
        countedInputTokens: call.countedInputTokens,
        reservedCostMicros: call.reservedCostMicros,
      };
      attempts.push(record);
      writeJson(`${call.dir}/intent.json`, { requestHash: call.hash, countedInputTokens: call.countedInputTokens, reservedCostMicros: call.reservedCostMicros });
      const settleOnce = (actual: number): void => {
        if (call.reservationSettled) return;
        call.reservationSettled = true;
        budget.settle(call.reservedCostMicros, actual);
        record.settledCostMicros = actual;
      };
      try {
        const reply = await provider.invoke(call.request, path.join(outDir, call.dir));
        writeJson(`${call.dir}/response.json`, reply);
        record.responsePath = path.join(outDir, call.dir, 'response.json');
        if (typeof reply.text !== 'string' || typeof reply.stopReason !== 'string' || reply.stopReason.length === 0
          || !Number.isSafeInteger(reply.inputTokens) || !Number.isSafeInteger(reply.outputTokens)
          || reply.inputTokens < 0 || reply.outputTokens < 0
          || reply.inputTokens > call.countedInputTokens || reply.outputTokens > activeConfig.maxOutputTokens) {
          settleOnce(call.reservedCostMicros);
          uncertainCharges = true;
          record.issues.push('Provider returned invalid token usage accounting.');
          failed.stop = true;
          break;
        }
        record.usage = { inputTokens: reply.inputTokens, outputTokens: reply.outputTokens };
        settleOnce(requestCostMicros(activeConfig, reply.inputTokens, reply.outputTokens));
        if (reply.stopReason !== 'end_turn') {
          record.issues.push(`Reply terminated with stopReason ${reply.stopReason}; terminal, never repaired.`);
          failed.stop = true;
          break;
        }
        const scoped = projectPartition(parent, (parent.partitionManifest?.partitions ?? []).find((part) => part.id === call.request.partitionId)!);
        const inspection = inspectModelResponse(reply.text, scoped, priorLedger, loaded.policy);
        record.issues.push(...inspection.issues);
        if (inspection.accepted && inspection.report) {
          envelope.reports.push({ partitionId: call.request.partitionId, report: inspection.report });
          record.status = 'accepted';
          continue;
        }
        if (inspection.repairable && inspection.report) {
          const repairOutcome = await attemptRepair(parent, call.request.partitionId, inspection.report, inspection.issues, loaded, provider, budget, outDir, writeJson, attempts, activeConfig, priorLedger);
          if (repairOutcome.report) {
            envelope.reports.push({ partitionId: call.request.partitionId, report: repairOutcome.report });
          } else {
            envelope.reports.push({ partitionId: call.request.partitionId, report: inspection.report });
          }
          if (repairOutcome.uncertain) uncertainCharges = true;
          if (repairOutcome.stop) failed.stop = true;
          continue;
        }
        if (inspection.report) {
          envelope.reports.push({ partitionId: call.request.partitionId, report: inspection.report });
          failed.stop = true;
        }
        record.status = 'rejected';
      } catch (error) {
        record.status = 'failed';
        record.issues.push((error as Error).message);
        try {
          settleOnce(call.reservedCostMicros);
        } catch {
          // Already settled above; never settle twice.
        }
        uncertainCharges = true;
        failed.stop = true;
      }
    }
  }
  releaseRemaining();

  let decision: GateDecision;
  try {
    decision = evaluateReview(parent, envelope, priorLedger, loaded.policy);
  } catch (error) {
    decision = { status: 'incomplete', reasons: [`Final gate evaluation failed: ${(error as Error).message}`, ...diagnostics], ledger: structuredClone(priorLedger) };
  }
  if (diagnostics.length > 0 && decision.status !== 'incomplete') {
    decision = { status: 'incomplete', reasons: [...decision.reasons, ...diagnostics], ledger: decision.ledger };
  }
  if (decision.status === 'incomplete' && diagnostics.length > 0) {
    decision = { ...decision, reasons: [...decision.reasons, ...diagnostics.filter((reason) => !decision.reasons.includes(reason))] };
  }

  const reportFileName = synthetic ? 'mock-report.json' : 'report.json';
  const reportPath = writeJson(reportFileName, envelope);
  const executionPath = writeJson('execution.json', {
    status: decision.status,
    synthetic,
    uncertainCharges,
    diagnostics,
    attempts,
    budget: budget.snapshot(),
    partCount: parent.partitionManifest?.partitions.length ?? 0,
    reportedParts: envelope.reports.length,
  });
  return {
    synthetic,
    decision,
    report: envelope,
    reportPath,
    executionPath,
    attempts,
    budget: budget.snapshot(),
    uncertainCharges,
  };
}

interface RepairOutcome {
  report: ReviewReport | null;
  stop: boolean;
  uncertain: boolean;
}

async function attemptRepair(
  parent: ReviewSnapshot,
  partitionId: string,
  original: ReviewReport,
  issues: string[],
  loaded: LoadedPolicy,
  provider: ReviewProvider,
  budget: ReviewSpendBudget,
  outDir: string,
  writeJson: (filePath: string, value: unknown) => string,
  attempts: AttemptRecord[],
  config: ReturnType<typeof validateProviderConfig>,
  priorLedger: ReviewLedger,
): Promise<RepairOutcome> {
  const outcome: RepairOutcome = { report: null, stop: false, uncertain: false };
  const dir = `parts/${partitionId}/repair`;
  const request = buildRequest(parent, partitionId, 'repair', loaded, config, priorLedger, { originalReport: original, validationErrors: issues });
  const hash = requestHash(request);
  const requestPath = writeJson(`${dir}/request.json`, request);
  const record: AttemptRecord = {
    partitionId,
    phase: 'repair',
    status: 'failed',
    requestPath,
    requestHash: hash,
    issues: [],
  };
  attempts.push(record);
  let reserved = 0;
  let settled = false;
  const settleOnce = (actual: number): void => {
    if (settled) return;
    settled = true;
    budget.settle(reserved, actual);
    record.settledCostMicros = actual;
  };
  try {
    const counted = await provider.countTokens(request, path.join(outDir, dir));
    assertTokenFit(config, counted);
    record.countedInputTokens = counted;
    reserved = requestCostMicros(config, counted, config.maxOutputTokens);
    record.reservedCostMicros = reserved;
    budget.reserve(reserved);
    writeJson(`${dir}/intent.json`, { requestHash: hash, countedInputTokens: counted, reservedCostMicros: reserved });
    const reply = await provider.invoke(request, path.join(outDir, dir));
    writeJson(`${dir}/response.json`, reply);
    record.responsePath = path.join(outDir, dir, 'response.json');
    if (typeof reply.text !== 'string' || typeof reply.stopReason !== 'string' || reply.stopReason.length === 0
      || !Number.isSafeInteger(reply.inputTokens) || !Number.isSafeInteger(reply.outputTokens)
      || reply.inputTokens < 0 || reply.outputTokens < 0
      || reply.inputTokens > counted || reply.outputTokens > config.maxOutputTokens) {
      settleOnce(reserved);
      outcome.uncertain = true;
      outcome.stop = true;
      record.issues.push('Repair reply usage accounting invalid.');
      return outcome;
    }
    record.usage = { inputTokens: reply.inputTokens, outputTokens: reply.outputTokens };
    settleOnce(requestCostMicros(config, reply.inputTokens, reply.outputTokens));
    if (reply.stopReason !== 'end_turn') {
      outcome.stop = true;
      record.issues.push(`Repair reply ended with stopReason ${reply.stopReason}.`);
      return outcome;
    }
    const scoped = projectPartition(parent, (parent.partitionManifest?.partitions ?? []).find((part) => part.id === partitionId)!);
    const inspection = inspectModelResponse(reply.text, scoped, priorLedger, loaded.policy);
    if (!inspection.accepted || !inspection.report) {
      record.issues.push(...(inspection.issues.length > 0 ? inspection.issues : ['Repair response was not accepted.']));
      outcome.stop = true;
      return outcome;
    }
    if (!isCitationOnlyRepair(original, inspection.report)) {
      record.issues.push('Repair altered protected report fields; original report retained.');
      outcome.stop = true;
      return outcome;
    }
    outcome.report = inspection.report;
    record.status = 'accepted';
    return outcome;
  } catch (error) {
    record.issues.push((error as Error).message);
    try {
      settleOnce(reserved);
    } catch {
      // Already settled.
    }
    outcome.uncertain = true;
    outcome.stop = true;
    return outcome;
  }
}
