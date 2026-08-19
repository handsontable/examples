// Route-level proof for the MCP endpoints (DEV-2501, ADR-0033): POST
// /api/mcp/demos and PATCH /api/mcp/demos/:id, driven through the REAL router —
// the default export of workers/api/src/index.ts — not through re-declared
// copies of its checks. Until this spec, nothing imported the router at all, so
// every status code and response shape it promises was untested.
//
// The worker loads under plain `node --test` via the module hooks in
// fixtures/worker-hooks.mjs (registered below, before the import). Bindings are
// in-memory fakes covering exactly what these two routes touch: D1 (with a
// recorded write log), KV, and R2. No route under test may reach a container —
// the create path is steered through createDemo()'s build-cache-hit branch
// (itself production code) by a fake build_cache row, and the sandbox stub
// throws if anything asks for a container anyway.
//
// Run: node --experimental-strip-types --test pipeline/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// register() is synchronous by contract: it blocks until the hooks module's
// initialize has completed and returns void — nothing to await (node:module
// docs). The worker imports below are dynamic, so they evaluate strictly
// after the .js→.ts remap and the sandbox stub are live.
register("./fixtures/worker-hooks.mjs", import.meta.url);

const { default: worker } = await import("../workers/api/src/index.ts");
const { demoListQuery } = await import("../workers/api/src/demos-list.ts");

// ---- in-memory bindings ------------------------------------------------------

/** Rebuild the row a `INSERT OR REPLACE INTO demos (...) VALUES (...)` wrote:
 *  zip the column list with the placeholders, `?` consuming a bind and a bare
 *  literal (the hardcoded `revoked` 0) standing as itself. */
function parseDemosInsert(sql, binds) {
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

/** D1 fake: seeded demo rows, a recorded write log, and a build_cache that
 *  always hits so createDemo() takes its cached-artifact branch. Unmatched
 *  reads answer empty, which the budget code treats as "no spend yet". */
function fakeD1(seedRows = []) {
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

function fakeKV() {
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

function fakeR2() {
  const puts = [];
  return {
    puts,
    async put(key) {
      puts.push(key);
    },
    async get() {
      return null;
    },
    async list() {
      return { objects: [] };
    },
  };
}

const SECRET = "test-secret";
const AUTHOR = "dev@handsontable.com";

function makeEnv(seedRows = []) {
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

const ctx = {
  waitUntil(promise) {
    Promise.resolve(promise).catch(() => {});
  },
  passThroughOnException() {},
};

const FILES = { "/package.json": '{"name":"demo"}', "/index.js": "console.log(1)" };

const mcpHeaders = {
  "Content-Type": "application/json",
  "X-MCP-Secret": SECRET,
  "X-Demo-Author": AUTHOR,
};

const createRequest = (body) =>
  new Request("https://demos.handsontable.com/api/mcp/demos", {
    method: "POST",
    headers: mcpHeaders,
    body: JSON.stringify(body),
  });

const patchRequest = (id, body = { files: FILES }) =>
  new Request(`https://demos.handsontable.com/api/mcp/demos/${id}`, {
    method: "PATCH",
    headers: mcpHeaders,
    body: JSON.stringify(body),
  });

/** A stored demo row as D1 would return it (see DemoRow in share.ts). */
const demoRow = (overrides = {}) => ({
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

// ---- create ------------------------------------------------------------------

test("an MCP demo without a description is refused before it is built", async () => {
  const { env, writes, artifacts } = makeEnv();
  const res = await worker.fetch(
    createRequest({ framework: "react", title: "Grid", files: FILES }),
    env,
    ctx,
  );
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /description is required/);
  // Refused up front: nothing was written, no artifact was stored, no build ran.
  assert.deepEqual(writes, [], "no D1 write may happen for a refused create");
  assert.deepEqual(artifacts.puts, [], "no artifact may be stored for a refused create");
});

test("a created demo answers with the four links and its owner", async () => {
  const { env } = makeEnv();
  const res = await worker.fetch(
    createRequest({ framework: "react", title: "Grid", description: "A sortable grid", files: FILES }),
    env,
    ctx,
  );
  assert.equal(res.status, 201);
  const body = await res.json();
  // Exactly these keys — an agent navigates by them, so a dropped or renamed
  // link is a breaking change of the MCP contract. `htVersion` joined the
  // response when the version catalog moved server-side (master, ht-version.ts)
  // — this assertion caught that addition, which is its job; grew, reviewed,
  // admitted.
  assert.deepEqual(
    Object.keys(body).sort(),
    ["createdBy", "editUrl", "embedUrl", "htVersion", "id", "shareUrl", "url"],
  );
  assert.equal(body.url, `/d/${body.id}`);
  assert.equal(body.embedUrl, `/embed/${body.id}`);
  assert.equal(body.editUrl, `/edit/${body.id}`);
  assert.equal(body.shareUrl, `/share/${body.id}`);
  assert.equal(body.createdBy, AUTHOR);
  // Concrete, not a dist-tag: the agent pins its follow-up update to this.
  assert.match(body.htVersion, /^\d+\.\d+\.\d+/);
});

test("a created demo is written with the caller as its owner, and its owner's listing finds it", async () => {
  const { env, writes, demos } = makeEnv();
  const res = await worker.fetch(
    createRequest({ framework: "react", title: "Grid", description: "A sortable grid", files: FILES }),
    env,
    ctx,
  );
  assert.equal(res.status, 201);
  const { id } = await res.json();

  const insert = writes.find((w) => /INSERT OR REPLACE INTO demos/.test(w.sql));
  assert.ok(insert, "the create route must insert a demos row");
  const row = demos.get(id);
  assert.equal(row.created_by, AUTHOR, "the asserted author is the stored owner");
  assert.match(row.forked_from, /^mcp:/, "provenance is stamped, or the demo can never be MCP-updated");

  // The row lands in the owner's "My demos": the same query GET /api/demos runs
  // for scope=mine matches it (the audit's G5 concern, router-side).
  const { sql, binds } = demoListQuery("mine", AUTHOR);
  assert.match(sql, /LOWER\(created_by\) = \?/);
  assert.equal(row.created_by.toLowerCase(), binds[0], "the stored owner matches the listing's bind");
});

// ---- update: every refusal the guard chain promises ---------------------------

test("someone else's demo is 403, even with a valid secret", async () => {
  const { env, writes } = makeEnv([
    demoRow({ created_by: "other@handsontable.com", forked_from: "mcp:react" }),
  ]);
  const res = await worker.fetch(patchRequest("abc123"), env, ctx);
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, "forbidden");
  assert.match(body.detail, /belongs to someone else/);
  assert.deepEqual(writes, [], "a refused update must not write");
});

test("a browser-made demo is 403 through the MCP, and says where to edit it", async () => {
  const { env, writes } = makeEnv([demoRow({ forked_from: "catalog:react" })]);
  const res = await worker.fetch(patchRequest("abc123"), env, ctx);
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, "forbidden");
  assert.match(body.detail, /not created through the MCP/);
  assert.match(body.detail, /\/edit\//, "the refusal points at the browser editor");
  assert.deepEqual(writes, [], "a refused update must not write");
});

test("a revoked demo is gone, not rebuilt", async () => {
  const { env, writes, artifacts } = makeEnv([
    demoRow({ revoked: 1, revoked_at: "2026-08-16T00:00:00.000Z" }),
  ]);
  const res = await worker.fetch(patchRequest("abc123"), env, ctx);
  assert.equal(res.status, 410);
  assert.equal((await res.json()).error, "gone");
  assert.deepEqual(writes, [], "a revoked demo must not be written to");
  assert.deepEqual(artifacts.puts, [], "a revoked demo must not get fresh artifacts");
});

test("an unknown demo is 404", async () => {
  const { env } = makeEnv();
  const res = await worker.fetch(patchRequest("nosuchid"), env, ctx);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, "not found");
});
