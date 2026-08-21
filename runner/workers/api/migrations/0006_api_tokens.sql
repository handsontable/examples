-- 0006_api_tokens.sql — persistent API tokens (DEV-2583, ADR-0037).
--
-- The credential the nightly canary needs and the broker cannot mint. Keyed on
-- the token's own public id — the 16 hex characters that appear verbatim inside
-- `hot_pat_<id>_<secret>` — so verification is a primary-key hit rather than a
-- scan over digests.
--
-- `token_hash` is a SHA-256 hex digest of the whole token string. The plaintext
-- exists only in the mint response; nothing here can reconstruct it.
--
-- `created_by` is the verified @handsontable.com address the token *acts as*,
-- matching `demos.created_by` and `profiles.email` — there is no user table to
-- point a foreign key at (see 0005). A token is not an identity of its own, so
-- `sameOwner()`, `?scope=mine` and "My demos" need no changes.
--
-- NULL semantics: `revoked_at IS NULL` means live, and it is the only liveness
-- test — rows are never deleted, so a revoked token's id can never be reissued
-- and the audit trail of who killed what survives. `last_used_at IS NULL` means
-- never used, and is coarsened to the hour by the atomic UPDATE in
-- token-store.ts rather than written on every request.
--
-- Re-runnable (IF NOT EXISTS), like 0005.

CREATE TABLE IF NOT EXISTS api_tokens (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT,
  revoked_by   TEXT
);

-- The listing is org-wide and ordered newest-first (ADR-0037: anyone on the team
-- may see and revoke any token), so the index that matters is the sort, not the
-- creator. `created_by` is carried for display and attribution only.
CREATE INDEX IF NOT EXISTS idx_api_tokens_created_at ON api_tokens(created_at DESC);
