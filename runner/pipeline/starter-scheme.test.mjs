import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// DEV-2561 / ADR-0035: every starter states its colour scheme.
//
// This is the only place the pin is observable. In a running preview the shell is
// already driving a stock demo's `color-scheme`, so the grid reads `light` whether
// the starter declared it or inherited `auto` — `e2e/row-striping.spec.ts` cannot
// tell the two apart, and says so. What a missing declaration actually costs is
// invisible in the playground and shows up only after someone copies the demo out:
// their grid then follows *their reader's* operating system instead of the theme
// the source names.

const HERE = dirname(fileURLToPath(import.meta.url));
const BUCKETS = join(HERE, "..", "apps", "authoring", "public", "starter-examples");

/**
 * Buckets below 17 have no `handsontable/themes` at all: they theme through the
 * string `themeName` plus the shipped stylesheet, whose `.ht-theme-main` rule
 * already pins `color-scheme: light`. Nothing to declare, nothing to check.
 *
 * 17 and 18 are `todo`, and the reason is structural rather than an excuse.
 * `examples/` on master feeds only the `next` bucket; those two source from the
 * frozen `prod-examples/17` and `/18` branches, which a master PR cannot reach
 * (ADR-0029). They are listed rather than omitted so the gap is on the record and
 * turns into a real failure the moment someone drops the flag after backporting.
 */
const THEME_API_BUCKETS = [
  { bucket: "next" },
  { bucket: "17", todo: "pending the prod-examples/17 backport (ADR-0029)" },
  { bucket: "18", todo: "pending the prod-examples/18 backport (ADR-0029)" },
];

/** How a scheme can legitimately be stated. The spread is what the general-purpose
 *  starters use; `setColorScheme` and a `colorScheme:` key are what the ones that
 *  register a theme of their own use. */
const DECLARES = /colorScheme:\s*['"]|setColorScheme\(/;

/** A demo declares a scheme somewhere in its own source, not in a lockfile. */
function declaresScheme(artifact) {
  return Object.entries(artifact.files).some(
    ([path, source]) => /\.(m?[jt]sx?|vue|astro)$/.test(path) && DECLARES.test(source),
  );
}

for (const { bucket, todo } of THEME_API_BUCKETS) {
  const dir = join(BUCKETS, bucket);
  const names = readdirSync(dir).filter((n) => n.endsWith(".json") && n !== "manifest.json");

  test(`bucket ${bucket}: every starter declares a colour scheme`, { todo }, () => {
    const missing = [];
    for (const name of names) {
      const artifact = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (!declaresScheme(artifact)) missing.push(name);
    }
    assert.deepEqual(
      missing,
      [],
      "a starter with no `colorScheme` inherits the builder's `auto`, so a copy of it "
        + "renders whatever the reader's OS prefers rather than the theme it names",
    );
  });
}

test("the buckets that predate the theme API are left alone", () => {
  // Stated as a test so "15 and 16 were skipped" is a decision on the record rather
  // than an oversight — the CSS import they still carry is what pins them, and
  // adding `colorScheme` there would be a syntax error against a core with no
  // `handsontable/themes`.
  for (const bucket of ["15", "16"]) {
    const dir = join(BUCKETS, bucket);
    const names = readdirSync(dir).filter((n) => n.endsWith(".json") && n !== "manifest.json");
    assert.ok(names.length > 0, `bucket ${bucket} should still be built`);
  }
});
