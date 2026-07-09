// Version dispatch — ported from render-ms (validate-handsontable-version.js,
// pkg-pr-new.js) and its package.json dependency rewrite, so the new system
// accepts exactly the same `handsontable-version` inputs the old deep links used.
//
// Rule (identical to render-ms): rewrite every dependency whose package name
// contains "handsontable" EXCEPT `@handsontable/pikaday` to the requested
// version (or a pkg.pr.new URL). This pins core `handsontable` and its framework
// wrapper in lockstep. Supported Handsontable major range: 15-19.

import semver from "semver";
import type { FilesMap, HandsontableVersionRef } from "./types.js";

export const DEFAULT_MAX_MAJOR = 19;
const MIN_BARE_NUMERIC_PKG_PR_NEW_REF = 1000;

/** Dependency never rewritten: an independently versioned Handsontable plugin. */
const NEVER_REWRITE = new Set(["@handsontable/pikaday"]);

export function pkgPrNewDependencyUrl(packageName: string, buildRef: string): string {
  return `https://pkg.pr.new/${packageName}@${buildRef}`;
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
): ValidationResult {
  if (value === undefined || value === null) {
    return { ok: false, message: "handsontable-version is required" };
  }
  const trimmed = String(value).trim();
  if (trimmed === "") return { ok: false, message: "handsontable-version cannot be empty" };

  const urlRef = parsePkgPrNewFromUrl(trimmed);
  if (urlRef !== null) return { ok: true, value: { ref: urlRef, pkgPrNew: true } };

  const capMsg = (normalized: string) => {
    const major = semver.major(normalized);
    return major > maxMajor
      ? `handsontable-version major must be at most ${maxMajor}; got ${major}`
      : null;
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
    const err = capMsg(normalized);
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
  const err = capMsg(normalized);
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
