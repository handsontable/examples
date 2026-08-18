// `BUNDLED_VERSION` has to be the Handsontable this app is actually built with
// (DEV-2560).
//
// The panel names it: when a demo's own version cannot be fetched, the fallback
// note says "Showing Handsontable 18.0.0's defaults". Bumping the dependency
// without bumping the constant turns that note into a confident lie, and skips
// the CDN fetch for whatever version the constant still claims.
//
// Read as text, not imported: `presets.ts` imports `handsontable/themes/...`,
// which needs the app's node_modules and a bundler-ish resolver.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

test("BUNDLED_VERSION matches the pinned handsontable dependency", () => {
  const presets = read("apps/authoring/src/theme/presets.ts");
  const pkg = JSON.parse(read("apps/authoring/package.json"));

  const declared = /export const BUNDLED_VERSION = "([^"]+)"/.exec(presets)?.[1];
  assert.ok(declared, "presets.ts must export BUNDLED_VERSION");

  const pinned = pkg.dependencies?.handsontable;
  assert.ok(pinned, "apps/authoring must depend on handsontable");
  assert.equal(
    declared,
    pinned,
    `BUNDLED_VERSION (${declared}) must match the handsontable pin (${pinned})`,
  );
});

test("the pin is exact, so the constant can be exact", () => {
  const pkg = JSON.parse(read("apps/authoring/package.json"));
  assert.match(
    pkg.dependencies.handsontable,
    /^\d+\.\d+\.\d+$/,
    "a range would make the bundled numbers unnameable",
  );
});
