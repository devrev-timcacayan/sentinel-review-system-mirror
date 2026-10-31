import type { PartitionManifest, ReviewPolicy, ReviewSnapshot } from './contracts.ts';
import {
  computeManifestDigest,
  dependencySourceKeys,
  requiredSharedSourceKeys,
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

  const shared = requiredSharedSourceKeys(snapshot, policy);
  if (shared.length > policy.limits.maxFiles) {
    fail(`required shared context is ${shared.length} source entries, exceeding maxFiles ${policy.limits.maxFiles}.`);
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
    return { rootPath, keys: keys as Set<string> };
  });

  const partitions: { id: string; sourceKeys: string[] }[] = [];
  let current = new Set(shared);
  const covered = new Set<string>();
  const flush = (): void => {
    partitions.push({
      id: `part-${String(partitions.length + 1).padStart(3, '0')}`,
      sourceKeys: [...current].sort(),
    });
    for (const key of current) covered.add(key);
    current = new Set(shared);
  };
  for (const unit of units) {
    if ([...unit.keys].every((key: string): boolean => covered.has(key) || current.has(key))) continue;
    if (current.size + [...unit.keys].filter((key: string): boolean => !current.has(key)).length > policy.limits.maxFiles) flush();
    for (const key of unit.keys) current.add(key);
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
