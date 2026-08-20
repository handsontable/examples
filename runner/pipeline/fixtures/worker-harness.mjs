// Shared in-memory bindings for route-level worker specs — extracted from
// pipeline/mcp-routes.test.mjs when demo-routes-version.test.mjs (DEV-2565)
// needed the same fakes for the browser routes. Imports nothing from the
// worker's source tree, so a spec may load it before `module.register()`
// installs the .js→.ts hooks; `node --test` runs each spec file in its own
// process, so state never crosses files.
//
// The fakes cover exactly what the share routes touch: D1 (with a recorded
// write log and a live `demos` map), KV, and R2 (with recorded {key, value}
// puts — the value is the only observable of the server-side version pin, via
// the `demos/<id>/__source.json` snapshot). The build_cache read always hits,
// steering createDemo()/updateDemo() through their cached-artifact branch so
// no route under test ever asks for a container.

import assert from "node:assert/strict";

/**
 * Rebuild the row a `INSERT OR REPLACE INTO demos (...) VALUES (...)` wrote:
 * zip the column list with the placeholders, `?` consuming a bind and a bare
 * literal (the hardcoded `revoked` 0) standing as itself.
 */
export function parseDemosInsert(sql, binds) {
  const m = /INSERT OR REPLACE INTO demos\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/s.exec(sql);
  if (!m) return null;
  const cols = m[1].split(",").map((s) => s.trim());
  const placeholders = m[2].split(",").map((s) => s.trim());
  let next = 0;
  const row = {};
  cols.forEach((col, i) => {
    row[col] = placeholders[i] === "?" ? binds[next++] : Number(placeholders[i]);
  });
  return row;
}

/**
 * D1 fake: seeded demo rows, a recorded write log, and a build_cache that
 * always hits so createDemo() takes its cached-artifact branch. Unmatched
 * reads answer empty, which the budget code treats as "no spend yet".
 */
export function fakeD1(seedRows = []) {
  const writes = [];
  const demos = new Map(seedRows.map((row) => [row.id, row]));
  const prepare = (sql) => {
    const bound = (binds) => ({
      async first() {
        if (/FROM demos WHERE id = \?/.test(sql)) return demos.get(binds[0]) ?? null;
        if (/FROM build_cache/.test(sql)) return { r2_prefix: "demos/_prior-identical-build/" };
        return null;
      },
      async run() {
        writes.push({ sql, binds });
        const inserted = parseDemosInsert(sql, binds);
        if (inserted) demos.set(inserted.id, inserted);
        return { success: true, meta: {} };
      },
      async all() {
        return { success: true, results: [] };
      },
    });
    return { bind: (...binds) => bound(binds), ...bound([]) };
  };
  return { db: { prepare }, writes, demos };
}

/**
 * KV fake — a Map, ignoring TTL options (nothing under test outlives one).
 */
export function fakeKV() {
  const store = new Map();
  return {
    async get(key, type) {
      const value = store.get(key);
      if (value === undefined) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    async put(key, value) {
      store.set(key, String(value));
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

/**
 * R2 fake recording every put as {key, value}. The value matters: the version
 * pin's only artifact-side observable is the `__source.json` snapshot body —
 * built output never exists here (the build-cache branch copies an empty
 * listing), so asserting on put *keys* alone could not tell a pinned file map
 * from the raw submitted one.
 */
export function fakeR2() {
  const puts = [];
  return {
    puts,
    async put(key, value) {
      puts.push({ key, value });
    },
    async get() {
      return null;
    },
    async list() {
      return { objects: [] };
    },
  };
}

export const SECRET = "test-secret";
export const AUTHOR = "dev@handsontable.com";

/**
 * A worker env wired to fresh fakes. Extra keys (e.g. DEV_AUTH_EMAIL) can be
 * layered by the caller; none are set here so the broker path stays the one
 * under test on the browser routes.
 */
export function makeEnv(seedRows = []) {
  const { db, writes, demos } = fakeD1(seedRows);
  const artifacts = fakeR2();
  const env = {
    Sandbox: {},
    SANDBOX_BUILDER: {},
    DB: db,
    CACHE: fakeKV(),
    ARTIFACTS: artifacts,
    MCP_SHARED_SECRET: SECRET,
    LOGIN_BROKER_URL: "https://login.invalid",
    EMBED_ALLOWED_ANCESTORS: "https://handsontable.com",
    ERROR_REPORTING_DSN: "",
    CF_VERSION_METADATA: { id: "test", tag: "test" },
    // Not the production host, so the Sentry gate in index.ts stays inert.
    PREVIEW_HOST: "localhost:8787",
  };
  return { env, writes, demos, artifacts };
}

export const ctx = {
  waitUntil(promise) {
    Promise.resolve(promise).catch(() => {});
  },
  passThroughOnException() {},
};

/**
 * A stored demo row as D1 would return it (see DemoRow in share.ts).
 */
export const demoRow = (overrides = {}) => ({
  id: "abc123",
  title: "A demo",
  description: "words",
  framework: "react",
  tier: 1,
  ht_version: "latest",
  files_hash: "hash",
  r2_prefix: "demos/abc123/",
  forked_from: "mcp:react",
  visibility: "unlisted",
  revoked: 0,
  created_by: AUTHOR,
  created_at: "2026-08-17T00:00:00.000Z",
  updated_at: "2026-08-17T00:00:00.000Z",
  revoked_at: null,
  ...overrides,
});

/**
 * Seed the KV version catalog (ht-version.ts CATALOG_KEY) so a dist-tag
 * resolves without touching npm. "16.2.0" is deliberately not any real
 * `latest`: an assertion on it can only pass through this seeded document,
 * never by a live registry fetch answering the same thing. The guard at
 * fetchVersionCatalog requires a truthy `.latest` and the validator caps
 * majors at 15–19; this document satisfies both.
 */
export async function seedCatalog(env, latest = "16.2.0") {
  await env.CACHE.put("versions", JSON.stringify({ latest, next: null, versions: [latest] }));
  return latest;
}

/**
 * The parsed `demos/<id>/__source.json` snapshot a route stored — the single
 * observable of the server-side pin (share.ts writes it on both create and
 * update). Fails loudly when the route stored none.
 */
export function sourceSnapshot(artifacts, id) {
  const put = artifacts.puts.find((p) => p.key === `demos/${id}/__source.json`);
  assert.ok(put, `expected an R2 put of demos/${id}/__source.json`);
  return JSON.parse(put.value);
}
