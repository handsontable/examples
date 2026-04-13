import semver from "semver";
import { parsePkgPrNewBuildRef } from "./pkg-pr-new.js";

/**
 * Validates `handsontable-version` query param: required, non-empty, and either
 * semver-valid (loose, npm-style) or a pkg.pr.new preview ref (numeric id or full URL).
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
  const pkgRef = parsePkgPrNewBuildRef(trimmed);
  if (pkgRef !== null) {
    return { ok: true, normalized: pkgRef, pkgPrNew: true };
  }
  const normalized = semver.valid(trimmed, { loose: true });
  if (!normalized) {
    return {
      ok: false,
      message: `handsontable-version must be semver-valid or a pkg.pr.new id/URL; got ${JSON.stringify(trimmed)}`,
    };
  }
  return { ok: true, normalized, pkgPrNew: false };
}
