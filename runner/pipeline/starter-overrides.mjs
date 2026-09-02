// pipeline/starter-overrides.mjs — per-major starter source, applied as a
// pipeline-side overlay (DEV-2545).
//
// WHY THIS EXISTS
//
// Handsontable 18 changed the `date`/`time` cell contract in two coupled ways:
//
//   1. OPTION SHAPE. `dateFormat`/`timeFormat` must be an
//      Intl.DateTimeFormatOptions OBJECT. 18's dateRenderer `valueFormatter`
//      returns the raw value early when it sees a STRING (with a one-per-instance
//      console warning), so a string-formatted column renders unformatted.
//      Below 18 the opposite holds: 15/16/17 feed the option straight into
//      `moment(value, format, true)`, which cannot consume an object — so an
//      object silently fails validation there with no warning at all.
//      The defect class is therefore BIDIRECTIONAL: string-too-late at 18+,
//      object-too-early at 17-. A fix keyed only on "string is bad" misses half.
//
//   2. STORED VALUE. 18's `dateValidator` is `isValidISODate(value)` — it ignores
//      `dateFormat` entirely — and its renderer parses through
//      `parseToLocalDate`, which accepts ONLY strict `YYYY-MM-DD`. So at 18 a
//      date column's DATA must be ISO 8601 regardless of how it is displayed.
//      Swapping only the option on a starter whose data is `DD/MM/YYYY` turns a
//      readable raw value into BAD_VALUE on every row — strictly worse than the
//      bug being fixed. Option shape and stored value must move together.
//
// WHY AN OVERLAY RATHER THAN PER-MAJOR FILES ON DISK
//
// `.github/workflows/import-starters.yml` checks the PIPELINE out from `master`
// but sparse-checks-out `examples/**` at `prod-examples/<major>` when that
// branch exists — and all four of 15/16/17/18 exist. So anything under
// `examples/` reaches bucket 18 only via a commit on `prod-examples/18`, while
// anything under `runner/` reaches every bucket from master. A per-major
// directory under `examples/` is structurally incapable of fixing bucket 18
// from a master PR, and the branches are frozen snapshots in practice (15/16/18
// are 0 commits ahead of master), so maintaining content on them would invent a
// maintenance line that does not exist.
//
// This is the same tradeoff `blank-starters.mjs` already litigated and landed on
// pipeline-side generation for — see its header (lines 9-15), which explicitly
// rejects disk-backed per-major variants that "would have to be hand-committed
// to prod-examples/15 and prod-examples/16 and kept in sync forever".
//
// NOTE the indirection this creates: bucket content is now a TWO-PLACE question
// (source ref + this registry). Reading `examples/angular` on master no longer
// tells you what bucket 16 ships. `importStarters` records the applied override
// ids on the manifest and on each artifact so a bucket artifact answers for
// itself.
//
// SET SEMANTICS, NOT FIND-AND-DOWNGRADE. Every option row rewrites its site to
// the bucket-correct literal regardless of what the source says. This is
// load-bearing: bucket 18 sources from `prod-examples/18` (which carries the
// string) while `next` sources from master (which carries the object), so a
// downgrade-only overlay would leave 18 broken. Set semantics is also idempotent
// and survives future source drift on any branch.
//
// A SECOND OPTION CLASS, A SECOND THRESHOLD (DEV-2734). `numericFormat` has the
// same bidirectional shape problem, but it does NOT change at the same major:
// 18 removed numbro and feeds the option straight into Intl.NumberFormat, while
// Intl support was ADDED in 17.0.0 (handsontable#11997), so 17 accepts either
// shape. Rows therefore declare their own `intlSince` (default 18) rather than
// sharing one predicate. The date rules below stay on 18 deliberately: the
// stored-value coupling they encode is a property of 18's dateValidator, not of
// the option shape.
//
// STATED LIMITATION. This is source-TEXT matching. It cannot evaluate a computed
// value: a `dateFormat: getFormat()` would be invisible to both the rewrite and
// the lint. It is a lint, not a proof — its job is to make the common literal
// case impossible to reintroduce silently.

/**
 * Does this bucket use the Intl-object date/time contract (18+), rather than
 * the moment format-string contract (15/16/17)?
 *
 * Keyed off the BUCKET KEY, never the pinned version — mirroring
 * `isLegacyBucket` in blank-starters.mjs. The "next" bucket pins
 * `0.0.0-next-<sha>-<date>`, whose major parses as 0, so a version-derived
 * check would classify current dev as the oldest legacy bucket.
 */
export function usesIntlDate(bucket) {
  return usesIntlOptions(bucket, 18);
}

/**
 * Is `bucket` at or past the major where an option's Intl contract starts?
 *
 * Split out from `usesIntlDate` because the thresholds differ per option class
 * (see the header): dates change at 18, numbers at 17.
 */
function usesIntlOptions(bucket, since) {
  return bucket === "next" || Number(bucket) >= since;
}

/** The major from which this row's Intl literal is the correct one. */
const intlSince = (row) => row.intlSince ?? 18;

/** Does this row emit its Intl literal at `bucket`? */
const rowUsesIntl = (row, bucket) => usesIntlOptions(bucket, intlSince(row));

// The same Intl.DateTimeFormatOptions literal in each starter's own quote
// style, so an overridden line is indistinguishable from hand-written source.
const INTL_DATE = "{ year: 'numeric', month: '2-digit', day: '2-digit' }";
const INTL_DATE_DQ = '{ year: "numeric", month: "2-digit", day: "2-digit" }';

/**
 * Per-bucket option literals.
 *
 * Each row owns exactly ONE line in one file and replaces that whole line,
 * preserving indentation. `pattern` must match the site whichever shape the
 * source currently carries, so the rewrite is idempotent and branch-agnostic.
 * A row matching zero or two sites THROWS — a source refactor that moves or
 * duplicates the site must be loud, not silently a no-op.
 *
 * The patterns are LINE-SCOPED (`[^\n]*$`), so a row is only correct while its
 * site fits on one line. `assertSingleLineSite` enforces that; see its comment
 * for the silent corruption it exists to prevent.
 */
export const OPTION_OVERRIDES = [
  {
    // The dataset is DD/MM/YYYY on the frozen prod-examples branches and ISO on
    // master; `angular:data-iso` converges both on ISO at EVERY bucket, so the
    // legacy literal is the ISO format string rather than DD/MM/YYYY. This
    // CHANGES buckets 15/16/17, but data and option move together and
    // `moment('2020-10-11','YYYY-MM-DD',true)` is valid, so those buckets stay
    // correct — see the storage note on SOURCE_NORMALIZATIONS.
    id: "angular:dateFormat",
    framework: "angular",
    file: "/src/app/data-grid.component.ts",
    option: "dateFormat",
    pattern: /^([ \t]*)dateFormat:[^\n]*$/m,
    legacy: "dateFormat: 'YYYY-MM-DD',",
    intl: `dateFormat: ${INTL_DATE},`,
  },
  {
    // The javascript starter's data is ALREADY ISO on every branch while its
    // option says DD/MM/YYYY, so at 15/16/17 today
    // `moment('2020-10-11','DD/MM/YYYY',true)` strict-fails and every cell in
    // the column is flagged invalid (correctFormat defaults to false). The
    // legacy literal therefore becomes YYYY-MM-DD: this CHANGES buckets
    // 15/16/17 and fixes a live defect there.
    //
    // The ternary this replaces was `isArabicDemoEnabled() ? 'M/D/YYYY' :
    // 'DD/MM/YYYY'`. Both branches mismatched the ISO data, so the format
    // collapses to one literal; the Arabic demo's locale distinction belongs on
    // a `locale` cell option (18 passes it to Intl.DateTimeFormat), which is
    // left as a follow-up product decision rather than guessed at here.
    id: "javascript:dateFormat",
    framework: "javascript",
    file: "/index.js",
    option: "dateFormat",
    pattern: /^([ \t]*)dateFormat:[^\n]*$/m,
    legacy: "dateFormat: 'YYYY-MM-DD',",
    intl: `dateFormat: ${INTL_DATE},`,
  },
  {
    // Already ISO data with a matching YYYY-MM-DD string: correct at legacy,
    // needs only the object at 18+.
    id: "example1:dateFormat",
    framework: "example1",
    file: "/index.ts",
    option: "dateFormat",
    pattern: /^([ \t]*)dateFormat:[^\n]*$/m,
    legacy: 'dateFormat: "YYYY-MM-DD",',
    intl: `dateFormat: ${INTL_DATE_DQ},`,
  },
  // DEV-2734. example1's numeric columns. Four rows rather than one because the
  // three `numericFormat:` lines are not distinguishable by their own text (two
  // are byte-identical), so each row anchors on the `data:` key of the column it
  // owns via a lookbehind and still rewrites exactly one site.
  //
  // `intlSince: 17`, not the default 18: numbro is only REMOVED at 18, but Intl
  // options are ACCEPTED from 17.0.0 (handsontable#11997), so putting 17 on the
  // Intl side gives it the same rendering as 18 and drops the deprecation
  // warning it logs today.
  {
    // At 18 `{ pattern }` reaches Intl.NumberFormat, which ignores keys it does
    // not know, so the column renders `350,000` with no currency at all. The
    // legacy literal is `$0,0` rather than the source's `$0 0`: numbro reads the
    // space as a literal and emits `$ 350000`, so this CHANGES buckets 15/16 —
    // deliberately, so every bucket renders `$350,000`.
    id: "example1:cost",
    framework: "example1",
    file: "/index.ts",
    option: "numericFormat",
    intlSince: 17,
    pattern: /(?<=data: "cost",\n[ \t]*type: "numeric",\n)([ \t]*)numericFormat:[^\n]*$/m,
    legacy: 'numericFormat: { pattern: "$0,0" },',
    intl: 'numericFormat: { style: "currency", currency: "USD", maximumFractionDigits: 0 },',
  },
  {
    // itemQuality is stored as percent POINTS (87), not a fraction. numbro's
    // `0%` multiplies by 100, so 15/16/17 render `8700%` today — this column was
    // already wrong on every bucket, not only at 18.
    //
    // The Intl literal is `style: "unit"`, NOT `style: "percent"`: percent
    // multiplies by 100 too. Rescaling the data instead was rejected because the
    // numeric editor is TextEditor unmodified and `refreshValue()` seeds it from
    // getSourceDataAtCell — the RAW value — so fractions would open the editor
    // on `0.87` and make a typed `90` render `9,000%`.
    //
    // The cost is that 15/16 render a bare `87`: numbro cannot append a literal
    // `%` without also scaling (`'0 %'` -> `8700 %`, `"0'%'"` -> `8700%`).
    // Magnitude-correct everywhere beats a correct glyph on a wrong number.
    id: "example1:itemQuality",
    framework: "example1",
    file: "/index.ts",
    option: "numericFormat",
    intlSince: 17,
    pattern: /(?<=data: "itemQuality",\n[ \t]*type: "numeric",\n)([ \t]*)numericFormat:[^\n]*$/m,
    legacy: 'numericFormat: { pattern: "0" },',
    intl: 'numericFormat: { style: "unit", unit: "percent" },',
  },
  {
    // The only INSERT row in the registry: no branch carries a `numericFormat`
    // on this column, so there is no line to replace. The site is the
    // `type: "numeric",` line and the optional group swallows an existing option
    // line, which keeps set semantics intact — master carries the line after
    // DEV-2734 and the frozen branches do not, and both converge on these bytes.
    //
    // Without an explicit option, 18 falls back to DEFAULT_INTL_FORMAT
    // (`useGrouping: false`) while the columns above get Intl's default
    // grouping, so one numeric column would group and another would not. Not
    // observable at today's data (quantity tops out at 50); the row states the
    // intent so it stays true if the dataset grows.
    id: "example1:quantity",
    framework: "example1",
    file: "/index.ts",
    option: "numericFormat",
    intlSince: 17,
    pattern: /(?<=data: "quantity",\n)([ \t]*)type: "numeric",(?:\n[ \t]*numericFormat:[^\n]*)?$/m,
    legacy: 'type: "numeric",\nnumericFormat: { pattern: "0,0" },',
    intl: 'type: "numeric",\nnumericFormat: { useGrouping: true },',
  },
  {
    // Same defect and same literals as example1:cost; a separate row because
    // every row owns exactly one site.
    id: "example1:valueStock",
    framework: "example1",
    file: "/index.ts",
    option: "numericFormat",
    intlSince: 17,
    pattern: /(?<=data: "valueStock",\n[ \t]*type: "numeric",\n)([ \t]*)numericFormat:[^\n]*$/m,
    legacy: 'numericFormat: { pattern: "$0,0" },',
    intl: 'numericFormat: { style: "currency", currency: "USD", maximumFractionDigits: 0 },',
  },
  {
    // The MIRROR defect, already shipping. This starter has minCoreMajor 17 and
    // carries the Intl OBJECT, so bucket 17 feeds an object to
    // `moment(value, dateFormat, true)`: cells fail validation and the
    // datepicker mis-seeds, with NO console warning (17 only warns on strings).
    // Fixed entirely by supplying the string equivalent at 17.
    id: "next-shadcn.js:dateFormat",
    framework: "next-shadcn.js",
    file: "/components/DataGrid.tsx",
    option: "dateFormat",
    pattern: /^([ \t]*)dateFormat=[^\n]*$/m,
    legacy: 'dateFormat="YYYY-MM-DD"',
    intl: 'dateFormat={{ year: "numeric", month: "short", day: "2-digit" }}',
  },
  {
    // Same mirror defect through the SIBLING option: 17's timeValidator also
    // feeds `this.timeFormat` into moment. The stored values are "HH:mm"
    // ("06:02"), which is what both contracts parse.
    id: "next-shadcn.js:timeFormat",
    framework: "next-shadcn.js",
    file: "/components/DataGrid.tsx",
    option: "timeFormat",
    pattern: /^([ \t]*)timeFormat=[^\n]*$/m,
    legacy: 'timeFormat="HH:mm"',
    intl: 'timeFormat={{ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }}',
  },
];

/**
 * Stored-value migrations.
 *
 * These are NOT per-bucket literals — they bring a starter's DATA up to the
 * shape its bucket's contract requires. Count-agnostic and self-verifying:
 * every occurrence is replaced and the postcondition is then asserted, so a row
 * is idempotent (master may already carry the migrated form, in which case zero
 * matches is correct) yet still fails loudly if any stale occurrence survives.
 *
 * STORAGE IS UNIFORM, DISPLAY IS PER-BUCKET. ISO 8601 is the one stored shape
 * every supported major accepts — `moment(v,'YYYY-MM-DD',true)` at 15/16/17 and
 * `isValidISODate(v)` at 18+ — so these run at ALL buckets and only the display
 * OPTION varies by bucket. Keeping storage bucket-dependent instead would make
 * a local full regen (which sources master for every bucket) disagree with CI
 * (which sources the frozen prod-examples branches), and pair master's ISO data
 * with a DD/MM option at 15/16/17.
 *
 * `buckets: "intl"` applies only at 18+/next; `"all"` applies everywhere.
 *
 * `expect` is the POSITIVE postcondition, and it is the half that matters.
 * "nothing left matching `pattern`" is trivially true when `pattern` never
 * matched anything, so on its own it cannot tell "the source already carries
 * the migrated form" (success) apart from "the source moved and this row is now
 * dead" (a silent regression that would pair unmigrated data with a migrated
 * option). `expect` must hold on the OUTPUT either way, so a row that stops
 * finding its site fails the import instead of quietly doing nothing.
 */
export const SOURCE_NORMALIZATIONS = [
  {
    // 100 `'DD/MM/YYYY'` literals in the angular dataset -> ISO. Mandatory at 18
    // because dateValidator is `isValidISODate(value)` — it ignores dateFormat
    // entirely — and the renderer parses through the ISO-only parseToLocalDate,
    // while the column sets allowInvalid:false. Swapping only the option there
    // would turn a readable raw value into BAD_VALUE on every row.
    // The pattern is strict (2/2/4 digits): verified to match all 100 date
    // literals and none of the product names ('HL Mountain Seat/Saddle 1'), the
    // only other slash-bearing strings in the file. The transform is DD/MM/YYYY
    // -> YYYY-MM-DD, confirmed against the javascript starter, which is the
    // already-ISO twin of this same dataset ('11/10/2020' <-> '2020-10-11').
    id: "angular:data-iso",
    framework: "angular",
    file: "/src/app/utils/constants.ts",
    buckets: "all",
    pattern: /'(\d{2})\/(\d{2})\/(\d{4})'/g,
    replacement: "'$3-$2-$1'",
    expect: /'\d{4}-\d{2}-\d{2}'/,
  },
  {
    // The dataset arrived with a DD/MM/YYYY normalizer baked into its accessor:
    // `getData()` splits row[4] on "/" and reassembles it as
    // `${year}-${month}-${day}`. That was correct while the literals WERE
    // DD/MM/YYYY. Once `angular:data-iso` above (or DEV-2545 on master) turns
    // them into ISO, the split returns a one-element array and every date
    // reaches the grid as `undefined-undefined-2020-10-11`: at 18+
    // parseToLocalDate rejects it and the column renders BAD_VALUE on every
    // row, at 16/17 moment strict-fails it and allowInvalid:false flags every
    // cell. So a literals-only migration is not enough — the stored value and
    // the code that reads it have to move together. Neither the option rows nor
    // lintStarterOptionShapes could catch this: both read source TEXT, and this
    // is a computed value (the header's STATED LIMITATION). DEV-2563.
    //
    // The replacement is byte-identical to master's post-fix function, so every
    // source ref converges on the same bytes. `expect` must therefore describe
    // THAT text rather than the frozen-branch shape — it is re-tested on the
    // output at every bucket, `next` (which sources master) included.
    id: "angular:data-passthrough",
    framework: "angular",
    file: "/src/app/utils/constants.ts",
    buckets: "all",
    pattern:
      /export function getData\(\) \{\n  return data\.map\(\(row\) => \{\n    const \[day, month, year\] = String\(row\[4\]\)\.split\('\/'\);\n\n    return \[\.\.\.row\.slice\(0, 4\), `\$\{year\}-\$\{month\}-\$\{day\}`, \.\.\.row\.slice\(5\)\];\n  \}\);\n\}/g,
    replacement: "export function getData() {\n  return data.map((row) => [...row]);\n}",
    expect: /return data\.map\(\(row\) => \[\.\.\.row\]\);/,
  },
  {
    // The Arabic demo generates its dates with
    // `toLocaleDateString('en-gb')` = DD/MM/YYYY, while the static dataset in
    // the same starter is ISO. Applied at ALL buckets so the starter is
    // internally consistent and one dateFormat literal covers both branches.
    id: "javascript:random-date-iso",
    framework: "javascript",
    file: "/src/utils.js",
    buckets: "all",
    pattern: /\.toLocaleDateString\('en-gb'\)/g,
    replacement: ".toISOString().slice(0, 10)",
    expect: /\.toISOString\(\)\.slice\(0, 10\)/,
  },
];

/** Cell-type markers that make a `dateFormat`/`timeFormat` load-bearing. */
const DATE_CELL_MARKERS = [
  /type:\s*['"]date['"]/,
  /type=['"]date['"]/,
  /type:\s*['"]time['"]/,
  /type=['"]time['"]/,
];

const hasDateCell = (text) => DATE_CELL_MARKERS.some((re) => re.test(text));

/** Cell-type markers that make a `numericFormat` load-bearing. */
const NUMERIC_CELL_MARKERS = [/type:\s*['"]numeric['"]/, /type=['"]numeric['"]/];

/**
 * Which cell types make each option load-bearing.
 *
 * Per OPTION, not per file: a starter carrying both a date and a numeric column
 * would otherwise have each option demand a registry row on the strength of the
 * other one's cell type.
 */
const OPTION_CELL_MARKERS = {
  dateFormat: DATE_CELL_MARKERS,
  timeFormat: DATE_CELL_MARKERS,
  numericFormat: NUMERIC_CELL_MARKERS,
};

/**
 * Files whose string literals are candidate cell VALUES. Deliberately narrow:
 * the file map also carries READMEs and lockfiles, and a prose line like
 * "renders as 31/12/2020" must not fail a bucket regen.
 */
const SOURCE_EXT = /\.(?:js|jsx|mjs|cjs|ts|tsx|vue|svelte|astro)$/i;

/** A quoted slash-separated date — the shape HOT 18's isValidISODate rejects. */
const SLASH_DATE = /['"]\d{1,2}\/\d{1,2}\/\d{4}['"]/;

function rowsFor(list, framework) {
  return list.filter((row) => row.framework === framework);
}

/** Literal this row emits for `bucket`. */
function literalFor(row, bucket) {
  return rowUsesIntl(row, bucket) ? row.intl : row.legacy;
}

/** Buckets on the legacy side of a row's threshold, for problem messages. */
const legacyBucketList = (row) =>
  ["15", "16", "17"].filter((bucket) => !rowUsesIntl(row, bucket)).join("/");

/** What the legacy literal for this option IS, for problem messages. */
const legacyShapeName = (option) =>
  option === "numericFormat" ? "numbro pattern object" : "format string";

function normalizationApplies(row, bucket) {
  return row.buckets === "all" || usesIntlDate(bucket);
}

/**
 * Refuse to rewrite a site whose value spills past the matched line.
 *
 * The patterns end in `[^\n]*$`, so if a source site is ever wrapped across
 * lines — one added field pushes
 * `dateFormat={{ year: "numeric", month: "short", day: "2-digit" }}` (66 chars)
 * past prettier's 80 and it wraps — the pattern still matches EXACTLY ONE site
 * (`      dateFormat={{`), the count guard passes, and the replacement orphans
 * the remaining `year: ...` / `}}` lines into syntactically invalid source. The
 * shape lint would pass too, because the expected literal IS present. That is a
 * green regen shipping a starter that cannot compile.
 *
 * Balanced braces on the matched text is the cheap invariant that catches it:
 * a complete one-line site closes every brace it opens (0/0 for a quoted
 * string, 1/1 for an object literal, 2/2 for a JSX expression container).
 *
 * Balance, not line count, is what is actually being asserted — which is why an
 * INSERT row (`example1:quantity`, whose pattern spans the anchor line plus an
 * optional option line so the row is correct whether or not the source already
 * carries it) passes this guard while a truncated site still fails it.
 */
function assertSingleLineSite(row, site) {
  const opens = (site.match(/\{/g) ?? []).length;
  const closes = (site.match(/\}/g) ?? []).length;
  if (opens !== closes) {
    throw new Error(
      `[starter-overrides] ${row.id}: the \`${row.option}\` site in ${row.file} spans more than ` +
        `one line (unbalanced braces in ${JSON.stringify(site.trim())}). These rows rewrite a ` +
        `single line — re-join the site or widen the row's pattern.`,
    );
  }
}

/**
 * Rewrite a collected starter file map so it is correct for `bucket`.
 *
 * Returns `{ files, applied }`. MUST run before pinHandsontableDependencies:
 * the pinned /package.json has to stay byte-identical to what the runtime's
 * applyHandsontableVersion re-serializes (the Tier-2 frozen-install fast path
 * only opens while it still hashes to the baked sourceDependencyFingerprint),
 * so the pin gets the last word. No row here touches /package.json, and the
 * ordering must not depend on that staying true.
 */
export function applyStarterOverrides(framework, files, { bucket }) {
  let next = files;
  const applied = [];

  for (const row of rowsFor(OPTION_OVERRIDES, framework)) {
    const text = next[row.file];
    if (text === undefined) {
      throw new Error(
        `[starter-overrides] ${row.id}: target file ${row.file} not found in the ${framework} starter`,
      );
    }
    const global = new RegExp(row.pattern.source, `${row.pattern.flags}g`);
    const matches = text.match(global) ?? [];
    if (matches.length !== 1) {
      throw new Error(
        `[starter-overrides] ${row.id}: expected exactly 1 \`${row.option}\` site in ${row.file}, ` +
          `found ${matches.length}. The starter was refactored — update the registry row.`,
      );
    }
    assertSingleLineSite(row, matches[0]);
    const replaced = text.replace(row.pattern, (...args) => {
      // A FUNCTION replacement, not a string: `example1:cost` emits
      // `{ pattern: "$0,0" }`, and in a string replacement `String.replace`
      // reinterprets `$`-sequences — a numbro pattern like `$'0,0'` would
      // silently splice in the text FOLLOWING the match. Group 1 is the site's
      // indentation, by convention shared by every row.
      const indent = typeof args[1] === "string" ? args[1] : "";
      return indent + literalFor(row, bucket).split("\n").join(`\n${indent}`);
    });
    if (replaced !== text) applied.push(row.id);
    next = { ...next, [row.file]: replaced };
  }

  for (const row of rowsFor(SOURCE_NORMALIZATIONS, framework)) {
    if (!normalizationApplies(row, bucket)) continue;
    const text = next[row.file];
    if (text === undefined) {
      throw new Error(
        `[starter-overrides] ${row.id}: target file ${row.file} not found in the ${framework} starter`,
      );
    }
    const replaced = text.replace(row.pattern, row.replacement);
    // Postcondition, negative half: nothing stale survived. Makes the row
    // idempotent (master may already carry the migrated form) without letting a
    // partial through.
    const residue = new RegExp(row.pattern.source, row.pattern.flags).test(replaced);
    if (residue) {
      throw new Error(
        `[starter-overrides] ${row.id}: ${row.file} still matches ${row.pattern} after migration`,
      );
    }
    // Positive half: the migrated form is actually present. Without this a row
    // whose site moved or was renamed on a frozen branch matches nothing, the
    // negative check passes vacuously, and the bucket ships unmigrated data
    // paired with a migrated option — the exact pairing this module exists to
    // make impossible.
    if (!new RegExp(row.expect.source, row.expect.flags.replace("g", "")).test(replaced)) {
      throw new Error(
        `[starter-overrides] ${row.id}: ${row.file} does not match ${row.expect} after migration. ` +
          `The row found nothing to migrate and the source no longer carries the migrated form — ` +
          `the site moved, so update the row.`,
      );
    }
    if (replaced !== text) applied.push(row.id);
    next = { ...next, [row.file]: replaced };
  }

  return { files: next, applied };
}

/**
 * Validate that every date/time format option a bucket is about to emit has a
 * shape that bucket's Handsontable major supports. Returns problem strings;
 * `importStarters` pushes them into its `problems[]`, which throws.
 *
 * Three rules:
 *   - REGISTERED sites must carry the registry's literal for this bucket.
 *   - COMPLETENESS: any registered option in a file that also declares the
 *     matching cell type and is NOT covered by a row fails generation. This is
 *     what stops the class returning silently — a new or edited starter that
 *     adds a date column cannot reach a bucket until someone declares its
 *     per-major shape here. Coverage is counted PER SITE, not per (file,
 *     option): example1 owns four `numericFormat` sites in one file, so a fifth
 *     column would otherwise inherit their coverage and ship un-linted.
 *   - STORED VALUE at 18+: a starter that declares a date/time cell must not
 *     ship slash-separated date literals. Option shape and stored value are
 *     coupled (see the header), and the first two rules only cover the option —
 *     so without this a starter whose data drifts to `DD/MM/YYYY`, or one whose
 *     date column carries NO dateFormat at all (react, react-js, typescript and
 *     vue are all in that shape today), reaches bucket 18 invisible to both,
 *     and 18's isValidISODate turns every row into BAD_VALUE.
 */
export function lintStarterOptionShapes(framework, files, { bucket }) {
  const problems = [];
  const rows = rowsFor(OPTION_OVERRIDES, framework);

  for (const row of rows) {
    const text = files[row.file];
    if (text === undefined) {
      problems.push(`${framework}: ${row.id} target file ${row.file} is missing`);
      continue;
    }
    const expected = literalFor(row, bucket);
    // Line by line, because an INSERT row's literal spans the anchor line and
    // the option line, and the emitted text carries the site's indentation
    // between them while the registry literal does not.
    if (!expected.split("\n").every((line) => text.includes(line))) {
      problems.push(
        `${framework}: ${row.file} must carry \`${expected}\` at bucket ${bucket} ` +
          `(${
            rowUsesIntl(row, bucket)
              ? `${intlSince(row)}+ needs the Intl object`
              : `${legacyBucketList(row)} need the ${legacyShapeName(row.option)}`
          })`,
      );
    }
  }

  const covered = new Set(rows.map((row) => `${row.file} ${row.option}`));
  // How many sites the registry claims to own per (file, option). A row owns
  // exactly one site — applyStarterOverrides throws otherwise — so this is
  // directly comparable to the number of sites found in the file.
  const declared = new Map();
  for (const row of rows) {
    const key = `${row.file} ${row.option}`;
    declared.set(key, (declared.get(key) ?? 0) + 1);
  }
  for (const [file, text] of Object.entries(files)) {
    if (typeof text !== "string") continue;
    for (const [option, markers] of Object.entries(OPTION_CELL_MARKERS)) {
      if (!markers.some((re) => re.test(text))) continue;
      if (!new RegExp(`\\b${option}\\b`).test(text)) continue;
      const key = `${file} ${option}`;
      if (!covered.has(key)) {
        problems.push(
          `${framework}: ${file} sets \`${option}\` on a matching cell but has no ` +
            `starter-overrides.mjs row declaring its per-major shape (bucket ${bucket})`,
        );
        continue;
      }
      // Registered — but for how many of the sites in this file? Matched as an
      // ASSIGNMENT (`option:` or `option=`) rather than by bare presence, so a
      // mention in a comment or an import cannot inflate the count and red a
      // regen for nothing.
      const sites = (text.match(new RegExp(`\\b${option}\\s*[:=]`, "g")) ?? []).length;
      const owned = declared.get(key) ?? 0;
      if (sites > owned) {
        problems.push(
          `${framework}: ${file} has ${sites} \`${option}\` sites but the registry declares ` +
            `${owned} (bucket ${bucket}). A site with no row of its own is checked by nothing — ` +
            `add a row per site, each anchored on its own column`,
        );
      }
    }
  }

  // Stored values. Scoped to the whole starter, not per file: the cell type is
  // declared in the component and the values live in a sibling constants file.
  const declaresDateCell = Object.values(files).some(
    (text) => typeof text === "string" && hasDateCell(text),
  );
  if (usesIntlDate(bucket) && declaresDateCell) {
    for (const [file, text] of Object.entries(files)) {
      if (typeof text !== "string" || !SOURCE_EXT.test(file)) continue;
      const hit = text.match(SLASH_DATE);
      if (!hit) continue;
      problems.push(
        `${framework}: ${file} carries a slash-separated date literal (${hit[0]}) at bucket ` +
          `${bucket}. Handsontable ${bucket === "next" ? "18+" : bucket}'s dateValidator is ` +
          `isValidISODate and its renderer parses through the ISO-only parseToLocalDate, so a ` +
          `date cell's stored value must be YYYY-MM-DD however it is displayed — add a ` +
          `starter-overrides.mjs SOURCE_NORMALIZATIONS row`,
      );
    }
  }

  return problems;
}

/** Override ids that WOULD apply for a framework at a bucket, for the manifest. */
export function starterOverrideIds(framework, bucket) {
  return [
    ...rowsFor(OPTION_OVERRIDES, framework).map((row) => row.id),
    ...rowsFor(SOURCE_NORMALIZATIONS, framework)
      .filter((row) => normalizationApplies(row, bucket))
      .map((row) => row.id),
  ];
}
