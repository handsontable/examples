export interface DocsBucketResolution {
  selectedVersion: string;
  nextVersion: string;
  bucketKeys: Iterable<string>;
}

/**
 * Resolve a selected Handsontable version to an imported docs-example bucket.
 * Unmatched versions intentionally have no bucket; callers must not fall back
 * to `next`, whose content may target a different API.
 */
export function resolveDocsBucket({
  selectedVersion,
  nextVersion,
  bucketKeys,
}: DocsBucketResolution): string | null {
  const buckets = new Set(bucketKeys);

  if (selectedVersion === nextVersion) {
    return buckets.has("next") ? "next" : null;
  }

  const match = selectedVersion.match(/^(\d+)\.(\d+)(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/);
  if (!match) return null;

  const bucket = `${match[1]}.${match[2]}`;
  return buckets.has(bucket) ? bucket : null;
}
