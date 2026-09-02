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

// The pin itself has to track a *release*, not just its own constant. The two
// assertions above only compare the pin and BUNDLED_VERSION to each other, so
// they drift together and stay "consistent" while both go stale — which is
// exactly what happened: both sat at 18.0.0 for months after 18.1.0 became npm
// `latest` (DEV-2735). The starter buckets do not have that problem, because
// `.github/workflows/import-starters.yml` re-resolves each bucket's hotVersion
// from npm every Monday and opens a PR with the regenerated `catalog.json`.
//
// Checked against that committed state rather than the live registry: no
// pipeline test touches the network (eleven of them stub `globalThis.fetch` to
// keep it that way), and `docs/TESTING.md` rules out an env gate to hide one.
//
// Deliberately per-major, not "must equal the newest bucket". When 19 ships,
// bucket 19 appears and a highest-bucket rule would demand the app move major
// — a much larger job (THEME_API_MIN_MAJOR, preset shape, wrapper peers) that
// must not be forced by a red suite. Within its own major this still catches
// the reported drift. Do not "tighten" it.
test("the pin tracks its own major's starter bucket", () => {
  const pin = JSON.parse(read("apps/authoring/package.json")).dependencies.handsontable;
  const { bucketVersions } = JSON.parse(read("catalog.json"));
  const major = pin.split(".")[0];

  assert.ok(
    bucketVersions?.[major],
    `catalog.json has no bucket ${major}; run \`node pipeline/import.mjs --index\``,
  );
  assert.equal(
    pin,
    bucketVersions[major],
    `the handsontable pin (${pin}) trails bucket ${major} (${bucketVersions[major]}) — `
      + "bump apps/authoring/package.json, BUNDLED_VERSION and the lockfile together",
  );
});
