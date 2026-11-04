import { DIMENSIONS } from './contracts.ts';
import { evaluatePartitionedReview } from './partitionGate.ts';
import type {
  Coverage,
  Evidence,
  Finding,
  GateDecision,
  Reconciliation,
  ReviewIdentity,
  ReviewLedger,
  ReviewPolicy,
  ReviewReport,
  ReviewSnapshot,
  SizeAssessment,
} from './contracts.ts';

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key: string): boolean => key in value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown): boolean => isText(item));
}

function isSafePath(value: unknown): value is string {
  return isText(value)
    && !value.startsWith('/')
    && !value.includes('\\')
    && !value.includes('\0')
    && !value.split('/').some((part: string): boolean => part === '..' || part === '.' || part === '');
}

function isIdentity(value: unknown): value is ReviewIdentity {
  return isObject(value)
    && hasKeys(value, ['repository', 'pullRequest', 'headSha', 'baseSha', 'mergeBaseSha', 'policyDigest', 'model', 'runId'])
    && isText(value.repository)
    && Number.isSafeInteger(value.pullRequest) && Number(value.pullRequest) > 0
    && typeof value.headSha === 'string' && SHA_PATTERN.test(value.headSha)
    && typeof value.baseSha === 'string' && SHA_PATTERN.test(value.baseSha)
    && typeof value.mergeBaseSha === 'string' && SHA_PATTERN.test(value.mergeBaseSha)
    && typeof value.policyDigest === 'string' && /^[0-9a-f]{64}$/.test(value.policyDigest)
    && isText(value.model)
    && typeof value.runId === 'string' && ID_PATTERN.test(value.runId);
}

function isEvidence(value: unknown): value is Evidence {
  return isObject(value)
    && hasKeys(value, ['path', 'revision', 'startLine', 'endLine', 'quote'])
    && isSafePath(value.path)
    && (value.revision === 'head' || value.revision === 'base')
    && Number.isSafeInteger(value.startLine) && Number(value.startLine) > 0
    && Number.isSafeInteger(value.endLine) && Number(value.endLine) >= Number(value.startLine)
    && isText(value.quote);
}

export function isFinding(value: unknown): value is Finding {
  return isObject(value)
    && hasKeys(value, ['id', 'ruleId', 'severity', 'title', 'explanation', 'impact', 'introducedBy', 'evidence', 'counterEvidence'])
    && typeof value.id === 'string' && ID_PATTERN.test(value.id)
    && isText(value.ruleId)
    && ['blocker', 'advisory', 'question'].includes(String(value.severity))
    && isText(value.title) && isText(value.explanation) && isText(value.impact)
    && isEvidence(value.introducedBy)
    && Array.isArray(value.evidence) && value.evidence.length > 0 && value.evidence.every(isEvidence)
    && isStringArray(value.counterEvidence);
}

function isCoverage(value: unknown): value is Coverage {
  return isObject(value)
    && hasKeys(value, ['path', 'dimension', 'assessment', 'rationale', 'relatedPaths'])
    && isSafePath(value.path)
    && DIMENSIONS.some((dimension: string): boolean => dimension === value.dimension)
    && ['reviewed', 'not_applicable', 'blocked'].includes(String(value.assessment))
    && isText(value.rationale)
    && isStringArray(value.relatedPaths) && value.relatedPaths.every(isSafePath);
}

function isReconciliation(value: unknown): value is Reconciliation {
  return isObject(value)
    && hasKeys(value, ['findingId', 'outcome', 'rationale', 'evidence'])
    && typeof value.findingId === 'string' && ID_PATTERN.test(value.findingId)
    && ['open', 'fixed', 'withdrawn'].includes(String(value.outcome))
    && isText(value.rationale)
    && Array.isArray(value.evidence) && value.evidence.length > 0 && value.evidence.every(isEvidence);
}

function isSize(value: unknown): value is SizeAssessment {
  return isObject(value)
    && hasKeys(value, ['changedLines', 'warnChangedLines', 'blockChangedLines', 'outcome'])
    && Number.isSafeInteger(value.changedLines) && Number(value.changedLines) >= 0
    && Number.isSafeInteger(value.warnChangedLines) && Number(value.warnChangedLines) > 0
    && Number.isSafeInteger(value.blockChangedLines) && Number(value.blockChangedLines) > 0
    && ['within_threshold', 'split_recommended'].includes(String(value.outcome));
}

function isPartitionScope(value: unknown): value is { manifestDigest: string; partitionId: string } {
  return isObject(value)
    && hasKeys(value, ['manifestDigest', 'partitionId'])
    && typeof value.manifestDigest === 'string' && /^[0-9a-f]{64}$/.test(value.manifestDigest)
    && typeof value.partitionId === 'string' && /^part-[0-9]{3,}$/.test(value.partitionId);
}

export function isReport(value: unknown): value is ReviewReport {
  return isObject(value)
    && hasKeys(value, [
      'schemaVersion', 'identity', 'complete', 'limitations', 'coverage', 'findings', 'reconciliations',
      ...(value.partitionScope !== undefined ? ['partitionScope'] : []),
    ])
    && value.schemaVersion === 1
    && isIdentity(value.identity)
    && (value.partitionScope === undefined || isPartitionScope(value.partitionScope))
    && typeof value.complete === 'boolean'
    && isStringArray(value.limitations)
    && Array.isArray(value.coverage) && value.coverage.every(isCoverage)
    && Array.isArray(value.findings) && value.findings.every(isFinding)
    && Array.isArray(value.reconciliations) && value.reconciliations.every(isReconciliation);
}

function sameIdentity(left: ReviewIdentity, right: ReviewIdentity): boolean {
  return (Object.keys(left) as (keyof ReviewIdentity)[])
    .every((key: keyof ReviewIdentity): boolean => left[key] === right[key]);
}

// The single-review gate only reads these fields. Packet callers pass full ReviewSnapshot
// values; agent validation passes a verification context whose files are a locally loaded
// evidence cache, never a packet served to the model.
export type ReviewEvaluationContext = Pick<
  ReviewSnapshot,
  'identity' | 'previousHeadSha' | 'changes' | 'size' | 'files' | 'dependencyEdges' | 'complete' | 'limitations' | 'partitionScope'
>;

function evidenceExists(snapshot: ReviewEvaluationContext, evidence: Evidence): boolean {
  const source = snapshot.files.find((file): boolean => file.path === evidence.path && file.revision === evidence.revision);
  if (!source) return false;
  const lines = source.content.split('\n');
  return evidence.endLine <= lines.length
    && lines.slice(evidence.startLine - 1, evidence.endLine).join('\n') === evidence.quote;
}

function duplicateValues(values: string[]): string[] {
  return values.filter((value: string, index: number): boolean => values.indexOf(value) !== index);
}

export function evaluateReview(
  snapshot: ReviewSnapshot,
  input: unknown,
  previous: ReviewLedger,
  policy: ReviewPolicy,
): GateDecision {
  if (snapshot.partitionScope) {
    return { status: 'incomplete', reasons: ['A partition cannot independently clear a PR. Submit all reports against the parent manifest.'], ledger: structuredClone(previous) };
  }
  if (snapshot.partitionManifest) return evaluatePartitionedReview(snapshot, input, previous, policy, evaluateSingleReview);
  if (snapshot.files.length > policy.limits.maxFiles) {
    return { status: 'incomplete', reasons: ['Source entries exceed the per-packet limit without a partition manifest.'], ledger: structuredClone(previous) };
  }
  return evaluateSingleReview(snapshot, input, previous, policy);
}

export interface PartitionReportInspection {
  accepted: boolean;
  repairable: boolean;
  issues: string[];
  report: ReviewReport | null;
}

export function inspectPartitionReport(
  snapshot: ReviewSnapshot,
  input: unknown,
  previous: ReviewLedger,
  policy: ReviewPolicy,
): PartitionReportInspection {
  if (!snapshot.partitionScope || snapshot.partitionManifest) {
    return { accepted: false, repairable: false, issues: ['Inspection requires a projected partition, not a parent review.'], report: null };
  }
  const decision = evaluateSingleReview(snapshot, input, previous, policy);
  const report = isReport(input) ? input : null;
  const citationOnly = decision.reasons.length === 1
    && (/^Finding [A-Za-z0-9._-]+ has evidence absent from the captured source\.$/.test(decision.reasons[0])
      || /^Reconciliation for [A-Za-z0-9._-]+ has unavailable code evidence\.$/.test(decision.reasons[0]));
  return {
    accepted: decision.status !== 'incomplete',
    repairable: report !== null && report.complete && report.limitations.length === 0 && citationOnly,
    issues: decision.reasons,
    report,
  };
}

export function evaluateSingleReview(
  snapshot: ReviewEvaluationContext,
  input: unknown,
  previous: ReviewLedger,
  policy: ReviewPolicy,
): GateDecision {
  const invalid = (reason: string): GateDecision => ({
    status: 'incomplete',
    reasons: [reason],
    ledger: structuredClone(previous),
  });

  if (!isIdentity(snapshot.identity)) return invalid('Snapshot identity is invalid.');
  if (!isSize(snapshot.size)) return invalid('Snapshot size assessment is invalid.');
  if (snapshot.size.warnChangedLines !== policy.limits.warnChangedLines || snapshot.size.blockChangedLines !== policy.limits.blockChangedLines) {
    return invalid('Snapshot size thresholds do not match trusted policy.');
  }
  if (snapshot.size.changedLines > policy.limits.blockChangedLines) return invalid('Snapshot exceeds the agreed changed-line limit.');
  const expectedSizeOutcome = snapshot.size.changedLines > policy.limits.warnChangedLines ? 'split_recommended' : 'within_threshold';
  if (snapshot.size.outcome !== expectedSizeOutcome) return invalid('Snapshot size outcome does not match the changed-line count.');
  if (!policy.repositories.includes(snapshot.identity.repository)) return invalid('Repository is outside the POC allowlist.');
  if (snapshot.identity.model !== policy.model) return invalid('Snapshot model differs from trusted policy.');
  if (previous.repository !== snapshot.identity.repository || previous.pullRequest !== snapshot.identity.pullRequest) {
    return invalid('Prior ledger belongs to a different PR.');
  }
  if (snapshot.previousHeadSha !== previous.lastHeadSha) {
    return invalid('Snapshot was prepared against a different prior review state.');
  }
  if (duplicateValues(previous.openFindings.map((finding): string => finding.id)).length > 0) {
    return invalid('Prior ledger contains duplicate finding IDs.');
  }
  if (!isReport(input)) return invalid('Report does not match the strict review-report contract.');
  const report = input;
  if (!sameIdentity(snapshot.identity, report.identity)) return invalid('Report identity does not match this exact snapshot and run.');
  const scope = snapshot.partitionScope ?? null;
  const reportScope = report.partitionScope ?? null;
  if (scope === null && reportScope !== null) return invalid('Report carries a partition scope but the snapshot is not a partition.');
  if (scope !== null && (reportScope === null || reportScope.manifestDigest !== scope.manifestDigest || reportScope.partitionId !== scope.partitionId)) {
    return invalid('Report partition scope does not match the assigned partition manifest.');
  }

  const reasons: string[] = [];
  const add = (reason: string): void => { reasons.push(reason); };
  if (!snapshot.complete) add('Source snapshot is incomplete.');
  snapshot.limitations.forEach((limitation: string): void => add(`Snapshot limitation: ${limitation}`));
  if (!report.complete) add('Reviewer declared the review incomplete.');
  report.limitations.forEach((limitation: string): void => add(`Review limitation: ${limitation}`));

  const changedPaths = new Set(snapshot.changes.map((change): string => change.path));
  const attributedPaths = new Set(snapshot.changes.flatMap((change): string[] => [change.path, ...(change.previousPath ? [change.previousPath] : [])]));
  const sourcePaths = new Set(snapshot.files.map((file): string => file.path));
  if (duplicateValues([...snapshot.changes.map((change): string => change.path)]).length > 0) add('Snapshot has duplicate changed paths.');
  if (duplicateValues(snapshot.files.map((file): string => `${file.revision}:${file.path}`)).length > 0) add('Snapshot has duplicate source entries.');
  for (const change of snapshot.changes) {
    const revision = change.status === 'deleted' ? 'base' : 'head';
    if (!snapshot.files.some((file): boolean => file.path === change.path && file.revision === revision)) {
      add(`Missing ${revision} source for changed path ${change.path}.`);
    }
    if (change.status !== 'added') {
      const beforePath = change.previousPath ?? change.path;
      if (!snapshot.files.some((file): boolean => file.path === beforePath && file.revision === 'base')) {
        add(`Missing before source for changed path ${change.path}.`);
      }
    }
  }

  const coverageKeys = report.coverage.map((entry): string => `${entry.path}:${entry.dimension}`);
  if (duplicateValues(coverageKeys).length > 0) add('Coverage contains duplicate entries.');
  for (const entry of report.coverage) {
    if (!changedPaths.has(entry.path)) add(`Coverage references a non-changed path: ${entry.path}.`);
    if (entry.assessment === 'blocked') add(`Coverage blocked for ${entry.path}/${entry.dimension}.`);
    for (const path of entry.relatedPaths) {
      if (!sourcePaths.has(path)) add(`Coverage claims unavailable source: ${path}.`);
    }
  }
  for (const change of snapshot.changes) {
    for (const dimension of DIMENSIONS) {
      const entry = report.coverage.find((item): boolean => item.path === change.path && item.dimension === dimension);
      if (!entry) {
        add(`Missing coverage for ${change.path}/${dimension}.`);
        continue;
      }
      if (dimension !== 'reliability-impact') continue;
      const relevantPaths = new Set([change.path, ...(change.previousPath ? [change.previousPath] : [])]);
      const neighbors = new Set(snapshot.dependencyEdges.flatMap((edge): string[] => [
        ...(relevantPaths.has(edge.from) ? [edge.to] : []),
        ...(relevantPaths.has(edge.to) ? [edge.from] : []),
      ]).filter((path: string): boolean => !relevantPaths.has(path)));
      if (neighbors.size > 0 && entry.assessment !== 'reviewed') add(`Dependency impact requires review for ${change.path}.`);
      for (const neighbor of neighbors) {
        if (!entry.relatedPaths.includes(neighbor)) add(`Impact review omitted dependency/caller ${neighbor} of ${change.path}.`);
      }
    }
  }

  const findingIds = report.findings.map((finding): string => finding.id);
  if (duplicateValues(findingIds).length > 0) return invalid('Report has duplicate finding IDs.');
  const reconciliationIds = report.reconciliations.map((item): string => item.findingId);
  if (duplicateValues(reconciliationIds).length > 0) return invalid('Report has duplicate reconciliation IDs.');
  const ruleIds = new Set(policy.rules.map((rule): string => rule.id));
  for (const finding of report.findings) {
    if (!ruleIds.has(finding.ruleId) && finding.ruleId !== 'novel') return invalid(`Unknown rule: ${finding.ruleId}.`);
    if (finding.ruleId === 'novel' && finding.severity === 'blocker') return invalid('A novel concern cannot establish blocking policy.');
    if (!attributedPaths.has(finding.introducedBy.path)) return invalid(`Finding ${finding.id} is not attributed to a changed path.`);
    if (![finding.introducedBy, ...finding.evidence].every((evidence): boolean => evidenceExists(snapshot, evidence))) {
      return invalid(`Finding ${finding.id} has evidence absent from the captured source.`);
    }
  }

  const previousIds = new Set(previous.openFindings.map((finding): string => finding.id));
  for (const reconciliation of report.reconciliations) {
    if (!previousIds.has(reconciliation.findingId)) return invalid(`Reconciliation references an unknown prior finding: ${reconciliation.findingId}.`);
    if (!reconciliation.evidence.every((evidence): boolean => evidenceExists(snapshot, evidence))) {
      return invalid(`Reconciliation for ${reconciliation.findingId} has unavailable code evidence.`);
    }
    if (reconciliation.outcome !== 'open' && findingIds.includes(reconciliation.findingId)) {
      return invalid(`Finding ${reconciliation.findingId} is both open and resolved.`);
    }
  }
  for (const prior of previous.openFindings) {
    const reconciliation = report.reconciliations.find((item): boolean => item.findingId === prior.id);
    const current = report.findings.find((finding): boolean => finding.id === prior.id);
    if (current && (current.ruleId !== prior.ruleId || current.severity !== prior.severity)) {
      return invalid(`Finding ${prior.id} changed rule or severity without authorized adjudication.`);
    }
    if (!reconciliation) {
      add(`Prior finding ${prior.id} was not reconciled.`);
      continue;
    }
    if (reconciliation.outcome === 'open' && !current) add(`Open finding ${prior.id} is missing from current findings.`);
  }

  const retained = new Map(previous.openFindings.map((finding): [string, Finding] => [finding.id, finding]));
  if (reasons.length === 0) {
    for (const reconciliation of report.reconciliations) {
      if (reconciliation.outcome !== 'open') retained.delete(reconciliation.findingId);
    }
  }
  for (const finding of report.findings) retained.set(finding.id, finding);
  const ledger: ReviewLedger = {
    schemaVersion: 1,
    repository: snapshot.identity.repository,
    pullRequest: snapshot.identity.pullRequest,
    lastHeadSha: reasons.length === 0 ? snapshot.identity.headSha : previous.lastHeadSha,
    openFindings: structuredClone([...retained.values()]),
  };
  if (reasons.length > 0) return { status: 'incomplete', reasons: [...new Set(reasons)], ledger };
  const blockers = ledger.openFindings.filter((finding): boolean => finding.severity === 'blocker');
  return blockers.length > 0
    ? { status: 'changes_required', reasons: blockers.map((finding): string => `${finding.id}: ${finding.title}`), ledger }
    : { status: 'pass', reasons: [], ledger };
}
