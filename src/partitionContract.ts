import { createHash } from 'node:crypto';
import type { PartitionManifest, ReviewPartition, ReviewPolicy, ReviewSnapshot, SourceFile } from './contracts.ts';

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).filter((key): boolean => object[key] !== undefined).sort()
      .map((key): string => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function sourceKey(source: Pick<SourceFile, 'path' | 'revision'>): string {
  return `${source.revision}:${source.path}`;
}

export function computeManifestDigest(
  snapshot: ReviewSnapshot,
  manifest: Omit<PartitionManifest, 'digest'>,
): string {
  const parent = { ...snapshot, partitionManifest: undefined, partitionScope: undefined };
  return createHash('sha256').update(canonicalJson({ snapshot: parent, manifest })).digest('hex');
}

export function dependencySourceKeys(snapshot: ReviewSnapshot, rootPaths: Iterable<string>): string[] {
  const paths = new Set(rootPaths);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of snapshot.dependencyEdges) {
      if (paths.has(edge.from) && !paths.has(edge.to)) {
        paths.add(edge.to);
        changed = true;
      }
    }
  }
  const available = new Set(snapshot.files.map((file): string => file.path));
  for (const path of paths) {
    if (!available.has(path)) throw new Error(`Partition context is unavailable: ${path}`);
  }
  return snapshot.files.filter((file): boolean => paths.has(file.path)).map(sourceKey).sort();
}

export function requiredSharedSourceKeys(snapshot: ReviewSnapshot, policy: ReviewPolicy): string[] {
  const changedPaths = new Set(snapshot.changes.flatMap((change): string[] => [
    change.path, ...(change.previousPath ? [change.previousPath] : []),
  ]));
  const priorPaths = new Set(snapshot.contextPlan.selections.filter((selection): boolean =>
    selection.reasons.some((reason): boolean => reason.includes('prior-finding'))).map((selection): string => selection.path));
  const roots = snapshot.files.filter((file): boolean => changedPaths.has(file.path)
    || priorPaths.has(file.path)
    || (file.revision === 'base' && policy.contextPaths.includes(file.path))).map((file): string => file.path);
  return dependencySourceKeys(snapshot, roots);
}

function objectWithKeys(input: unknown, keys: string[]): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    && Object.keys(input).length === keys.length && keys.every((key): boolean => key in input);
}

export function validatePartitionManifest(snapshot: ReviewSnapshot, policy: ReviewPolicy): void {
  const fail = (message: string): never => { throw new Error(`Invalid partition manifest: ${message}`); };
  if (snapshot.partitionScope) fail('a partition cannot be a parent bundle');
  const manifest = snapshot.partitionManifest as PartitionManifest;
  if (!objectWithKeys(manifest, ['schemaVersion', 'digest', 'sharedSourceKeys', 'partitions'])) fail('fields');
  if (manifest.schemaVersion !== 1 || typeof manifest.digest !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.digest)) fail('version or digest');
  if (!Array.isArray(manifest.sharedSourceKeys) || !Array.isArray(manifest.partitions) || manifest.partitions.length === 0) fail('source keys or partitions');
  const keys = snapshot.files.map(sourceKey);
  const known = new Set(keys);
  if (known.size !== keys.length) fail('duplicate parent sources');
  const bytes = snapshot.files.reduce((total, file): number => total + Buffer.byteLength(file.content), 0);
  if (bytes > policy.limits.maxSourceBytes) fail('parent exceeds the total source-byte budget');
  const shared = requiredSharedSourceKeys(snapshot, policy);
  if (canonicalJson(manifest.sharedSourceKeys) !== canonicalJson(shared)) fail('shared context differs from required sources');
  const covered = new Set<string>();
  for (let index = 0; index < manifest.partitions.length; index += 1) {
    const part = manifest.partitions[index] as unknown as Record<string, unknown>;
    if (!objectWithKeys(part, ['id', 'sourceKeys'])) fail('partition fields');
    if (part.id !== `part-${String(index + 1).padStart(3, '0')}` || !Array.isArray(part.sourceKeys)) fail('partition identity or keys');
    const membership = new Set<string>(part.sourceKeys as string[]);
    if (membership.size !== (part.sourceKeys as string[]).length || membership.size === 0 || membership.size > policy.limits.maxFiles) fail('partition size or duplicate sources');
    const partBytes = snapshot.files.filter((file): boolean => membership.has(sourceKey(file)))
      .reduce((total, file): number => total + Buffer.byteLength(file.content), 0);
    if (partBytes > policy.limits.maxPartSourceBytes) fail('partition exceeds the per-part source-byte budget');
    for (const key of membership) if (typeof key !== 'string' || !known.has(key)) fail('unknown source key');
    for (const key of shared) if (!membership.has(key)) fail('missing shared context');
    const paths = snapshot.files.filter((file): boolean => membership.has(sourceKey(file))).map((file): string => file.path);
    for (const key of dependencySourceKeys(snapshot, paths)) if (!membership.has(key)) fail('partition is not dependency-closed');
    for (const key of membership) covered.add(key as string);
  }
  if (known.size !== covered.size || [...known].some((key): boolean => !covered.has(key))) fail('not all source entries are assigned');
  const expected = computeManifestDigest(snapshot, {
    schemaVersion: 1,
    sharedSourceKeys: manifest.sharedSourceKeys as string[],
    partitions: manifest.partitions as ReviewPartition[],
  });
  if (manifest.digest !== expected) fail('digest does not bind this exact snapshot and membership');
}

export function projectPartition(snapshot: ReviewSnapshot, partition: ReviewPartition): ReviewSnapshot {
  if (!snapshot.partitionManifest) throw new Error('Parent partition manifest is required.');
  const keys = new Set(partition.sourceKeys);
  const projected = structuredClone(snapshot);
  delete projected.partitionManifest;
  projected.partitionScope = { manifestDigest: snapshot.partitionManifest.digest, partitionId: partition.id };
  projected.files = projected.files.filter((file): boolean => keys.has(sourceKey(file)));
  const paths = new Set(projected.files.map((file): string => file.path));
  projected.dependencyEdges = projected.dependencyEdges.filter((edge): boolean => paths.has(edge.from) && paths.has(edge.to));
  projected.contextPlan.selections = projected.contextPlan.selections.filter((selection): boolean => paths.has(selection.path));
  projected.contextPlan.fallbacks = projected.contextPlan.fallbacks.filter((fallback): boolean => paths.has(fallback.path));
  return projected;
}
