import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentReportSchema } from '../src/agentSchema.ts';
import type { ReviewIdentity } from '../src/contracts.ts';

const IDENTITY: ReviewIdentity = {
  repository: 'devrev/sentinel',
  pullRequest: 17,
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  mergeBaseSha: 'c'.repeat(40),
  policyDigest: 'd'.repeat(64),
  model: 'global.anthropic.claude-sonnet-5-5',
  runId: 'offline-run-1',
};

function properties(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  const object = value as Record<string, unknown>;
  assert.equal(object.type, 'object');
  assert.equal(object.additionalProperties, false);
  assert.ok(object.properties !== null && typeof object.properties === 'object' && !Array.isArray(object.properties));
  return object.properties as Record<string, unknown>;
}

function items(value: unknown): unknown {
  assert.ok(value !== null && typeof value === 'object' && 'items' in value);
  return value.items;
}

test('agent schema declares the draft-07 dialect accepted by Claude structured output', (): void => {
  assert.equal(createAgentReportSchema(IDENTITY).$schema, 'http://json-schema.org/draft-07/schema#');
});

test('agent schema requires the non-partitioned report contract and binds every identity field', (): void => {
  const schema = createAgentReportSchema(IDENTITY);
  assert.deepEqual(schema.required, [
    'schemaVersion', 'identity', 'complete', 'limitations', 'coverage', 'findings', 'reconciliations',
  ]);
  const report = properties(schema);
  assert.equal('partitionScope' in report, false);
  assert.equal('verdict' in report, false);
  assert.deepEqual(properties(report.identity), {
    repository: { type: 'string', const: 'devrev/sentinel' },
    pullRequest: { type: 'integer', const: 17 },
    headSha: { type: 'string', const: 'a'.repeat(40) },
    baseSha: { type: 'string', const: 'b'.repeat(40) },
    mergeBaseSha: { type: 'string', const: 'c'.repeat(40) },
    policyDigest: { type: 'string', const: 'd'.repeat(64) },
    model: { type: 'string', const: 'global.anthropic.claude-sonnet-5-5' },
    runId: { type: 'string', const: 'offline-run-1' },
  });
});

test('coverage, findings, reconciliations and all evidence objects reject additional fields', (): void => {
  const report = properties(createAgentReportSchema(IDENTITY));
  const coverage = properties(items(report.coverage));
  assert.deepEqual(Object.keys(coverage), ['path', 'dimension', 'assessment', 'rationale', 'relatedPaths']);
  assert.deepEqual(coverage.dimension, {
    type: 'string', enum: ['test-validity', 'reliability-impact', 'maintainability'],
  });
  const finding = properties(items(report.findings));
  assert.deepEqual(Object.keys(finding), [
    'id', 'ruleId', 'severity', 'title', 'explanation', 'impact', 'introducedBy', 'evidence', 'counterEvidence',
  ]);
  assert.deepEqual(finding.severity, { type: 'string', enum: ['blocker', 'advisory', 'question'] });
  const reconciliation = properties(items(report.reconciliations));
  assert.deepEqual(Object.keys(reconciliation), ['findingId', 'outcome', 'rationale', 'evidence']);
  assert.deepEqual(reconciliation.outcome, { type: 'string', enum: ['open', 'fixed', 'withdrawn'] });
  for (const schema of [finding.introducedBy, items(finding.evidence), items(reconciliation.evidence)]) {
    const evidence = properties(schema);
    assert.deepEqual(Object.keys(evidence), ['path', 'revision', 'startLine', 'endLine', 'quote']);
    assert.deepEqual(evidence.revision, { type: 'string', enum: ['base', 'head'] });
    assert.deepEqual(evidence.startLine, { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
    assert.deepEqual(evidence.endLine, { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
  }
});
