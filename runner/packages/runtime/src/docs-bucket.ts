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

/** Outcome of planning a docs-example bucket for a selected version. `absent`
 *  is a normal outcome (ADR-0021 #2/#3 — most selectable versions have no
 *  imported bucket, by design), not an error: no manifest fetch should ever
 *  be attempted for it. */
export type DocsBucketOutcome =
  | { kind: "resolved"; bucket: string; suggestion: null }
  | { kind: "absent"; bucket: null; suggestion: string | null };

/** Highest *release* bucket in the set, ranked numerically (not lexically —
 *  a string sort would rank "9.0" above "18.0"). Never "next": its content
 *  targets an unreleased API, and ADR-0021 #2 forbids pointing a release
 *  selection's fallback at it. */
export function highestReleaseBucket(bucketKeys: Iterable<string>): string | null {
  let best: { major: number; minor: number; key: string } | null = null;
  for (const key of bucketKeys) {
    const match = /^(\d+)\.(\d+)$/.exec(key);
    if (!match) continue;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    if (!best || major > best.major || (major === best.major && minor > best.minor)) {
      best = { major, minor, key };
    }
  }
  return best ? best.key : null;
}

/** Resolve a selected version to a bucket outcome, and — when absent — the
 *  release bucket a visitor could switch to instead. Callers must skip the
 *  manifest fetch entirely on `absent`: fetching an unindexed bucket is what
 *  turns this by-design absence into a reported error (Sentry DEMOS-1C). */
export function planDocsBucket({
  selectedVersion,
  nextVersion,
  bucketKeys,
}: DocsBucketResolution): DocsBucketOutcome {
  const keys = Array.isArray(bucketKeys) ? bucketKeys : [...bucketKeys];
  const bucket = resolveDocsBucket({ selectedVersion, nextVersion, bucketKeys: keys });
  if (bucket) return { kind: "resolved", bucket, suggestion: null };
  return { kind: "absent", bucket: null, suggestion: highestReleaseBucket(keys) };
}

/** The visitor-facing sentence for an absent bucket. Names a version that
 *  works whenever one exists, instead of the dead end of "choose another
 *  version" with no version named. */
export function docsBucketAbsentMessage(version: string, suggestion: string | null): string {
  return suggestion
    ? `No documentation examples are available for Handsontable ${version}. They are available for Handsontable ${suggestion} — switch versions, or start from a starter template.`
    : `No documentation examples are available for Handsontable ${version}. Choose another version or a starter.`;
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
