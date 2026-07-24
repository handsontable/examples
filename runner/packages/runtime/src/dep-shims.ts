// DEV-2129 follow-up — dependency shims for the classic Sandpack `parcel`
// environment. The bundler's babel 6.26 parses every file it pulls into
// /node_modules, so a dependency whose published dist uses post-ES2017 syntax
// kills the sandbox at setup ("Setup failed"):
//
//   react-redux 9   optional catch binding (ES2019)
//   redux 5         ES2020 dist
//   jspdf 4         transitive fast-png uses optional chaining (ES2020)
//   @simonwep/pickr static class fields (ES2022) — no parseable version exists
//
// For each dep listed in DEP_SHIMS we fetch one self-contained dist file at
// the exact version pinned in the sandbox package.json, compile it to the
// babel 6 floor with the same babel 8 pass as example sources, and inject it
// as sandbox files under /node_modules/<pkg>/. Sandbox files shadow the
// packager's copy during module resolution, so babel 6 never sees the raw
// modern dist. The package stays in the root package.json so the packager
// still resolves its transitive deps (e.g. react-redux → use-sync-external-store).

import type { FilesMap } from "./types.js";
import { transpileDependencyDist } from "./transpile.js";

/**
 * Deps that need shimming, each with the single self-contained dist file to
 * fetch. UMD bundles (pickr, jspdf) inline their own dependencies; the redux
 * ESM dists only import peers the bundler already resolves.
 */
export const DEP_SHIMS: Record<string, { file: string }> = {
  "@simonwep/pickr": { file: "dist/pickr.min.js" },
  redux: { file: "dist/redux.mjs" },
  "react-redux": { file: "dist/react-redux.mjs" },
  jspdf: { file: "dist/jspdf.umd.min.js" },
};

const CDN = "https://unpkg.com";

/** Transpiled dist cache, keyed by `<pkg>@<version>` — shims are immutable per version. */
const shimCache = new Map<string, Promise<string>>();

function fetchAndTranspile(
  pkg: string,
  version: string,
  file: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const key = `${pkg}@${version}`;
  let cached = shimCache.get(key);
  if (!cached) {
    cached = (async () => {
      const url = `${CDN}/${key}/${file}`;
      const res = await fetchImpl(url);
      if (!res.ok) {
        throw new Error(`Failed to fetch dependency shim for ${pkg}: ${url} returned ${res.status}`);
      }
      return transpileDependencyDist(await res.text(), file);
    })();
    // A failed fetch must not poison the cache — the next mount retries.
    cached.catch(() => shimCache.delete(key));
    shimCache.set(key, cached);
  }
  return cached;
}

/**
 * Inject transpiled dist shims for every DEP_SHIMS package present in the
 * sandbox package.json. Returns the input map unchanged when nothing to shim.
 */
export async function applyDepShims(
  files: FilesMap,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<FilesMap> {
  const raw = files["/package.json"];
  if (raw === undefined) return files;
  let deps: Record<string, string>;
  try {
    deps = JSON.parse(raw).dependencies ?? {};
  } catch {
    return files;
  }

  const targets = Object.keys(DEP_SHIMS).filter((pkg) => typeof deps[pkg] === "string");
  if (!targets.length) return files;

  const fetchImpl = opts.fetchImpl ?? fetch;
  const out: FilesMap = { ...files };
  await Promise.all(
    targets.map(async (pkg) => {
      const version = deps[pkg] as string;
      const shim = DEP_SHIMS[pkg] as { file: string };
      const code = await fetchAndTranspile(pkg, version, shim.file, fetchImpl);
      out[`/node_modules/${pkg}/index.js`] = code;
      out[`/node_modules/${pkg}/package.json`] = JSON.stringify({
        name: pkg,
        version,
        main: "./index.js",
      });
    }),
  );
  return out;
}
