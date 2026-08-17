import test from "node:test";
import assert from "node:assert/strict";
import {
  OPTION_OVERRIDES,
  SOURCE_NORMALIZATIONS,
  applyStarterOverrides,
  lintStarterOptionShapes,
  starterOverrideIds,
  usesIntlDate,
} from "./starter-overrides.mjs";

// Synthetic file maps only — no artifacts, no network. These assert the
// mechanism; pipeline/import.test.mjs covers it against the real examples/ tree.

const LEGACY_BUCKETS = ["15", "16", "17"];
const INTL_BUCKETS = ["18", "next"];

const jsStarter = (dateFormat) => ({
  "/index.js": [
    "const settings = {",
    "  columns: [",
    "    {",
    "      data: 4,",
    "      type: 'date',",
    `      dateFormat: ${dateFormat},`,
    "    },",
    "  ],",
    "};",
  ].join("\n"),
  "/src/utils.js": "const randomDate = () => new Date(0).toISOString().slice(0, 10);\n",
  "/package.json": '{\n  "name": "javascript"\n}\n',
});

test("usesIntlDate keys off the bucket key, not the pinned version", () => {
  for (const bucket of LEGACY_BUCKETS) assert.equal(usesIntlDate(bucket), false, bucket);
  for (const bucket of INTL_BUCKETS) assert.equal(usesIntlDate(bucket), true, bucket);
  // "next" pins 0.0.0-next-<sha>-<date>; a version-derived check would read
  // major 0 and classify current dev as the oldest legacy bucket.
  assert.equal(usesIntlDate("next"), true);
  assert.equal(Number("0.0.0-next-abc1234-20260801".split(".")[0]), 0);
});

test("a string dateFormat on a date cell is a problem at 18 and next", () => {
  for (const bucket of INTL_BUCKETS) {
    const problems = lintStarterOptionShapes("javascript", jsStarter("'YYYY-MM-DD'"), { bucket });
    assert.equal(problems.length, 1, `${bucket}: ${JSON.stringify(problems)}`);
    assert.match(problems[0], /Intl object/);
  }
});

test("a string dateFormat on a date cell is clean at 15, 16 and 17", () => {
  for (const bucket of LEGACY_BUCKETS) {
    assert.deepEqual(
      lintStarterOptionShapes("javascript", jsStarter("'YYYY-MM-DD'"), { bucket }),
      [],
      bucket,
    );
  }
});

test("an object dateFormat on a date cell is a problem at 17 — the mirror defect", () => {
  // next-shadcn.js ships the object today with minCoreMajor 17, so bucket 17
  // feeds an object to moment(value, dateFormat, true): no warning, silent
  // validation failure. Regression-locked here.
  const intl = "{ year: 'numeric', month: '2-digit', day: '2-digit' }";
  const problems = lintStarterOptionShapes("javascript", jsStarter(intl), { bucket: "17" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /15\/16\/17 need the format string/);
});

test("an object dateFormat on a date cell is clean at 18 and next", () => {
  const intl = "{ year: 'numeric', month: '2-digit', day: '2-digit' }";
  for (const bucket of INTL_BUCKETS) {
    assert.deepEqual(lintStarterOptionShapes("javascript", jsStarter(intl), { bucket }), [], bucket);
  }
});

test("dateFormat with no date cell type is not flagged", () => {
  // The pikaday / flatpickr recipe shape: a dateFormat that configures a
  // third-party picker, not a Handsontable date column.
  const files = {
    "/index.js": "const picker = new Pikaday({ dateFormat: 'DD/MM/YYYY' });\n",
  };
  for (const bucket of [...LEGACY_BUCKETS, ...INTL_BUCKETS]) {
    assert.deepEqual(lintStarterOptionShapes("vue", files, { bucket }), [], bucket);
  }
});

test("an unregistered starter with a date column fails registry completeness", () => {
  const files = {
    "/src/Grid.vue": "columns: [{ type: 'date', dateFormat: 'DD/MM/YYYY' }]\n",
  };
  const problems = lintStarterOptionShapes("vue", files, { bucket: "18" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no starter-overrides\.mjs row declaring its per-major shape/);
  assert.match(problems[0], /\/src\/Grid\.vue/);
});

test("registry completeness also covers the sibling timeFormat option", () => {
  const files = {
    "/src/Grid.vue": "columns: [{ type: 'time', timeFormat: 'HH:mm' }]\n",
  };
  const problems = lintStarterOptionShapes("vue", files, { bucket: "17" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /timeFormat/);
});

test("applyStarterOverrides sets the bucket-correct literal whatever the source says", () => {
  // Set semantics, not find-and-downgrade: bucket 18 sources from
  // prod-examples/18 (string) while next sources from master (object), so the
  // rewrite must not depend on the incoming shape.
  for (const source of ["'DD/MM/YYYY'", "{ year: 'numeric' }"]) {
    const legacy = applyStarterOverrides("javascript", jsStarter(source), { bucket: "16" });
    assert.match(legacy.files["/index.js"], /dateFormat: 'YYYY-MM-DD',/);

    const intl = applyStarterOverrides("javascript", jsStarter(source), { bucket: "18" });
    assert.match(intl.files["/index.js"], /dateFormat: \{ year: 'numeric', month: '2-digit', day: '2-digit' \},/);
  }
});

test("applyStarterOverrides preserves indentation", () => {
  const { files } = applyStarterOverrides("javascript", jsStarter("'DD/MM/YYYY'"), { bucket: "18" });
  assert.match(files["/index.js"], /\n {6}dateFormat: \{/);
});

test("applyStarterOverrides is idempotent", () => {
  for (const bucket of [...LEGACY_BUCKETS, ...INTL_BUCKETS]) {
    const once = applyStarterOverrides("javascript", jsStarter("'DD/MM/YYYY'"), { bucket });
    const twice = applyStarterOverrides("javascript", once.files, { bucket });
    assert.deepEqual(twice.files, once.files, bucket);
    // The second pass changes nothing, so it reports nothing applied.
    assert.deepEqual(twice.applied, [], bucket);
  }
});

test("applyStarterOverrides output satisfies its own lint", () => {
  for (const bucket of [...LEGACY_BUCKETS, ...INTL_BUCKETS]) {
    const { files } = applyStarterOverrides("javascript", jsStarter("'DD/MM/YYYY'"), { bucket });
    assert.deepEqual(lintStarterOptionShapes("javascript", files, { bucket }), [], bucket);
  }
});

test("a row matching zero or two sites throws rather than silently no-opping", () => {
  const zero = { "/index.js": "type: 'date'\n", "/src/utils.js": "", "/package.json": "{}" };
  assert.throws(
    () => applyStarterOverrides("javascript", zero, { bucket: "18" }),
    /expected exactly 1 `dateFormat` site .* found 0/s,
  );

  const two = jsStarter("'DD/MM/YYYY'");
  two["/index.js"] += "\n      dateFormat: 'DD/MM/YYYY',\n";
  assert.throws(
    () => applyStarterOverrides("javascript", two, { bucket: "18" }),
    /expected exactly 1 `dateFormat` site .* found 2/s,
  );
});

test("a missing target file throws", () => {
  assert.throws(
    () => applyStarterOverrides("javascript", { "/package.json": "{}" }, { bucket: "18" }),
    /target file \/index\.js not found/,
  );
});

test("the overlay never touches /package.json, so the pin keeps the last word", () => {
  const before = jsStarter("'DD/MM/YYYY'");
  for (const bucket of [...LEGACY_BUCKETS, ...INTL_BUCKETS]) {
    const { files } = applyStarterOverrides("javascript", before, { bucket });
    assert.equal(files["/package.json"], before["/package.json"], bucket);
  }
  for (const row of [...OPTION_OVERRIDES, ...SOURCE_NORMALIZATIONS]) {
    assert.notEqual(row.file, "/package.json", row.id);
  }
});

test("stored values converge on ISO at EVERY bucket, display stays per-bucket", () => {
  // Storage is uniform because ISO is the one shape every supported major
  // accepts; only the display option varies. Keeping storage bucket-dependent
  // would make a local full regen (master for every bucket) disagree with CI
  // (frozen prod-examples branches), pairing master's ISO data with a DD/MM
  // option at 15/16/17.
  const angular = {
    "/src/app/data-grid.component.ts": "        dateFormat: 'DD/MM/YYYY',\n        type: 'date',\n",
    "/src/app/utils/constants.ts": "export const data = [[false, 'Tagcat', '11/10/2020'], [true, 'Zoomzone', '03/05/2020']];\n",
  };

  for (const bucket of [...LEGACY_BUCKETS, ...INTL_BUCKETS]) {
    const data = applyStarterOverrides("angular", angular, { bucket })
      .files["/src/app/utils/constants.ts"];
    // DD/MM/YYYY -> ISO, matching the javascript starter's already-migrated
    // twin of the same dataset ('11/10/2020' <-> '2020-10-11').
    assert.match(data, /'2020-10-11'/, bucket);
    assert.match(data, /'2020-05-03'/, bucket);
    assert.doesNotMatch(data, /\d{2}\/\d{2}\/\d{4}/, bucket);
  }

  const legacy = applyStarterOverrides("angular", angular, { bucket: "17" });
  assert.match(legacy.files["/src/app/data-grid.component.ts"], /dateFormat: 'YYYY-MM-DD',/);

  const intl = applyStarterOverrides("angular", angular, { bucket: "18" });
  assert.match(intl.files["/src/app/data-grid.component.ts"], /dateFormat: \{ year: 'numeric'/);
});

test("an already-ISO angular dataset is left untouched at every bucket", () => {
  // master carries the migrated form; the frozen prod-examples branches do not.
  const angular = {
    "/src/app/data-grid.component.ts": "        dateFormat: 'YYYY-MM-DD',\n        type: 'date',\n",
    "/src/app/utils/constants.ts": "export const data = [[false, 'Tagcat', '2020-10-11']];\n",
  };
  for (const bucket of [...LEGACY_BUCKETS, ...INTL_BUCKETS]) {
    const { files } = applyStarterOverrides("angular", angular, { bucket });
    assert.equal(files["/src/app/utils/constants.ts"], angular["/src/app/utils/constants.ts"], bucket);
  }
});

test("stored-value normalization is idempotent on already-migrated source", () => {
  // master carries the migrated form, the frozen prod-examples branches do not.
  // Zero matches must be success, not a failed count assertion.
  const migrated = {
    "/index.js": jsStarter("'YYYY-MM-DD'")["/index.js"],
    "/src/utils.js": "const randomDate = () => new Date(0).toISOString().slice(0, 10);\n",
    "/package.json": "{}",
  };
  const { files } = applyStarterOverrides("javascript", migrated, { bucket: "18" });
  assert.equal(files["/src/utils.js"], migrated["/src/utils.js"]);

  const stale = { ...migrated, "/src/utils.js": "const d = () => new Date(0).toLocaleDateString('en-gb');\n" };
  const out = applyStarterOverrides("javascript", stale, { bucket: "18" });
  assert.match(out.files["/src/utils.js"], /\.toISOString\(\)\.slice\(0, 10\)/);
  assert.doesNotMatch(out.files["/src/utils.js"], /toLocaleDateString/);
});

test("starterOverrideIds reports what a bucket applies", () => {
  // Storage migration is bucket-independent; only the option literal varies.
  for (const bucket of [...LEGACY_BUCKETS, ...INTL_BUCKETS]) {
    assert.deepEqual(starterOverrideIds("angular", bucket), ["angular:dateFormat", "angular:data-iso"], bucket);
  }
  // The javascript data migration is bucket-independent.
  for (const bucket of [...LEGACY_BUCKETS, ...INTL_BUCKETS]) {
    assert.ok(starterOverrideIds("javascript", bucket).includes("javascript:random-date-iso"), bucket);
  }
  assert.deepEqual(starterOverrideIds("react", "18"), []);
});

test("every registry row targets a distinct (file, option) site", () => {
  const seen = new Set();
  for (const row of OPTION_OVERRIDES) {
    const key = `${row.framework} ${row.file} ${row.option}`;
    assert.equal(seen.has(key), false, `duplicate row for ${key}`);
    seen.add(key);
  }
});
