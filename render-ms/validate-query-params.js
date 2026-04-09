/**
 * Client-side validation for query params. Returns 400 responses — callers must not
 * report these failures to Slack.
 */

const EXAMPLE_DIR_PATTERN = /^[a-zA-Z0-9._-]+$/;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

function trimOrUndefined(value) {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  return s === "" ? undefined : s;
}

/**
 * @param {unknown} value
 * @returns {{ ok: true, normalized: string } | { ok: false, message: string }}
 */
export function validateExampleDirParam(value) {
  if (value === undefined || value === null) {
    return {
      ok: false,
      message:
        "example-dir query parameter is required",
    };
  }
  const trimmed = String(value).trim();
  if (trimmed === "") {
    return {
      ok: false,
      message: "example-dir cannot be empty",
    };
  }
  if (trimmed.includes("..") || trimmed.includes("/") || trimmed.includes("\\")) {
    return {
      ok: false,
      message: "example-dir must be a single path segment (no slashes or ..)",
    };
  }
  if (!EXAMPLE_DIR_PATTERN.test(trimmed)) {
    return {
      ok: false,
      message:
        "example-dir may only contain letters, digits, dots, hyphens, and underscores",
    };
  }
  return { ok: true, normalized: trimmed };
}

/**
 * @param {string} paramName - e.g. "example-branch"
 * @param {unknown} value
 * @returns {{ ok: true, normalized: string | undefined } | { ok: false, message: string }}
 */
export function validateOptionalGitRefParam(paramName, value) {
  const t = trimOrUndefined(value);
  if (t === undefined) {
    return { ok: true, normalized: undefined };
  }
  if (t.length > 256) {
    return {
      ok: false,
      message: `${paramName} is too long (max 256 characters)`,
    };
  }
  if (t.includes("..")) {
    return {
      ok: false,
      message: `${paramName} must not contain ..`,
    };
  }
  if (CONTROL_CHARS.test(t)) {
    return {
      ok: false,
      message: `${paramName} contains invalid control characters`,
    };
  }
  return { ok: true, normalized: t };
}

/**
 * @param {unknown} value
 * @returns {{ ok: true, normalized: string | undefined } | { ok: false, message: string }}
 */
export function validateOptionalHandsontableShaParam(value) {
  const t = trimOrUndefined(value);
  if (t === undefined) {
    return { ok: true, normalized: undefined };
  }
  if (!/^[0-9a-fA-F]{7,40}$/.test(t)) {
    return {
      ok: false,
      message:
        "handsontable-sha must be a git commit SHA (7–40 hexadecimal characters)",
    };
  }
  return { ok: true, normalized: t.toLowerCase() };
}

/**
 * Ensures `examples/{exampleDir}` exists as a directory on handsontable/examples.
 *
 * @param {import("octokit").Octokit} octokit
 * @param {string} exampleDir - already format-validated
 * @param {string | undefined} exampleBranch - optional ref
 * @returns {Promise<{ ok: true } | { ok: false, message: string }>}
 */
/**
 * Runs format validation for all query params except handsontable-version (handled separately).
 *
 * @param {{ exampleDir?: unknown, exampleBranch?: unknown, handsontableBranch?: unknown, handsontableSha?: unknown }} query
 * @returns {{ ok: true, normalized: { exampleDir: string, exampleBranch: string | undefined, handsontableBranch: string | undefined, handsontableSha: string | undefined } } | { ok: false, message: string }}
 */
export function validateQueryParamsSync(query) {
  const ex = validateExampleDirParam(query.exampleDir);
  if (!ex.ok) return ex;

  const eb = validateOptionalGitRefParam("example-branch", query.exampleBranch);
  if (!eb.ok) return eb;

  const hb = validateOptionalGitRefParam("handsontable-branch", query.handsontableBranch);
  if (!hb.ok) return hb;

  const hs = validateOptionalHandsontableShaParam(query.handsontableSha);
  if (!hs.ok) return hs;

  return {
    ok: true,
    normalized: {
      exampleDir: ex.normalized,
      exampleBranch: eb.normalized,
      handsontableBranch: hb.normalized,
      handsontableSha: hs.normalized,
    },
  };
}

export async function validateExampleDirExistsInRepo(octokit, exampleDir, exampleBranch) {
  const path = `examples/${exampleDir}`;
  const options = {};
  if (exampleBranch) {
    options.ref = exampleBranch;
  }
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: "handsontable",
      repo: "examples",
      path,
      ...options,
    });
    if (Array.isArray(data)) {
      return { ok: true };
    }
    if (data && data.type === "dir") {
      return { ok: true };
    }
    return {
      ok: false,
      message: `example-dir is not a directory in the examples repository: ${exampleDir}`,
    };
  } catch (error) {
    const status = error.status ?? error.response?.status;
    if (status === 404) {
      return {
        ok: false,
        message: `example-dir not found in the handsontable/examples repository: ${exampleDir}`,
      };
    }
    throw error;
  }
}
