-- D1 schema for the demo runner. Applied to database `handsontable-demos`
-- (uuid 5fc0854f-d348-487f-9531-2c44cc86d182, region EEUR) in the main
-- Handsontable account 15111272c53ed0aaf84a908f0c9c7f8b on 2026-07-08.
--
-- demos: one row per shared, prebuilt-static demo (short id -> R2 artifact).
-- Internal per-user ownership via created_by (verified @handsontable.com email).

CREATE TABLE IF NOT EXISTS demos (
  id           TEXT PRIMARY KEY,           -- short id used in /d/:id and /embed/:id
  title        TEXT NOT NULL,
  description  TEXT,                        -- author-provided, shown to client
  framework    TEXT NOT NULL,              -- catalog example key
  tier         INTEGER NOT NULL,           -- 1 | 2
  ht_version   TEXT NOT NULL,              -- resolved semver or pkg.pr.new ref
  files_hash   TEXT NOT NULL,              -- sha256 of snapshot files
  r2_prefix    TEXT NOT NULL,              -- R2 path of source snapshot + built artifact
  forked_from  TEXT,                        -- source demo id, or "catalog:<framework>"
  visibility   TEXT NOT NULL DEFAULT 'unlisted',  -- 'public' | 'unlisted'
  revoked      INTEGER NOT NULL DEFAULT 0,        -- 1 -> GET returns 410
  created_by   TEXT NOT NULL,              -- @handsontable.com email (from login broker)
  created_at   TEXT NOT NULL,              -- ISO8601
  updated_at   TEXT NOT NULL,
  revoked_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_demos_framework ON demos(framework);
CREATE INDEX IF NOT EXISTS idx_demos_created_by ON demos(created_by);   -- powers "My demos"
CREATE INDEX IF NOT EXISTS idx_demos_forked_from ON demos(forked_from);
-- Non-unique: many demos may reference the same build (artifact dedupe lives in
-- build_cache, which owns the unique build_key).
CREATE INDEX IF NOT EXISTS idx_demos_buildkey ON demos(framework, ht_version, files_hash);

-- build_cache: dedupe identical immutable builds across shares.
CREATE TABLE IF NOT EXISTS build_cache (
  build_key  TEXT PRIMARY KEY,             -- framework:ht_version:files_hash
  r2_prefix  TEXT NOT NULL,
  created_at TEXT NOT NULL
);
