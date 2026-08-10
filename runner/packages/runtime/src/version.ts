// Version dispatch — the package.json dependency-rewrite logic that used to live
// in the former render-ms service (validate-handsontable-version.js,
// pkg-pr-new.js), so the runner accepts the same `handsontable-version` inputs.
//
// Rule: rewrite every dependency whose package name
// contains "handsontable" EXCEPT `@handsontable/pikaday` to the requested
// version (or a pkg.pr.new URL). This pins core `handsontable` and its framework
// wrapper in lockstep. Supported Handsontable major range: 15-19.
//
// Upstream `pikaday` — which the docs Pikaday recipe uses on every docs branch
// after DEV-2180 — needs no entry here: its name does not contain "handsontable",
// so it is left alone by the rule above. The fork entry only has to outlive the
// docs-examples buckets that still import it, i.e. until every bucket has been
// re-imported from a branch carrying that change.

import semver from "semver";
import type { FilesMap, HandsontableVersionRef } from "./types.js";

export const DEFAULT_MAX_MAJOR = 19;
// Empirically verified range is 15-19 (DEV-2102 / ADR-0021 decision 10); majors
// below 15 have never been tested against current starters/wrappers and stay
// out of scope. Previously only the UI-facing GET /api/versions listing
// enforced this floor — a direct session/API call bypassing the version
// dropdown could still request an untested major like 14.
export const DEFAULT_MIN_MAJOR = 15;
const MIN_BARE_NUMERIC_PKG_PR_NEW_REF = 1000;
// Prerelease build published under the npm `next` dist-tag, e.g.
// "0.0.0-next-64139ae-20260219" (commit hash + build date). Its major is
// always 0 under plain semver parsing, so it must bypass the major-range
// check below rather than being rejected as "major must be at least 15".
const NEXT_PRERELEASE_RE = /^0\.0\.0-next-[0-9a-f]+-\d{8}$/i;

/**
 * Dependency never rewritten: an independently versioned Handsontable plugin.
 * Legacy — docs examples moved to upstream `pikaday`, which needs no exemption.
 * Removable once no bucket under apps/authoring/public/docs-examples/ imports
 * the fork (`grep -rl "@handsontable/pikaday"` there).
 */
const NEVER_REWRITE = new Set(["@handsontable/pikaday"]);

export function pkgPrNewDependencyUrl(packageName: string, buildRef: string): string {
  return `https://pkg.pr.new/${packageName}@${buildRef}`;
}

/** True for an npm `next`-dist-tag prerelease build, e.g. "0.0.0-next-<hash>-<date>". */
export function isNextPrereleaseVersion(value: string): boolean {
  return NEXT_PRERELEASE_RE.test(value);
}

/** Matches nightly (`0.0.0-next-<hash>-<date>`) and dotted (`19.0.0-next.1`) prereleases. */
const ANY_NEXT_VERSION_RE = /^\d+\.\d+\.\d+-next[.-]/;

/**
 * Newest `-next` version by npm publish date, from a registry document's
 * `time` map — or null when none exists. The `next` dist-tag is deliberately
 * not consulted: it went stale on 2026-02-19 while nightlies kept publishing,
 * silently pinning docs examples to a five-month-old build. A string or
 * semver-prerelease sort would not do either — the nightly hash sits in the
 * prerelease identifier, so an old build can sort above newer ones. (The
 * docs importer applies the same rule in pipeline/docs-import-config.mjs.)
 */
export function pickLatestNextVersion(time: Record<string, string> | undefined): string | null {
  let newest: { version: string; publishedAt: number } | null = null;
  for (const [version, published] of Object.entries(time ?? {})) {
    if (!ANY_NEXT_VERSION_RE.test(version)) continue; // skips created/modified/stable
    const publishedAt = Date.parse(published);
    if (Number.isNaN(publishedAt)) continue;
    if (!newest || publishedAt > newest.publishedAt) newest = { version, publishedAt };
  }
  return newest?.version ?? null;
}

/** Parse a full https://pkg.pr.new/...@ref URL; bare numeric ids handled in validation. */
export function parsePkgPrNewFromUrl(value: string): string | null {
  try {
    const u = new URL(String(value).trim());
    if (u.protocol !== "https:" || u.hostname !== "pkg.pr.new") return null;
    const p = u.pathname.replace(/^\//, "");
    const at = p.lastIndexOf("@");
    if (at <= 0) return null;
    const ref = p.slice(at + 1);
    return ref === "" ? null : ref;
  } catch {
    return null;
  }
}

function expandPartialNumericSemver(s: string): string | null {
  if (!/^\d+(?:\.\d+)+$/.test(s)) return null;
  const parts = s.split(".");
  if (parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
  const nums = parts.map((p) => Number.parseInt(p, 10));
  const major = nums[0] ?? 0;
  const minor = nums[1] ?? 0;
  const patch = nums[2] ?? 0;
  if (![major, minor, patch].every((n) => Number.isFinite(n) && n >= 0)) return null;
  return `${major}.${minor}.${patch}`;
}

export type ValidationResult =
  | { ok: true; value: HandsontableVersionRef }
  | { ok: false; message: string };

/**
 * Validate a `handsontable-version` input: semver (loose, npm-style partials like
 * "17.0"), a bare pkg.pr.new numeric id, or a https://pkg.pr.new/... URL. Enforces
 * major <= maxMajor for real semver.
 */
export function validateHandsontableVersion(
  value: unknown,
  maxMajor: number = DEFAULT_MAX_MAJOR,
  minMajor: number = DEFAULT_MIN_MAJOR,
): ValidationResult {
  if (value === undefined || value === null) {
    return { ok: false, message: "handsontable-version is required" };
  }
  const trimmed = String(value).trim();
  if (trimmed === "") return { ok: false, message: "handsontable-version cannot be empty" };

  const urlRef = parsePkgPrNewFromUrl(trimmed);
  if (urlRef !== null) return { ok: true, value: { ref: urlRef, pkgPrNew: true } };

  if (isNextPrereleaseVersion(trimmed)) return { ok: true, value: { ref: trimmed, pkgPrNew: false } };

  const rangeMsg = (normalized: string) => {
    const major = semver.major(normalized);
    if (major > maxMajor) return `handsontable-version major must be at most ${maxMajor}; got ${major}`;
    if (major < minMajor) return `handsontable-version major must be at least ${minMajor}; got ${major}`;
    return null;
  };

  if (/^\d+$/.test(trimmed)) {
    const n = Number.parseInt(trimmed, 10);
    if (!Number.isSafeInteger(n) || n < 0) {
      return { ok: false, message: `handsontable-version is not a valid numeric id` };
    }
    if (n > maxMajor) {
      if (n < MIN_BARE_NUMERIC_PKG_PR_NEW_REF) {
        return { ok: false, message: `handsontable-version major must be at most ${maxMajor}` };
      }
      return { ok: true, value: { ref: trimmed, pkgPrNew: true } };
    }
    const coerced = semver.coerce(trimmed);
    const normalized = coerced ? semver.valid(coerced.version, { loose: true }) : null;
    if (!normalized) return { ok: false, message: `handsontable-version could not be interpreted as semver` };
    const err = rangeMsg(normalized);
    return err ? { ok: false, message: err } : { ok: true, value: { ref: normalized, pkgPrNew: false } };
  }

  let normalized = semver.valid(trimmed, { loose: true });
  if (!normalized) {
    const expanded = expandPartialNumericSemver(trimmed);
    if (expanded) normalized = semver.valid(expanded, { loose: true });
  }
  if (!normalized) {
    return { ok: false, message: `handsontable-version must be semver-valid or a pkg.pr.new id/URL` };
  }
  const err = rangeMsg(normalized);
  return err ? { ok: false, message: err } : { ok: true, value: { ref: normalized, pkgPrNew: false } };
}

/** True if `name` is a Handsontable package that should be version-pinned. */
export function isHandsontablePackage(name: string): boolean {
  return name.includes("handsontable") && !NEVER_REWRITE.has(name);
}

/**
 * Return a new FilesMap with package.json's Handsontable deps pinned to `version`.
 * Pure: does not mutate the input. Throws if package.json is missing/unparseable.
 */
export function applyHandsontableVersion(
  files: FilesMap,
  version: HandsontableVersionRef,
  pkgPath = "/package.json",
): FilesMap {
  const raw = files[pkgPath];
  if (raw === undefined) throw new Error(`applyHandsontableVersion: ${pkgPath} not found`);

  let pkg: { dependencies?: Record<string, string>; [k: string]: unknown };
  try {
    pkg = JSON.parse(raw);
  } catch (e) {
    throw new Error(`applyHandsontableVersion: ${pkgPath} is not valid JSON: ${(e as Error).message}`);
  }

  const rewrite = (deps: Record<string, string> | undefined) => {
    if (!deps) return deps;
    return Object.fromEntries(
      Object.entries(deps).map(([name, range]) =>
        isHandsontablePackage(name)
          ? [name, version.pkgPrNew ? pkgPrNewDependencyUrl(name, version.ref) : version.ref]
          : [name, range],
      ),
    );
  };

  const next = {
    ...pkg,
    dependencies: rewrite(pkg.dependencies),
  };

  return { ...files, [pkgPath]: JSON.stringify(next, null, 2) + "\n" };
}

/**
 * Return a new FilesMap with the baked Handsontable CDN CSS URL pinned to `version`.
 * Pure: does not mutate the input. pkg.pr.new builds are not available on unpkg.
 */
export function applyHandsontableCss(
  files: FilesMap,
  version: HandsontableVersionRef,
): FilesMap {
  if (version.pkgPrNew) return files;

  const htmlPath = files["/index.html"] !== undefined
    ? "/index.html"
    : files["/src/index.html"] !== undefined
      ? "/src/index.html"
      : null;
  if (!htmlPath) return files;

  const raw = files[htmlPath];
  if (raw === undefined) return files;
  const next = raw.replace(
    /(unpkg\.com\/handsontable@)[^/]+(\/dist\/handsontable\.full\.min\.css)/g,
    (_, prefix: string, suffix: string) => `${prefix}${version.ref}${suffix}`,
  );
  return next === raw ? files : { ...files, [htmlPath]: next };
}
