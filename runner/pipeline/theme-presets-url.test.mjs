// Which versions the Style panel can fetch preset data for, and from where
// (DEV-2560).
//
// Both halves are load-bearing and neither shows up as a failure at runtime: a
// predicate that says yes to a pkg.pr.new ref produces a 404 the loader silently
// falls back from, and a malformed URL does the same. The panel then quietly
// shows this app's numbers for someone else's version.
//
// No network here — the URLs are asserted as strings against paths verified by
// hand (jsDelivr serves `themes/static/variables/**.mjs` from 17.0.0-rc1 on, and
// 404s every 15.x/16.x). Imported directly: `presetUrls.ts` has no imports.
import test from "node:test";
import assert from "node:assert/strict";

const { canLoadPresets, PRESET_CDN, presetUrl } = await import("../apps/authoring/src/theme/presetUrls.ts");

test("a plain release and a next stamp are fetchable", () => {
  for (const v of ["17.0.1", "17.1.0", "18.0.0", "0.0.0-next-64139ae-20260219"]) {
    assert.equal(canLoadPresets(v), true, `${v} is a real npm version`);
  }
});

test("anything npm does not have is not fetchable", () => {
  // A bare pkg.pr.new build id, a pkg.pr.new URL, a dist-tag name, and nothing.
  for (const v of ["1234", "https://pkg.pr.new/handsontable@abc123", "next", "latest", "", "   "]) {
    assert.equal(canLoadPresets(v), false, `${v} must not be fetched`);
  }
});

test("the URLs are the ones jsDelivr actually serves", () => {
  assert.equal(
    presetUrl("17.0.1", "tokens", "main"),
    "https://cdn.jsdelivr.net/npm/handsontable@17.0.1/themes/static/variables/tokens/main.mjs",
  );
  assert.equal(
    presetUrl("18.0.0", "colors", "horizon"),
    "https://cdn.jsdelivr.net/npm/handsontable@18.0.0/themes/static/variables/colors/horizon.mjs",
  );
  // `sizing` and `density` are single modules, so no preset segment.
  assert.equal(
    presetUrl("18.0.0", "sizing"),
    "https://cdn.jsdelivr.net/npm/handsontable@18.0.0/themes/static/variables/sizing.mjs",
  );
  assert.equal(
    presetUrl("0.0.0-next-64139ae-20260219", "density"),
    `${PRESET_CDN}@0.0.0-next-64139ae-20260219/themes/static/variables/density.mjs`,
  );
});

test("the host is one that sends CORS headers for these files", () => {
  // unpkg works too; esm.sh and skypack rewrite modules, which this must not get.
  assert.equal(PRESET_CDN, "https://cdn.jsdelivr.net/npm/handsontable");
});
