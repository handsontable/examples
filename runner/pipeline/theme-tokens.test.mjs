// The vendored token catalogue and the worker's generated whitelist must agree
// (DEV-2199). Both files are read as text rather than imported: they are
// TypeScript, and `pnpm test` runs plain `node --test` on Node 20+, where type
// stripping isn't available. Parsing independently also means this test doesn't
// just re-run the generator's own logic.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalogue = readFileSync(join(root, "apps/authoring/src/theme/tokens.ts"), "utf8");
const generated = readFileSync(join(root, "workers/api/src/theme-tokens.generated.ts"), "utf8");

/** `key: "accentColor",` — the type declaration says `key: string;`, so quoting
 *  is what separates real entries from the `Token` type above them. */
const catalogueKeys = [...catalogue.matchAll(/^\s+key: "([^"]+)",$/gm)].map((m) => m[1]);
const generatedKeys = [...generated.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

test("the vendored catalogue is the one we think it is", () => {
  assert.equal(catalogueKeys.length, 272, "expected 272 tokens — re-vendoring changed the count");
  assert.match(catalogue, /blob\s+: d6342f7b3a91ff7b5c65121aca2579669fb32385/);
  // Both halves present, since the panel's tabs are built from them.
  assert.match(catalogue, /^ {2}common: \[$/m);
  assert.match(catalogue, /^ {2}components: \[$/m);
});

test("token keys are unique", () => {
  const seen = new Set();
  const dupes = catalogueKeys.filter((k) => (seen.has(k) ? true : (seen.add(k), false)));
  assert.deepEqual(dupes, [], "duplicate keys would make a token unreachable in the panel");
});

test("the worker's whitelist matches the catalogue exactly", () => {
  assert.deepEqual(
    generatedKeys,
    catalogueKeys,
    "run `node --experimental-strip-types scripts/gen-theme-tokens.mjs`",
  );
});

test("the tokens the old hand-written list got wrong stay gone", () => {
  // `wrapperBorderRadius` / `wrapperBorderColor` never existed; the panel wrote
  // them and Handsontable ignored them. The real names are below.
  for (const invented of ["wrapperBorderRadius", "wrapperBorderColor"]) {
    assert.ok(!catalogueKeys.includes(invented), `${invented} is not a Handsontable token`);
  }
  for (const real of ["borderRadius", "borderColor"]) {
    assert.ok(catalogueKeys.includes(real), `${real} should be in the catalogue`);
  }
});

test("linked tokens point at tokens that exist", () => {
  // `linkedTokens` pairs a column-header token with its row-header counterpart;
  // the panel writes and resets them together. A typo here would silently write
  // a token nothing reads.
  const linked = [...catalogue.matchAll(/linkedTokens: \[([^\]]*)\]/g)]
    .flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((t) => t[1]));
  assert.ok(linked.length > 0, "expected the catalogue to declare linked tokens");
  for (const key of linked) {
    assert.ok(catalogueKeys.includes(key), `linkedTokens references unknown token ${key}`);
  }
});

test("the panel writes linked tokens, not just the edited one", () => {
  // Bugbot caught this: the controls were ported but the write path only
  // touched the edited key, so a restyled column header left the row header
  // stock.
  const panel = readFileSync(join(root, "apps/authoring/src/StylePanel.tsx"), "utf8");
  assert.match(panel, /setParam\(token\.key, v, token\.linkedTokens\)/);
  assert.match(panel, /resetParam\(token\.key, token\.linkedTokens\)/);
});

test("clearing a numeric field stores nothing, not a bare unit", () => {
  // `${value}${unit}` on an emptied field yields "%" or "s", which is not empty
  // by any string check, so it was stored and emitted as a value the grid
  // cannot use.
  const controls = readFileSync(join(root, "apps/authoring/src/theme/controls.tsx"), "utf8");
  assert.match(controls, /e\.target\.value === "" \? "" : `\$\{e\.target\.value\}\$\{unit\}`/);
});

test("the density editor tracks the theme's variant on load and on reset", () => {
  // `densityVariant` is the panel's only piece of local state derived from the
  // theme, so it is the only one that can go stale against it. It went wrong
  // twice: starting on DEFAULT_THEME.density (a restored compact theme opened
  // on `default`), then surviving Reset (a pristine theme kept warning about a
  // mismatch that no longer existed).
  const panel = readFileSync(join(root, "apps/authoring/src/StylePanel.tsx"), "utf8");
  assert.match(panel, /useState<ThemeState\["density"\]>\(\(\) => state\.density\)/);

  const resetBody = panel.slice(panel.indexOf("function reset()"));
  assert.match(
    resetBody.slice(0, resetBody.indexOf("\n  }")),
    /setDensityVariant\(DEFAULT_THEME\.density\)/,
    "reset() must bring the density editor back too",
  );
});

test("every token declares a type the panel can render", () => {
  const types = new Set([...catalogue.matchAll(/^\s+type: "([^"]+)",$/gm)].map((m) => m[1]));
  assert.deepEqual([...types].sort(), ["color", "numeric", "select", "size"]);
  assert.equal(
    [...catalogue.matchAll(/^\s+type: "[^"]+",$/gm)].length,
    catalogueKeys.length,
    "every token needs a type — the typed controls switch on it",
  );
});
