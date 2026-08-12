// Starter-bucket import configuration (DEV-2213). The docs pipeline derives
// its bucket from an external branch name (normalizeDocsBranch); starter
// buckets are addressed directly by key — the branch-or-master seam lives in
// the CI matrix, not here.

import {
  assertConcreteVersion,
  resolveLatestNextVersion,
  resolveNpmPackageVersion,
} from "./docs-import-config.mjs";

const NPM_REGISTRY_URL = "https://registry.npmjs.org";
const STARTER_BUCKET_RE = /^(?:\d+|next)$/;
const STABLE_VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/** Bucket keys are major-only ("15".."18") plus "next" — see docs-bucket.ts. */
export function assertStarterBucket(value) {
  if (typeof value !== "string" || !STARTER_BUCKET_RE.test(value)) {
    throw new Error(
      `--bucket is required and must be a Handsontable major ("18") or "next"; got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * Latest stable Handsontable release of one major, straight from the registry
 * versions map. Refuses a major with no stable release — a premature bucket
 * (e.g. 19 before 19.0.0 ships) must fail generation, not emit an empty or
 * mis-pinned snapshot.
 */
export async function resolveLatestStableOfMajor({ major, fetchImpl = globalThis.fetch }) {
  const source = `npm handsontable latest stable of major ${major}`;
  if (typeof fetchImpl !== "function") {
    throw new Error(`Could not fetch ${source}: fetch is unavailable`);
  }

  let registry;
  try {
    const response = await fetchImpl(`${NPM_REGISTRY_URL}/handsontable`);
    if (!response?.ok) {
      throw new Error(`registry returned ${response?.status ?? "an error"}`);
    }
    registry = await response.json();
  } catch (error) {
    throw new Error(`Could not resolve ${source}: ${error.message}`);
  }

  let newest = null;
  for (const version of Object.keys(registry?.versions ?? {})) {
    const match = version.match(STABLE_VERSION_RE);
    if (!match || Number(match[1]) !== major) continue;
    const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (
      !newest ||
      parts[1] > newest.parts[1] ||
      (parts[1] === newest.parts[1] && parts[2] > newest.parts[2])
    ) {
      newest = { version, parts };
    }
  }
  if (!newest) {
    throw new Error(`Could not resolve ${source}: no stable release of major ${major} in the registry`);
  }
  return assertConcreteVersion(newest.version, source);
}

/** Concrete Handsontable version a starter bucket pins its artifacts to. */
export async function resolveStarterHotVersion({ bucket, fetchImpl = globalThis.fetch }) {
  assertStarterBucket(bucket);
  return bucket === "next"
    ? resolveLatestNextVersion({ fetchImpl })
    : resolveLatestStableOfMajor({ major: Number(bucket), fetchImpl });
}

/** Major of npm dist-tags.latest — the upper bound of the release bucket set. */
export async function resolveLatestStableMajor({ fetchImpl = globalThis.fetch } = {}) {
  const latest = await resolveNpmPackageVersion({ packageName: "handsontable", fetchImpl });
  return Number(latest.split(".")[0]);
}
