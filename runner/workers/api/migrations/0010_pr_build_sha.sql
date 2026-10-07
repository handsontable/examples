-- Demos pinned to a pull request's pkg.pr.new preview (DEV-3338).
--
-- A PR number names whatever commit the PR has now, so these record which commit
-- the served artifact was built from and which one a build was last started for.
-- They differ while a view-triggered refresh runs, and after one failed, which is
-- what keeps a broken commit from being rebuilt on every view. NULL for every
-- other demo, and for PR demos built before this, which refresh on first view.
ALTER TABLE demos ADD COLUMN ht_built_sha TEXT;
ALTER TABLE demos ADD COLUMN ht_attempt_sha TEXT;
