import type { ReviewIdentity } from './contracts.ts';

export function createAgentReportSchema(identity: ReviewIdentity): Record<string, unknown> {
  const text = { type: 'string', minLength: 1, pattern: '\\S' };
  const texts = { type: 'array', items: text };
  const object = (properties: Record<string, unknown>): Record<string, unknown> => ({
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  });
  const evidence = object({
    path: text,
    revision: { type: 'string', enum: ['base', 'head'] },
    startLine: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    endLine: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    quote: text,
  });
  const evidenceList = { type: 'array', minItems: 1, items: evidence };
  const id = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$' };
  const boundIdentity = object({
    repository: { type: 'string', const: identity.repository },
    pullRequest: { type: 'integer', const: identity.pullRequest },
    headSha: { type: 'string', const: identity.headSha },
    baseSha: { type: 'string', const: identity.baseSha },
    mergeBaseSha: { type: 'string', const: identity.mergeBaseSha },
    policyDigest: { type: 'string', const: identity.policyDigest },
    model: { type: 'string', const: identity.model },
    runId: { type: 'string', const: identity.runId },
  });
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    ...object({
      schemaVersion: { type: 'integer', const: 1 },
      identity: boundIdentity,
      complete: { type: 'boolean' },
      limitations: texts,
      coverage: {
        type: 'array',
        items: object({
          path: text,
          dimension: { type: 'string', enum: ['test-validity', 'reliability-impact', 'maintainability'] },
          assessment: { type: 'string', enum: ['reviewed', 'not_applicable', 'blocked'] },
          rationale: text,
          relatedPaths: texts,
        }),
      },
      findings: {
        type: 'array',
        items: object({
          id,
          ruleId: text,
          severity: { type: 'string', enum: ['blocker', 'advisory', 'question'] },
          title: text,
          explanation: text,
          impact: text,
          introducedBy: evidence,
          evidence: evidenceList,
          counterEvidence: texts,
        }),
      },
      reconciliations: {
        type: 'array',
        items: object({
          findingId: id,
          outcome: { type: 'string', enum: ['open', 'fixed', 'withdrawn'] },
          rationale: text,
          evidence: evidenceList,
        }),
      },
    }),
  };
}
