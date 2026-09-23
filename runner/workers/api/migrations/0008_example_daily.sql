-- ADR-0042 (example analytics) — the permanent daily record. Analytics
-- Engine keeps ~3 months; this table is what a longer-range "which guides
-- get opened" view reads from, recomputed nightly by
-- `reconcile.ts#rollupExampleDaily` for the previous full UTC day.
--
-- `area` is a function of `ref` (a docs guide's breadcrumb never changes
-- which area it is in) but is stored anyway, not joined at read time — this
-- table has no other source of the docs-example taxonomy to join against
-- (the taxonomy lives in the docs-examples JSON, not in D1), and ADR-0042 §5
-- names it as a column explicitly.
--
-- Primary key is (day, kind, ref, framework, ht_major), NOT including area
-- (ADR-0042 §5: "area is a function of ref") — re-running the rollup for a
-- day replaces that day's rows (`rollupExampleDaily` does a real DELETE +
-- INSERT, not a bare INSERT OR REPLACE: a group with zero events on a re-run
-- must disappear, not linger from the previous run).
--
-- No `downloaded` column — ADR-0042 §5 names five counters (opens, engaged,
-- forked, saved, shared) for six `example.*` metrics; `example.downloaded`
-- has no column here by the ADR's own spec (T12 Outcome, flagged as a
-- concern: the raw AE point still exists, just not rolled into this table).
CREATE TABLE IF NOT EXISTS example_daily (
  day       TEXT    NOT NULL,  -- YYYY-MM-DD, UTC
  kind      TEXT    NOT NULL,  -- 'docs' | 'starter' | 'saved' | 'import' | 'payload'
  ref       TEXT    NOT NULL,  -- guide path or starter id
  area      TEXT    NOT NULL,  -- first breadcrumb element (docs only; '' otherwise)
  framework TEXT    NOT NULL,
  ht_major  TEXT    NOT NULL,
  opens     INTEGER NOT NULL DEFAULT 0,
  engaged   INTEGER NOT NULL DEFAULT 0,
  forked    INTEGER NOT NULL DEFAULT 0,
  saved     INTEGER NOT NULL DEFAULT 0,
  shared    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind, ref, framework, ht_major)
);

CREATE INDEX IF NOT EXISTS idx_example_daily_day ON example_daily (day);
