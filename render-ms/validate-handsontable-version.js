import semver from "semver";

/**
 * Validates `handsontable-version` query param: required, non-empty, semver-valid
 * (loose parsing, same family as npm), e.g. 0.0.0-next-bc9fe3e-20260409, 17.0.1-rc2.
 *
 * @param {unknown} value - raw query value
 * @returns {{ ok: true, normalized: string } | { ok: false, message: string }}
 */
export function validateHandsontableVersionParam(value) {
  if (value === undefined || value === null) {
    return {
      ok: false,
      message:
        "handsontable-version query parameter is required and must be a valid semver string",
    };
  }
  const trimmed = String(value).trim();
  if (trimmed === "") {
    return {
      ok: false,
      message:
        "handsontable-version cannot be empty; provide a valid semver string",
    };
  }
  const normalized = semver.valid(trimmed, { loose: true });
  if (!normalized) {
    return {
      ok: false,
      message: `handsontable-version must be semver-valid; got ${JSON.stringify(trimmed)}`,
    };
  }
  return { ok: true, normalized };
}
