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

test("every token declares a type the panel can render", () => {
  const types = new Set([...catalogue.matchAll(/^\s+type: "([^"]+)",$/gm)].map((m) => m[1]));
  assert.deepEqual([...types].sort(), ["color", "numeric", "select", "size"]);
  assert.equal(
    [...catalogue.matchAll(/^\s+type: "[^"]+",$/gm)].length,
    catalogueKeys.length,
    "every token needs a type — the typed controls switch on it",
  );
});
