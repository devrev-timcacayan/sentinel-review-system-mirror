import type { PartitionManifest, ReviewPolicy, ReviewSnapshot } from './contracts.ts';
import {
  computeManifestDigest,
  dependencySourceKeys,
  requiredSharedSourceKeys,
  sourceKey,
  validatePartitionManifest,
} from './partitionContract.ts';

function fail(message: string): never {
  throw new Error(`Partition preparation incomplete: ${message}`);
}

export function buildReviewBundle(snapshot: ReviewSnapshot, policy: ReviewPolicy): ReviewSnapshot {
  if (snapshot.partitionScope) {
    fail('a projected partition cannot be expanded into a bundle.');
  }
  if (snapshot.partitionManifest) {
    fail('snapshot already carries a partition manifest.');
  }
  if (!snapshot.complete || snapshot.limitations.length > 0) {
    fail(`parent snapshot is incomplete (${snapshot.limitations.join('; ') || 'no recorded reasons'}).`);
  }
  const totalBytes = snapshot.files.reduce((total: number, file): number => total + Buffer.byteLength(file.content), 0);
  if (totalBytes > policy.limits.maxSourceBytes) {
    fail(`parent source entries total ${totalBytes} bytes, exceeding the ${policy.limits.maxSourceBytes}-byte budget.`);
  }

  const keyBytes = new Map<string, number>(snapshot.files.map((file): [string, number] => [sourceKey(file), Buffer.byteLength(file.content)]));
  const sumBytes = (keys: Iterable<string>): number => {
    let total = 0;
    for (const key of keys) total += keyBytes.get(key) ?? 0;
    return total;
  };

  const shared = requiredSharedSourceKeys(snapshot, policy);
  if (shared.length > policy.limits.maxFiles) {
    fail(`required shared context is ${shared.length} source entries, exceeding maxFiles ${policy.limits.maxFiles}.`);
  }
  const sharedBytes = sumBytes(shared);
  if (sharedBytes > policy.limits.maxPartSourceBytes) {
    fail(`required shared context is ${sharedBytes} bytes, exceeding maxPartSourceBytes ${policy.limits.maxPartSourceBytes}.`);
  }

  const rootPaths = [...new Set(snapshot.files.map((file): string => file.path))].sort();
  const sharedSet = new Set(shared);
  const units = rootPaths.map((rootPath: string): { rootPath: string; keys: Set<string> } => {
    let keys: Set<string>;
    try {
      keys = new Set([...sharedSet, ...dependencySourceKeys(snapshot, [rootPath])]);
    } catch (error) {
      fail(`context root ${rootPath} cannot be closed: ${(error as Error).message}`);
    }
    if (keys.size > policy.limits.maxFiles) {
      fail(`context root ${rootPath} requires ${keys.size} source entries, exceeding maxFiles ${policy.limits.maxFiles}.`);
    }
    const unitBytes = sumBytes(keys);
    if (unitBytes > policy.limits.maxPartSourceBytes) {
      fail(`context root ${rootPath} requires ${unitBytes} source bytes, exceeding maxPartSourceBytes ${policy.limits.maxPartSourceBytes}.`);
    }
    return { rootPath, keys: keys as Set<string> };
  });

  const partitions: { id: string; sourceKeys: string[] }[] = [];
  let current = new Set(shared);
  let currentBytes = sharedBytes;
  const covered = new Set<string>();
  const flush = (): void => {
    partitions.push({
      id: `part-${String(partitions.length + 1).padStart(3, '0')}`,
      sourceKeys: [...current].sort(),
    });
    for (const key of current) covered.add(key);
    current = new Set(shared);
    currentBytes = sharedBytes;
  };
  for (const unit of units) {
    if ([...unit.keys].every((key: string): boolean => covered.has(key) || current.has(key))) continue;
    const newKeys = [...unit.keys].filter((key: string): boolean => !current.has(key));
    if (current.size + newKeys.length > policy.limits.maxFiles || currentBytes + sumBytes(newKeys) > policy.limits.maxPartSourceBytes) flush();
    for (const key of unit.keys) {
      if (!current.has(key)) {
        current.add(key);
        currentBytes += keyBytes.get(key) ?? 0;
      }
    }
  }
  if (current.size > 0 || partitions.length === 0) flush();

  const manifest: Omit<PartitionManifest, 'digest'> = {
    schemaVersion: 1,
    sharedSourceKeys: [...sharedSet].sort(),
    partitions,
  };
  const parent = structuredClone(snapshot);
  const digest = computeManifestDigest(parent, manifest);
  parent.partitionManifest = { ...manifest, digest };
  try {
    validatePartitionManifest(parent, policy);
  } catch (error) {
    fail(`assembled manifest failed validation: ${(error as Error).message}`);
  }
  return parent;
}
