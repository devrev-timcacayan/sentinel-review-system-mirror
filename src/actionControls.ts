export interface ActionControls {
  // Manual dispatch carries no spend/turn caps by user decision; legacy paths
  // still require explicit positive numbers. Only these two may be null.
  maxTurns: number | null;
  maxBudgetUsd: number | null;
  timeoutMinutes: number;
  maxFiles: number;
  maxSourceBytes: number;
  maxReadBytes: number;
}

export const CLAUDE_ACTION_COMMIT = '1d6de8cb0c237e7c15e9e1bdf973826ebae490cc';
export const STATE_BRANCH = 'sentinel-review-state';

export function readActionControls(env: NodeJS.ProcessEnv, pullRequest: number): ActionControls {
  // Manual workflow_dispatch is authorized by the trusted staging workflow and
  // verified run identity, so it needs no legacy approval/verification flags;
  // every other mode still requires both. Numeric limits stay strict either way.
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch') {
    if (env.SENTINEL_REVIEW_POC_APPROVED_PR !== String(pullRequest)) {
      throw new Error('This PR is not explicitly authorized for a paid POC review.');
    }
    if (env.SENTINEL_REVIEW_CONTROLS_VERIFIED !== 'true') {
      throw new Error('Runtime tool/settings isolation and execution-trace format must be verified before activation.');
    }
  }
  const positiveInteger = (name: string): number => {
    const raw = env[name] ?? '';
    const value = Number(raw);
    if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(value)) throw new Error(`${name} must be an explicitly configured positive integer.`);
    return value;
  };
  const manual = env.GITHUB_EVENT_NAME === 'workflow_dispatch';
  const optionalPositiveInteger = (name: string): number | null => {
    const raw = env[name] ?? '';
    if (manual && raw === '') return null;
    return positiveInteger(name);
  };
  const rawBudget = env.SENTINEL_REVIEW_MAX_USD ?? '';
  const maxBudgetUsd = manual && rawBudget === '' ? null : Number(rawBudget);
  if (maxBudgetUsd !== null && (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(rawBudget) || !Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0)) {
    throw new Error('SENTINEL_REVIEW_MAX_USD must be explicitly configured and positive; it is an estimated-cost control, not an AWS billing ceiling.');
  }
  const controls = {
    maxTurns: optionalPositiveInteger('SENTINEL_REVIEW_MAX_TURNS'),
    maxBudgetUsd,
    timeoutMinutes: positiveInteger('SENTINEL_REVIEW_TIMEOUT_MINUTES'),
    maxFiles: positiveInteger('SENTINEL_REVIEW_MAX_FILES'),
    maxSourceBytes: positiveInteger('SENTINEL_REVIEW_MAX_SOURCE_BYTES'),
    maxReadBytes: positiveInteger('SENTINEL_REVIEW_MAX_READ_BYTES'),
  };
  if (!Number.isSafeInteger(controls.timeoutMinutes * 60_000)) throw new Error('Configured timeout is too large.');
  return controls;
}

export function actionClaudeArgs(controls: ActionControls, model: string, schema: unknown): string {
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  return [
    '--model', quote(model),
    ...(controls.maxTurns !== null ? ['--max-turns', String(controls.maxTurns)] : []),
    ...(controls.maxBudgetUsd !== null ? ['--max-budget-usd', String(controls.maxBudgetUsd)] : []),
    '--json-schema', quote(JSON.stringify(schema)),
    '--safe-mode',
    '--restricted',
    '--tools', quote('Read,Glob,Grep'),
    '--allowedTools', quote('Read(./review-source/**),Glob,Grep'),
    '--disallowedTools', quote('Bash,Edit,Write,NotebookEdit,Agent,Task,WebFetch,WebSearch,mcp__*'),
    '--setting-sources', 'user',
    '--permission-mode', 'dontAsk',
    '--strict-mcp-config',
    '--mcp-config', quote('{"mcpServers":{}}'),
  ].join(' ');
}

export const ACTION_SETTINGS = {
  disableAllHooks: true,
  enableAllProjectMcpServers: false,
  permissions: {
    defaultMode: 'dontAsk',
    allow: ['Read(./review-source/**)', 'Glob', 'Grep'],
    deny: ['Bash', 'Edit', 'Write', 'NotebookEdit', 'Agent', 'Task', 'WebFetch', 'WebSearch', 'mcp__*', 'Read(./.git/**)', 'Read(./review-system/**)'],
  },
};
