import test from "node:test";
import assert from "node:assert/strict";
import { SandpackRuntime } from "../packages/runtime/dist/sandpack.js";
import { applyHandsontableVersion } from "../packages/runtime/dist/version.js";

// DEV-2855 / Sentry DEMOS-15 (Tier1CompileError, 56 events).
//
// `/package.json` is user-editable in the live editor (EditorShell.tsx never passes
// `readOnly` to <CodeEditor>; FileTree.tsx's PROTECTED set only blocks rename/delete),
// so every intermediate keystroke leaves it unparseable. `buildSetup` used to run
// `applyHandsontableVersion` unguarded, BEFORE `loadSandpackClient` — so the throw
// aborted `mount()` entirely. No client got attached, so nothing could re-emit ready,
// and `onEdit`'s `try/catch { /* not mounted */ }` (App.tsx:2303-2307) silently
// swallowed every subsequent keystroke until the visitor hit "Restart preview".
//
// The fix guards only `applyHandsontableVersion` — an unparseable/missing
// /package.json now mounts unpinned instead of rejecting — while keeping
// `applyHandsontableCss` unconditional, since it never reads package.json at all
// (version.ts:406-434 keys off /index.html) and skipping it would leave a legacy
// stylesheet URL pinned to the wrong version for the rest of the session.
//
// `buildSetup` is private in TS but an ordinary method on the compiled dist JS, so
// it is driven directly here — no DOM, no bundler, no babel (`vue-cli` skips the
// parcel pre-transpile).

/** Same shape as sandpack-reload.test.mjs's ENTRY: a `vue-cli` environment, which
 *  the runtime hands to the bundler as-is (no parcel pre-transpile). */
const ENTRY = {
  framework: "vue",
  displayName: "Vue",
  tier: 1,
  engine: "sandpack",
  sandpackTemplate: "vue",
  sandpackEnvironment: "vue-cli",
  container: null,
  htWrappers: [],
  entry: "/src/main.js",
  htmlEntry: null,
  devCommand: null,
  buildCommand: "build",
  outputDir: "dist",
  outputGlob: null,
  staticExport: false,
  spaMode: false,
  port: null,
  installCommand: "install",
  htCoreRange: null,
  minCoreMajor: null,
  fileCount: 2,
  assets: [],
  skipped: [],
  files: {},
};

const VERSION = { ref: "16.0.1", pkgPrNew: false };

const INDEX_HTML =
  '<link rel="stylesheet" href="https://unpkg.com/handsontable@14.0.0/dist/handsontable.full.min.css">';

/** `opts.version` MUST be set, or `buildSetup` never enters the pin branch at all
 *  and the test proves nothing. */
function runtimeWithVersion() {
  return new SandpackRuntime(ENTRY, { iframe: {}, version: VERSION });
}

const CASES = [
  {
    name: "truncated JSON (mid-keystroke)",
    packageJson: '{"dependencies":{"handsontable":"16.0.1"',
  },
  {
    name: "trailing comma",
    packageJson: '{"dependencies":{"handsontable":"16.0.1",}}',
  },
  {
    name: "empty file (select-all + delete)",
    packageJson: "",
  },
];

for (const { name, packageJson } of CASES) {
  test(`buildSetup mounts unpinned when /package.json is invalid: ${name}`, async () => {
    const runtime = runtimeWithVersion();
    const files = {
      "/src/main.js": "console.log('demo');",
      "/index.html": INDEX_HTML,
      "/package.json": packageJson,
    };

    const setup = await runtime.buildSetup(files);

    assert.equal(
      runtime.files["/package.json"],
      packageJson,
      "an unparseable /package.json must be guarded, not swallowed-and-mangled",
    );
    assert.equal(setup.entry, "/src/main.js");
    assert.match(
      runtime.files["/index.html"],
      /handsontable@16\.0\.1/,
      "the CSS rewrite must still run even though the version dependency pin did not",
    );
  });
}

test("buildSetup mounts unpinned when /package.json is entirely absent", async () => {
  const runtime = runtimeWithVersion();
  const files = {
    "/src/main.js": "console.log('demo');",
    "/index.html": INDEX_HTML,
  };

  const setup = await runtime.buildSetup(files);

  assert.equal(setup.files["/package.json"], undefined);
  // This is what a coarse `try` around the whole `applyHandsontableCss(applyHandsontableVersion(...))`
  // expression would fail: the CSS rewrite does not depend on package.json existing at all, so a
  // missing manifest must not also suppress the stylesheet pin.
  assert.match(
    runtime.files["/index.html"],
    /handsontable@16\.0\.1/,
    "the CSS rewrite must run even when there is no /package.json to guard",
  );
});

// Happy-path regression guard, not a fix-prover: this case passes with the guard
// reverted too, since applyHandsontableVersion never throws on valid JSON. It is
// here to pin that the guard does not change behavior on the common, well-formed case.
test("buildSetup pins a valid /package.json exactly as before (happy-path regression guard)", async () => {
  const runtime = runtimeWithVersion();
  const files = {
    "/src/main.js": "console.log('demo');",
    "/index.html": INDEX_HTML,
    "/package.json": JSON.stringify({ dependencies: { handsontable: "14.0.0" } }),
  };

  await runtime.buildSetup(files);

  // buildSetup's pipeline is applyHandsontableVersion -> applyHandsontableCss, then (next
  // line of the same function, unrelated to this guard) ensureSandpackDeps, which also
  // appends `@swc/helpers` for any package.json that now depends on handsontable — so a
  // byte-identical comparison against applyHandsontableVersion's output alone would be
  // wrong. applyHandsontableVersion is documented idempotent (version.ts:309-311), so pin
  // the format against the real function on the already-pinned output instead of a literal
  // that would break for an unrelated reason (e.g. a version bump in ensureSandpackDeps).
  const actual = runtime.files["/package.json"];
  assert.equal(JSON.parse(actual).dependencies.handsontable, "16.0.1");
  assert.equal(
    actual,
    applyHandsontableVersion({ ...files, "/package.json": actual }, VERSION)["/package.json"],
    "already-pinned output is a fixed point, so 2-space indent + trailing newline match the real pin",
  );
  assert.match(runtime.files["/index.html"], /handsontable@16\.0\.1/);
});
