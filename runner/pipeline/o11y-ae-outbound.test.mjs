// The GrafanaBox outbound handler for Analytics Engine SQL (ADR-0041 §A),
// driven through the REAL handler and the REAL `GrafanaBox.outboundByHost`
// registration, with `fetch` mocked at the api.cloudflare.com boundary.
//
// Run: node --experimental-strip-types --test pipeline/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { hooks, defaultHooks } from "./fixtures/cloudflare-containers-stub.mjs";

register("./fixtures/o11y-worker-hooks.mjs", import.meta.url);

const { GrafanaBox } = await import("../workers/o11y/src/box.ts");

const ACCOUNT = "test-account-id";
const PATH = `/client/v4/accounts/${ACCOUNT}/analytics_engine/sql`;
const ENV = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, AE_SQL_TOKEN: "test-ae-token" };

test.beforeEach(() => {
  Object.assign(hooks, defaultHooks());
});

function mockFetch(response = () => new Response('{"data":[]}', { headers: { "content-type": "application/json" } })) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    return response();
  };
  return { fn, calls };
}

// The registered handler, wired to a mocked fetch by swapping globalThis.fetch.
async function callRegistered(req, env = ENV, response) {
  const handler = GrafanaBox.outboundByHost["ae.internal"];
  assert.equal(typeof handler, "function", "GrafanaBox registers an ae.internal outbound handler");
  const { fn, calls } = mockFetch(response);
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  try {
    const res = await handler(req, env, { containerId: "c", className: "GrafanaBox" });
    return { res, calls };
  } finally {
    globalThis.fetch = original;
  }
}

test("GET on the allowed path is forwarded to api.cloudflare.com with the Worker's bearer", async () => {
  const { res, calls } = await callRegistered(
    new Request(`http://ae.internal${PATH}?query=SELECT%201%20FORMAT%20JSON`),
  );
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '{"data":[]}');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.cloudflare.com${PATH}?query=SELECT%201%20FORMAT%20JSON`);
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer test-ae-token");
});

test("a client-supplied Authorization is replaced, and other client headers are not forwarded", async () => {
  const { calls } = await callRegistered(
    new Request(`http://ae.internal${PATH}`, {
      headers: { authorization: "Bearer attacker", "x-evil": "1", cookie: "a=b", "content-type": "text/plain" },
    }),
  );
  const forwarded = new Headers(calls[0].init.headers);
  assert.equal(forwarded.get("authorization"), "Bearer test-ae-token");
  assert.equal(forwarded.get("x-evil"), null);
  assert.equal(forwarded.get("cookie"), null);
  assert.equal(forwarded.get("content-type"), "text/plain");
});

test("POST forwards the SQL body; a trailing slash on the path is accepted and normalised", async () => {
  const { res, calls } = await callRegistered(
    new Request(`http://ae.internal${PATH}/`, { method: "POST", body: "SELECT 1", headers: { "content-type": "text/plain" } }),
  );
  assert.equal(res.status, 200);
  assert.equal(calls[0].url, `https://api.cloudflare.com${PATH}`);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(new TextDecoder().decode(calls[0].init.body), "SELECT 1");
});

test("upstream status and body are passed back", async () => {
  const { res } = await callRegistered(new Request(`http://ae.internal${PATH}`), ENV, () => new Response("nope", { status: 401 }));
  assert.equal(res.status, 401);
  assert.equal(await res.text(), "nope");
});

for (const [name, url] of [
  ["another account's path", "http://ae.internal/client/v4/accounts/other/analytics_engine/sql"],
  ["a different API path", "http://ae.internal/client/v4/user/tokens/verify"],
  ["a path-suffix extension", `http://ae.internal${PATH}/../tokens`],
  ["a path with extra segments", `http://ae.internal${PATH}/extra`],
  ["another host", `http://evil.example${PATH}`],
  ["a lookalike host", `http://ae.internal.evil.example${PATH}`],
]) {
  test(`refuses ${name} without calling upstream`, async () => {
    const { res, calls } = await callRegistered(new Request(url));
    assert.equal(res.status, 403);
    assert.equal(calls.length, 0);
  });
}

test("refuses methods other than GET and POST", async () => {
  for (const method of ["PUT", "DELETE", "PATCH"]) {
    const { res, calls } = await callRegistered(new Request(`http://ae.internal${PATH}`, { method, body: "x" }));
    assert.equal(res.status, 405, method);
    assert.equal(calls.length, 0);
  }
});

test("refuses an oversized POST body without calling upstream", async () => {
  const { res, calls } = await callRegistered(
    new Request(`http://ae.internal${PATH}`, { method: "POST", body: "x".repeat(1_000_001) }),
  );
  assert.equal(res.status, 413);
  assert.equal(calls.length, 0);
});

test("fails closed with 503 when the token is not configured", async () => {
  const { res, calls } = await callRegistered(new Request(`http://ae.internal${PATH}`), { CLOUDFLARE_ACCOUNT_ID: ACCOUNT });
  assert.equal(res.status, 503);
  assert.equal(calls.length, 0);
});

test("the Worker entrypoint exports ContainerProxy, which outbound interception requires", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../workers/o11y/src/index.ts", import.meta.url), "utf8");
  assert.match(src, /export\s*\{\s*ContainerProxy\s*\}\s*from\s*"@cloudflare\/containers"/);
});

test("the only registered outbound host is ae.internal", () => {
  assert.deepEqual(Object.keys(GrafanaBox.outboundByHost), ["ae.internal"]);
});

test("local mode keeps host.docker.internal and its own ClickHouse headers", async () => {
  const env = {
    INBOX_WRITER: { getByName: () => ({ recordWake: async () => {} }), jurisdiction: () => ({ getByName: () => ({ recordWake: async () => {} }) }) },
    O11Y_ENV: "local",
    AE_SQL_TOKEN: "local-dev-token",
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
  };
  const storage = { async get() {}, async put() {}, async delete() {} };
  const box = new GrafanaBox({ storage }, env);
  let envVars;
  hooks.start = async (self, startOptions) => {
    envVars = startOptions.envVars;
    self._state = { status: "running", lastChange: Date.now() };
  };
  await box.wake("visit");
  assert.equal(envVars.O11Y_CLICKHOUSE_URL, "http://host.docker.internal:4404");
  assert.equal(envVars.O11Y_CLICKHOUSE_HEADER1_NAME, "X-ClickHouse-User");
  assert.equal(envVars.O11Y_CLICKHOUSE_HEADER2_NAME, "X-ClickHouse-Key");
  assert.equal(envVars.O11Y_CLICKHOUSE_HEADER2_VALUE, "local-dev-token");
});
