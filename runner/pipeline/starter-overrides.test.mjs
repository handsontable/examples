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

/**
 * Copy of `ISO_DATE_REGEX` from handsontable/helpers/dateTime (18.0.0) — the
 * only shape `parseToLocalDate` and `isValidISODate` accept. Copied rather than
 * imported so this file stays hermetic; if core ever widens it, this test gets
 * stricter than core, never looser.
 */
const ISO_DATE_REGEX = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** The two accessor shapes that exist in the wild: the frozen branches' DD/MM
 *  normalizer (byte-identical to `examples/angular`, which is what pins the
 *  registry pattern) and master's post-DEV-2563 pass-through. */
const ANGULAR_ACCESSORS = {
  split: [
    "export function getData() {",
    "  return data.map((row) => {",
    "    const [day, month, year] = String(row[4]).split('/');",
    "",
    "    return [...row.slice(0, 4), `${year}-${month}-${day}`, ...row.slice(5)];",
    "  });",
    "}",
  ].join("\n"),
  passthrough: ["export function getData() {", "  return data.map((row) => [...row]);", "}"].join(
    "\n",
  ),
};

const ANGULAR_DATES = {
  slash: ["'11/10/2020'", "'03/05/2020'", "'27/03/2020'"],
  iso: ["'2020-10-11'", "'2020-05-03'", "'2020-03-27'"],
};

/** The date column is \`data: 4\`, and the accessor reads \`row[4]\` — so a
 *  fixture row has to be index-accurate or the corruption never happens and the
 *  test passes for the wrong reason. */
const DATE_INDEX = 4;

const angularStarter = ({ dates, accessor }) => ({
  "/src/app/data-grid.component.ts": [
    "export class DataGridComponent {",
    "  gridSettings = {",
    "    columns: [",
    "      {",
    `        data: ${DATE_INDEX},`,
    "        type: 'date',",
    "        dateFormat: 'DD/MM/YYYY',",
    "        locale: 'en-GB',",
    "        allowInvalid: false,",
    "      },",
    "    ],",
    "  };",
    "}",
  ].join("\n"),
  "/src/app/utils/constants.ts": [
    "export const data = [",
    ...ANGULAR_DATES[dates].map((date) =>
      [
        "  [",
        "    false,",
        "    'Tagcat',",
        "    'United Kingdom',",
        "    'Classic Vest',",
        `    ${date},`,
        "    '01-2331942',",
        "    true,",
        "  ],",
      ].join("\n"),
    ),
    "];",
    "",
    ANGULAR_ACCESSORS[accessor],
    "",
  ].join("\n"),
  "/package.json": '{\n  "name": "angular"\n}\n',
});

/** Evaluate an emitted constants module and return the date column's values. */
const sellDates = (source) =>
  new Function(`${source.replace(/^export /gm, "")}\nreturn getData();`)().map(
    (row) => row[DATE_INDEX],
  );

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

test("a site wrapped across lines throws instead of being corrupted in place", () => {
  // The patterns are line-scoped, so a wrapped site still matches EXACTLY ONE
  // site (`dateFormat: {`), the count guard passes, and the replacement would
  // orphan the remaining lines into invalid source — while the shape lint still
  // passes, because the expected literal IS present. Green regen, dead starter.
  const wrapped = {
    "/index.js": [
      "columns: [",
      "  {",
      "    type: 'date',",
      "    dateFormat: {",
      "      year: 'numeric',",
      "      month: '2-digit',",
      "    },",
      "  },",
      "]",
    ].join("\n"),
    "/src/utils.js": "const d = () => new Date(0).toISOString().slice(0, 10);\n",
    "/package.json": "{}",
  };

  // Precondition: this is the dangerous case, not the already-loud one.
  const sites = wrapped["/index.js"].match(/^([ \t]*)dateFormat:[^\n]*$/gm);
  assert.equal(sites.length, 1, "exactly one match, so the count guard cannot catch it");

  assert.throws(
    () => applyStarterOverrides("javascript", wrapped, { bucket: "17" }),
    /spans more than one line/,
  );
});

test("every registry site in the real starters is single-line today", () => {
  // The guard above is only useful if it is not already tripping.
  for (const shape of ["'DD/MM/YYYY'", "{ year: 'numeric', month: '2-digit', day: '2-digit' }"]) {
    assert.doesNotThrow(() =>
      applyStarterOverrides("javascript", jsStarter(shape), { bucket: "18" }),
    );
  }
});

test("a normalization row whose site moved throws instead of silently no-opping", () => {
  // "nothing left matching `pattern`" is trivially true when `pattern` never
  // matched, so the negative postcondition alone cannot tell "already migrated"
  // from "this row is now dead". Renaming the call is exactly how a frozen
  // branch would drift out from under a row.
  const drifted = {
    "/index.js": jsStarter("'DD/MM/YYYY'")["/index.js"],
    "/src/utils.js": "const d = () => new Date(0).toLocaleDateString('en-GB');\n",
    "/package.json": "{}",
  };
  assert.throws(
    () => applyStarterOverrides("javascript", drifted, { bucket: "18" }),
    /javascript:random-date-iso: \/src\/utils\.js does not match .* after migration/,
  );
});

test("stored slash-dates fail the lint at 18 and next, whatever the option says", () => {
  // Option shape and stored value are coupled: 18's dateValidator is
  // isValidISODate and ignores dateFormat entirely, so a correct Intl object
  // over DD/MM data is BAD_VALUE on every row.
  const files = {
    "/src/index.tsx": '<HotColumn data={4} type="date" />\n',
    "/src/constants.ts": 'export const data = [["Tagcat", "11/10/2020"]];\n',
  };
  for (const bucket of INTL_BUCKETS) {
    const problems = lintStarterOptionShapes("react", files, { bucket });
    assert.equal(problems.length, 1, `${bucket}: ${JSON.stringify(problems)}`);
    assert.match(problems[0], /slash-separated date literal/);
    assert.match(problems[0], /\/src\/constants\.ts/);
  }
  // Below 18 the format string parses DD/MM/YYYY, so storage is not linted.
  for (const bucket of LEGACY_BUCKETS) {
    assert.deepEqual(lintStarterOptionShapes("react", files, { bucket }), [], bucket);
  }
});

test("the stored-value rule covers date columns that carry no dateFormat at all", () => {
  // react, react-js, typescript and vue are all in this shape today: a date
  // column with no dateFormat is invisible to both option rules, so without
  // this rule nothing at all guards their data.
  const files = { "/src/index.tsx": 'const d = "11/10/2020";\n<HotColumn type="date" />\n' };
  assert.equal(lintStarterOptionShapes("react", files, { bucket: "18" }).length, 1);
});

test("the stored-value rule ignores prose and starters with no date cell", () => {
  // A README line would otherwise fail a whole bucket regen.
  const prose = {
    "/src/index.tsx": '<HotColumn data={4} type="date" />\n',
    "/README.md": "Dates render as 31/12/2020 in the grid.\n",
    "/src/constants.ts": 'export const data = [["Tagcat", "2020-10-11"]];\n',
  };
  assert.deepEqual(lintStarterOptionShapes("react", prose, { bucket: "18" }), []);

  // No date/time cell anywhere: a slash-date is just a string.
  const noCell = { "/src/index.tsx": 'const label = "11/10/2020";\n' };
  assert.deepEqual(lintStarterOptionShapes("react", noCell, { bucket: "18" }), []);
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
    "/src/app/utils/constants.ts":
      "export const data = [[false, 'Tagcat', '11/10/2020'], [true, 'Zoomzone', '03/05/2020']];\n" +
      `\n${ANGULAR_ACCESSORS.passthrough}\n`,
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
    "/src/app/utils/constants.ts":
      "export const data = [[false, 'Tagcat', '2020-10-11']];\n" +
      `\n${ANGULAR_ACCESSORS.passthrough}\n`,
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
    assert.deepEqual(
      starterOverrideIds("angular", bucket),
      ["angular:dateFormat", "angular:data-iso", "angular:data-passthrough"],
      bucket,
    );
  }
  // The javascript data migration is bucket-independent.
  for (const bucket of [...LEGACY_BUCKETS, ...INTL_BUCKETS]) {
    assert.ok(starterOverrideIds("javascript", bucket).includes("javascript:random-date-iso"), bucket);
  }
  assert.deepEqual(starterOverrideIds("react", "18"), []);
});

test("every registry row targets a distinct site", () => {
  // Keyed on the PATTERN, not on (file, option): example1 owns four
  // `numericFormat` sites in one file, each anchored on its own `data:` key, so
  // (file, option) is legitimately shared. Two rows sharing a pattern would
  // fight over the same line, and whichever ran second would win silently.
  const seen = new Set();
  for (const row of OPTION_OVERRIDES) {
    const key = `${row.framework} ${row.file} ${row.pattern.source}`;
    assert.equal(seen.has(key), false, `duplicate row for ${key}`);
    seen.add(key);
  }
  // Ids stay unique too — they are what the manifest records.
  const ids = [...OPTION_OVERRIDES, ...SOURCE_NORMALIZATIONS].map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length);
});

// DEV-2563. Both registries and the lint read source TEXT, so a starter that
// REFORMATS its stored value at runtime is invisible to all three. The angular
// dataset shipped with a DD/MM/YYYY normalizer inside `getData()`; once
// `angular:data-iso` migrated the literals under it, the split returned a
// one-element array and every date reached the grid as
// `undefined-undefined-2020-10-11` — BAD_VALUE on every row at 18+, every cell
// invalid at 16/17. Every text assertion above passed while that shipped, which
// is the whole reason this test EXECUTES the emitted module and inspects the
// value the grid would actually receive.

test("the angular date column reaches the grid as ISO at every bucket", () => {
  // Every combination, because the overlay must converge them: the frozen
  // branches are slash+split, master is iso+pass-through, and iso+split is the
  // corrupted pairing DEV-2545 created and DEV-2563 closed.
  for (const accessor of Object.keys(ANGULAR_ACCESSORS)) {
    for (const dates of Object.keys(ANGULAR_DATES)) {
      for (const bucket of [...LEGACY_BUCKETS, ...INTL_BUCKETS]) {
        const label = `${dates}+${accessor} @ ${bucket}`;
        const { files } = applyStarterOverrides("angular", angularStarter({ dates, accessor }), {
          bucket,
        });

        for (const value of sellDates(files["/src/app/utils/constants.ts"])) {
          assert.match(value, ISO_DATE_REGEX, `${label}: ${JSON.stringify(value)}`);
        }
        assert.deepEqual(lintStarterOptionShapes("angular", files, { bucket }), [], label);
      }
    }
  }
});

test("the emitted angular accessor is byte-identical whatever the source ref", () => {
  // Convergence is what lets a frozen branch be brought to master's state
  // without the registry rows going stale: they become no-ops that still assert.
  const emitted = new Set();
  for (const accessor of Object.keys(ANGULAR_ACCESSORS)) {
    for (const dates of Object.keys(ANGULAR_DATES)) {
      const { files } = applyStarterOverrides("angular", angularStarter({ dates, accessor }), {
        bucket: "18",
      });
      emitted.add(files["/src/app/utils/constants.ts"].slice(files["/src/app/utils/constants.ts"].indexOf("function getData")));
    }
  }
  assert.equal(emitted.size, 1, [...emitted].join("\n---\n"));
});

// DEV-2734. `numericFormat` is the second option class to split per major, and
// it splits one major EARLIER than the date options: numbro was removed in 18,
// but Intl.NumberFormat support landed in 17.0.0 (handsontable#11997), so 17
// accepts both shapes. The rows therefore carry `intlSince: 17` while the
// date rows keep the default 18 — the two thresholds have to coexist in one
// registry, and in one file.

const example1Starter = ({ numeric = "numbro", quantityFormat = false } = {}) => ({
  "/index.ts": [
    "const data = [",
    '  { cost: 350000, itemQuality: 87, valueStock: 700000, quantity: 2, date: "2020-10-11" },',
    "];",
    "",
    "const settings = {",
    "  columns: [",
    "    {",
    '      data: "cost",',
    '      type: "numeric",',
    numeric === "numbro"
      ? '      numericFormat: { pattern: "$0 0" },'
      : '      numericFormat: { style: "currency", currency: "USD", maximumFractionDigits: 0 },',
    '      className: "htRight",',
    "    },",
    "    {",
    '      data: "itemQuality",',
    '      type: "numeric",',
    numeric === "numbro"
      ? '      numericFormat: { pattern: "0%" },'
      : '      numericFormat: { style: "unit", unit: "percent" },',
    '      className: "htRight",',
    "    },",
    "    {",
    '      data: "quantity",',
    '      type: "numeric",',
    ...(quantityFormat ? ['      numericFormat: { useGrouping: true },'] : []),
    '      className: "htRight",',
    "    },",
    "    {",
    '      data: "valueStock",',
    '      type: "numeric",',
    numeric === "numbro"
      ? '      numericFormat: { pattern: "$0 0" },'
      : '      numericFormat: { style: "currency", currency: "USD", maximumFractionDigits: 0 },',
    '      className: "htRight",',
    "    },",
    "    {",
    '      data: "date",',
    '      type: "date",',
    '      dateFormat: "YYYY-MM-DD",',
    "    },",
    "  ],",
    "};",
  ].join("\n"),
  "/package.json": '{\n  "name": "example1"\n}\n',
});

/** Buckets on the numbro side of `numericFormat`'s 17.0.0 threshold. */
const NUMBRO_BUCKETS = ["15", "16"];
/** Buckets on the Intl side of it — note 17, which is legacy for dateFormat. */
const INTL_NUMBER_BUCKETS = ["17", "18", "next"];

test("numericFormat splits at 17 while dateFormat in the same file still splits at 18", () => {
  // The whole reason `intlSince` exists. Bucket 17 must come out of a single
  // pass with an Intl numericFormat AND a moment dateFormat string.
  const { files } = applyStarterOverrides("example1", example1Starter(), { bucket: "17" });
  assert.match(files["/index.ts"], /numericFormat: \{ style: "currency", currency: "USD", maximumFractionDigits: 0 \},/);
  assert.match(files["/index.ts"], /dateFormat: "YYYY-MM-DD",/);
  assert.doesNotMatch(files["/index.ts"], /pattern:/);
});

test("the numeric rows set the bucket-correct literal whatever the source says", () => {
  // Set semantics: bucket 18 sources from prod-examples/18 (numbro pattern)
  // while next sources from master (Intl), so neither direction may be assumed.
  for (const numeric of ["numbro", "intl"]) {
    for (const bucket of NUMBRO_BUCKETS) {
      const { files } = applyStarterOverrides("example1", example1Starter({ numeric }), { bucket });
      const source = files["/index.ts"];
      assert.equal(source.match(/numericFormat: \{ pattern: "\$0,0" \},/g).length, 2, `${numeric} @ ${bucket}`);
      assert.match(source, /numericFormat: \{ pattern: "0" \},/, `${numeric} @ ${bucket}`);
      assert.doesNotMatch(source, /style:/, `${numeric} @ ${bucket}`);
    }
    for (const bucket of INTL_NUMBER_BUCKETS) {
      const { files } = applyStarterOverrides("example1", example1Starter({ numeric }), { bucket });
      const source = files["/index.ts"];
      assert.equal(
        source.match(/numericFormat: \{ style: "currency", currency: "USD", maximumFractionDigits: 0 \},/g).length,
        2,
        `${numeric} @ ${bucket}`,
      );
      assert.match(source, /numericFormat: \{ style: "unit", unit: "percent" \},/, `${numeric} @ ${bucket}`);
      assert.doesNotMatch(source, /pattern:/, `${numeric} @ ${bucket}`);
    }
  }
});

test("a currency literal containing $ is emitted verbatim, not read as a capture reference", () => {
  // `"$0,0"` is the first registry literal to carry a `$`. With a STRING
  // replacement, `String.replace` would reinterpret `$'`/`$&`/`$1` sequences —
  // and a future numbro pattern like `$'0,0'` would silently emit the text
  // FOLLOWING the match. The replacement is a function so no such expansion
  // can happen.
  const { files } = applyStarterOverrides("example1", example1Starter(), { bucket: "16" });
  assert.match(files["/index.ts"], /numericFormat: \{ pattern: "\$0,0" \},/);
});

test("the quantity row emits its option whether or not the source carries the line", () => {
  // No branch has this line today, so the row has to INSERT it; master will
  // carry it after this change, so the row must also be a no-op there. Both
  // sources must converge on the same bytes.
  const emitted = new Set();
  for (const quantityFormat of [false, true]) {
    for (const bucket of [...NUMBRO_BUCKETS, ...INTL_NUMBER_BUCKETS]) {
      const { files } = applyStarterOverrides("example1", example1Starter({ quantityFormat }), {
        bucket,
      });
      const block = files["/index.ts"].match(/data: "quantity",\n[\s\S]*?\n {4}\},/)[0];
      assert.match(block, /numericFormat:/, `${quantityFormat} @ ${bucket}`);
      emitted.add(`${bucket}\n${block}`);
    }
  }
  // Two source shapes x six buckets, but only one emitted block per bucket.
  assert.equal(emitted.size, [...NUMBRO_BUCKETS, ...INTL_NUMBER_BUCKETS].length, [...emitted].join("\n---\n"));
});

test("an inserted multi-line literal is indented to its site", () => {
  const { files } = applyStarterOverrides("example1", example1Starter(), { bucket: "18" });
  assert.match(files["/index.ts"], /\n {6}type: "numeric",\n {6}numericFormat: \{ useGrouping: true \},/);
});

test("applyStarterOverrides is idempotent for the numeric rows", () => {
  for (const bucket of [...NUMBRO_BUCKETS, ...INTL_NUMBER_BUCKETS]) {
    const once = applyStarterOverrides("example1", example1Starter(), { bucket });
    const twice = applyStarterOverrides("example1", once.files, { bucket });
    assert.deepEqual(twice.files, once.files, bucket);
    assert.deepEqual(twice.applied, [], bucket);
  }
});

test("example1's overlay output satisfies its own lint at every bucket", () => {
  for (const numeric of ["numbro", "intl"]) {
    for (const bucket of [...NUMBRO_BUCKETS, ...INTL_NUMBER_BUCKETS]) {
      const { files } = applyStarterOverrides("example1", example1Starter({ numeric }), { bucket });
      assert.deepEqual(lintStarterOptionShapes("example1", files, { bucket }), [], `${numeric} @ ${bucket}`);
    }
  }
});

test("a numbro numericFormat is a problem from 17 up, an Intl one below it", () => {
  for (const bucket of INTL_NUMBER_BUCKETS) {
    const problems = lintStarterOptionShapes("example1", example1Starter(), { bucket });
    assert.ok(problems.length > 0, bucket);
    assert.match(problems.join("\n"), /17\+ needs the Intl object/, bucket);
  }
  for (const bucket of NUMBRO_BUCKETS) {
    const problems = lintStarterOptionShapes("example1", example1Starter({ numeric: "intl" }), {
      bucket,
    });
    assert.ok(problems.length > 0, bucket);
    assert.match(problems.join("\n"), /15\/16 need the numbro pattern object/, bucket);
  }
});

test("a fifth numeric column is caught even though four are registered", () => {
  // The granularity trap the numeric rows introduced. Coverage used to be keyed
  // by (file, option), which was equivalent while every registered file had
  // exactly ONE site; example1 has four, so a new column would have inherited
  // their coverage — invisible to rule 1 (no row checks it) AND to rule 2
  // (already "covered"), and shipping at every bucket.
  const rogue = applyStarterOverrides("example1", example1Starter(), { bucket: "18" }).files;
  rogue["/index.ts"] = rogue["/index.ts"].replace(
    '      data: "cost",',
    [
      '      data: "rogue",',
      '      type: "numeric",',
      '      numericFormat: { pattern: "unvetted" },',
      "    },",
      "    {",
      '      data: "cost",',
    ].join("\n"),
  );
  const problems = lintStarterOptionShapes("example1", rogue, { bucket: "18" });
  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.match(problems[0], /has 5 `numericFormat` sites but the registry declares 4/);
});

test("a mention of an option in a comment does not inflate the site count", () => {
  // The count matches an ASSIGNMENT, not bare presence: a false positive here
  // reds a bucket regen for nothing, and the fix would look like weakening the
  // lint.
  const files = applyStarterOverrides("example1", example1Starter(), { bucket: "18" }).files;
  files["/index.ts"] = `// numericFormat is documented at handsontable.com\n${files["/index.ts"]}`;
  assert.deepEqual(lintStarterOptionShapes("example1", files, { bucket: "18" }), []);
});

test("an unregistered starter with a numeric column fails registry completeness", () => {
  const files = {
    "/src/Grid.vue": "columns: [{ type: 'numeric', numericFormat: { pattern: '0,0' } }]\n",
  };
  const problems = lintStarterOptionShapes("vue", files, { bucket: "18" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /numericFormat/);
  assert.match(problems[0], /no starter-overrides\.mjs row declaring its per-major shape/);
});

test("numericFormat with no numeric cell type is not flagged", () => {
  // A helper module that builds an option object it never attaches to a column.
  const files = { "/src/format.ts": "export const numericFormat = { pattern: '0,0' };\n" };
  for (const bucket of [...NUMBRO_BUCKETS, ...INTL_NUMBER_BUCKETS]) {
    assert.deepEqual(lintStarterOptionShapes("vue", files, { bucket }), [], bucket);
  }
});

test("a date column does not make numericFormat load-bearing, or the reverse", () => {
  // The completeness gate is per option, not per file: mixing the two markers
  // in one file must not make either option demand a row it does not need.
  const dateOnly = { "/src/Grid.vue": "columns: [{ type: 'date' }]\nconst numericFormat = {};\n" };
  assert.deepEqual(lintStarterOptionShapes("vue", dateOnly, { bucket: "18" }), []);

  const numericOnly = { "/src/Grid.vue": "columns: [{ type: 'numeric' }]\nconst dateFormat = {};\n" };
  assert.deepEqual(lintStarterOptionShapes("vue", numericOnly, { bucket: "18" }), []);
});

test("starterOverrideIds reports example1's numeric rows at every bucket", () => {
  for (const bucket of [...NUMBRO_BUCKETS, ...INTL_NUMBER_BUCKETS]) {
    assert.deepEqual(
      starterOverrideIds("example1", bucket),
      [
        "example1:dateFormat",
        "example1:cost",
        "example1:itemQuality",
        "example1:quantity",
        "example1:valueStock",
      ],
      bucket,
    );
  }
});
