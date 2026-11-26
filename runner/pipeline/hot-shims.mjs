// Prebuilt Handsontable shadow files for the stable versions the starter buckets pin.
//
// A Handsontable release newer than HOT_LAST_KNOWN_GOOD (dep-shims.ts) can carry syntax the
// Tier-1 bundler's babel 6 cannot parse, so the runtime shadows those files with transpiled
// copies. Built in the browser, that means downloading the whole registry tarball (14 MB for
// 19.0.0) and transpiling on every page load, and a network-less e2e cannot do it at all. This
// script builds the same shadow files once, with the runtime's own code, into
// `apps/authoring/public/hot-shims/<version>.json`, which the runtime fetches first.
//
// The directory always holds exactly the versions `catalog.json` `bucketVersions` needs: a
// version a re-pin left behind is deleted, and one already built is kept as is.
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
const REGISTRY = "https://registry.npmjs.org";

/** Stable bucket versions whose default mount would otherwise scan a tarball, ascending. */
export function versionsNeedingShims(bucketVersions) {
  const wanted = new Set(
    Object.values(bucketVersions ?? {}).filter((v) => /^\d+\.\d+\.\d+$/.test(v) && handsontableNeedsScan(v)),
  );
  return [...wanted].sort();
}

/** Serialized asset: keys sorted, so a rebuild of the same tarball is byte-identical. */
export function serializeShimAsset(version, files) {
  const sorted = Object.fromEntries(Object.keys(files).sort().map((k) => [k, files[k]]));
  return `${JSON.stringify({ version, files: sorted })}\n`;
}

export async function syncHotShims({
  bucketVersions = JSON.parse(fs.readFileSync(path.join(RUNNER_DIR, "catalog.json"), "utf8")).bucketVersions,
  outDir = path.join(RUNNER_DIR, "apps", "authoring", "public", HOT_SHIMS_DIR),
  fetchImpl = globalThis.fetch,
  log = console.log,
} = {}) {
  const wanted = versionsNeedingShims(bucketVersions);
  fs.mkdirSync(outDir, { recursive: true });

  const removed = [];
  for (const name of fs.readdirSync(outDir)) {
    if (!wanted.includes(name.replace(/\.json$/, ""))) {
      fs.rmSync(path.join(outDir, name));
      removed.push(name);
    }
  }

  const built = [];
  for (const version of wanted) {
    const file = path.join(outDir, `${version}.json`);
    if (fs.existsSync(file)) continue;
    const url = `${REGISTRY}/handsontable/-/handsontable-${version}.tgz`;
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`Failed to fetch handsontable@${version} tarball: ${url} returned ${res.status}`);
    const files = await buildHandsontableShims(await res.arrayBuffer());
    fs.writeFileSync(file, serializeShimAsset(version, files));
    built.push(version);
    log(`[hot-shims] ${version}: ${Object.keys(files).length} files`);
  }

  if (!wanted.length) fs.rmSync(outDir, { recursive: true, force: true });
  log(`[hot-shims] wanted ${wanted.join(", ") || "none"}; built ${built.join(", ") || "none"}; removed ${removed.join(", ") || "none"}`);
  return { wanted, built, removed };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  syncHotShims().catch((error) => {
    console.error(`[hot-shims] ${error.message}`);
    process.exitCode = 1;
  });
}
