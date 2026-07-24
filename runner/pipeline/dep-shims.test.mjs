import test from "node:test";
import assert from "node:assert/strict";
import { applyDepShims, DEP_SHIMS } from "../packages/runtime/dist/dep-shims.js";

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

test("rejects with the package name when the dist fetch fails", async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, text: async () => "" });
  await assert.rejects(
    applyDepShims(filesWithDeps({ "@simonwep/pickr": "1.10.1-test-404" }), { fetchImpl }),
    /@simonwep\/pickr/,
  );
});
