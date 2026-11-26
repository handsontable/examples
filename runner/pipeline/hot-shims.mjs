// Prebuilt Handsontable shadow files for the stable versions the starter and docs buckets pin.
//
// For a Handsontable release newer than HOT_LAST_KNOWN_GOOD (dep-shims.ts), the runtime shadows
// every file whose syntax the Tier-1 bundler's babel 6 cannot parse with a transpiled copy.
// Built in the browser, that means downloading the whole registry tarball (14 MB for 19.0.0) and
// transpiling on every page load, and a network-less e2e cannot do it at all. This script builds
// the same shadow files with the runtime's own code into
// `apps/authoring/public/hot-shims/<version>.json`, which the runtime fetches first.
//
// Every run rebuilds every wanted version, so a change to the blocking-syntax regex or the
// transpile step reaches the committed assets (the output is byte-identical when nothing changed),
// and deletes any version no bucket pins any more.
//
// Usage: node pipeline/hot-shims.mjs   (needs a runtime build: pnpm --filter @handsontable/demo-runtime build)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOT_SHIMS_DIR,
  buildHandsontableShims,
  handsontableNeedsScan,
} from "../packages/runtime/dist/dep-shims.js";

const RUNNER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS_EXAMPLES_DIR = path.join(RUNNER_DIR, "apps", "authoring", "public", "docs-examples");
const REGISTRY = "https://registry.npmjs.org";

/** Stable versions among `versions` whose mount would otherwise scan a tarball, ascending, unique. */
export function versionsNeedingShims(versions) {
  const wanted = new Set(versions.filter((v) => /^\d+\.\d+\.\d+$/.test(v) && handsontableNeedsScan(v)));
  return [...wanted].sort();
}

/** The `hotVersion` of every committed docs release bucket (`next` pins a nightly, never shimmed here). */
export function docsBucketVersions(docsDir = DOCS_EXAMPLES_DIR) {
  if (!fs.existsSync(docsDir)) return [];
  return fs
    .readdirSync(docsDir)
    .map((bucket) => path.join(docsDir, bucket, "manifest.json"))
    .filter((manifest) => fs.existsSync(manifest))
    .map((manifest) => JSON.parse(fs.readFileSync(manifest, "utf8")).hotVersion)
    .filter((v) => typeof v === "string");
}

/** Serialized asset: keys sorted, so a rebuild of the same tarball is byte-identical. */
export function serializeShimAsset(version, files) {
  const sorted = Object.fromEntries(Object.keys(files).sort().map((k) => [k, files[k]]));
  return `${JSON.stringify({ version, files: sorted })}\n`;
}

export async function syncHotShims({
  bucketVersions = JSON.parse(fs.readFileSync(path.join(RUNNER_DIR, "catalog.json"), "utf8")).bucketVersions,
  docsVersions = docsBucketVersions(),
  outDir = path.join(RUNNER_DIR, "apps", "authoring", "public", HOT_SHIMS_DIR),
  fetchImpl = globalThis.fetch,
  log = console.log,
} = {}) {
  const wanted = versionsNeedingShims([...Object.values(bucketVersions ?? {}), ...docsVersions]);
  fs.mkdirSync(outDir, { recursive: true });

  const removed = [];
  for (const name of fs.readdirSync(outDir)) {
    if (!wanted.includes(name.replace(/\.json$/, ""))) {
      fs.rmSync(path.join(outDir, name));
      removed.push(name);
    }
  }

  for (const version of wanted) {
    const url = `${REGISTRY}/handsontable/-/handsontable-${version}.tgz`;
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`Failed to fetch handsontable@${version} tarball: ${url} returned ${res.status}`);
    const files = await buildHandsontableShims(await res.arrayBuffer());
    fs.writeFileSync(path.join(outDir, `${version}.json`), serializeShimAsset(version, files));
    log(`[hot-shims] ${version}: ${Object.keys(files).length} files`);
  }

  if (!wanted.length) fs.rmSync(outDir, { recursive: true, force: true });
  log(`[hot-shims] built ${wanted.join(", ") || "none"}; removed ${removed.join(", ") || "none"}`);
  return { wanted, removed };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  syncHotShims().catch((error) => {
    console.error(`[hot-shims] ${error.message}`);
    process.exitCode = 1;
  });
}
