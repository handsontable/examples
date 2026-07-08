-- Correct a design error: idx_demos_buildkey must NOT be unique. Two users may
-- share identical files+version and each get their own /d/:id; artifact dedupe
-- is handled by build_cache (unique build_key), not by demos.

DROP INDEX IF EXISTS idx_demos_buildkey;
CREATE INDEX IF NOT EXISTS idx_demos_buildkey ON demos(framework, ht_version, files_hash);
