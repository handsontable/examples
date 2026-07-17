import fs from "node:fs";
import path from "node:path";

const RELEASE_BRANCH_RE = /^prod-docs\/(\d+)\.(\d+)$/;
const CONCRETE_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const HANDSONTABLE_REGISTRY_URL = "https://registry.npmjs.org/handsontable";

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

function assertConcreteVersion(version, source) {
  if (typeof version !== "string" || !CONCRETE_VERSION_RE.test(version)) {
    throw new Error(`${source} must be a concrete semver version; got ${JSON.stringify(version)}`);
  }
  return version;
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

  if (typeof fetchImpl !== "function") {
    throw new Error("Could not fetch npm dist-tags.next: fetch is unavailable");
  }

  let response;
  try {
    response = await fetchImpl(HANDSONTABLE_REGISTRY_URL);
  } catch (error) {
    throw new Error(`Could not fetch npm dist-tags.next: ${error.message}`);
  }
  if (!response?.ok) {
    throw new Error(`Could not fetch npm dist-tags.next: registry returned ${response?.status ?? "an error"}`);
  }

  let registry;
  try {
    registry = await response.json();
  } catch (error) {
    throw new Error(`Could not parse npm dist-tags.next response: ${error.message}`);
  }
  return assertConcreteVersion(registry?.["dist-tags"]?.next, "npm dist-tags.next");
}
