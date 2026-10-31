import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import type { LoadedPolicy } from './policy.ts';
import { planReviewContext } from './contextPlanner.ts';
import { validatePartitionManifest } from './partitionContract.ts';
import type { Change, DependencyEdge, ReviewSnapshot, SizeAssessment, SourceFile } from './contracts.ts';

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.jsx', '.mjs', '.cjs'] as const;
const PROBE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.d.ts'] as const;
const INVENTORY_EXCLUDED_SEGMENTS = new Set([
  'node_modules', 'test-results', 'playwright-report', 'blob-report', 'coverage', 'dist', '.artifacts', '.worktrees', '.state',
]);
// Well-known empty tree; pins the gitattributes source so repository-controlled attributes
// (.gitattributes, core.attributesFile) cannot alter diff classification or content.
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface CollectSnapshotOptions {
  checkout: string;
  repository: string;
  pullRequest: number;
  baseRef: string;
  headRef: string;
  previousHeadRef?: string;
  runId: string;
  additionalContextPaths?: string[];
}

interface TreeEntry {
  mode: string;
  type: string;
  oid: string;
}

interface FileCandidate {
  path: string;
  revision: 'head' | 'base';
  reason: string;
}

function isSafeRepoPath(value: string): boolean {
  return value.length > 0
    && !value.startsWith('/')
    && !value.includes('\\')
    && !value.includes('\0')
    && !value.includes('\n')
    && !value.includes('\r')
    && !value.split('/').some((part: string): boolean => part === '..' || part === '.' || part === '');
}

function isForbiddenRepoPath(value: string): boolean {
  return value.split('/').some((segment: string): boolean => {
    const lower = segment.toLowerCase();
    if (lower === '.env' || lower.startsWith('.env.')) return true;
    if (['.auth', '.secrets', 'secrets', 'credentials', '.npmrc', '.netrc', 'id_rsa', 'id_ed25519', 'id_dsa', 'id_ecdsa'].includes(lower)) return true;
    return /\.(pem|key|p12|pfx|jks)$/.test(lower);
  });
}

function git(checkout: string, args: string[], input?: string | Buffer): Buffer {
  const result = spawnSync('git', ['-C', checkout, '-c', 'core.attributesFile=/dev/null', ...args], {
    input,
    maxBuffer: 512 * 1024 * 1024,
    env: { ...process.env, GIT_ATTR_SOURCE: EMPTY_TREE_SHA },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = result.stderr?.toString('utf8').trim() ?? '';
    throw new Error(`git ${args[0]} failed in ${checkout}: ${stderr || `exit ${result.status}`}`);
  }
  return result.stdout;
}

export function resolveRefToSha(checkout: string, ref: string, label: string = 'ref'): string {
  if (typeof ref !== 'string' || ref.trim().length === 0 || ref.startsWith('-')) {
    throw new Error(`Unsafe ${label} ref: ${String(ref)}`);
  }
  const out = git(checkout, ['rev-parse', '--verify', `${ref}^{commit}`]).toString('utf8').trim();
  if (!SHA_PATTERN.test(out)) throw new Error(`${label} ref ${ref} did not resolve to a commit SHA`);
  return out;
}

function listTree(checkout: string, sha: string): Map<string, TreeEntry> {
  const out = git(checkout, ['ls-tree', '-r', '-z', sha]).toString('utf8');
  const tree = new Map<string, TreeEntry>();
  for (const record of out.split('\0')) {
    if (record.length === 0) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const meta = record.slice(0, tab).split(' ');
    tree.set(record.slice(tab + 1), { mode: meta[0], type: meta[1], oid: meta[2] });
  }
  return tree;
}

function readBlobs(checkout: string, specs: string[]): Map<string, Buffer | 'missing'> {
  const results = new Map<string, Buffer | 'missing'>();
  if (specs.length === 0) return results;
  const out = git(checkout, ['cat-file', '--batch'], `${specs.join('\n')}\n`);
  let offset = 0;
  for (const spec of specs) {
    const newline = out.indexOf('\n', offset);
    if (newline < 0) throw new Error(`cat-file batch output truncated at ${spec}`);
    const header = out.slice(offset, newline).toString('utf8');
    offset = newline + 1;
    if (header === `${spec} missing`) {
      results.set(spec, 'missing');
      continue;
    }
    const parts = header.split(' ');
    const size = Number(parts[2]);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Unexpected cat-file header: ${header}`);
    results.set(spec, out.slice(offset, offset + size));
    offset += size + 1;
  }
  return results;
}

function readBlob(checkout: string, sha: string, filePath: string): Buffer | 'missing' {
  return readBlobs(checkout, [`${sha}:${filePath}`]).get(`${sha}:${filePath}`) ?? 'missing';
}

function countChangedLines(checkout: string, fromSha: string, toSha: string): number {
  const output = git(checkout, ['diff', '--numstat', '-z', '-M', '--no-ext-diff', '--no-textconv', fromSha, toSha]).toString('utf8');
  const records = output.split('\0');
  let changedLines = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length === 0) continue;
    const firstTab = record.indexOf('\t');
    const secondTab = firstTab < 0 ? -1 : record.indexOf('\t', firstTab + 1);
    if (firstTab < 0 || secondTab < 0) throw new Error(`Unexpected git numstat record: ${record}`);
    const addedText = record.slice(0, firstTab);
    const deletedText = record.slice(firstTab + 1, secondTab);
    if (addedText === '-' && deletedText === '-') {
      let headPath = record.slice(secondTab + 1);
      let basePath = headPath;
      if (secondTab === record.length - 1) {
        basePath = records[index + 1];
        headPath = records[index + 2];
        index += 2;
      }
      const headBlob = readBlob(checkout, toSha, headPath);
      const probe = headBlob === 'missing' ? readBlob(checkout, fromSha, basePath) : headBlob;
      if (probe === 'missing' || !probe.includes(0)) {
        throw new Error(
          `Preparation refused: git produced no changed-line count for ${headPath}; `
          + 'an attribute-classified or otherwise uncounted text change cannot pass the cumulative size gate.',
        );
      }
      continue;
    }
    const added = Number(addedText);
    const deleted = Number(deletedText);
    if (!Number.isSafeInteger(added) || !Number.isSafeInteger(deleted) || added < 0 || deleted < 0) {
      throw new Error(`Unexpected git numstat counts: ${addedText}/${deletedText}`);
    }
    changedLines += added + deleted;
    if (secondTab === record.length - 1) index += 2;
  }
  return changedLines;
}

function refuseUnsafeChangePaths(changes: Change[], scope: string): void {
  const offenders: string[] = [];
  for (const change of changes) {
    for (const path of [change.path, ...(change.previousPath ? [change.previousPath] : [])]) {
      if (!isSafeRepoPath(path) || isForbiddenRepoPath(path)) offenders.push(path);
    }
  }
  if (offenders.length > 0) {
    throw new Error(`Preparation refused: unsafe or secret-like changed path(s) in ${scope}: ${[...new Set(offenders)].sort().join(', ')}`);
  }
}

function parseNameStatus(output: string): Change[] {
  const records = output.split('\0').filter((record: string): boolean => record.length > 0);
  const changes: Change[] = [];
  let index = 0;
  while (index < records.length) {
    const status = records[index];
    const letter = status[0];
    if (letter === 'R' || letter === 'C') {
      const previousPath = records[index + 1];
      const path = records[index + 2];
      index += 3;
      if (letter === 'R') changes.push({ path, status: 'renamed', previousPath });
      else changes.push({ path, status: 'added', previousPath });
      continue;
    }
    const path = records[index + 1];
    index += 2;
    if (letter === 'A') changes.push({ path, status: 'added' });
    else if (letter === 'D') changes.push({ path, status: 'deleted' });
    else changes.push({ path, status: 'modified' });
  }
  return changes.sort((left: Change, right: Change): number => left.path.localeCompare(right.path));
}

function normalizeRepoPath(value: string): string | null {
  const out: string[] = [];
  for (const part of value.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

function dirOf(filePath: string): string {
  const index = filePath.lastIndexOf('/');
  return index < 0 ? '' : filePath.slice(0, index);
}

function collectSpecifiers(filePath: string, text: string): string[] {
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      if (moduleSpecifier && ts.isStringLiteralLike(moduleSpecifier)) specifiers.push(moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      if (ts.isExternalModuleReference(reference) && ts.isStringLiteralLike(reference.expression)) {
        specifiers.push(reference.expression.text);
      }
    } else if (ts.isCallExpression(node)) {
      const first = node.arguments[0];
      if (first && ts.isStringLiteralLike(first)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) specifiers.push(first.text);
        else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') specifiers.push(first.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

interface TsconfigPaths {
  baseUrl: string;
  patterns: { regex: RegExp; targets: string[] }[];
}

function loadTsconfigPaths(checkout: string, sha: string, tree: Map<string, TreeEntry>): { config: TsconfigPaths; limitation: string | null } {
  if (!tree.has('tsconfig.json')) return { config: { baseUrl: '', patterns: [] }, limitation: null };
  const blob = readBlob(checkout, sha, 'tsconfig.json');
  if (blob === 'missing') return { config: { baseUrl: '', patterns: [] }, limitation: 'tsconfig.json was listed at this revision but unreadable.' };
  const parsed = ts.parseConfigFileTextToJson('tsconfig.json', blob.toString('utf8'));
  const compilerOptions = parsed.config?.compilerOptions as Record<string, unknown> | undefined;
  const paths = compilerOptions?.paths as Record<string, unknown> | undefined;
  const patterns: { regex: RegExp; targets: string[] }[] = [];
  if (paths && typeof paths === 'object') {
    for (const [key, targets] of Object.entries(paths)) {
      if (!Array.isArray(targets)) continue;
      const escaped = key.split('*').map((part: string): string => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const regex = new RegExp(`^${escaped.join('(.*)')}$`);
      patterns.push({ regex, targets: targets.filter((target: unknown): target is string => typeof target === 'string') });
    }
  }
  const baseUrl = typeof compilerOptions?.baseUrl === 'string' ? compilerOptions.baseUrl : '.';
  let limitation: string | null = null;
  if (typeof parsed.config?.extends === 'string') {
    limitation = `tsconfig.json extends ${parsed.config.extends}; path aliases from the extended config are not resolved in this POC.`;
  }
  return { config: { baseUrl: baseUrl === '.' ? '' : baseUrl.replace(/\/$/, ''), patterns }, limitation };
}

function probeFile(stem: string, tree: Map<string, TreeEntry>): string | null {
  const candidates = [stem];
  const runtimeExtension = /(.+)(\.(?:m|c)?jsx?)$/.exec(stem);
  const stemBase = runtimeExtension ? runtimeExtension[1] : stem;
  if (runtimeExtension) {
    for (const ext of PROBE_EXTENSIONS) candidates.push(`${stemBase}${ext}`);
  } else {
    for (const ext of PROBE_EXTENSIONS) candidates.push(`${stemBase}${ext}`);
  }
  for (const ext of PROBE_EXTENSIONS) candidates.push(`${stemBase}/index${ext}`);
  for (const candidate of candidates) {
    if (!candidate) continue;
    const entry = tree.get(candidate);
    if (entry && entry.type === 'blob' && entry.mode !== '120000') return candidate;
  }
  return null;
}

function resolveSpecifier(
  specifier: string,
  importer: string,
  tree: Map<string, TreeEntry>,
  tsconfig: TsconfigPaths,
): { resolved: string | null; internal: boolean } {
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const joined = normalizeRepoPath(`${dirOf(importer)}/${specifier}`);
    if (joined === null) return { resolved: null, internal: true };
    return { resolved: probeFile(joined, tree), internal: true };
  }
  if (specifier.startsWith('/')) return { resolved: null, internal: true };
  for (const pattern of tsconfig.patterns) {
    const match = pattern.regex.exec(specifier);
    if (!match) continue;
    for (const target of pattern.targets) {
      let resolved = target;
      match.slice(1).forEach((capture: string): void => { resolved = resolved.replace('*', capture); });
      const joined = normalizeRepoPath(tsconfig.baseUrl ? `${tsconfig.baseUrl}/${resolved}` : resolved);
      if (joined === null) continue;
      const found = probeFile(joined, tree);
      if (found) return { resolved: found, internal: true };
    }
    return { resolved: null, internal: true };
  }
  return { resolved: null, internal: false };
}

function isSourceInventoryPath(filePath: string): boolean {
  if (!SOURCE_EXTENSIONS.some((ext: string): boolean => filePath.endsWith(ext))) return false;
  return !filePath.split('/').some((segment: string): boolean => INVENTORY_EXCLUDED_SEGMENTS.has(segment));
}

interface RevisionGraph {
  edges: DependencyEdge[];
  unresolved: string[];
  sources: Map<string, string>;
  resolveImport: (importer: string, specifier: string) => string | null;
}

function buildGraph(
  checkout: string,
  sha: string,
  tree: Map<string, TreeEntry>,
): RevisionGraph {
  const inventory = [...tree.keys()].filter((filePath: string): boolean => {
    const entry = tree.get(filePath);
    return entry?.type === 'blob' && entry.mode !== '120000' && isSourceInventoryPath(filePath) && !isForbiddenRepoPath(filePath);
  }).sort();
  const specs = inventory.map((filePath: string): string => `${sha}:${filePath}`);
  const blobs = readBlobs(checkout, specs);
  const { config: tsconfig } = loadTsconfigPaths(checkout, sha, tree);
  const edges: DependencyEdge[] = [];
  const unresolved: string[] = [];
  const sources = new Map<string, string>();
  for (const filePath of inventory) {
    const blob = blobs.get(`${sha}:${filePath}`);
    if (!blob || blob === 'missing' || blob.includes(0)) continue;
    const text = blob.toString('utf8');
    sources.set(filePath, text);
    for (const specifier of collectSpecifiers(filePath, text)) {
      const { resolved, internal } = resolveSpecifier(specifier, filePath, tree, tsconfig);
      if (resolved) edges.push({ from: filePath, to: resolved });
      else if (internal) unresolved.push(`${filePath} -> ${specifier}`);
    }
  }
  const resolveImport = (importer: string, specifier: string): string | null =>
    resolveSpecifier(specifier, importer, tree, tsconfig).resolved;
  return { edges, unresolved, sources, resolveImport };
}

function pickRevision(filePath: string, headTree: Map<string, TreeEntry>, baseTree: Map<string, TreeEntry>): 'head' | 'base' | null {
  if (headTree.has(filePath)) return 'head';
  if (baseTree.has(filePath)) return 'base';
  return null;
}

export function collectSnapshot(options: CollectSnapshotOptions, loaded: LoadedPolicy, mode: 'single' | 'bundle' = 'single'): ReviewSnapshot {
  const { policy, digest } = loaded;
  const limitations: string[] = [];
  if (!policy.repositories.includes(options.repository)) {
    throw new Error(`Repository ${options.repository} is outside the trusted policy allowlist.`);
  }
  if (!Number.isSafeInteger(options.pullRequest) || options.pullRequest <= 0) {
    throw new Error(`Invalid pull request number: ${options.pullRequest}`);
  }
  if (!RUN_ID_PATTERN.test(options.runId)) throw new Error(`Invalid run id: ${options.runId}`);
  for (const extra of options.additionalContextPaths ?? []) {
    if (!isSafeRepoPath(extra)) throw new Error(`Unsafe additional context path: ${extra}`);
    if (isForbiddenRepoPath(extra)) throw new Error(`Forbidden additional context path: ${extra}`);
  }
  git(options.checkout, ['rev-parse', '--git-dir']);

  const headSha = resolveRefToSha(options.checkout, options.headRef, 'head');
  const baseSha = resolveRefToSha(options.checkout, options.baseRef, 'base');
  const mergeBaseSha = git(options.checkout, ['merge-base', baseSha, headSha]).toString('utf8').trim();
  if (!SHA_PATTERN.test(mergeBaseSha)) throw new Error('merge-base did not produce a commit SHA');

  let previousHeadSha: string | null = null;
  if (options.previousHeadRef !== undefined) {
    previousHeadSha = resolveRefToSha(options.checkout, options.previousHeadRef, 'previous-head');
  }

  const nameStatus = git(options.checkout, ['diff', '--name-status', '-z', '-M', '--no-ext-diff', '--no-textconv', mergeBaseSha, headSha]).toString('utf8');
  const changes = parseNameStatus(nameStatus);
  refuseUnsafeChangePaths(changes, `cumulative diff ${mergeBaseSha}..${headSha}`);

  if (previousHeadSha !== null) {
    const deltaNameStatus = git(options.checkout, ['diff', '--name-status', '-z', '-M', '--no-ext-diff', '--no-textconv', previousHeadSha, headSha]).toString('utf8');
    refuseUnsafeChangePaths(parseNameStatus(deltaNameStatus), `previous-head delta ${previousHeadSha}..${headSha}`);
  }

  const changedLines = countChangedLines(options.checkout, mergeBaseSha, headSha);
  if (changedLines > policy.limits.blockChangedLines) {
    throw new Error(
      `Preparation refused: cumulative PR has ${changedLines} changed lines, exceeding the agreed ${policy.limits.blockChangedLines}-line limit. `
      + 'Break the change into focused, independently reviewable PRs and retry. No review packet was produced.',
    );
  }
  const size: SizeAssessment = {
    changedLines,
    warnChangedLines: policy.limits.warnChangedLines,
    blockChangedLines: policy.limits.blockChangedLines,
    outcome: changedLines > policy.limits.warnChangedLines ? 'split_recommended' : 'within_threshold',
  };

  const cumulativeDiff = git(options.checkout, ['diff', '--no-ext-diff', '--no-textconv', mergeBaseSha, headSha]).toString('utf8');
  if (Buffer.byteLength(cumulativeDiff, 'utf8') > policy.limits.maxDiffBytes) {
    limitations.push(`Cumulative diff is ${Buffer.byteLength(cumulativeDiff, 'utf8')} bytes, exceeding policy maxDiffBytes ${policy.limits.maxDiffBytes}.`);
  }

  let deltaDiff: string | null = null;
  if (previousHeadSha !== null) {
    const twoTree = git(options.checkout, ['diff', '--no-ext-diff', '--no-textconv', previousHeadSha, headSha]).toString('utf8');
    const ancestor = spawnSync('git', ['-C', options.checkout, 'merge-base', '--is-ancestor', previousHeadSha, headSha]);
    if (ancestor.status !== 0 && ancestor.status !== 1) {
      throw new Error(`git merge-base --is-ancestor failed in ${options.checkout}: ${ancestor.stderr?.toString('utf8').trim() ?? `exit ${ancestor.status}`}`);
    }
    if (ancestor.status === 0) {
      deltaDiff = twoTree;
    } else {
      deltaDiff = `# informational: previous head ${previousHeadSha} is not an ancestor of head ${headSha} (e.g. rebase); this delta is a two-tree navigation aid only.\n${twoTree}`;
    }
  }

  const headTree = listTree(options.checkout, headSha);
  const baseTree = listTree(options.checkout, mergeBaseSha);

  const headGraph = buildGraph(options.checkout, headSha, headTree);
  const baseGraph = buildGraph(options.checkout, mergeBaseSha, baseTree);
  const unresolved = [...new Set([...headGraph.unresolved, ...baseGraph.unresolved])].sort();
  if (unresolved.length > 0) {
    const shown = unresolved.slice(0, 25).join('; ');
    limitations.push(`Unresolved internal imports (${unresolved.length}): ${shown}${unresolved.length > 25 ? `; ... +${unresolved.length - 25} more` : ''}.`);
  }

  const additionalContext = [...new Set(options.additionalContextPaths ?? [])];
  const plannerResult = planReviewContext({
    revisions: [
      { sources: baseGraph.sources, edges: baseGraph.edges, resolveImport: baseGraph.resolveImport },
      { sources: headGraph.sources, edges: headGraph.edges, resolveImport: headGraph.resolveImport },
    ],
    changes,
    additionalContextPaths: additionalContext,
    policyContextPaths: policy.contextPaths,
  });
  const dependencyEdges = plannerResult.dependencyEdges;
  const { limitation: tsconfigLimitation } = loadTsconfigPaths(options.checkout, headSha, headTree);
  if (tsconfigLimitation) limitations.push(tsconfigLimitation);

  const candidates: FileCandidate[] = [];
  const seen = new Set<string>();
  const addCandidate = (path: string, revision: 'head' | 'base', reason: string): void => {
    const key = `${revision}:${path}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ path, revision, reason });
  };

  for (const change of changes) {
    if (change.status !== 'deleted') addCandidate(change.path, 'head', 'changed');
    if (change.status !== 'added') addCandidate(change.previousPath ?? change.path, 'base', 'changed-before');
  }
  for (const contextPath of policy.contextPaths) addCandidate(contextPath, 'base', 'policy-context');
  for (const contextPath of additionalContext) {
    const revision = pickRevision(contextPath, headTree, baseTree);
    if (revision === null) {
      limitations.push(`Prior-finding context path ${contextPath} is absent at head and merge base.`);
      continue;
    }
    addCandidate(contextPath, revision, 'prior-finding-context');
  }
  for (const filePath of plannerResult.selectedPaths) {
    const revision = pickRevision(filePath, headTree, baseTree);
    if (revision === null) {
      limitations.push(`Dependency graph selected ${filePath}, but it is absent at head and merge base.`);
      continue;
    }
    addCandidate(filePath, revision, 'dependency-context');
  }

  const blobSpecs = candidates
    .map((candidate: FileCandidate): string | null => {
      const tree = candidate.revision === 'head' ? headTree : baseTree;
      const entry = tree.get(candidate.path);
      if (!entry || entry.type !== 'blob' || entry.mode === '120000') return null;
      const sha = candidate.revision === 'head' ? headSha : mergeBaseSha;
      return `${sha}:${candidate.path}`;
    })
    .filter((spec: string | null): spec is string => spec !== null);
  const blobs = readBlobs(options.checkout, [...new Set(blobSpecs)]);

  const files: SourceFile[] = [];
  const omitted: string[] = [];
  let sourceBytes = 0;
  for (const candidate of candidates) {
    const tree = candidate.revision === 'head' ? headTree : baseTree;
    const sha = candidate.revision === 'head' ? headSha : mergeBaseSha;
    const entry = tree.get(candidate.path);
    if (!isSafeRepoPath(candidate.path) || isForbiddenRepoPath(candidate.path)) {
      limitations.push(`Refused unsafe or secret-like path ${candidate.path} (${candidate.reason}).`);
      continue;
    }
    if (!entry) {
      limitations.push(`Required source ${candidate.path} missing at ${candidate.revision} revision (${candidate.reason}).`);
      continue;
    }
    if (entry.type === 'commit' || entry.mode === '160000') {
      limitations.push(`Submodule ${candidate.path} not expanded (${candidate.reason}).`);
      continue;
    }
    if (entry.mode === '120000') {
      limitations.push(`Symlink ${candidate.path} not followed (${candidate.reason}).`);
      continue;
    }
    const blob = blobs.get(`${sha}:${candidate.path}`);
    if (!blob || blob === 'missing') {
      limitations.push(`Blob for ${candidate.path} unreadable at ${candidate.revision} revision (${candidate.reason}).`);
      continue;
    }
    if (blob.includes(0)) {
      limitations.push(`Binary file ${candidate.path} excluded (${candidate.reason}).`);
      continue;
    }
    if (blob.length > policy.limits.maxSourceBytes) {
      limitations.push(`File ${candidate.path} is ${blob.length} bytes, exceeding policy maxSourceBytes ${policy.limits.maxSourceBytes} (${candidate.reason}).`);
      continue;
    }
    if ((mode !== 'bundle' && files.length >= policy.limits.maxFiles) || sourceBytes + blob.length > policy.limits.maxSourceBytes) {
      omitted.push(candidate.path);
      continue;
    }
    files.push({ path: candidate.path, revision: candidate.revision, content: blob.toString('utf8') });
    sourceBytes += blob.length;
  }
  if (omitted.length > 0) {
    limitations.push(`Context budget exhausted: ${omitted.length} selected files omitted under policy limits (${omitted.slice(0, 25).join(', ')}${omitted.length > 25 ? `, ... +${omitted.length - 25} more` : ''}).`);
  }

  files.sort((left: SourceFile, right: SourceFile): number => left.path.localeCompare(right.path) || left.revision.localeCompare(right.revision));

  return {
    schemaVersion: 1,
    identity: {
      repository: options.repository,
      pullRequest: options.pullRequest,
      headSha,
      baseSha,
      mergeBaseSha,
      policyDigest: digest,
      model: policy.model,
      runId: options.runId,
    },
    previousHeadSha,
    changes,
    size,
    files,
    dependencyEdges,
    contextPlan: plannerResult.evidence,
    cumulativeDiff,
    deltaDiff,
    complete: limitations.length === 0,
    limitations,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key: string): boolean => key in value);
}

export function validateSnapshot(input: unknown, loaded: LoadedPolicy): ReviewSnapshot {
  function check(condition: boolean, reason: string): asserts condition {
    if (!condition) throw new Error(`Snapshot validation failed: ${reason}`);
  }
  check(isObject(input), 'not an object');
  check(
    hasKeys(input, [
      'schemaVersion', 'identity', 'previousHeadSha', 'changes', 'size', 'files', 'dependencyEdges', 'contextPlan',
      'cumulativeDiff', 'deltaDiff', 'complete', 'limitations',
      ...(input.partitionManifest !== undefined ? ['partitionManifest'] : []),
      ...(input.partitionScope !== undefined ? ['partitionScope'] : []),
    ]),
    'unexpected or missing top-level fields',
  );
  check(input.schemaVersion === 1, 'schemaVersion must be 1');
  const identity = input.identity;
  check(
    isObject(identity) && hasKeys(identity, ['repository', 'pullRequest', 'headSha', 'baseSha', 'mergeBaseSha', 'policyDigest', 'model', 'runId']),
    'identity fields invalid',
  );
  check(
    typeof identity.repository === 'string' && loaded.policy.repositories.includes(identity.repository),
    'repository is outside the trusted allowlist',
  );
  check(Number.isSafeInteger(identity.pullRequest) && Number(identity.pullRequest) > 0, 'pullRequest invalid');
  for (const key of ['headSha', 'baseSha', 'mergeBaseSha']) {
    check(typeof identity[key] === 'string' && SHA_PATTERN.test(identity[key] as string), `${key} must be a 40-char SHA`);
  }
  check(identity.policyDigest === loaded.digest, 'policyDigest does not match the trusted policy digest');
  check(identity.model === loaded.policy.model, 'model differs from trusted policy');
  check(typeof identity.runId === 'string' && RUN_ID_PATTERN.test(identity.runId), 'runId invalid');
  check(
    input.previousHeadSha === null || (typeof input.previousHeadSha === 'string' && SHA_PATTERN.test(input.previousHeadSha)),
    'previousHeadSha must be null or a 40-char SHA',
  );
  check(Array.isArray(input.changes), 'changes must be an array');
  const changePaths = new Set<string>();
  for (const change of input.changes as unknown[]) {
    check(isObject(change), 'change entry is not an object');
    const expected = change.previousPath !== undefined ? ['path', 'status', 'previousPath'] : ['path', 'status'];
    check(hasKeys(change, expected), 'change entry has unexpected fields');
    check(typeof change.path === 'string' && isSafeRepoPath(change.path), `unsafe change path ${String(change.path)}`);
    check(['added', 'modified', 'deleted', 'renamed'].includes(String(change.status)), 'change status invalid');
    check(
      change.previousPath === undefined || (typeof change.previousPath === 'string' && isSafeRepoPath(change.previousPath)),
      'previousPath unsafe',
    );
    check(!changePaths.has(change.path as string), `duplicate change path ${String(change.path)}`);
    changePaths.add(change.path as string);
  }
  const size = input.size;
  check(
    isObject(size) && hasKeys(size, ['changedLines', 'warnChangedLines', 'blockChangedLines', 'outcome'])
      && Number.isSafeInteger(size.changedLines) && Number(size.changedLines) >= 0
      && size.warnChangedLines === loaded.policy.limits.warnChangedLines
      && size.blockChangedLines === loaded.policy.limits.blockChangedLines
      && ['within_threshold', 'split_recommended'].includes(String(size.outcome)),
    'size assessment invalid',
  );
  const expectedOutcome = Number(size.changedLines) > loaded.policy.limits.warnChangedLines ? 'split_recommended' : 'within_threshold';
  check(size.outcome === expectedOutcome, 'size assessment outcome does not match changed-line count');
  check(Number(size.changedLines) <= loaded.policy.limits.blockChangedLines, 'changed-line count exceeds the agreed blocking threshold');
  check(Array.isArray(input.files), 'files must be an array');
  const fileKeys = new Set<string>();
  for (const file of input.files as unknown[]) {
    check(isObject(file) && hasKeys(file, ['path', 'revision', 'content']), 'file entry malformed');
    check(typeof file.path === 'string' && isSafeRepoPath(file.path), `unsafe file path ${String(file.path)}`);
    check(file.revision === 'head' || file.revision === 'base', 'file revision invalid');
    check(typeof file.content === 'string', 'file content must be a string');
    const key = `${String(file.revision)}:${String(file.path)}`;
    check(!fileKeys.has(key), `duplicate file entry ${key}`);
    fileKeys.add(key);
  }
  check(Array.isArray(input.dependencyEdges), 'dependencyEdges must be an array');
  for (const edge of input.dependencyEdges as unknown[]) {
    check(isObject(edge) && hasKeys(edge, ['from', 'to']), 'edge malformed');
    check(typeof edge.from === 'string' && isSafeRepoPath(edge.from), 'edge.from unsafe');
    check(typeof edge.to === 'string' && isSafeRepoPath(edge.to), 'edge.to unsafe');
  }
  const contextPlan = input.contextPlan;
  check(
    isObject(contextPlan) && hasKeys(contextPlan, ['strategy', 'selections', 'fallbacks']),
    'contextPlan malformed',
  );
  check(contextPlan.strategy === 'symbol-aware-reverse-v1', 'contextPlan strategy unknown');
  check(Array.isArray(contextPlan.selections), 'contextPlan.selections must be an array');
  const seenSelections = new Set<string>();
  for (const selection of contextPlan.selections as unknown[]) {
    check(isObject(selection) && hasKeys(selection, ['path', 'reasons']), 'contextPlan selection malformed');
    check(typeof selection.path === 'string' && isSafeRepoPath(selection.path), 'contextPlan selection path unsafe');
    check(
      Array.isArray(selection.reasons) && selection.reasons.length > 0
        && selection.reasons.every((reason: unknown): boolean => typeof reason === 'string' && reason.trim().length > 0),
      'contextPlan selection reasons invalid',
    );
    check(!seenSelections.has(selection.path as string), 'contextPlan duplicate selection path');
    seenSelections.add(selection.path as string);
  }
  check(Array.isArray(contextPlan.fallbacks), 'contextPlan.fallbacks must be an array');
  for (const fallback of contextPlan.fallbacks as unknown[]) {
    check(isObject(fallback) && hasKeys(fallback, ['path', 'reason']), 'contextPlan fallback malformed');
    check(typeof fallback.path === 'string' && isSafeRepoPath(fallback.path), 'contextPlan fallback path unsafe');
    check(typeof fallback.reason === 'string' && fallback.reason.trim().length > 0, 'contextPlan fallback reason invalid');
  }
  check(typeof input.cumulativeDiff === 'string', 'cumulativeDiff must be a string');
  check(input.deltaDiff === null || typeof input.deltaDiff === 'string', 'deltaDiff must be null or a string');
  check(typeof input.complete === 'boolean', 'complete must be boolean');
  check(
    Array.isArray(input.limitations) && input.limitations.every((item: unknown): boolean => typeof item === 'string'),
    'limitations must be a string array',
  );
  check(
    !(input.partitionManifest !== undefined && input.partitionScope !== undefined),
    'partitionManifest and partitionScope cannot appear together',
  );
  if (input.partitionScope !== undefined) {
    const scope = input.partitionScope;
    check(
      isObject(scope) && hasKeys(scope, ['manifestDigest', 'partitionId']),
      'partitionScope must contain exactly manifestDigest and partitionId',
    );
    check(
      typeof scope.manifestDigest === 'string' && /^[0-9a-f]{64}$/.test(scope.manifestDigest),
      'partitionScope.manifestDigest must be a lowercase 64-char hex digest',
    );
    check(
      typeof scope.partitionId === 'string' && /^part-[0-9]{3,}$/.test(scope.partitionId),
      'partitionScope.partitionId invalid',
    );
  }
  const snapshot = input as unknown as ReviewSnapshot;
  if (input.partitionManifest !== undefined) {
    try {
      validatePartitionManifest(snapshot, loaded.policy);
    } catch (error) {
      check(false, (error as Error).message);
    }
  }
  return snapshot;
}
