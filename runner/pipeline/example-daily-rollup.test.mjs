// ADR-0042 §5 — the nightly `example_daily` rollup (`workers/api/src/
// reconcile.ts`, T12).
//
// `pivotExampleDaily` and `previousUtcDay` are pure — tested directly, no I/O.
//
// `writeExampleDaily` is tested against a REAL SQLite database created from
// the REAL migration files (`workers/api/migrations/0008_example_daily.sql`,
// then `0009_example_daily_downloaded.sql`), via Node's built-in `node:sqlite`
// (experimental, Node 22+) — not a hand-rolled regex fake of `env.DB`. This is
// what makes "running the rollup twice for one day yields identical rows" a
// claim about the actual `PRIMARY KEY (day, kind, ref, framework, ht_major)`
// constraint, not about a mock that never enforced one. The dedicated "0009"
// test section further down applies 0008 alone, writes a row, THEN applies
// 0009 — proving the ADD COLUMN is additive against data that predates it,
// the real production ordering.
//
// `queryExampleEventTotals`'s live AE/ClickHouse HTTP read is NOT exercised
// here — this task has no Analytics Engine credentials (COMMON.md) and no
// live ClickHouse in this run; see the task Outcome for what was and was not
// verified there. Its production PRE-FLIGHT config guard (C-I1 fix round: a
// missing AE_SQL_TOKEN/CF_ACCOUNT_ID throws before any `fetch` happens) IS
// exercised below, since it needs no credential or network access at all.
//
// Run: node --experimental-strip-types --test pipeline/example-daily-rollup.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./fixtures/worker-hooks.mjs", import.meta.url);
const { pivotExampleDaily, previousUtcDay, writeExampleDaily, queryExampleEventTotals, rollupExampleDaily } = await import(
  "../workers/api/src/reconcile.ts"
);
const { captures } = await import("./fixtures/sentry-cloudflare-stub.mjs");

const MIGRATION = readFileSync(
  fileURLToPath(new URL("../workers/api/migrations/0008_example_daily.sql", import.meta.url)),
  "utf8",
);
const MIGRATION_0009 = readFileSync(
  fileURLToPath(new URL("../workers/api/migrations/0009_example_daily_downloaded.sql", import.meta.url)),
  "utf8",
);

/** A `node:sqlite`-backed fake of the two `env.DB` methods `writeExampleDaily`
 *  uses (`prepare().bind()` returning something `batch` can run) — enough
 *  surface for this file, not a general D1 fake. */
function fakeD1(db) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() {
              db.prepare(sql).run(...args);
              return { success: true };
            },
          };
        },
      };
    },
    async batch(statements) {
      const results = [];
      for (const stmt of statements) results.push(await stmt.run());
      return results;
    },
  };
}

// Every test in this file runs against 0008 THEN 0009 applied in sequence —
// the real migration order production runs, not a single hand-merged schema
// — so a bug in 0009's ADD COLUMN (wrong type, wrong default, wrong table)
// would show up here exactly as it would against a real D1.
function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(MIGRATION);
  db.exec(MIGRATION_0009);
  return db;
}

/** Plain objects — `node:sqlite`'s `.all()` returns null-prototype rows,
 *  which `assert.deepEqual` treats as unequal to a literal object even when
 *  every field matches. */
function allRows(db) {
  return db
    .prepare("SELECT * FROM example_daily ORDER BY kind, ref, framework, ht_major")
    .all()
    .map((row) => ({ ...row }));
}

// ---- pivotExampleDaily (pure) ---------------------------------------------------

test("pivotExampleDaily: one row per (kind, ref, area, framework, ht_major), one column per metric", () => {
  const rows = pivotExampleDaily("2026-09-22", [
    { metric: "example.open", kind: "docs", ref: "guides/x/x.md", area: "Columns", framework: "react", ht_major: "18", total: 12 },
    { metric: "example.engaged", kind: "docs", ref: "guides/x/x.md", area: "Columns", framework: "react", ht_major: "18", total: 5 },
    { metric: "example.saved", kind: "docs", ref: "guides/x/x.md", area: "Columns", framework: "react", ht_major: "18", total: 1 },
    // A distinct taxonomy tuple (different framework) must not merge with the one above.
    { metric: "example.open", kind: "docs", ref: "guides/x/x.md", area: "Columns", framework: "vue3", ht_major: "18", total: 3 },
  ]);
  assert.equal(rows.length, 2);
  const react = rows.find((r) => r.framework === "react");
  assert.deepEqual(react, {
    day: "2026-09-22",
    kind: "docs",
    ref: "guides/x/x.md",
    area: "Columns",
    framework: "react",
    ht_major: "18",
    opens: 12,
    engaged: 5,
    forked: 0,
    saved: 1,
    shared: 0,
    downloaded: 0,
  });
  const vue = rows.find((r) => r.framework === "vue3");
  assert.equal(vue.opens, 3);
  assert.equal(vue.engaged, 0);
});

test("pivotExampleDaily: rounds a fractional (sampled) AE total to an integer count", () => {
  const [row] = pivotExampleDaily("2026-09-22", [
    { metric: "example.open", kind: "starter", ref: "react", area: "", framework: "react", ht_major: "18", total: 7.6 },
  ]);
  assert.equal(row.opens, 8);
});

test("pivotExampleDaily: an unrecognised index1 value is ignored, not thrown on", () => {
  const rows = pivotExampleDaily("2026-09-22", [
    { metric: "o11y.ingest", kind: "docs", ref: "x", area: "", framework: "react", ht_major: "18", total: 99 },
  ]);
  assert.equal(rows.length, 0);
});

// ADR-0042 §2 names `example.downloaded` as one of the six `example.*`
// metrics; this pins that it is now pivoted into its own `downloaded`
// column (0009_example_daily_downloaded.sql), not silently dropped the way
// an unrecognised metric is above.
test("pivotExampleDaily: example.downloaded is pivoted into its own `downloaded` column", () => {
  const [row] = pivotExampleDaily("2026-09-22", [
    { metric: "example.downloaded", kind: "starter", ref: "react", area: "", framework: "react", ht_major: "18", total: 6 },
  ]);
  assert.equal(row.downloaded, 6);
  assert.equal(row.opens, 0);
});

// ---- previousUtcDay (pure) -------------------------------------------------------

test("previousUtcDay: the day before `now`, UTC, half-open [start, end)", () => {
  const { day, start, end } = previousUtcDay(new Date("2026-09-23T11:38:00Z"));
  assert.equal(day, "2026-09-22");
  assert.equal(start, "2026-09-22 00:00:00");
  assert.equal(end, "2026-09-23 00:00:00");
});

test("previousUtcDay: a `now` right at UTC midnight still resolves the FULL prior day, not the current one", () => {
  const { day, start, end } = previousUtcDay(new Date("2026-09-23T00:00:00Z"));
  assert.equal(day, "2026-09-22");
  assert.equal(start, "2026-09-22 00:00:00");
  assert.equal(end, "2026-09-23 00:00:00");
});

// ---- writeExampleDaily against a real SQLite DB, the real migration -------------

test("writeExampleDaily: writes rows honouring the real PRIMARY KEY", async () => {
  const db = freshDb();
  const env = { DB: fakeD1(db) };
  await writeExampleDaily(env, "2026-09-22", [
    { day: "2026-09-22", kind: "docs", ref: "guides/x/x.md", area: "Columns", framework: "react", ht_major: "18", opens: 10, engaged: 3, forked: 0, saved: 1, shared: 0, downloaded: 0 },
    { day: "2026-09-22", kind: "starter", ref: "vue3", area: "", framework: "vue3", ht_major: "18", opens: 4, engaged: 0, forked: 0, saved: 0, shared: 0, downloaded: 0 },
  ]);
  const rows = allRows(db);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.kind === "docs").opens, 10);
  assert.equal(rows.find((r) => r.kind === "starter").opens, 4);
});

test("writeExampleDaily: running it TWICE for the same day yields identical rows (idempotency)", async () => {
  const db = freshDb();
  const env = { DB: fakeD1(db) };
  const rows = [
    { day: "2026-09-22", kind: "docs", ref: "guides/x/x.md", area: "Columns", framework: "react", ht_major: "18", opens: 10, engaged: 3, forked: 0, saved: 1, shared: 0, downloaded: 0 },
  ];
  await writeExampleDaily(env, "2026-09-22", rows);
  await writeExampleDaily(env, "2026-09-22", rows);
  assert.deepEqual(allRows(db), [{ ...rows[0] }]);
});

test("writeExampleDaily: `downloaded` round-trips through the real column (0009), and stays identical on a re-run", async () => {
  const db = freshDb();
  const env = { DB: fakeD1(db) };
  const rows = [
    { day: "2026-09-22", kind: "docs", ref: "guides/x/x.md", area: "Columns", framework: "react", ht_major: "18", opens: 10, engaged: 3, forked: 0, saved: 1, shared: 0, downloaded: 7 },
  ];
  await writeExampleDaily(env, "2026-09-22", rows);
  assert.equal(allRows(db)[0].downloaded, 7);
  await writeExampleDaily(env, "2026-09-22", rows);
  assert.deepEqual(allRows(db), [{ ...rows[0] }]);
});

test("writeExampleDaily: a group that disappears on a re-run is REMOVED, not left stale (why a bare INSERT OR REPLACE is not enough)", async () => {
  const db = freshDb();
  const env = { DB: fakeD1(db) };
  await writeExampleDaily(env, "2026-09-22", [
    { day: "2026-09-22", kind: "docs", ref: "guides/x/x.md", area: "Columns", framework: "react", ht_major: "18", opens: 10, engaged: 0, forked: 0, saved: 0, shared: 0, downloaded: 0 },
    { day: "2026-09-22", kind: "starter", ref: "vue3", area: "", framework: "vue3", ht_major: "18", opens: 4, engaged: 0, forked: 0, saved: 0, shared: 0, downloaded: 0 },
  ]);
  // Re-run: the vue3 starter had zero example.* events this time, so the
  // pivot never produces a row for it at all.
  await writeExampleDaily(env, "2026-09-22", [
    { day: "2026-09-22", kind: "docs", ref: "guides/x/x.md", area: "Columns", framework: "react", ht_major: "18", opens: 11, engaged: 1, forked: 0, saved: 0, shared: 0, downloaded: 0 },
  ]);
  const rows = allRows(db);
  assert.equal(rows.length, 1, "the vue3 row from the first run must be gone");
  assert.equal(rows[0].kind, "docs");
  assert.equal(rows[0].opens, 11);
});

// ---- C-I1: a misconfigured production AE SQL read must not silently wipe the day ----

test("queryExampleEventTotals: production with no AE_SQL_TOKEN/CF_ACCOUNT_ID THROWS, never returns []", async () => {
  const env = { PREVIEW_HOST: "demos.handsontable.com" }; // production, both secrets absent
  await assert.rejects(
    () => queryExampleEventTotals(env, "2026-09-22 00:00:00", "2026-09-23 00:00:00"),
    /AE_SQL_TOKEN|CF_ACCOUNT_ID/,
  );
});

test("queryExampleEventTotals: production, a 200 response with no data array THROWS, never degrades to []", async () => {
  // A response shape change or a truncated body must not read as "zero
  // events today" either — same C-I1 rule as the missing-credential case
  // above, one step further down the same function.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ meta: [], rows: 0 }), { status: 200 });
  try {
    const env = { PREVIEW_HOST: "demos.handsontable.com", AE_SQL_TOKEN: "tok", CF_ACCOUNT_ID: "acct" };
    await assert.rejects(
      () => queryExampleEventTotals(env, "2026-09-22 00:00:00", "2026-09-23 00:00:00"),
      /no "data" array/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("rollupExampleDaily: a misconfigured production read is refused loudly and never deletes the day's rows", async () => {
  const db = freshDb();
  // `rollupExampleDaily` computes its own `previousUtcDay()` internally, from
  // the real clock — seed the row under THAT day, not a hardcoded literal,
  // or this test would prove nothing on any date but the one it was written
  // on (the DELETE would target a different day than the seeded row, so
  // "the row survives" would pass whether or not the fix is present).
  const { day } = previousUtcDay();
  await writeExampleDaily({ DB: fakeD1(db) }, day, [
    { day, kind: "docs", ref: "guides/x/x.md", area: "Columns", framework: "react", ht_major: "18", opens: 10, engaged: 3, forked: 0, saved: 1, shared: 0, downloaded: 0 },
  ]);
  let batchCalls = 0;
  const spyD1 = { ...fakeD1(db), batch: (...args) => { batchCalls += 1; return fakeD1(db).batch(...args); } };
  const capturesBefore = captures.length;

  const env = { PREVIEW_HOST: "demos.handsontable.com", DB: spyD1 }; // production, no AE_SQL_TOKEN/CF_ACCOUNT_ID
  const result = await rollupExampleDaily(env);

  assert.equal(batchCalls, 0, "writeExampleDaily's DELETE must never run when the read was refused");
  assert.equal(result.rows, 0);
  assert.equal(allRows(db).length, 1, "the prior run's row for the day must survive untouched");
  assert.equal(allRows(db)[0].opens, 10);

  const newCaptures = captures.slice(capturesBefore);
  assert.equal(newCaptures.length, 1, "the refusal must be reported loudly (Sentry)");
  assert.equal(newCaptures[0].kind, "exception");
  assert.deepEqual(newCaptures[0].context, { tags: { context: "example-daily-rollup" } });
});

test("writeExampleDaily: never touches a DIFFERENT day's rows", async () => {
  const db = freshDb();
  const env = { DB: fakeD1(db) };
  await writeExampleDaily(env, "2026-09-21", [
    { day: "2026-09-21", kind: "docs", ref: "guides/x/x.md", area: "Columns", framework: "react", ht_major: "18", opens: 5, engaged: 0, forked: 0, saved: 0, shared: 0, downloaded: 0 },
  ]);
  await writeExampleDaily(env, "2026-09-22", [
    { day: "2026-09-22", kind: "docs", ref: "guides/x/x.md", area: "Columns", framework: "react", ht_major: "18", opens: 9, engaged: 0, forked: 0, saved: 0, shared: 0, downloaded: 0 },
  ]);
  const rows = allRows(db);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.day === "2026-09-21").opens, 5);
  assert.equal(rows.find((r) => r.day === "2026-09-22").opens, 9);
});

// ---- 0009_example_daily_downloaded.sql: additive, safe on production data ----

test("0009: applying it AFTER 0008 against a row already written adds `downloaded` defaulted to 0, every other column untouched", () => {
  // Deliberately does NOT go through `freshDb()` (which already applies both
  // migrations) — this test's whole point is the ORDER production runs in:
  // 0008 ships first (already applied against real data), a row is written
  // under the five-counter schema, and ONLY THEN does 0009 land. This is the
  // "safe on production data" claim from the migration file's own header,
  // proven against a real SQLite schema change, not asserted in prose.
  const db = new DatabaseSync(":memory:");
  db.exec(MIGRATION); // 0008 only
  db.exec(
    `INSERT INTO example_daily (day, kind, ref, area, framework, ht_major, opens, engaged, forked, saved, shared)
     VALUES ('2026-09-22', 'docs', 'guides/x/x.md', 'Columns', 'react', '18', 10, 3, 0, 1, 0)`,
  );
  // Pre-migration sanity: the column genuinely does not exist yet.
  assert.throws(() => db.prepare("SELECT downloaded FROM example_daily").get(), /no such column/);

  db.exec(MIGRATION_0009); // 0009, applied after real data already exists

  const row = { ...db.prepare("SELECT * FROM example_daily").get() };
  assert.equal(row.downloaded, 0, "a pre-existing row backfills to downloaded = 0, never null or an error");
  assert.equal(row.opens, 10, "every pre-existing column is untouched by the ADD COLUMN");
  assert.equal(row.engaged, 3);
  assert.equal(row.forked, 0);
  assert.equal(row.saved, 1);
  assert.equal(row.shared, 0);

  // A fresh write after 0009 lands can now populate a real downloaded count
  // on the SAME row, exactly like any other counter.
  db.exec("UPDATE example_daily SET downloaded = 4 WHERE day = '2026-09-22'");
  assert.equal(db.prepare("SELECT downloaded FROM example_daily").get().downloaded, 4);
});
