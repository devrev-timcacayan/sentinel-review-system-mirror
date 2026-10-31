export const DIMENSIONS = ['test-validity', 'reliability-impact', 'maintainability'] as const;

export type Dimension = (typeof DIMENSIONS)[number];
export type Severity = 'blocker' | 'advisory' | 'question';
export type Revision = 'base' | 'head';

export interface ReviewIdentity {
  repository: string;
  pullRequest: number;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
  policyDigest: string;
  model: string;
  runId: string;
}

export interface Change {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  previousPath?: string;
}

export interface SourceFile {
  path: string;
  revision: Revision;
  content: string;
}

export interface DependencyEdge {
  from: string;
  to: string;
}

export interface ContextPlan {
  strategy: 'symbol-aware-reverse-v1';
  selections: { path: string; reasons: string[] }[];
  fallbacks: { path: string; reason: string }[];
}

export interface SizeAssessment {
  changedLines: number;
  warnChangedLines: number;
  blockChangedLines: number;
  outcome: 'within_threshold' | 'split_recommended';
}

export interface ReviewSnapshot {
  schemaVersion: 1;
  identity: ReviewIdentity;
  previousHeadSha: string | null;
  changes: Change[];
  size: SizeAssessment;
  files: SourceFile[];
  dependencyEdges: DependencyEdge[];
  contextPlan: ContextPlan;
  cumulativeDiff: string;
  deltaDiff: string | null;
  complete: boolean;
  limitations: string[];
  partitionManifest?: PartitionManifest;
  partitionScope?: { manifestDigest: string; partitionId: string };
}

export interface ReviewPartition {
  id: string;
  sourceKeys: string[];
}

export interface PartitionManifest {
  schemaVersion: 1;
  digest: string;
  sharedSourceKeys: string[];
  partitions: ReviewPartition[];
}

export interface PartitionedReviewReport {
  schemaVersion: 1;
  kind: 'partitioned-review';
  manifestDigest: string;
  synthetic: boolean;
  reports: { partitionId: string; report: ReviewReport }[];
}

export interface Evidence {
  path: string;
  revision: Revision;
  startLine: number;
  endLine: number;
  quote: string;
}

export interface Finding {
  id: string;
  ruleId: string;
  severity: Severity;
  title: string;
  explanation: string;
  impact: string;
  introducedBy: Evidence;
  evidence: Evidence[];
  counterEvidence: string[];
}

export interface Coverage {
  path: string;
  dimension: Dimension;
  assessment: 'reviewed' | 'not_applicable' | 'blocked';
  rationale: string;
  relatedPaths: string[];
}

export interface Reconciliation {
  findingId: string;
  outcome: 'open' | 'fixed' | 'withdrawn';
  rationale: string;
  evidence: Evidence[];
}

export interface ReviewReport {
  schemaVersion: 1;
  identity: ReviewIdentity;
  partitionScope?: { manifestDigest: string; partitionId: string };
  complete: boolean;
  limitations: string[];
  coverage: Coverage[];
  findings: Finding[];
  reconciliations: Reconciliation[];
}

export interface ReviewLedger {
  schemaVersion: 1;
  repository: string;
  pullRequest: number;
  lastHeadSha: string | null;
  openFindings: Finding[];
}

export interface GateDecision {
  status: 'pass' | 'changes_required' | 'incomplete';
  reasons: string[];
  ledger: ReviewLedger;
}

export interface ReviewPolicy {
  schemaVersion: 1;
  repositories: string[];
  model: string;
  dimensions: Dimension[];
  limits: {
    maxFiles: number;
    maxSourceBytes: number;
    maxDiffBytes: number;
    warnChangedLines: number;
    blockChangedLines: number;
  };
  contextPaths: string[];
  rules: {
    id: string;
    name: string;
    blocking: string;
    exception: string;
  }[];
}
