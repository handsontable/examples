// `writeExampleDaily` and the D1 per-invocation query limit (DEV-3146). D1 counts
// every statement inside `batch()` against the 1000-query limit and caps bound
// parameters at 100 per statement, so rows go in as multi-row VALUES. Runs against
// a real SQLite database built from the real migrations, like example-daily-rollup.test.mjs.
// Run: node --experimental-strip-types --test pipeline/example-daily-statement-budget.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./fixtures/worker-hooks.mjs", import.meta.url);
const { writeExampleDaily, EXAMPLE_DAILY_MAX_STATEMENTS } = await import("../workers/api/src/reconcile.ts");

const migration = (name) => readFileSync(fileURLToPath(new URL(`../workers/api/migrations/${name}`, import.meta.url)), "utf8");

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(migration("0008_example_daily.sql"));
  db.exec(migration("0009_example_daily_downloaded.sql"));
  return db;
}

/** Real SQLite behind the two `env.DB` methods the write uses, recording what D1 would meter. */
function meteredD1(db) {
  const seen = { batches: 0, statements: 0, maxParams: 0 };
  return {
    seen,
    prepare(sql) {
      return {
        bind(...args) {
          seen.maxParams = Math.max(seen.maxParams, args.length);
          return { run: async () => db.prepare(sql).run(...args) };
        },
      };
    },
    async batch(statements) {
      seen.batches += 1;
      seen.statements += statements.length;
      for (const stmt of statements) await stmt.run();
    },
  };
}

const manyRows = (n) =>
  Array.from({ length: n }, (_, i) => ({
    day: "2026-09-22", kind: "docs", ref: `guide-${i}`, area: "Columns", framework: "react", ht_major: "18",
    opens: i, engaged: 1, forked: 0, saved: 2, shared: 0, downloaded: 3,
  }));

const count = (db) => db.prepare("SELECT COUNT(*) AS n FROM example_daily").get().n;

test("100 rows take one batch of 1 + ceil(100/8) statements, each under 100 bound parameters", async () => {
  const db = freshDb();
  const DB = meteredD1(db);
  await writeExampleDaily({ DB }, "2026-09-22", manyRows(100));
  assert.equal(DB.seen.batches, 1);
  assert.equal(DB.seen.statements, 1 + Math.ceil(100 / 8));
  assert.ok(DB.seen.maxParams <= 100, `bound ${DB.seen.maxParams} parameters`);
  assert.equal(count(db), 100);
  const row = db.prepare("SELECT * FROM example_daily WHERE ref = 'guide-99'").get();
  assert.deepEqual([row.opens, row.engaged, row.saved, row.downloaded], [99, 1, 2, 3]);
});

test("a day too big for the statement budget throws BEFORE the DELETE, keeping the previous rows", async () => {
  const db = freshDb();
  await writeExampleDaily({ DB: meteredD1(db) }, "2026-09-22", manyRows(5));
  const DB = meteredD1(db);
  await assert.rejects(
    writeExampleDaily({ DB }, "2026-09-22", manyRows(8 * EXAMPLE_DAILY_MAX_STATEMENTS)),
    /over the 500 budget/,
  );
  assert.equal(DB.seen.batches, 0, "no batch was issued");
  assert.equal(count(db), 5);
});

test("exactly at the budget is still written", async () => {
  const db = freshDb();
  const rows = 8 * (EXAMPLE_DAILY_MAX_STATEMENTS - 1);
  const DB = meteredD1(db);
  await writeExampleDaily({ DB }, "2026-09-22", manyRows(rows));
  assert.equal(DB.seen.statements, EXAMPLE_DAILY_MAX_STATEMENTS);
  assert.equal(count(db), rows);
});
