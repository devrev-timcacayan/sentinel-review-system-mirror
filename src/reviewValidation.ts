import type { Evidence, ReviewLedger, ReviewPolicy, ReviewReport, ReviewSnapshot } from './contracts.ts';
import { inspectPartitionReport } from './gate.ts';
import type { PartitionReportInspection } from './gate.ts';
import { canonicalJson } from './partitionContract.ts';
import { parseStrictJson } from './strictJson.ts';

export function inspectModelResponse(
  text: string,
  snapshot: ReviewSnapshot,
  previous: ReviewLedger,
  policy: ReviewPolicy,
): PartitionReportInspection {
  let parsed: unknown;
  try {
    parsed = parseStrictJson(text);
  } catch {
    return { accepted: false, repairable: false, issues: ['Response must be one strict JSON object, without fences or prose.'], report: null, citationAdjustments: [], unverifiedFindings: [] };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { accepted: false, repairable: false, issues: ['Partition response must be an object.'], report: null, citationAdjustments: [], unverifiedFindings: [] };
  }
  const object = parsed as Record<string, unknown>;
  if (Object.keys(object).length !== 2 || !('partitionId' in object) || !('report' in object)
    || object.partitionId !== snapshot.partitionScope?.partitionId) {
    return { accepted: false, repairable: false, issues: ['Response fields or assigned partition ID do not match.'], report: null, citationAdjustments: [], unverifiedFindings: [] };
  }
  return inspectPartitionReport(snapshot, object.report, previous, policy);
}

function protectedReport(report: ReviewReport): unknown {
  const protect = (evidence: Evidence): Pick<Evidence, 'path' | 'revision'> => ({
    path: evidence.path, revision: evidence.revision,
  });
  return {
    ...report,
    findings: report.findings.map((finding) => ({
      ...finding, introducedBy: protect(finding.introducedBy), evidence: finding.evidence.map(protect),
    })),
    reconciliations: report.reconciliations.map((item) => ({ ...item, evidence: item.evidence.map(protect) })),
  };
}

export function isCitationOnlyRepair(original: ReviewReport, repaired: ReviewReport): boolean {
  return canonicalJson(protectedReport(original)) === canonicalJson(protectedReport(repaired));
}
