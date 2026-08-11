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

export interface StarterBucketResolution {
  selectedVersion: string;
  nextVersion: string;
  bucketKeys: Iterable<string>;
}

/**
 * Derive the starter bucket key a selected version would use, if available.
 * Major-only ("18"), unlike docs' major.minor: guide content changes between
 * minors, starter scaffolds don't, and per-minor keys would mean ~12 live
 * prod-examples branches instead of one per major.
 */
export function deriveStarterBucketCandidate(
  selectedVersion: string,
  nextVersion: string,
): string | null {
  // Same guard as docs: any next-dist-tag build maps to "next" — plain semver
  // parses "0.0.0-next-*" as major 0, which must never derive bucket "0".
  if (selectedVersion === nextVersion || isNextPrereleaseVersion(selectedVersion)) return "next";

  const version = parse(selectedVersion);
  return version ? String(version.major) : null;
}

/**
 * Resolve a selected Handsontable version to an imported starter bucket.
 * Same no-fallback policy as docs: an unmatched version has no bucket and the
 * caller must refuse rather than serve another major's scaffold.
 */
export function resolveStarterBucket({
  selectedVersion,
  nextVersion,
  bucketKeys,
}: StarterBucketResolution): string | null {
  const buckets = new Set(bucketKeys);
  const candidate = deriveStarterBucketCandidate(selectedVersion, nextVersion);
  return candidate && buckets.has(candidate) ? candidate : null;
}
