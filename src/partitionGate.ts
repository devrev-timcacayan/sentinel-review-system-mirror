import type { Coverage, Finding, GateDecision, Reconciliation, ReviewLedger, ReviewPolicy, ReviewReport, ReviewSnapshot } from './contracts.ts';
import { canonicalJson, projectPartition, validatePartitionManifest } from './partitionContract.ts';

type SingleReviewGate = (snapshot: ReviewSnapshot, report: unknown, previous: ReviewLedger, policy: ReviewPolicy) => GateDecision;

function hasKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key): boolean => key in value);
}

function unique<T>(items: T[]): T[] {
  return [...new Map(items.map((item): [string, T] => [canonicalJson(item), item])).values()];
}

export function evaluatePartitionedReview(
  snapshot: ReviewSnapshot,
  input: unknown,
  previous: ReviewLedger,
  policy: ReviewPolicy,
  evaluateSingle: SingleReviewGate,
): GateDecision {
  const decisions: GateDecision[] = [];
  const incomplete = (reasons: string[]): GateDecision => {
    const retained = new Map(previous.openFindings.map((finding): [string, Finding] => [finding.id, structuredClone(finding)]));
    const priorIds = new Set(retained.keys());
    const severity = { question: 0, advisory: 1, blocker: 2 };
    for (const decision of decisions) {
      for (const finding of decision.ledger.openFindings) {
        if (priorIds.has(finding.id)) continue;
        const current = retained.get(finding.id);
        if (!current || severity[finding.severity] > severity[current.severity]) retained.set(finding.id, structuredClone(finding));
      }
    }
    return {
      status: 'incomplete',
      reasons: [...new Set(reasons)],
      ledger: { ...structuredClone(previous), openFindings: [...retained.values()] },
    };
  };
  try {
    validatePartitionManifest(snapshot, policy);
  } catch (error) {
    return incomplete([error instanceof Error ? error.message : String(error)]);
  }
  const manifest = snapshot.partitionManifest!;
  if (!hasKeys(input, ['schemaVersion', 'kind', 'manifestDigest', 'reports'])
    || input.schemaVersion !== 1 || input.kind !== 'partitioned-review'
    || input.manifestDigest !== manifest.digest || !Array.isArray(input.reports)) {
    return incomplete(['Partition report envelope does not match this exact manifest.']);
  }
  const reportMap = new Map<string, unknown>();
  const expectedIds = new Set(manifest.partitions.map((partition): string => partition.id));
  for (const row of input.reports as unknown[]) {
    if (!hasKeys(row, ['partitionId', 'report']) || typeof row.partitionId !== 'string'
      || !expectedIds.has(row.partitionId) || reportMap.has(row.partitionId)) {
      return incomplete(['Partition reports contain malformed, unknown, or duplicate partition IDs.']);
    }
    reportMap.set(row.partitionId, row.report);
  }
  const missing = manifest.partitions.filter((partition): boolean => !reportMap.has(partition.id));
  const reasons = missing.map((partition): string => `Required partition ${partition.id} is missing.`);
  for (const partition of manifest.partitions) {
    if (!reportMap.has(partition.id)) continue;
    const decision = evaluateSingle(projectPartition(snapshot, partition), reportMap.get(partition.id), previous, policy);
    decisions.push(decision);
    if (decision.status === 'incomplete') reasons.push(...decision.reasons.map((reason): string => `${partition.id}: ${reason}`));
  }
  if (reasons.length > 0) return incomplete(reasons);

  const findings = new Map<string, Finding>();
  const reconciliations = new Map<string, Reconciliation>();
  const coverage = new Map<string, Coverage>();
  for (const partition of manifest.partitions) {
    // The single-review gate has now validated every nested report and its exact evidence.
    const report = reportMap.get(partition.id) as ReviewReport;
    for (const finding of report.findings) {
      const current = findings.get(finding.id);
      if (current && canonicalJson(current) !== canonicalJson(finding)) {
        reasons.push(`Conflicting partition findings for ${finding.id} require verification.`);
      } else findings.set(finding.id, structuredClone(finding));
    }
    for (const reconciliation of report.reconciliations) {
      const current = reconciliations.get(reconciliation.findingId);
      if (current && current.outcome !== reconciliation.outcome) {
        reasons.push(`Conflicting reconciliation outcomes for ${reconciliation.findingId} require verification.`);
      } else if (current) {
        current.rationale += `\n[${partition.id}] ${reconciliation.rationale}`;
        current.evidence = unique([...current.evidence, ...reconciliation.evidence]);
      } else reconciliations.set(reconciliation.findingId, structuredClone(reconciliation));
    }
    for (const item of report.coverage) {
      const key = `${item.path}:${item.dimension}`;
      const current = coverage.get(key);
      if (!current) {
        coverage.set(key, { ...structuredClone(item), rationale: `[${partition.id}] ${item.rationale}` });
        continue;
      }
      current.rationale += `\n[${partition.id}] ${item.rationale}`;
      current.relatedPaths = [...new Set([...current.relatedPaths, ...item.relatedPaths])].sort();
      if (item.assessment === 'blocked' || current.assessment === 'blocked') current.assessment = 'blocked';
      else if (item.assessment === 'reviewed') current.assessment = 'reviewed';
    }
  }
  if (reasons.length > 0) return incomplete(reasons);
  const aggregate: ReviewReport = {
    schemaVersion: 1,
    identity: structuredClone(snapshot.identity),
    complete: true,
    limitations: [],
    coverage: [...coverage.values()],
    findings: [...findings.values()],
    reconciliations: [...reconciliations.values()],
  };
  // Recheck global caller coverage and evidence after combining the partition attestations.
  return evaluateSingle(snapshot, aggregate, previous, policy);
}
