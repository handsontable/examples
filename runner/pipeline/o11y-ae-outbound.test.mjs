// The GrafanaBox outbound handler for Analytics Engine SQL (ADR-0041 §A),
// driven through the REAL handler and the REAL `GrafanaBox.outboundByHost`
// registration, with `fetch` mocked at the api.cloudflare.com boundary.
//
// Run: node --experimental-strip-types --test pipeline/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { hooks, defaultHooks, outboundByHostRegistry, proxyLookup } from "./fixtures/cloudflare-containers-stub.mjs";

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
  // Resolved the way the SDK's ContainerProxy does: by class name, from the registry.
  // Always looked up under ae.internal so the handler's own host check is exercised for other hosts too.
  const handler = proxyLookup("GrafanaBox", "http://ae.internal/");
  assert.equal(typeof handler, "function", "the SDK registry has an ae.internal handler for GrafanaBox");
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
  assert.equal(calls[0].init.redirect, "manual", "the Worker never follows an upstream redirect on the container's behalf");
});

test("an upstream redirect is not followed and neither Location nor Set-Cookie reaches the container", async () => {
  const { res, calls } = await callRegistered(new Request(`http://ae.internal${PATH}`), ENV, () =>
    new Response("moved", {
      status: 302,
      headers: { location: "https://evil.example/steal", "set-cookie": "s=1", "content-type": "text/plain", "x-upstream": "1" },
    }),
  );
  assert.equal(calls.length, 1);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), null);
  assert.equal(res.headers.get("set-cookie"), null);
  assert.equal(res.headers.get("x-upstream"), null);
  assert.equal(res.headers.get("content-type"), "text/plain");
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
  // The Request constructor resolves `..`, so these reach the handler already collapsed to a sibling path.
  ["a dot-dot segment that normalises to a sibling path", `http://ae.internal${PATH}/../tokens`],
  ["a percent-encoded dot-dot that normalises to a sibling path", `http://ae.internal${PATH}/%2e%2e/tokens`],
  ["an encoded slash after the path", `http://ae.internal${PATH}%2F`],
  ["a leading double slash", `http://ae.internal/${PATH}`],
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

test("a dot-dot that collapses back onto the allowed path is forwarded to the canonical path only", async () => {
  const { res, calls } = await callRegistered(new Request(`http://ae.internal/x/%2e%2e${PATH}`));
  assert.equal(res.status, 200);
  assert.equal(calls[0].url, `https://api.cloudflare.com${PATH}`);
});

test("a single trailing dot on the host is the same host", async () => {
  const { res, calls } = await callRegistered(new Request(`http://ae.internal.${PATH}`));
  assert.equal(res.status, 200);
  assert.equal(calls[0].url, `https://api.cloudflare.com${PATH}`);
});

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

test("a declared content-length over the cap is refused before the body is read", async () => {
  let pulled = false;
  // highWaterMark 0: a stream is only pulled when something reads it.
  const body = new ReadableStream(
    {
      pull(c) {
        pulled = true;
        c.enqueue(new Uint8Array(1));
        c.close();
      },
    },
    { highWaterMark: 0 },
  );
  // Node's Request never carries a content-length, so the handler is driven with the minimal request shape it reads.
  const req = {
    url: `http://ae.internal${PATH}`,
    method: "POST",
    headers: new Headers({ "content-length": "1000001" }),
    body,
  };
  const { res, calls } = await callRegistered(req);
  assert.equal(res.status, 413);
  assert.equal(calls.length, 0);
  assert.equal(pulled, false, "the declared length is enough; the stream is never read");
});

test("a chunked body over the cap is cut off early and never reaches upstream", async () => {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      pulls++;
      if (pulls > 50) return controller.close();
      controller.enqueue(new Uint8Array(400_000));
    },
    cancel() {
      cancelled = true;
    },
  });
  const { res, calls } = await callRegistered(
    new Request(`http://ae.internal${PATH}`, { method: "POST", body, duplex: "half" }),
  );
  assert.equal(res.status, 413);
  assert.equal(calls.length, 0);
  assert.equal(cancelled, true, "the reader cancels the stream");
  assert.ok(pulls < 10, `stopped early (pulled ${pulls} of 50 chunks)`);
});

test("fails closed with 503 when the token is not configured", async () => {
  const { res, calls } = await callRegistered(new Request(`http://ae.internal${PATH}`), { CLOUDFLARE_ACCOUNT_ID: ACCOUNT });
  assert.equal(res.status, 503);
  assert.equal(calls.length, 0);
});

test("the Worker entrypoint exports ContainerProxy, which outbound interception requires", async () => {
  const mod = await import("../workers/o11y/src/index.ts");
  assert.equal(typeof mod.ContainerProxy, "function");
});

test("the only registered outbound host is ae.internal, found by class name as the SDK's ContainerProxy does", () => {
  const registered = outboundByHostRegistry.get("GrafanaBox");
  assert.ok(registered, "a static class field would bypass the SDK setter and leave the registry empty");
  assert.deepEqual(Object.keys(registered), ["ae.internal"]);
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
