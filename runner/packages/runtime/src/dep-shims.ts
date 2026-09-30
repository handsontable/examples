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

// DEV-3162 — Handsontable ships unbundled (~900 `.js` files), and builds cut from `develop`
// carry syntax the bundler's babel 6 cannot parse: logical assignment (`??=`, `||=`, `&&=`,
// sheetsBar/sheetModel.js) and regex lookbehind / named groups (utils/cellLinks). Optional
// chaining and `??` are fine — stable 18.1.1 is full of them and previews. Only the few files
// that use the blocking constructs are shadowed, so the rest of the package stays the
// packager's copy. Stable releases up to HOT_LAST_KNOWN_GOOD are verified clean; anything newer
// or any prerelease is scanned, because `develop` reaches a stable release eventually.
const HOT_LAST_KNOWN_GOOD = [18, 1, 1] as const;
const HOT_BLOCKING_SYNTAX = /(?:\?\?|\|\||&&)=|\(\?<[=!A-Za-z_$]/;
const REGISTRY = "https://registry.npmjs.org";

/** Prerelease builds and anything newer than the last stable verified clean; ranges are left alone. */
export function handsontableNeedsScan(version: string): boolean {
  if (/^0\.0\.0-/.test(version)) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return false;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const [gMajor, gMinor, gPatch] = HOT_LAST_KNOWN_GOOD;
  if (major !== gMajor) return major > gMajor;
  if (minor !== gMinor) return minor > gMinor;
  return patch > gPatch || (patch === gPatch && version.length > m[0].length);
}

/** Minimal tar reader: the regular `.js` files outside `dist/` that `keep` accepts, by package-relative path. */
function untarJs(tar: Uint8Array, keep: (source: string) => boolean): Record<string, string> {
  const out: Record<string, string> = {};
  const dec = new TextDecoder();
  const field = (h: Uint8Array, from: number, len: number) => dec.decode(h.subarray(from, from + len)).replace(/\0.*$/s, "");
  let pendingPath: string | undefined;
  for (let off = 0; off + 512 <= tar.length; ) {
    const header = tar.subarray(off, off + 512);
    if (header[0] === 0) break;
    const size = parseInt(field(header, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    const body = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      pendingPath = /\d+ path=([^\n]+)\n/.exec(dec.decode(body))?.[1];
      continue;
    }
    if (type === "L") {
      pendingPath = dec.decode(body).replace(/\0.*$/s, "");
      continue;
    }
    const prefix = field(header, 345, 155);
    const name = pendingPath ?? (prefix ? `${prefix}/` : "") + field(header, 0, 100);
    pendingPath = undefined;
    if (type !== "0" && type !== "\0") continue;
    const rel = name.replace(/^package\//, "");
    if (!rel.endsWith(".js") || rel.startsWith("dist/")) continue;
    const source = dec.decode(body);
    if (keep(source)) out[rel] = source;
  }
  return out;
}

// One registry tarball per version: fetching ~900 files from a CDN gets throttled (unpkg's
// 429/5xx carry no CORS headers, so the browser reports a blocked fetch, not a status) or
// crawls (jsDelivr took 7-20s per file for a fresh prerelease), while the npm registry serves
// the tarball in one request with `access-control-allow-origin: *`.
const hotShimCache = new Map<string, Promise<Record<string, string>>>();

function shimHandsontable(version: string, fetchImpl: typeof fetch): Promise<Record<string, string>> {
  let cached = hotShimCache.get(version);
  if (!cached) {
    cached = (async () => {
      const url = `${REGISTRY}/handsontable/-/handsontable-${version}.tgz`;
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`Failed to fetch handsontable@${version} tarball: ${url} returned ${res.status}`);
      const gz = new Blob([await res.arrayBuffer()]).stream().pipeThrough(new DecompressionStream("gzip"));
      const blocked = untarJs(new Uint8Array(await new Response(gz).arrayBuffer()), (s) => HOT_BLOCKING_SYNTAX.test(s));
      const out: Record<string, string> = {};
      await Promise.all(
        Object.entries(blocked).map(async ([file, source]) => {
          out[file] = await transpileDependencyDist(source, file);
        }),
      );
      return out;
    })();
    // A failed download must not poison the cache — the next mount retries.
    cached.catch(() => hotShimCache.delete(version));
    hotShimCache.set(version, cached);
  }
  return cached;
}

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
  const hotVersion = deps.handsontable;
  const shimHot = typeof hotVersion === "string" && handsontableNeedsScan(hotVersion);
  if (!targets.length && !shimHot) return files;

  const fetchImpl = opts.fetchImpl ?? fetch;
  const out: FilesMap = { ...files };
  if (shimHot) {
    const tree = await shimHandsontable(hotVersion, fetchImpl);
    for (const [file, code] of Object.entries(tree)) out[`/node_modules/handsontable/${file}`] = code;
  }
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
