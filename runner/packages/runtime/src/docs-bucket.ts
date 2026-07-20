import { parse } from "semver";
import { isNextPrereleaseVersion } from "./version.js";

export interface DocsBucketResolution {
  selectedVersion: string;
  nextVersion: string;
  bucketKeys: Iterable<string>;
}

/** Derive the docs bucket key a selected version would use, if available. */
export function deriveDocsBucketCandidate(
  selectedVersion: string,
  nextVersion: string,
): string | null {
  // Any next-dist-tag build (not just whichever hash is currently live)
  // shares the same "next" docs content — the API's dist-tags.next pointer
  // moves with every publish, so a stricter equality check would send an
  // older-but-still-unreleased next build down the semver-major=0 path.
  if (selectedVersion === nextVersion || isNextPrereleaseVersion(selectedVersion)) return "next";

  const version = parse(selectedVersion);
  return version ? `${version.major}.${version.minor}` : null;
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
  const candidate = deriveDocsBucketCandidate(selectedVersion, nextVersion);
  return candidate && buckets.has(candidate) ? candidate : null;
}
