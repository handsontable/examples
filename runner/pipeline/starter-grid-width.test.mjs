import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// DEV-2794: a starter must not pin its grid to a pixel width narrower than the
// container it sits in.
//
// `javascript` shipped `width: 587` with seven 150px columns, and `example1`
// shipped `width: 800` with ~1930px of columns. Both rendered as a small box of
// permanently clipped grid in a 704px preview pane, and example1's was wide
// enough to overflow its own document and grow a second horizontal scrollbar on
// top of the grid's own. The reported "renders too small" figures on the ticket
// (587x248) were literally these two options read back.
//
// Why a bucket-artifact test rather than a source test: `examples/` on master
// feeds only the `next` bucket, and 15-18 source from the frozen
// `prod-examples/<major>` branches that a master PR cannot reach (ADR-0029).
// Reading the artifacts is the only place all five are observable at once, so a
// backport that lands on four branches and misses one fails here instead of
// silently shipping a clipped grid at one major.
//
// KNOW WHAT THIS DOES NOT GATE. The artifacts only change on master when the
// generated `chore/starter-example-buckets` PR merges, which happens *after* a
// `prod-examples/<major>` merge. So this guard is a lagging indicator: it cannot
// run against a prod-branch PR's own source at review time, and it reports a
// missed backport once that branch's bucket is next regenerated. If it goes red,
// the answer is the missing backport - never a weakened assertion here.

const HERE = dirname(fileURLToPath(import.meta.url));
const BUCKETS = join(HERE, "..", "apps", "authoring", "public", "starter-examples");

const SOURCE = /\.(m?[jt]sx?|vue|astro)$/;
const LICENSE = /^(\s*):?licenseKey\s*[:=]/;

/**
 * A bare pixel number, and only that.
 *
 * `width="100%"` (fluent-ui, mui), `width: "100%"` (next-shadcn), `width: 32px`
 * in a `<style>` block and `width="24"` on an SVG icon are all legitimate and
 * must not match — an earlier draft of this guard keyed on indentation alone and
 * flagged all four.
 */
const FIXED_PX = /^(\s*)width\s*[:=]\s*\{?\s*(\d+)\s*\}?\s*,?\s*$/;

const indentOf = (line) => line.match(/^\s*/)[0].length;

/**
 * The grid's own option block: the run of lines around `licenseKey` sitting at
 * or below its indentation, which is what bounds this to grid options in both
 * shapes the starters use — an object literal (`width: 587,`) and JSX props
 * (`width={600}`). Every starter's settings carry a `licenseKey`, and nothing
 * else in these files does, which makes it the one reliable anchor.
 *
 * Deliberately text-scoped, with the same stated limitation as
 * `starter-overrides.mjs`: a computed `width: someFn()` is invisible here. This
 * is a lint against reintroducing the literal, not a proof.
 */
function optionRegions(lines) {
  const regions = [];
  for (const [i, line] of lines.entries()) {
    const m = LICENSE.exec(line);
    if (!m) continue;
    const ind = m[1].length;
    let lo = i;
    let hi = i;
    while (lo > 0 && (lines[lo - 1].trim() === "" || indentOf(lines[lo - 1]) >= ind)) lo--;
    while (hi < lines.length - 1 && (lines[hi + 1].trim() === "" || indentOf(lines[hi + 1]) >= ind)) hi++;
    regions.push({ lo, hi, ind });
  }
  return regions;
}

/** Grid options in `source` that pin a fixed pixel width, as "<line>: <text>". */
function fixedWidths(source) {
  const lines = source.split("\n");
  const hits = [];
  for (const { lo, hi, ind } of optionRegions(lines)) {
    for (let i = lo; i <= hi; i++) {
      const m = FIXED_PX.exec(lines[i]);
      if (m && m[1].length === ind) hits.push(`${i + 1}: ${lines[i].trim()}`);
    }
  }
  return hits;
}

/**
 * `base-web` is allowed its `width={600}` because it is not this defect.
 *
 * Its grid sits in `.table-shell`, which is itself `width: 600px` in the
 * starter's own stylesheet, so the option matches its container exactly rather
 * than clamping below it — deleting the prop changes nothing on screen, since
 * the grid would then take 100% of the same 600px shell. Measured live: grid
 * 600x304 in a 600px shell, and the preview document does not overflow.
 *
 * What it does have is 880px of declared columns inside that card, so its two
 * rightmost columns are scrolled out of view. That is a question about the
 * card's width, tracked as DEV-2841 - it is not fixed by touching this option,
 * which is why it is exempted here rather than left to fail.
 */
const FIXED_WIDTH_BY_DESIGN = new Set(["base-web.json"]);

const buckets = readdirSync(BUCKETS).sort();

test("the bucket set is non-empty", () => {
  // Guards the loops below: a mistyped BUCKETS path would otherwise make every
  // test vacuously pass by iterating nothing.
  assert.ok(buckets.length > 0, `no starter buckets found under ${BUCKETS}`);
});

for (const bucket of buckets) {
  const dir = join(BUCKETS, bucket);
  const names = readdirSync(dir)
    .filter((n) => n.endsWith(".json") && n !== "manifest.json")
    .sort();

  test(`bucket ${bucket}: no starter pins its grid to a fixed pixel width`, () => {
    assert.ok(names.length > 0, `bucket ${bucket} ships no starters`);

    const offenders = [];
    for (const name of names) {
      if (FIXED_WIDTH_BY_DESIGN.has(name)) continue;
      const artifact = JSON.parse(readFileSync(join(dir, name), "utf8"));
      for (const [path, source] of Object.entries(artifact.files)) {
        if (!SOURCE.test(path) || typeof source !== "string") continue;
        for (const hit of fixedWidths(source)) offenders.push(`${name} ${path} -> ${hit}`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      "a grid pinned to a pixel width renders clipped whenever its columns total more "
        + "than that width, and cannot grow when the preview pane or a copy of the demo does",
    );
  });

  test(`bucket ${bucket}: the two starters fixed in DEV-2794 track their container`, () => {
    for (const name of ["javascript.json", "example1.json"]) {
      // A bucket that stops emitting one of these must fail rather than skip:
      // silently iterating nothing is how this guard would rot into a pass.
      assert.ok(names.includes(name), `bucket ${bucket} no longer ships ${name}`);

      const artifact = JSON.parse(readFileSync(join(dir, name), "utf8"));
      const entry = name === "example1.json" ? "/index.ts" : "/index.js";
      const source = artifact.files[entry];
      assert.ok(source, `${bucket}/${name} has no ${entry}`);

      assert.deepEqual(
        fixedWidths(source),
        [],
        `${bucket}/${name} pins a fixed grid width again`,
      );
      assert.match(
        source,
        /^\s*height: 450,$/m,
        `${bucket}/${name} should stand at the 450px height its sibling starters use`,
      );
    }
  });
}

test("the base-web exemption is still load-bearing", () => {
  // An exemption nobody checks is dead code that goes on suppressing findings in
  // that file forever. If base-web's card gets widened and the prop dropped, this
  // fails and says to delete the entry rather than leave it masking a regression.
  const stale = [];
  for (const bucket of buckets) {
    const path = join(BUCKETS, bucket, "base-web.json");
    let artifact;
    try {
      artifact = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue; // base-web predates buckets 15 and 16.
    }
    const app = artifact.files["/src/App.tsx"];
    if (app && fixedWidths(app).length === 0) stale.push(bucket);
  }
  assert.deepEqual(
    stale,
    [],
    "base-web no longer pins a fixed width in these buckets, so its entry in "
      + "FIXED_WIDTH_BY_DESIGN should be removed and the general rule left to cover it",
  );
});

test("the javascript starter sizes its columns like its siblings", () => {
  // The scalar `colWidths: 150` was the other half of the defect: seven columns
  // at a flat 150px is what made the content overflow the old 587px width. The
  // array is shared verbatim with typescript/react/react-js.
  const expected = "colWidths: [170, 222, 130, 120, 120, 130, 156],";
  for (const bucket of buckets) {
    const artifact = JSON.parse(
      readFileSync(join(BUCKETS, bucket, "javascript.json"), "utf8"),
    );
    assert.ok(
      artifact.files["/index.js"].includes(expected),
      `bucket ${bucket}: javascript should carry the shared colWidths array`,
    );
  }
});
