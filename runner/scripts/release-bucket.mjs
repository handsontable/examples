/**
 * The newest release bucket in `catalog.json` `bucketVersions`: the major key with the highest
 * number whose version is a stable release. That is the bucket a bare visit defaults to, so it is
 * the one worth baking into the container image and warming. `next` never qualifies. Same
 * answer as the runtime's `stableBucketVersions` (packages/runtime/src/version.ts), kept
 * dependency-free because prepare-container runs before the runtime is built.
 */
export function newestReleaseBucket(bucketVersions) {
  const majors = Object.entries(bucketVersions ?? {})
    .filter(([bucket, version]) => /^\d+$/.test(bucket) && /^\d+\.\d+\.\d+$/.test(String(version)))
    .map(([bucket]) => Number(bucket));
  if (!majors.length) {
    throw new Error(`bucketVersions holds no release bucket: ${JSON.stringify(bucketVersions)}`);
  }
  return String(Math.max(...majors));
}
