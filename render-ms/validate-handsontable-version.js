import semver from "semver";
import { parsePkgPrNewFromUrl } from "./pkg-pr-new.js";

function readMaxMajor() {
  const raw = process.env.HANDSONTABLE_MAX_MAJOR ?? "19";
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    return 19;
  }
  return Math.min(n, 999);
}

const MAX_MAJOR = readMaxMajor();

/** Bare numeric ids below this (when > max major) are rejected as invalid semver, not pkg.pr.new. */
const MIN_BARE_NUMERIC_PKG_PR_NEW_REF = 1000;

/**
 * npm-style partial versions like `17.0` or `16.1` (not accepted by semver.valid alone).
 * @param {string} s
 * @returns {string | null} full `M.m.p` semver or null
 */
function expandPartialNumericSemver(s) {
  if (!/^\d+(?:\.\d+)+$/.test(s)) {
    return null;
  }
  const parts = s.split(".");
  if (parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) {
    return null;
  }
  const major = Number.parseInt(parts[0], 10);
  const minor = parts.length > 1 ? Number.parseInt(parts[1], 10) : 0;
  const patch = parts.length > 2 ? Number.parseInt(parts[2], 10) : 0;
  if (
    !Number.isFinite(major) ||
    !Number.isFinite(minor) ||
    !Number.isFinite(patch) ||
    major < 0 ||
    minor < 0 ||
    patch < 0
  ) {
    return null;
  }
  return `${major}.${minor}.${patch}`;
}

function majorWithinCap(normalizedSemver) {
  const major = semver.major(normalizedSemver);
  if (major > MAX_MAJOR) {
    return {
      ok: false,
      message: `handsontable-version major must be at most ${MAX_MAJOR}; got ${major} (${JSON.stringify(normalizedSemver)})`,
    };
  }
  return { ok: true };
}

/**
 * Validates `handsontable-version` query param: required, non-empty, and either
 * semver-valid (loose, npm-style) with major ≤ HANDSONTABLE_MAX_MAJOR (default 19),
 * or a pkg.pr.new preview (full URL, or bare digits ≥ MIN_BARE_NUMERIC_PKG_PR_NEW_REF when > max major).
 *
 * @param {unknown} value - raw query value
 * @returns {{ ok: true, normalized: string, pkgPrNew: boolean } | { ok: false, message: string }}
 */
export function validateHandsontableVersionParam(value) {
  if (value === undefined || value === null) {
    return {
      ok: false,
      message:
        "handsontable-version is required: use a semver version, a pkg.pr.new build id (digits), or a https://pkg.pr.new/... URL",
    };
  }
  const trimmed = String(value).trim();
  if (trimmed === "") {
    return {
      ok: false,
      message:
        "handsontable-version cannot be empty; provide semver, a pkg.pr.new id, or URL",
    };
  }

  const urlRef = parsePkgPrNewFromUrl(trimmed);
  if (urlRef !== null) {
    return { ok: true, normalized: urlRef, pkgPrNew: true };
  }

  if (/^\d+$/.test(trimmed)) {
    const n = Number.parseInt(trimmed, 10);
    if (!Number.isSafeInteger(n) || n < 0) {
      return {
        ok: false,
        message: `handsontable-version is not a valid numeric id; got ${JSON.stringify(trimmed)}`,
      };
    }
    if (n > MAX_MAJOR) {
      if (n < MIN_BARE_NUMERIC_PKG_PR_NEW_REF) {
        return {
          ok: false,
          message: `handsontable-version major must be at most ${MAX_MAJOR}; got ${n} (${JSON.stringify(trimmed)})`,
        };
      }
      return { ok: true, normalized: trimmed, pkgPrNew: true };
    }
    const coerced = semver.coerce(trimmed);
    const normalized = coerced
      ? semver.valid(coerced.version, { loose: true })
      : null;
    if (!normalized) {
      return {
        ok: false,
        message: `handsontable-version could not be interpreted as semver; got ${JSON.stringify(trimmed)}`,
      };
    }
    const cap = majorWithinCap(normalized);
    if (!cap.ok) {
      return cap;
    }
    return { ok: true, normalized, pkgPrNew: false };
  }

  let normalized = semver.valid(trimmed, { loose: true });
  if (!normalized) {
    const expanded = expandPartialNumericSemver(trimmed);
    if (expanded) {
      normalized = semver.valid(expanded, { loose: true });
    }
  }
  if (!normalized) {
    return {
      ok: false,
      message: `handsontable-version must be semver-valid or a pkg.pr.new id/URL; got ${JSON.stringify(trimmed)}`,
    };
  }
  const cap = majorWithinCap(normalized);
  if (!cap.ok) {
    return cap;
  }
  return { ok: true, normalized, pkgPrNew: false };
}
