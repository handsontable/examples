-- Async snapshot builds on the MCP service path.
--
-- A cold tier-2 framework build (next/ng/astro/nuxt/remix) takes minutes, while the
-- MCP clients calling POST /api/mcp/demos time the tool call out at ~60 seconds and
-- abort the whole request chain — so every tier-2 create through the MCP died
-- mid-build with nothing recorded. The route now answers before the build finishes,
-- and these columns are where a demo's build state lives while (and after) it runs.
--
-- Every pre-existing row was only ever written after a successful build, so the
-- default backfills them all as 'ready'.
ALTER TABLE demos ADD COLUMN build_status TEXT NOT NULL DEFAULT 'ready';  -- 'ready' | 'building' | 'failed'
ALTER TABLE demos ADD COLUMN build_error TEXT;                            -- one-line cause when build_status='failed'
