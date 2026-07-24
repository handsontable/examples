import fs from "node:fs";
import path from "node:path";

const RELEASE_BRANCH_RE = /^prod-docs\/(\d+)\.(\d+)$/;
const CONCRETE_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const NPM_REGISTRY_URL = "https://registry.npmjs.org";

export function normalizeDocsBranch(value) {
  if (value === "develop") {
    return { docsBranch: "develop", bucket: "next" };
  }

  const match = typeof value === "string" ? value.match(RELEASE_BRANCH_RE) : null;
  if (match) {
    return { docsBranch: value, bucket: `${match[1]}.${match[2]}` };
  }

  throw new Error(
    "--docs-branch is required and must be develop or prod-docs/<major.minor>",
  );
}

export function assertConcreteVersion(version, source) {
  if (typeof version !== "string" || !CONCRETE_VERSION_RE.test(version)) {
    throw new Error(`${source} must be a concrete semver version; got ${JSON.stringify(version)}`);
  }
  return version;
}

export async function resolveNpmPackageVersion({
  packageName,
  distTag = "latest",
  fetchImpl = globalThis.fetch,
}) {
  const source = `npm ${packageName} dist-tags.${distTag}`;
  if (typeof fetchImpl !== "function") {
    throw new Error(`Could not fetch ${source}: fetch is unavailable`);
  }

  let response;
  try {
    response = await fetchImpl(`${NPM_REGISTRY_URL}/${encodeURIComponent(packageName)}`);
  } catch (error) {
    throw new Error(`Could not fetch ${source}: ${error.message}`);
  }
  if (!response?.ok) {
    throw new Error(`Could not fetch ${source}: registry returned ${response?.status ?? "an error"}`);
  }

  let registry;
  try {
    registry = await response.json();
  } catch (error) {
    throw new Error(`Could not parse ${source} response: ${error.message}`);
  }
  return assertConcreteVersion(registry?.["dist-tags"]?.[distTag], source);
}

// Matches nightly (`0.0.0-next-<hash>-<date>`) and dotted (`19.0.0-next.1`)
// prerelease versions.
const NEXT_VERSION_RE = /^\d+\.\d+\.\d+-next[.-]/;

/**
 * Newest `-next` Handsontable version by npm publish date. The `next`
 * dist-tag is deliberately not consulted: it went stale on 2026-02-19 while
 * nightlies kept publishing daily, silently pinning every docs example to a
 * five-month-old build (getPlugin('notification') === undefined).
 */
export async function resolveLatestNextVersion({ fetchImpl = globalThis.fetch } = {}) {
  const source = "npm handsontable next version by publish date";
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
  for (const [version, published] of Object.entries(registry?.time ?? {})) {
    if (!NEXT_VERSION_RE.test(version)) continue; // skips created/modified/stable
    const publishedAt = Date.parse(published);
    if (Number.isNaN(publishedAt)) continue;
    if (!newest || publishedAt > newest.publishedAt) newest = { version, publishedAt };
  }
  if (!newest) {
    throw new Error(`Could not resolve ${source}: no -next versions in the registry time map`);
  }
  return assertConcreteVersion(newest.version, source);
}

export async function resolveDocsHotVersion({
  docsBranch,
  docsDir,
  readFile = fs.readFileSync,
  fetchImpl = globalThis.fetch,
}) {
  if (docsBranch !== "develop") {
    const packagePath = path.join(docsDir, "..", "handsontable", "package.json");
    let packageJson;
    try {
      packageJson = JSON.parse(readFile(packagePath, "utf8"));
    } catch (error) {
      throw new Error(
        `Could not read Handsontable package version from ${packagePath}: ${error.message}`,
      );
    }
    return assertConcreteVersion(packageJson.version, `${packagePath} version`);
  }

  return resolveLatestNextVersion({ fetchImpl });
}
