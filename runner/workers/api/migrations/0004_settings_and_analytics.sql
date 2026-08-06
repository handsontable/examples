-- Runtime-editable guardrail settings + anonymous audience analytics
-- (DEV-2030 follow-up).

-- runner_settings: small key/value store for things the team must be able to
-- change without a deploy. Today that is the budget configuration (the dollar
-- thresholds and the enforcement switch); the wrangler.jsonc vars remain the
-- defaults it falls back to. `updated_by` is the audit trail — changing the
-- ceiling is a decision, not a preference.
CREATE TABLE IF NOT EXISTS runner_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,        -- JSON
  updated_at TEXT NOT NULL,        -- ISO8601
  updated_by TEXT NOT NULL         -- verified @handsontable.com email
);

-- cost_alerts: which in-app spend alerts have already fired this month, so a
-- threshold notifies once per billing month instead of every night.
CREATE TABLE IF NOT EXISTS cost_alerts (
  month     TEXT NOT NULL,         -- YYYY-MM (UTC)
  threshold REAL NOT NULL,         -- USD
  spend_usd REAL NOT NULL,         -- month-to-date spend when it fired
  fired_at  TEXT NOT NULL,
  PRIMARY KEY (month, threshold)
);

-- analytics_daily: audience counters, aggregated at write time into
-- (day, dimension, value) buckets. Deliberately coarse — this is a simplified,
-- anonymous analytics view, not a tracking system:
--
--   dimension  'views'  (value '' — total page views)
--              'page'      normalised path (/d/:id, /embed/:id, /edit, …)
--              'demo'      demo id, for shared/embedded demos
--              'referrer'  referring *hostname* only (never a full URL)
--              'country'   two-letter code from Cloudflare's edge
--              'device'    desktop | mobile | tablet
--              'browser'   chrome | safari | firefox | edge | other
--              'os'        windows | macos | linux | ios | android | other
--              'language'  primary language subtag (en, pl, …)
--              'bot'       'bot' — requests filtered out of every other bucket
--
-- No URLs with query strings, no user agents, no IPs, no per-request rows.
CREATE TABLE IF NOT EXISTS analytics_daily (
  day        TEXT NOT NULL,
  dimension  TEXT NOT NULL,
  value      TEXT NOT NULL DEFAULT '',
  views      INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day, dimension, value)
);

CREATE INDEX IF NOT EXISTS idx_analytics_daily_day ON analytics_daily(day);

-- analytics_visitors: one row per (day, anonymous visitor) so unique visitors
-- can be counted without storing anything identifying.
--
-- `visitor` is a truncated SHA-256 of (daily rotating random salt + IP + user
-- agent). The salt lives in KV for ~48h and is then gone, so the hashes are
-- one-way, unlinkable across days, and cannot be re-derived from a known IP
-- once the salt has rotated. This is the Plausible/Fathom approach: no
-- cookies, no cross-day identity, no way back to a person.
CREATE TABLE IF NOT EXISTS analytics_visitors (
  day     TEXT NOT NULL,
  visitor TEXT NOT NULL,
  PRIMARY KEY (day, visitor)
);
