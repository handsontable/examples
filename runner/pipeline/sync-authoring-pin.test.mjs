// The Monday starter re-pin (#423) moved bucket 18 to 18.1.2 and left two hand-held versions
// behind: the authoring app's pin, and `HOT_LAST_KNOWN_GOOD`, whose lag made every default mount
// download a tarball and turned the deterministic preview-recovery e2e red (#424).
// `scripts/sync-authoring-pin.mjs` now moves both inside the generated PR; this file pins its
// rules and guards the committed state.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BLOCKING_SYNTAX, blockingFiles, planSync } from "../scripts/sync-authoring-pin.mjs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const PKG = '{ "dependencies": { "handsontable": "18.1.1" } }';
const PRESETS = 'export const BUNDLED_VERSION = "18.1.1";';
const SHIMS = "const HOT_LAST_KNOWN_GOOD = [18, 1, 1] as const;";
const plan = (over) =>
  planSync({ pkgText: PKG, presetsText: PRESETS, shimsText: SHIMS, target: "18.1.2", oldBlocking: [], newBlocking: [], ...over });

test("moves the pin, BUNDLED_VERSION and the known-good version to a clean new bucket version", () => {
  const out = plan();
  assert.match(out.pkgText, /"handsontable": "18\.1\.2"/);
  assert.match(out.presetsText, /BUNDLED_VERSION = "18\.1\.2"/);
  assert.match(out.shimsText, /\[18, 1, 2\] as const/);
});

test("a blocking file the known-good lacks keeps the known-good where it is", () => {
  const out = plan({ oldBlocking: ["a.js"], newBlocking: ["a.js", "sheetsBar/sheetModel.js"] });
  assert.match(out.pkgText, /18\.1\.2/, "the pin still follows the bucket");
  assert.match(out.shimsText, /\[18, 1, 1\] as const/);
  assert.match(out.notes.join("\n"), /adds blocking syntax in sheetsBar\/sheetModel\.js/);
});

test("a blocking file both versions share is not new", () => {
  const out = plan({ oldBlocking: ["x.js"], newBlocking: ["x.js"] });
  assert.match(out.shimsText, /\[18, 1, 2\] as const/);
});

test("never lowers the known-good, never crosses a major, no-op when in step", () => {
  assert.equal(plan({ target: "18.1.1" }).shimsText, SHIMS);
  assert.equal(plan({ target: "19.0.0" }).shimsText, SHIMS);
  assert.equal(plan({ target: "18.1.1" }).notes.length, 0);
});

test("blockingFiles skips dist/ and non-js and flags the shim's constructs", () => {
  const files = {
    "a.js": "x ??= 1",
    "dist/b.js": "x ??= 1",
    "c.d.ts": "x ??= 1",
    "d.js": "const y = a ?? b",
    "e.js": "/(?<!\\d)x/",
  };
  assert.deepEqual(blockingFiles(files), ["a.js", "e.js"]);
});

test("the script's syntax regex is the shim's", () => {
  const src = /const HOT_BLOCKING_SYNTAX = (\/.+\/);/.exec(read("packages/runtime/src/dep-shims.ts"))?.[1];
  assert.equal(src, String(BLOCKING_SYNTAX));
});

test("the newest stable bucket version is verified, so a default mount never scans a tarball", () => {
  const good = /HOT_LAST_KNOWN_GOOD = \[(\d+), (\d+), (\d+)\]/.exec(read("packages/runtime/src/dep-shims.ts"))
    .slice(1)
    .map(Number);
  const { bucketVersions } = JSON.parse(read("catalog.json"));
  for (const [bucket, v] of Object.entries(bucketVersions)) {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
    if (!m || Number(m[1]) !== good[0]) continue;
    const parts = m.slice(1).map(Number);
    const ahead = parts[1] > good[1] || (parts[1] === good[1] && parts[2] > good[2]);
    assert.equal(
      ahead,
      false,
      `bucket ${bucket} is ${v}, past HOT_LAST_KNOWN_GOOD ${good.join(".")}: run \`node scripts/sync-authoring-pin.mjs\` `
        + "(it verifies the tarball) or bump it by hand after checking",
    );
  }
});
