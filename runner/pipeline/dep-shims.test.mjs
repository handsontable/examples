import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { Parser } from "acorn";
import { applyDepShims, DEP_SHIMS, handsontableNeedsScan, isPkgPrNewHandsontable } from "../packages/runtime/dist/dep-shims.js";

// DEV-2129 follow-up: the parcel bundler's babel 6 also parses dependency
// files under /node_modules, so any dep whose published dist uses post-ES2017
// syntax kills the sandbox at setup (react-redux 9 `catch {}`, jspdf 4's
// fast-png `?.`, pickr's static class fields). For each dep in DEP_SHIMS we
// fetch its self-contained dist at the exact pinned version, run it through
// the same babel 8 pre-transpile as example sources, and inject the result as
// sandbox files under /node_modules/<pkg>/ — sandbox files shadow the
// packager's copy, so babel 6 never sees the raw modern dist.

function filesWithDeps(deps) {
  return {
    "/package.json": JSON.stringify({ name: "x", dependencies: deps }),
    "/index.js": "export default 1;\n",
  };
}

const MODERN_SRC =
  "export function read(o) {\n" +
  "  try { return o?.a ?? 'z'; } catch {}\n" +
  "}\n";

test("injects a transpiled dist and a package.json override for a configured dep", async () => {
  const fetched = [];
  const fetchImpl = async (url) => {
    fetched.push(url);
    return { ok: true, text: async () => MODERN_SRC };
  };
  const out = await applyDepShims(filesWithDeps({ "react-redux": "9.3.1-test1" }), { fetchImpl });

  assert.equal(fetched.length, 1);
  assert.match(fetched[0], /^https:\/\/unpkg\.com\/react-redux@9\.3\.1-test1\//, "exact pinned version fetched");
  assert.match(fetched[0], new RegExp(DEP_SHIMS["react-redux"].file.replace(/\./g, "\\.") + "$"));

  const shim = out["/node_modules/react-redux/index.js"];
  assert.ok(shim, "shim file injected");
  assert.ok(!/\?\./.test(shim), "optional chaining downleveled");
  assert.ok(!/\?\?/.test(shim), "nullish coalescing downleveled");
  assert.ok(!/catch\s*\{/.test(shim), "optional catch binding downleveled");

  const pkg = JSON.parse(out["/node_modules/react-redux/package.json"]);
  assert.equal(pkg.name, "react-redux");
  assert.equal(pkg.version, "9.3.1-test1");
  assert.equal(pkg.main, "./index.js");
});

test("leaves deps without a shim config untouched", async () => {
  const fetchImpl = async () => {
    throw new Error("must not fetch");
  };
  const files = filesWithDeps({ hyperformula: "3.3.0", moment: "2.30.1" });
  const out = await applyDepShims(files, { fetchImpl });
  assert.deepEqual(out, files);
});

test("returns files unchanged when there is no package.json", async () => {
  const files = { "/index.js": "export default 1;\n" };
  const out = await applyDepShims(files, { fetchImpl: async () => ({ ok: true, text: async () => "" }) });
  assert.deepEqual(out, files);
});

test("caches the transpiled dist per package version", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: true, text: async () => MODERN_SRC };
  };
  await applyDepShims(filesWithDeps({ redux: "5.9.9-test-cache" }), { fetchImpl });
  await applyDepShims(filesWithDeps({ redux: "5.9.9-test-cache" }), { fetchImpl });
  assert.equal(calls, 1, "same version fetched once");
  await applyDepShims(filesWithDeps({ redux: "5.9.8-test-cache" }), { fetchImpl });
  assert.equal(calls, 2, "different version fetched again");
});

test("preserves top-level `this` in UMD (script) dists", async () => {
  // jspdf/pickr ship UMD bundles whose factory dispatches on top-level `this`.
  // Compiling them as ES modules would rewrite `this` to undefined at the top
  // level; sourceType must be detected per file.
  const umd = "(function (g) { g.X = (g.X ?? 0) + 1; })(typeof self !== 'undefined' ? self : this);\n";
  const fetchImpl = async () => ({ ok: true, text: async () => umd });
  const out = await applyDepShims(filesWithDeps({ jspdf: "4.9.9-test-umd" }), { fetchImpl });
  const shim = out["/node_modules/jspdf/index.js"];
  assert.match(shim, /this/, "top-level this survives");
  assert.ok(!/\?\?/.test(shim), "still downleveled");
});

test("turns regex literals babel 6 cannot parse into RegExp constructor calls", async () => {
  // The bundler's babel 6 runs regexpu over `u`-flag literals and its parser has no
  // lookbehind or named groups ("Expected atom at position 16"); a string never reaches it.
  const src = "export const a = /(?<![a-z])b/u;\nexport const n = /(?<year>\\d{4})/;\nexport const plain = /x+/g;\n";
  const fetchImpl = async () => ({ ok: true, text: async () => src });
  const out = await applyDepShims(filesWithDeps({ redux: "5.9.9-test-regex" }), { fetchImpl });
  const shim = out["/node_modules/redux/index.js"];
  assert.ok(!/\/\(\?<[!=a-z]/.test(shim), "no lookbehind/named-group literal left");
  assert.match(shim, /new RegExp\("\(\?<!\[a-z\]\)b","u"\)/, "lookbehind kept verbatim in a string");
  assert.match(shim, /new RegExp\("\(\?<year>/, "named group converted");
  assert.match(shim, /\/x\+\/g/, "ordinary literals untouched");
  assert.ok(new Function(`${shim.replace(/export const (\w+)/g, "globalThis.$1")}; return [a.test("1b"), a.test("ab"), n.exec("2026").groups.year]`)().join() === "true,false,2026");
});

test("rejects with the package name when the dist fetch fails", async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, text: async () => "" });
  await assert.rejects(
    applyDepShims(filesWithDeps({ "@simonwep/pickr": "1.10.1-test-404" }), { fetchImpl }),
    /@simonwep\/pickr/,
  );
});

// DEV-3162: prerelease handsontable ships `??=` / `??` / `?.` across the whole
// package (sheetsBar/sheetModel.js, shortcuts/manager.js), so the babel 6
// bundler died on `/share` while the Vite build behind `/d` was fine. The shim
// downloads the version's registry tarball and shadows only the files that use a
// construct babel 6 cannot parse (`??=`/`||=`/`&&=`, regex lookbehind, named groups)
// with their downleveled copy. `??` and `?.` are fine: stable 18.1.1 is full of them.

/** Minimal ustar writer: enough for the reader in dep-shims to prove it parses real tarballs. */
function tar(entries) {
  const blocks = [];
  for (const [name, body] of Object.entries(entries)) {
    const data = Buffer.from(body);
    const header = Buffer.alloc(512);
    // Split long names across the ustar prefix field the way `npm pack` does.
    let prefix = "";
    let rest = name;
    if (name.length > 100) {
      const cut = name.lastIndexOf("/", 100);
      prefix = name.slice(0, cut);
      rest = name.slice(cut + 1);
    }
    header.write(rest, 0);
    header.write("0000644\0", 100);
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write("0", 156);
    header.write("ustar\0" + "00", 257);
    header.write(prefix, 345);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

const tgz = (tree) =>
  gzipSync(tar({ "package/package.json": "{}", "package/dist/handsontable.js": "var x = 1 ?? 2;", ...Object.fromEntries(Object.entries(tree).map(([k, v]) => [`package/${k}`, v])) }));

const tarballUrl = (version) => `https://registry.npmjs.org/handsontable/-/handsontable-${version}.tgz`;

/** fetch stub serving `tree` as the version's tarball; `requested` records every URL. */
function tarballFetch(version, tree, requested = []) {
  return async (url) => {
    requested.push(url);
    if (url !== tarballUrl(version)) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const buf = tgz(tree);
    return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  };
}

const HOT_VERSION = "0.0.0-next-test3162-20260929";
const HOT_TREE = {
  "index.js": "const m = require('./shortcuts/manager');\nexports.m = m;\nexports.ok = m?.size ?? 0;\n",
  "shortcuts/manager.js": "let v;\nv ??= new Set();\nmodule.exports = v;\n",
  "plugins/sheetsBar/sheetModel.js": "let segmenter;\nsegmenter ||= new Intl.Segmenter();\nlet other;\nother &&= 1;\nmodule.exports = segmenter;\n",
  "utils/cellLinks/findLinkTokens.js": "module.exports = /(?<![a-z])b/u;\n",
  "plugins/usesOnlyEs2020.js": "module.exports = (a) => a?.b ?? 'z';\n",
  "plugins/plain.js": "module.exports = 1;\n",
};

test("shadows only the files that use syntax babel 6 cannot parse", async () => {
  const files = filesWithDeps({ handsontable: HOT_VERSION });
  const out = await applyDepShims(files, { fetchImpl: tarballFetch(HOT_VERSION, HOT_TREE) });

  const shadowed = Object.keys(out).filter((k) => k.startsWith("/node_modules/handsontable/")).sort();
  assert.deepEqual(shadowed, [
    "/node_modules/handsontable/plugins/sheetsBar/sheetModel.js",
    "/node_modules/handsontable/shortcuts/manager.js",
    "/node_modules/handsontable/utils/cellLinks/findLinkTokens.js",
  ], "`??`/`?.`-only and plain files stay the packager's copy; dist is never touched");

  for (const f of ["shortcuts/manager.js", "plugins/sheetsBar/sheetModel.js"]) {
    assert.ok(!/(\?\?|\|\||&&)=/.test(out[`/node_modules/handsontable/${f}`]), `${f} has no logical assignment`);
  }
  assert.match(out["/node_modules/handsontable/utils/cellLinks/findLinkTokens.js"], /new RegExp\("\(\?<!\[a-z\]\)b","u"\)/);
  assert.equal(out["/package.json"], files["/package.json"], "package.json left to the packager");
});

test("finds blocking files under long (ustar-prefix) paths", async () => {
  const version = "0.0.0-next-testlong-20260929";
  const deep = `plugins/${"d".repeat(60)}/${"e".repeat(60)}/deep.js`;
  const out = await applyDepShims(filesWithDeps({ handsontable: version }), {
    fetchImpl: tarballFetch(version, { [deep]: "let a;\na ??= 1;\nmodule.exports = a;\n", "index.js": "1;\n" }),
  });
  const code = out[`/node_modules/handsontable/${deep}`];
  assert.ok(code && !/\?\?=/.test(code));
});

test("downloads the tarball once per version across remounts", async () => {
  const version = "0.0.0-next-testonce-20260929";
  const requested = [];
  const fetchImpl = tarballFetch(version, HOT_TREE, requested);
  const deps = filesWithDeps({ handsontable: version });
  await applyDepShims(deps, { fetchImpl });
  await applyDepShims({ ...deps, "/src/a.js": "export default 2;\n" }, { fetchImpl });
  assert.equal(requested.length, 1, "keystroke-driven remounts never refetch");
});

test("a failed tarball download is not cached: the next mount retries", async () => {
  const version = "0.0.0-next-testevict-20260929";
  const deps = filesWithDeps({ handsontable: version });
  const down = async () => ({ ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) });
  await assert.rejects(applyDepShims(deps, { fetchImpl: down }), /handsontable@.*tarball.*503/);
  const out = await applyDepShims(deps, { fetchImpl: tarballFetch(version, HOT_TREE) });
  assert.ok(out["/node_modules/handsontable/shortcuts/manager.js"]);
});

test("scans prereleases and versions newer than the last verified stable, nothing else", () => {
  const scanned = ["0.0.0-next-7f4330c-20260929", "18.1.2", "18.2.0", "19.0.0", "18.1.1-rc1"];
  const clean = ["18.1.1", "18.1.0", "18.0.0", "17.1.0", "16.2.0", "8.0.0-beta.2", "latest", "^18", "18"];
  for (const v of scanned) assert.equal(handsontableNeedsScan(v), true, v);
  for (const v of clean) assert.equal(handsontableNeedsScan(v), false, v);
});

test("does not download anything for a verified-clean stable version", async () => {
  const fetchImpl = async () => {
    throw new Error("must not fetch");
  };
  const files = filesWithDeps({ handsontable: "18.1.1" });
  assert.deepEqual(await applyDepShims(files, { fetchImpl }), files);
});

// DEV-3338: a pkg.pr.new build is a URL dependency, so the bundler fetches the tarball itself
// and runs every file through babel 6 — there is no registry `isModule: false` metadata to skip
// it with. `?.`, `??`, `catch {` and object spread all kill it, so the shim downlevels the whole
// tree from the PR tarball instead of scanning for the few constructs registry builds need.

const PR_TREE = {
  "core.js":
    "const h = require('./helpers/string');\n" +
    "function read(s) {\n" +
    "  const merged = { ...s, dir: s?.layoutDirection ?? 'inherit' };\n" +
    "  try { return h(merged); } catch { return null; }\n" +
    "}\n" +
    "module.exports = read;\n",
  "helpers/string.js": "module.exports = (o) => String(o.dir);\n",
};

/** fetch stub serving `tree` at exactly `url`; `requested` records every URL. */
function urlFetch(url, tree, requested = []) {
  return async (asked) => {
    requested.push(asked);
    if (asked !== url) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const buf = tgz(tree);
    return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  };
}

test("downlevels every file of a pkg.pr.new build, fetched from the PR URL", async () => {
  const url = "https://pkg.pr.new/handsontable@93381";
  const requested = [];
  const out = await applyDepShims(filesWithDeps({ handsontable: url }), { fetchImpl: urlFetch(url, PR_TREE, requested) });

  assert.deepEqual(requested, [url], "the PR tarball, not the registry");
  const shadowed = Object.keys(out).filter((k) => k.startsWith("/node_modules/handsontable/")).sort();
  assert.deepEqual(shadowed, [
    "/node_modules/handsontable/core.js",
    "/node_modules/handsontable/helpers/string.js",
  ], "plain files are shadowed too; dist/ is not");
  for (const file of shadowed) {
    assert.doesNotThrow(() => Parser.parse(out[file], { ecmaVersion: 2017, sourceType: "script" }), `${file} parses at ES2017`);
  }
  const read = new Function("require", "module", `${out["/node_modules/handsontable/core.js"]}; return module.exports;`)(
    () => (o) => String(o.dir),
    { exports: {} },
  );
  assert.equal(read({ layoutDirection: "rtl" }), "rtl", "downleveled code still behaves");
});

test("only a handsontable build on the pkg.pr.new host takes the PR path", async () => {
  assert.equal(isPkgPrNewHandsontable("https://pkg.pr.new/handsontable@13766"), true);
  assert.equal(isPkgPrNewHandsontable("https://pkg.pr.new/handsontable/handsontable/handsontable@9974bd9"), true);
  assert.equal(isPkgPrNewHandsontable("https://pkg.pr.new/handsontable@13766/"), true, "the validator lets a trailing slash through");
  for (const v of [
    "https://pkg.pr.new/@handsontable/react-wrapper@13766",
    "https://pkg.pr.new/other@13766",
    "https://evil.example/handsontable@13766",
    "http://pkg.pr.new/handsontable@13766",
    "13766",
    "18.1.1",
  ]) {
    assert.equal(isPkgPrNewHandsontable(v), false, v);
  }
  const fetchImpl = async () => {
    throw new Error("must not fetch");
  };
  const files = filesWithDeps({ handsontable: "https://evil.example/handsontable@13766" });
  assert.deepEqual(await applyDepShims(files, { fetchImpl }), files);
});

test("a missing PR build rejects naming the URL and is retried on the next mount", async () => {
  const url = "https://pkg.pr.new/handsontable@93382";
  const deps = filesWithDeps({ handsontable: url });
  const missing = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
  await assert.rejects(applyDepShims(deps, { fetchImpl: missing }), /handsontable PR build tarball: https:\/\/pkg\.pr\.new\/handsontable@93382 returned 404/);
  const out = await applyDepShims(deps, { fetchImpl: urlFetch(url, PR_TREE) });
  assert.ok(out["/node_modules/handsontable/core.js"]);
});

test("downleveling a whole PR build yields to the event loop between files", async () => {
  // babel's transform is synchronous; chained awaits alone would freeze the editor for the
  // whole tree (about 3 s for a real build), so the loop must hand back macrotasks as it goes.
  const url = "https://pkg.pr.new/handsontable@93383";
  const tree = {};
  for (let i = 0; i < 400; i++) tree[`plugins/p${i}.js`] = `module.exports = (o) => ({ ...o, v${i}: o?.a ?? ${i} });\n`;
  const fetchImpl = urlFetch(url, tree);
  let maxGap = 0;
  let last = performance.now();
  const tick = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 1);
  const started = performance.now();
  const out = await applyDepShims(filesWithDeps({ handsontable: url }), { fetchImpl });
  const elapsed = performance.now() - started;
  maxGap = Math.max(maxGap, performance.now() - last);
  clearInterval(tick);
  assert.equal(Object.keys(out).filter((k) => k.startsWith("/node_modules/handsontable/")).length, 400);
  assert.ok(elapsed > 200, `precondition: the work is long enough to measure (${Math.round(elapsed)} ms)`);
  assert.ok(maxGap < elapsed / 2, `longest block ${Math.round(maxGap)} ms of ${Math.round(elapsed)} ms`);
});
