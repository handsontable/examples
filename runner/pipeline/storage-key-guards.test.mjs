// Request-derived KV keys, R2 keys and DO names that would exceed a platform
// limit must be answered with a clean 4xx (or a miss) before any storage
// access. The KV fake here throws on a key over 512 bytes the way real Workers
// KV does, so a route that forgets the guard fails these specs instead of
// passing on a permissive Map.
//
// Run: node --experimental-strip-types --test pipeline/storage-key-guards.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

import { ctx, demoRow, fakeKV, makeEnv } from "./fixtures/worker-harness.mjs";
import { setSandboxFactory } from "./fixtures/cloudflare-sandbox-stub.mjs";

register("./fixtures/worker-hooks.mjs", import.meta.url);

const { default: worker } = await import("../workers/api/src/index.ts");
const { captures } = await import("./fixtures/sentry-cloudflare-stub.mjs");
const { kvKeyFits, r2KeyFits } = await import("../workers/api/src/storage-key.ts");

const bytes = (s) => Buffer.byteLength(s, "utf8");

/** fakeKV that rejects like the real thing and records every rejected or accepted key. */
function strictKV() {
  const inner = fakeKV();
  const accessed = [];
  const rejected = [];
  const guard = (op, key) => {
    accessed.push(`${op} ${key}`);
    const n = bytes(key);
    if (n === 0 || n > 512) {
      rejected.push(key);
      throw new Error(`KV ${op} failed: 414 UTF-8 encoded length of ${n} exceeds key length limit of 512.`);
    }
  };
  return {
    accessed,
    rejected,
    inner,
    async get(key, type) { guard("GET", key); return inner.get(key, type); },
    async put(key, value, options) { guard("PUT", key); return inner.put(key, value, options); },
    async delete(key) { guard("DELETE", key); return inner.delete(key); },
    async list(options) { return inner.list(options); },
  };
}

/** R2 fake that throws on an object key over 1024 bytes, like real R2. */
function strictR2(r2) {
  const rejected = [];
  const guard = (key) => {
    if (bytes(key) > 1024) {
      rejected.push(key);
      throw new Error(`R2 get failed: The specified object name is not valid. (10020)`);
    }
  };
  return {
    rejected,
    puts: r2.puts,
    async get(key) { guard(key); return r2.get(key); },
    async put(key, value, options) { guard(key); return r2.put(key, value, options); },
    delete: (key) => r2.delete(key),
    list: (options) => r2.list(options),
  };
}

function setup(seedRows = [], seedArtifacts = {}) {
  const made = makeEnv(seedRows, [], seedArtifacts);
  const kv = strictKV();
  made.env.CACHE = kv;
  const r2 = strictR2(made.env.ARTIFACTS);
  made.env.ARTIFACTS = r2;
  return { ...made, kv, r2 };
}

const call = (env, method, path, init) =>
  worker.fetch(new Request(`https://demos.handsontable.com${path}`, { method, ...init }), env, ctx);

// ---- unit: bytes, not characters ------------------------------------------

test("key helpers measure UTF-8 bytes, not UTF-16 units", () => {
  const multibyte = "é".repeat(300); // 300 chars, 600 bytes
  assert.ok(multibyte.length < 512 && bytes(multibyte) > 512);
  assert.equal(kvKeyFits(multibyte), false);
  assert.equal(kvKeyFits("a".repeat(512)), true);
  assert.equal(kvKeyFits("a".repeat(513)), false);
  assert.equal(kvKeyFits(""), false);
  assert.equal(r2KeyFits("a".repeat(1024)), true);
  assert.equal(r2KeyFits("a".repeat(1025)), false);
});

// ---- GET /api/versions/exists ----------------------------------------------

test("versions/exists: an overlong v is a 400, with no KV access, no throw and no Sentry capture", async () => {
  const { env, kv } = setup();
  const before = captures.length;
  const res = await call(env, "GET", `/api/versions/exists?v=${"1".repeat(600)}`);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /valid version/);
  assert.deepEqual(kv.accessed, [], "the guard must run before any KV access");
  assert.equal(captures.length, before, "an anonymous malformed request must not reach Sentry");
});

test("versions/exists: a multibyte v under 512 characters but over 512 bytes is a 400", async () => {
  const { env, kv } = setup();
  const v = "é".repeat(300);
  assert.ok(v.length < 512 && bytes(`version-exists:${v}`) > 512);
  const before = captures.length;
  const res = await call(env, "GET", `/api/versions/exists?v=${encodeURIComponent(v)}`);
  assert.equal(res.status, 400);
  assert.deepEqual(kv.accessed, []);
  assert.equal(captures.length, before);
});

test("versions/exists: a valid version still asks npm once, caches the answer and serves the repeat from KV", async () => {
  const { env, kv } = setup();
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (input) => {
    if (String(input).startsWith("https://registry.npmjs.org/")) asked.push(String(input));
    return new Response("{}", { status: 200 });
  };
  try {
    const first = await call(env, "GET", "/api/versions/exists?v=17.0.0-next-abc123");
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { exists: true });
    const second = await call(env, "GET", "/api/versions/exists?v=17.0.0-next-abc123");
    assert.deepEqual(await second.json(), { exists: true });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(asked, ["https://registry.npmjs.org/handsontable/17.0.0-next-abc123"]);
  assert.deepEqual(kv.rejected, []);
});

test("versions/exists: an empty v is still a 400", async () => {
  const { env } = setup();
  const res = await call(env, "GET", "/api/versions/exists?v=");
  assert.equal(res.status, 400);
});

// ---- demo ids (getDemo cache key) -------------------------------------------

test("GET /d/:id with an overlong id is a 404, not a KV throw", async () => {
  const { env, kv } = setup();
  const before = captures.length;
  const res = await call(env, "GET", `/d/${"a".repeat(600)}/`);
  assert.equal(res.status, 404);
  assert.deepEqual(kv.rejected, []);
  assert.equal(captures.length, before);
});

test("GET /d/:id with a multibyte id under 512 characters but over 512 bytes is a 404", async () => {
  const { env, kv } = setup();
  const id = "é".repeat(300);
  const res = await call(env, "GET", `/d/${encodeURIComponent(id)}/`);
  assert.equal(res.status, 404);
  assert.deepEqual(kv.rejected, []);
});

test("GET /api/demos/:id and /api/demos/:id/source with an overlong id are 404s", async () => {
  const { env, kv } = setup();
  const before = captures.length;
  for (const path of [`/api/demos/${"b".repeat(600)}`, `/api/demos/${"b".repeat(600)}/source`]) {
    const res = await call(env, "GET", path);
    assert.equal(res.status, 404, path);
  }
  assert.deepEqual(kv.rejected, []);
  assert.equal(captures.length, before);
});

test("GET /d/:id for a real demo still serves its index.html", async () => {
  const { env } = setup([demoRow()], { "demos/abc123/index.html": "<html>ok</html>" });
  const res = await call(env, "GET", "/d/abc123/");
  assert.equal(res.status, 200);
  assert.match(await res.text(), /ok/);
});

// ---- R2 key from the /d/:id subpath ------------------------------------------

test("GET /d/:id/<overlong path> does not hand R2 a key over 1024 bytes", async () => {
  const { env, r2 } = setup([demoRow()], { "demos/abc123/index.html": "<html>ok</html>" });
  const before = captures.length;
  const res = await call(env, "GET", `/d/abc123/${"p".repeat(1100)}`);
  assert.equal(res.status, 200, "falls through to the SPA index like any other unknown path");
  assert.deepEqual(r2.rejected, []);
  assert.equal(captures.length, before);
});

// ---- Tier-2 session ids (tombstone/meter KV keys, DO name) -------------------

test("session subroutes with an overlong id are a 400 before any KV or sandbox access", async () => {
  const { env, kv } = setup();
  let sandboxTouched = 0;
  setSandboxFactory(() => { sandboxTouched += 1; return {}; });
  const id = "s".repeat(600);
  for (const [method, path, init] of [
    ["POST", `/api/session/${id}/file`, { body: JSON.stringify({ path: "a.js", contents: "x" }), headers: { "Content-Type": "application/json" } }],
    ["DELETE", `/api/session/${id}/file?path=a.js`],
    ["GET", `/api/session/${id}/status`],
  ]) {
    const res = await call(env, method, path, init);
    assert.equal(res.status, 400, `${method} ${path.slice(0, 40)}`);
  }
  assert.deepEqual(kv.accessed, [], "no tombstone or meter read for an invalid id");
  assert.equal(sandboxTouched, 0);
});

test("DELETE /api/session/:id with an overlong id is a 400 and touches nothing", async () => {
  const { env, kv } = setup();
  let sandboxTouched = 0;
  setSandboxFactory(() => { sandboxTouched += 1; return { destroy: async () => {} }; });
  const res = await call(env, "DELETE", `/api/session/${"s".repeat(600)}`);
  assert.equal(res.status, 400);
  assert.deepEqual(kv.accessed, []);
  assert.equal(sandboxTouched, 0);
});

test("POST /api/session with an overlong client-supplied sessionId is a 400 and touches nothing", async () => {
  const { env, kv } = setup();
  let sandboxTouched = 0;
  setSandboxFactory(() => { sandboxTouched += 1; return {}; });
  const res = await call(env, "POST", "/api/session", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      framework: "react-js",
      files: { "package.json": "{}" },
      sessionId: "s".repeat(600),
    }),
  });
  assert.equal(res.status, 400);
  assert.deepEqual(kv.rejected, []);
  assert.equal(sandboxTouched, 0);
});
