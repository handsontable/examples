-- 0005_profiles.sql — per-user profile (DEV-2166).
--
-- Keyed on the verified @handsontable.com email from the login broker, matching
-- `demos.created_by` / `idx_demos_created_by`. There is no user table to join
-- to and no user id anywhere in the system: the broker's `sub` is fetched but
-- never stored (auth.ts), so email is the only stable identifier we hold.
--
-- NULL semantics, load-bearing: `display_name IS NULL` means "never set, or
-- cleared" and the reader derives the default (the email's local part). A
-- non-NULL value is the user's own and is never overwritten. Same for
-- `avatar_key` — NULL means draw the monogram.
--
-- `avatar_key` is an opaque random id, not the email: it appears in the public
-- avatar URL, which must not enumerate team addresses. A fresh key per upload
-- also makes the served image immutably cacheable.
--
-- Re-runnable (IF NOT EXISTS), unlike 0003's bare ALTER.

CREATE TABLE IF NOT EXISTS profiles (
  email        TEXT PRIMARY KEY,
  display_name TEXT,
  description  TEXT,
  avatar_key   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
