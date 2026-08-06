-- Month-to-date cost ledger (DEV-2030). One row per (day, sku, source):
--
--   source='estimate' — what this Worker metered itself (container awake
--                       seconds, proxied egress, request counts).
--   source='billing'  — the nightly cron's reconciliation against Cloudflare's
--                       own analytics for the prior day.
--
-- A 'billing' row wins over the 'estimate' row for the same (day, sku), so
-- drift in our own accounting self-corrects within 24h instead of compounding
-- across the month. Both are kept: the pair is how we tell whether the
-- estimator is trustworthy (see docs/cost-guardrails.md).

CREATE TABLE IF NOT EXISTS cost_ledger (
  day        TEXT NOT NULL,           -- YYYY-MM-DD (UTC)
  sku        TEXT NOT NULL,           -- 'container' | 'egress' | 'workers' | 'r2'
  source     TEXT NOT NULL,           -- 'estimate' | 'billing'
  units      REAL NOT NULL DEFAULT 0, -- sku-specific (seconds, GB, requests, GB-months)
  usd        REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,        -- epoch ms
  PRIMARY KEY (day, sku, source)
);

CREATE INDEX IF NOT EXISTS idx_cost_ledger_day ON cost_ledger(day);

-- Daily usage counters behind the internal admin panel (GET /api/admin/usage).
-- Aggregated on write — one row per (day, metric, dimension), never one row per
-- event — so the table stays small and no request-level data is retained.
--
--   metric    'session_started' | 'session_denied' | 'build' | 'share_view'
--             | 'embed_view' | 'share_created'
--   dimension framework for sessions and builds, demo id for views, '' when the
--             metric has no useful breakdown.
CREATE TABLE IF NOT EXISTS usage_daily (
  day        TEXT NOT NULL,
  metric     TEXT NOT NULL,
  dimension  TEXT NOT NULL DEFAULT '',
  count      INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day, metric, dimension)
);

CREATE INDEX IF NOT EXISTS idx_usage_daily_day ON usage_daily(day);

-- Marks a revoked demo whose R2 artifacts the nightly GC has already deleted
-- (see gcRevokedArtifacts in src/reconcile.ts). The demos row itself is kept
-- forever so /d/:id keeps answering 410 rather than 404; this column is what
-- stops the GC from re-listing the same empty prefixes every night.
ALTER TABLE demos ADD COLUMN artifacts_purged_at TEXT;
