// ADR-0042 §5 — the nightly `example_daily` rollup (`workers/api/src/
// reconcile.ts`, T12).
//
// `pivotExampleDaily` and `previousUtcDay` are pure — tested directly, no I/O.
//
// `writeExampleDaily` is tested against a REAL SQLite database created from
// the REAL migration file (`workers/api/migrations/0008_example_daily.sql`),
// via Node's built-in `node:sqlite` (experimental, Node 22+) — not a
// hand-rolled regex fake of `env.DB`. This is what makes "running the rollup
// twice for one day yields identical rows" a claim about the actual
// `PRIMARY KEY (day, kind, ref, framework, ht_major)` constraint, not about a
// mock that never enforced one.
//
// `queryExampleEventTotals` (the live AE/ClickHouse HTTP read) is NOT
// exercised here — this task has no Analytics Engine credentials
// (COMMON.md) and no live ClickHouse in this run; see the task Outcome for
// what was and was not verified there.
//
// Run: node --experimental-strip-types --test pipeline/example-daily-rollup.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./fixtures/worker-hooks.mjs", import.meta.url);
const { pivotExampleDaily, previousUtcDay, writeExampleDaily } = await import("../workers/api/src/reconcile.ts");

const MIGRATION = readFileSync(
  fileURLToPath(new URL("../workers/api/migrations/0008_example_daily.sql", import.meta.url)),
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

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(MIGRATION);
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
    { day: "2026-09-22", kind: "docs", ref: "guides/x/x.md", area: "Columns", framework: "react", ht_major: "18", opens: 10, engaged: 3, forked: 0, saved: 1, shared: 0 },
    { day: "2026-09-22", kind: "starter", ref: "vue3", area: "", framework: "vue3", ht_major: "18", opens: 4, engaged: 0, forked: 0, saved: 0, shared: 0 },
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
    { day: "2026-09-22", kind: "docs", ref: "guides/x/x.md", area: "Columns", framework: "react", ht_major: "18", opens: 10, engaged: 3, forked: 0, saved: 1, shared: 0 },
  ];
  await writeExampleDaily(env, "2026-09-22", rows);
  await writeExampleDaily(env, "2026-09-22", rows);
  assert.deepEqual(allRows(db), [{ ...rows[0] }]);
});

test("writeExampleDaily: a group that disappears on a re-run is REMOVED, not left stale (why a bare INSERT OR REPLACE is not enough)", async () => {
  const db = freshDb();
  const env = { DB: fakeD1(db) };
  await writeExampleDaily(env, "2026-09-22", [
    { day: "2026-09-22", kind: "docs", ref: "guides/x/x.md", area: "Columns", framework: "react", ht_major: "18", opens: 10, engaged: 0, forked: 0, saved: 0, shared: 0 },
    { day: "2026-09-22", kind: "starter", ref: "vue3", area: "", framework: "vue3", ht_major: "18", opens: 4, engaged: 0, forked: 0, saved: 0, shared: 0 },
  ]);
  // Re-run: the vue3 starter had zero example.* events this time, so the
  // pivot never produces a row for it at all.
  await writeExampleDaily(env, "2026-09-22", [
    { day: "2026-09-22", kind: "docs", ref: "guides/x/x.md", area: "Columns", framework: "react", ht_major: "18", opens: 11, engaged: 1, forked: 0, saved: 0, shared: 0 },
  ]);
  const rows = allRows(db);
  assert.equal(rows.length, 1, "the vue3 row from the first run must be gone");
  assert.equal(rows[0].kind, "docs");
  assert.equal(rows[0].opens, 11);
});

test("writeExampleDaily: never touches a DIFFERENT day's rows", async () => {
  const db = freshDb();
  const env = { DB: fakeD1(db) };
  await writeExampleDaily(env, "2026-09-21", [
    { day: "2026-09-21", kind: "docs", ref: "guides/x/x.md", area: "Columns", framework: "react", ht_major: "18", opens: 5, engaged: 0, forked: 0, saved: 0, shared: 0 },
  ]);
  await writeExampleDaily(env, "2026-09-22", [
    { day: "2026-09-22", kind: "docs", ref: "guides/x/x.md", area: "Columns", framework: "react", ht_major: "18", opens: 9, engaged: 0, forked: 0, saved: 0, shared: 0 },
  ]);
  const rows = allRows(db);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.day === "2026-09-21").opens, 5);
  assert.equal(rows.find((r) => r.day === "2026-09-22").opens, 9);
});
