// `/grafana/*` and `POST /grafana/_o11y/reopen` (workers/o11y/src/grafana/{proxy,reopen}.ts,
// ADR-0041 §B.5/§H) — route-level, against fake `GRAFANA_BOX`/`INBOX_WRITER`
// stubs (no real Container/DO needed: these handlers only call methods on
// the stub returned by `getGrafanaBoxStub`/`inboxWriter`).
//
// K1: the gate itself is `gates/session.ts` (replacing Cloudflare Access) —
// its own cookie/nonce/broker mechanics are covered in
// `o11y-session.test.mjs`; this file covers what the PROXY route does with
// the gate's verdict (redirect vs. 401, never touching the box when
// unauthenticated, header stripping, wake gating).
//
// Run: node --experimental-strip-types --test pipeline/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./fixtures/o11y-worker-hooks.mjs", import.meta.url);

const { handleGrafana } = await import("../workers/o11y/src/grafana/proxy.ts");
const { handleReopen } = await import("../workers/o11y/src/grafana/reopen.ts");
const { wakingPageHtml } = await import("../workers/o11y/src/grafana/waking-page.ts");
const { signSessionCookie, SESSION_COOKIE } = await import("../workers/o11y/src/gates/session.ts");
const { GRAFANA_PROXY_MAX_BYTES } = await import("../workers/o11y/src/gates/limits.ts");

function makeBoxStub(overrides = {}) {
  const calls = { wake: [], noteVisitorActivity: 0, fetch: [], containerFetchRpc: 0 };
  return {
    calls,
    async wake(reason) {
      calls.wake.push(reason);
      if (overrides.wakeThrows) throw new Error("container is stopping — retry shortly");
    },
    async isReady() {
      return overrides.ready ?? true;
    },
    // F2 fix (B-I3): defaults to already-awake, so every EXISTING test above
    // (none of which cares about the wake-gating change) keeps its current
    // pass-through behaviour unchanged; only a test that explicitly sets
    // `isAwake: false` exercises the new gate.
    async isAwake() {
      return overrides.isAwake ?? true;
    },
    async noteVisitorActivity() {
      calls.noteVisitorActivity++;
    },
    // Z1: the DO's `fetch()` handler — the only way `/grafana/*` may reach
    // the box (see `GrafanaBox.fetch`'s doc comment in box.ts).
    async fetch(request) {
      calls.fetch.push(request);
      return overrides.fetchResponse ?? new Response("grafana-body", { status: 200 });
    },
    // Z1: the RPC method the proxy used to call. A `Request` handed to an
    // RPC method has its body sent as an RPC stream, and in workerd every
    // proxied POST printed "ReadableStream received over RPC disconnected
    // prematurely". The real DO still has this method (the drain and
    // `isReady()` call it locally, inside the DO), so this fake keeps it
    // but makes the route's use of it loud.
    async containerFetch() {
      calls.containerFetchRpc++;
      throw new Error("the /grafana/* proxy must not call the containerFetch RPC method on the box stub");
    },
  };
}

function makeGrafanaBoxNamespace(box) {
  const ns = { getByName: () => box, jurisdiction: () => ns };
  return ns;
}

function makeInboxWriterNamespace(stub) {
  const ns = {
    idFromName: (name) => ({ name }),
    get: () => stub,
    jurisdiction: () => ns,
  };
  return ns;
}

function makeEnv({ devAdmin, o11yEnv = "local", boxStub, inboxWriterStub } = {}) {
  const box = boxStub ?? makeBoxStub();
  return {
    env: {
      O11Y_ENV: o11yEnv,
      DEV_ADMIN: devAdmin,
      LOGIN_BROKER_URL: "https://mcp-auth-proxy.example.test",
      O11Y_SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
      GRAFANA_BOX: makeGrafanaBoxNamespace(box),
      INBOX_WRITER: makeInboxWriterNamespace(
        inboxWriterStub ?? { async reopenWindow() { return { reopened: 0 }; } },
      ),
    },
    box,
  };
}

/** A real, validly signed `__Host-o11y_session` cookie header — the
 *  non-DEV_ADMIN path through `verifySession`, exercised by the tests below
 *  that need to prove the gate itself (not just the local bypass) drives
 *  the route. */
async function sessionCookieHeader(env, email = "artur.medrygal@handsontable.com") {
  const token = await signSessionCookie(env, email, 3600);
  return `${SESSION_COOKIE}=${token}`;
}

// ---- /grafana/* -----------------------------------------------------------

test("/grafana/* unauthenticated, no navigation signal (and no local bypass): 401, box never touched", async () => {
  const box = makeBoxStub();
  const { env } = makeEnv({ o11yEnv: "production", boxStub: box });
  const req = new Request("https://demos.handsontable.com/grafana/d/abc");
  const res = await handleGrafana(req, env, {});
  assert.equal(res.status, 401);
  assert.deepEqual(box.calls.wake, [], "an unauthenticated request must never wake the box");
  assert.equal(box.calls.fetch.length, 0);
});

test("/grafana/* unauthenticated top-level navigation (Sec-Fetch-Mode: navigate): 302 to login, box never touched", async () => {
  const box = makeBoxStub();
  const { env } = makeEnv({ o11yEnv: "production", boxStub: box });
  const req = new Request("https://demos.handsontable.com/grafana/d/abc?tab=1", {
    headers: { "sec-fetch-mode": "navigate" },
  });
  const res = await handleGrafana(req, env, {});
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("Location"), "/grafana/_o11y/login?next=%2Fgrafana%2Fd%2Fabc%3Ftab%3D1");
  assert.deepEqual(box.calls.wake, [], "a redirect to login must never wake the box");
  assert.equal(box.calls.fetch.length, 0);
});

test("/grafana/* unauthenticated XHR/fetch (Sec-Fetch-Mode: cors): 401 JSON, box never touched — this is also what recovers a session that expired mid-use", async () => {
  const box = makeBoxStub();
  const { env } = makeEnv({ o11yEnv: "production", boxStub: box });
  const req = new Request("https://demos.handsontable.com/grafana/api/ds/query", {
    method: "POST",
    headers: { "sec-fetch-mode": "cors", accept: "application/json" },
  });
  const res = await handleGrafana(req, env, {});
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.deepEqual(box.calls.wake, []);
  assert.equal(box.calls.fetch.length, 0);
});

test("/grafana/* with a real (non-DEV_ADMIN) session cookie authenticates and reaches Grafana", async () => {
  const box = makeBoxStub({ ready: true });
  const { env } = makeEnv({ o11yEnv: "production", boxStub: box });
  const cookie = await sessionCookieHeader(env);
  const req = new Request("https://demos.handsontable.com/grafana/d/abc", { headers: { cookie } });
  const res = await handleGrafana(req, env, {});
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "grafana-body");
});

test("/grafana/* with the local DEV_ADMIN bypass shows the waking page while not ready, then Grafana once ready", async () => {
  const notReadyBox = makeBoxStub({ ready: false });
  const { env } = makeEnv({ devAdmin: "dev@handsontable.com", boxStub: notReadyBox });
  const req = new Request("https://demos.handsontable.com/grafana/d/abc");

  const wakingRes = await handleGrafana(req, env, {});
  assert.equal(wakingRes.status, 200);
  const wakingBody = await wakingRes.text();
  assert.equal(wakingBody, wakingPageHtml());
  // F2: a waking-page response DOES count as visitor activity now — a visit
  // wake with an empty backlog otherwise SIGTERMs itself ~20s after boot
  // because #finishDrain (box.ts) never sees any activity at all for a
  // wake that only ever served the waking page. See o11y-wake.test.mjs's
  // own F2 test for the end-to-end proof that this keeps the wake up past
  // the first drain-finish.
  assert.equal(notReadyBox.calls.noteVisitorActivity, 1, "a waking-page response must count as Grafana activity (F2)");

  const readyBox = makeBoxStub({ ready: true });
  const { env: readyEnv } = makeEnv({ devAdmin: "dev@handsontable.com", boxStub: readyBox });
  const res = await handleGrafana(req, readyEnv, {});
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "grafana-body");
  assert.equal(readyBox.calls.noteVisitorActivity, 1);
});

test("/grafana/* strips a client-supplied x-o11y-grafana-user and sets it from the verified identity", async () => {
  const box = makeBoxStub({ ready: true });
  const { env } = makeEnv({ devAdmin: "dev@handsontable.com", boxStub: box });
  const req = new Request("https://demos.handsontable.com/grafana/d/abc", {
    headers: { "x-o11y-grafana-user": "attacker@evil.example" },
  });

  await handleGrafana(req, env, {});

  const upstream = box.calls.fetch[0];
  assert.equal(upstream.headers.get("x-o11y-grafana-user"), "dev@handsontable.com");
});

test("/grafana/* strips the session cookie from the request forwarded to Grafana", async () => {
  const box = makeBoxStub({ ready: true });
  const { env } = makeEnv({ o11yEnv: "production", boxStub: box });
  const cookie = await sessionCookieHeader(env);
  const req = new Request("https://demos.handsontable.com/grafana/d/abc", { headers: { cookie } });

  await handleGrafana(req, env, {});

  const upstream = box.calls.fetch[0];
  assert.equal(upstream.headers.get("cookie"), null, "o11y_session must never reach the container Grafana runs in");
});

test("I2 (live, through the proxy route): a tossed/junk duplicate cookie ahead of the real one does not lock the visitor out", async () => {
  const box = makeBoxStub({ ready: true });
  const { env } = makeEnv({ o11yEnv: "production", boxStub: box });
  const token = (await sessionCookieHeader(env)).split("=").slice(1).join("=");
  const req = new Request("https://demos.handsontable.com/grafana/d/abc", {
    headers: { cookie: `${SESSION_COOKIE}=junk-from-a-tossed-cookie; ${SESSION_COOKIE}=${token}` },
  });
  const res = await handleGrafana(req, env, {});
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "grafana-body");
});

test("M7: an unauthenticated HEAD or OPTIONS request never touches the box either", async () => {
  for (const method of ["HEAD", "OPTIONS"]) {
    const box = makeBoxStub();
    const { env } = makeEnv({ o11yEnv: "production", boxStub: box });
    const req = new Request("https://demos.handsontable.com/grafana/d/abc", { method });
    const res = await handleGrafana(req, env, {});
    assert.equal(res.status, 401, `expected 401 for ${method}`);
    assert.deepEqual(box.calls.wake, [], `${method} must never wake the box`);
    assert.equal(box.calls.fetch.length, 0);
  }
});

test("/grafana/* preserves the original Host and path (never rewrites to a synthetic origin)", async () => {
  const box = makeBoxStub({ ready: true });
  const { env } = makeEnv({ devAdmin: "dev@handsontable.com", boxStub: box });
  const req = new Request("https://demos.handsontable.com/grafana/api/ds/query?x=1", { method: "POST" });

  await handleGrafana(req, env, {});

  const upstream = box.calls.fetch[0];
  assert.equal(new URL(upstream.url).host, "demos.handsontable.com");
  assert.equal(new URL(upstream.url).pathname, "/grafana/api/ds/query");
});

// --- Z1: never proxy through a JS RPC method ------------------------------
//
// Before Z1 the route called `box.containerFetch(upstream, 3000)`, an RPC
// method on the GrafanaBox stub. In `wrangler dev` every body-bearing
// request sent that way (33 of 33 POSTs from one dashboard switch; GETs:
// 0 of 77) printed "Uncaught Error: ReadableStream received over RPC
// disconnected prematurely." inside the DO. The DO's `fetch()` handler has
// no such stream (0 errors after the fix). workerd's RPC transport cannot
// run under `node --test`, so these pin the call shape that avoids it.

test("Z1: a panel-query POST reaches the box through the DO's fetch() with its body intact, never the containerFetch RPC method", async () => {
  const box = makeBoxStub({ ready: true });
  const { env } = makeEnv({ devAdmin: "dev@handsontable.com", boxStub: box });
  const body = JSON.stringify({ queries: [{ refId: "A", expr: '{service_name="api"}' }] });
  const req = new Request("https://demos.handsontable.com/grafana/api/ds/query", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-dest": "empty" },
    body,
  });

  const res = await handleGrafana(req, env, {});

  assert.equal(res.status, 200);
  assert.equal(box.calls.containerFetchRpc, 0, "the containerFetch RPC method must never carry a proxied request");
  assert.equal(box.calls.fetch.length, 1);
  const upstream = box.calls.fetch[0];
  assert.equal(upstream.method, "POST");
  assert.equal(await upstream.text(), body, "the request body is forwarded verbatim");
});

// Z1, second half. With the body piped straight from `req.body`, a box
// that answers WITHOUT reading it (every gate refusal: live path, Loki
// allowlists, not-running 503) left the runtime still pumping the incoming
// body after this Worker had sent the response. Live under `wrangler dev`:
// 30 of 30 refused 20 KB POSTs printed "Uncaught TypeError: Can't read from
// request stream after response has been sent", and some came back 500
// instead of 404. With the body buffered first: 0 of 30, all 404.
test("Z1: the incoming body is read to the end BEFORE the box is called, so a box that answers without reading it leaves nothing pumping", async () => {
  let sourceDrained = false;
  const chunks = ['{"streams":[', '{"stream":{"a":"b"},"values":[["1","x"]]}', "]}"];
  const source = new ReadableStream({
    pull(controller) {
      const next = chunks.shift();
      if (next === undefined) {
        sourceDrained = true;
        controller.close();
      } else controller.enqueue(new TextEncoder().encode(next));
    },
  });
  let drainedWhenBoxCalled = null;
  const box = makeBoxStub({ ready: true });
  box.fetch = async (request) => {
    drainedWhenBoxCalled = sourceDrained;
    box.calls.fetch.push(request);
    // Refuse without touching the body, like `GrafanaBox`'s own gates do.
    return new Response("Not Found", { status: 404 });
  };
  const { env } = makeEnv({ devAdmin: "dev@handsontable.com", boxStub: box });
  const req = new Request("https://demos.handsontable.com/grafana/api/datasources/uid/loki-worker/resources/push", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-dest": "empty" },
    body: source,
    duplex: "half",
  });

  const res = await handleGrafana(req, env, {});

  assert.equal(res.status, 404, "the box's own refusal is what the client gets");
  assert.equal(drainedWhenBoxCalled, true, "the client's body must be fully read before the request is handed to the box");
  assert.equal(
    await box.calls.fetch[0].text(),
    '{"streams":[{"stream":{"a":"b"},"values":[["1","x"]]}]}',
    "the body the box receives is still the complete original",
  );
});

test("Z1: a client that drops mid-upload gets a 400 from the Worker, and the box is never called", async () => {
  const box = makeBoxStub({ ready: true });
  const { env } = makeEnv({ devAdmin: "dev@handsontable.com", boxStub: box });
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"queries":['));
      controller.error(new Error("client disconnected"));
    },
  });
  const req = new Request("https://demos.handsontable.com/grafana/api/ds/query", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-dest": "empty" },
    body: source,
    duplex: "half",
  });

  const res = await handleGrafana(req, env, {});

  assert.equal(res.status, 400);
  assert.equal(box.calls.fetch.length, 0);
});

// ---- QA follow-up: a 10 MB cap on /grafana/* request bodies --------
//
// Grafana's dashboards are provisioned read-only, so no legitimate request
// through this proxy is anywhere near this size (a panel query or a
// dashboard save is small JSON). Two enforcement points, mirroring
// `gates/limits.ts#contentLengthExceeds` + `normalise/read-body.ts`'s own
// "Content-Length is only a hint" pattern: a cheap pre-check against the
// header (this section's first test), and the real enforcement while
// reading (the next two), which must catch it even when the header is
// absent or lies small.

test("item 1: a Content-Length above the cap is refused with 413 before the body is ever read", async () => {
  const box = makeBoxStub({ ready: true });
  const { env } = makeEnv({ devAdmin: "dev@handsontable.com", boxStub: box });
  // `ReadableStream.locked` is the precise signal here (rather than counting
  // `pull()` calls): the Streams spec has an underlying source's `pull()`
  // fire once on its own shortly after construction to pre-fill the default
  // high-water mark, entirely independent of application code (confirmed
  // directly against this Node version — a bare `new Request(..., {body})`
  // with nobody ever calling `getReader()` still ticks `pull()` once on its
  // own). `.locked` only flips to `true` once something actually calls
  // `getReader()` on the stream, which is exactly what this route's own
  // `readCappedArrayBuffer` does — so it is what actually distinguishes "the
  // route read this" from "the runtime pre-filled its queue unprompted".
  // Bounded (not infinite): a reverted route would fully drain this via
  // `req.arrayBuffer()` before ever answering, and an infinite producer would
  // hang that revert-check run forever instead of failing it promptly.
  let served = 0;
  const source = new ReadableStream({
    pull(controller) {
      if (served >= 15) {
        controller.close();
        return;
      }
      served++;
      controller.enqueue(new Uint8Array(1_000_000));
    },
  });
  const req = new Request("https://demos.handsontable.com/grafana/api/ds/query", {
    method: "POST",
    headers: {
      "content-length": String(GRAFANA_PROXY_MAX_BYTES + 1),
      "content-type": "application/json",
      "sec-fetch-dest": "empty",
    },
    body: source,
    duplex: "half",
  });

  const res = await handleGrafana(req, env, {});

  assert.equal(res.status, 413);
  assert.equal(source.locked, false, "the body must never be read (no reader ever attached) once the Content-Length hint alone already exceeds the cap");
  assert.deepEqual(box.calls.wake, [], "an oversized request must never wake the box");
  assert.equal(box.calls.fetch.length, 0, "an oversized request must never reach the box");
});

test("item 1: a body that exceeds the cap with NO Content-Length is still refused with 413, without draining the whole stream", async () => {
  const box = makeBoxStub({ ready: true });
  const { env } = makeEnv({ devAdmin: "dev@handsontable.com", boxStub: box });
  // 20 x 1 MB (20 MB total) crosses the 10 MB cap after the 11th chunk. The
  // stream's own automatic pre-fill/read-ahead (see the previous test's
  // comment) can race a chunk or two beyond exactly 11, but nowhere near all
  // 20 — proving the reader stops early without pinning an exact count that
  // would make this test flaky against that read-ahead.
  const TOTAL_CHUNKS = 20;
  let pulls = 0;
  let served = 0;
  const source = new ReadableStream({
    pull(controller) {
      pulls++;
      if (served >= TOTAL_CHUNKS) {
        controller.close();
        return;
      }
      served++;
      controller.enqueue(new Uint8Array(1_000_000));
    },
  });
  const req = new Request("https://demos.handsontable.com/grafana/api/ds/query", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-dest": "empty" }, // no content-length at all
    body: source,
    duplex: "half",
  });

  const res = await handleGrafana(req, env, {});

  assert.equal(res.status, 413);
  assert.ok(pulls < TOTAL_CHUNKS, `must stop well before draining all ${TOTAL_CHUNKS} chunks, got ${pulls} pulls`);
  assert.equal(box.calls.fetch.length, 0, "an oversized body must never reach the box");
});

test("item 1: a small, LYING Content-Length does not let an oversize streamed body bypass the cap", async () => {
  const box = makeBoxStub({ ready: true });
  const { env } = makeEnv({ devAdmin: "dev@handsontable.com", boxStub: box });
  const bigChunk = new Uint8Array(6_000_000);
  const chunks = [bigChunk, bigChunk];
  const source = new ReadableStream({
    pull(controller) {
      const next = chunks.shift();
      if (next === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(next);
    },
  });
  const req = new Request("https://demos.handsontable.com/grafana/api/ds/query", {
    method: "POST",
    headers: { "content-length": "10", "content-type": "application/json", "sec-fetch-dest": "empty" },
    body: source,
    duplex: "half",
  });

  const res = await handleGrafana(req, env, {});

  assert.equal(res.status, 413);
  assert.equal(box.calls.fetch.length, 0, "an oversized body must never reach the box, even behind a lying small Content-Length");
});

test("Z1: a client-supplied cf-container-target-port (the base Container.fetch()'s port selector) is stripped before reaching the box", async () => {
  const box = makeBoxStub({ ready: true });
  const { env } = makeEnv({ devAdmin: "dev@handsontable.com", boxStub: box });
  const req = new Request("https://demos.handsontable.com/grafana/api/health", {
    headers: { "cf-container-target-port": "3100" },
  });

  await handleGrafana(req, env, {});

  assert.equal(box.calls.fetch.length, 1);
  assert.equal(box.calls.fetch[0].headers.get("cf-container-target-port"), null);
});

test("Z1 (structural): nothing in workers/o11y/src outside box.ts calls containerFetch — only the DO may, on itself", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join, relative } = await import("node:path");
  const root = new URL("../workers/o11y/src/", import.meta.url).pathname;
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && relative(root, full) !== "box.ts") {
        const code = readFileSync(full, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\/\/.*$/gm, "");
        if (/\bcontainerFetch\s*\(/.test(code)) offenders.push(relative(root, full));
      }
    }
  };
  walk(root);
  assert.deepEqual(
    offenders,
    [],
    "a containerFetch call from a Worker route is an RPC call: any Request body it passes crosses as an RPC stream (Z1). Use the stub's fetch() instead.",
  );
});

test("/grafana/* serves the waking page instead of erroring when wake() refuses (e.g. mid-stop)", async () => {
  const box = makeBoxStub({ wakeThrows: true });
  const { env } = makeEnv({ devAdmin: "dev@handsontable.com", boxStub: box });
  const req = new Request("https://demos.handsontable.com/grafana/");

  const res = await handleGrafana(req, env, {});
  assert.equal(res.status, 200);
  assert.equal(await res.text(), wakingPageHtml());
});

// ---- F2 fix (B-I3): only a top-level navigation may START a stopped box ---

test("B-I3: a background request (sec-fetch-dest: empty) never wakes a stopped box — serves the waking page without calling wake()", async () => {
  const box = makeBoxStub({ isAwake: false });
  const { env } = makeEnv({ devAdmin: "dev@handsontable.com", boxStub: box });
  const req = new Request("https://demos.handsontable.com/grafana/api/ds/query", {
    headers: { "sec-fetch-dest": "empty", "sec-fetch-mode": "cors" },
  });

  const res = await handleGrafana(req, env, {});

  assert.equal(res.status, 200);
  assert.equal(await res.text(), wakingPageHtml());
  assert.deepEqual(box.calls.wake, [], "a background XHR must never mint a fresh wake on a stopped box");
});

test("B-I3: a top-level navigation (sec-fetch-dest: document) still wakes a stopped box", async () => {
  const box = makeBoxStub({ isAwake: false, ready: true });
  const { env } = makeEnv({ devAdmin: "dev@handsontable.com", boxStub: box });
  const req = new Request("https://demos.handsontable.com/grafana/d/abc", {
    headers: { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" },
  });

  const res = await handleGrafana(req, env, {});

  assert.equal(res.status, 200);
  assert.equal(await res.text(), "grafana-body");
  assert.deepEqual(box.calls.wake, ["visit"]);
});

test("B-I3: a request with no Fetch Metadata headers at all (old browser, CLI, most tests) still wakes — fails open on absence, not on presence", async () => {
  const box = makeBoxStub({ isAwake: false, ready: true });
  const { env } = makeEnv({ devAdmin: "dev@handsontable.com", boxStub: box });
  const req = new Request("https://demos.handsontable.com/grafana/d/abc");

  const res = await handleGrafana(req, env, {});

  assert.equal(res.status, 200);
  assert.deepEqual(box.calls.wake, ["visit"]);
});

test("B-I3: a background request while the box IS already awake still renews activity normally (only STARTING is gated)", async () => {
  const box = makeBoxStub({ isAwake: true, ready: true });
  const { env } = makeEnv({ devAdmin: "dev@handsontable.com", boxStub: box });
  const req = new Request("https://demos.handsontable.com/grafana/api/ds/query", {
    headers: { "sec-fetch-dest": "empty", "sec-fetch-mode": "cors" },
  });

  const res = await handleGrafana(req, env, {});

  assert.equal(res.status, 200);
  assert.equal(await res.text(), "grafana-body");
  assert.deepEqual(box.calls.wake, ["visit"], "wake() is idempotent and safe once already awake");
});

// ---- POST /grafana/_o11y/reopen --------------------------------------------

const JSON_HEADERS = { "content-type": "application/json", Origin: "https://demos.handsontable.com" };

test("POST /grafana/_o11y/reopen requires a session too", async () => {
  const { env } = makeEnv({ o11yEnv: "production" });
  const req = new Request("https://demos.handsontable.com/grafana/_o11y/reopen", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ fromMs: 0, toMs: 1 }),
  });
  const res = await handleReopen(req, env, {});
  assert.equal(res.status, 403);
});

test("POST /grafana/_o11y/reopen: a same-SITE but cross-ORIGIN caller (another *.handsontable.com host) is refused", async () => {
  const inboxWriterStub = { async reopenWindow() { return { reopened: 0 }; } };
  const { env } = makeEnv({ devAdmin: "dev@handsontable.com", inboxWriterStub });
  const req = new Request("https://demos.handsontable.com/grafana/_o11y/reopen", {
    method: "POST",
    headers: { "content-type": "application/json", Origin: "https://preview-host.demos.handsontable.com" },
    body: JSON.stringify({ fromMs: 0, toMs: 1000 }),
  });
  const res = await handleReopen(req, env, {});
  assert.equal(res.status, 403);
});

test("POST /grafana/_o11y/reopen calls InboxWriter.reopenWindow with the given window", async () => {
  const calls = [];
  const inboxWriterStub = {
    async reopenWindow(fromMs, toMs) {
      calls.push({ fromMs, toMs });
      return { reopened: 3 };
    },
  };
  const { env } = makeEnv({ devAdmin: "dev@handsontable.com", inboxWriterStub });
  const req = new Request("https://demos.handsontable.com/grafana/_o11y/reopen", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ fromMs: 1000, toMs: 2000 }),
  });

  const res = await handleReopen(req, env, {});
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(body, { reopened: 3 });
  assert.deepEqual(calls, [{ fromMs: 1000, toMs: 2000 }]);
});

test("POST /grafana/_o11y/reopen rejects a malformed body with 400, never reaching the ledger", async () => {
  let called = false;
  const inboxWriterStub = { async reopenWindow() { called = true; return { reopened: 0 }; } };
  const { env } = makeEnv({ devAdmin: "dev@handsontable.com", inboxWriterStub });
  const req = new Request("https://demos.handsontable.com/grafana/_o11y/reopen", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ fromMs: "not-a-number" }),
  });

  const res = await handleReopen(req, env, {});

  assert.equal(res.status, 400);
  assert.equal(called, false);
});

// ---- F2 fix (B-M9): CSRF hardening and the retention-window cap -----------

test("B-M9: a non-application/json content-type is refused with 415, never reaching the ledger (CSRF: a cross-site 'simple' request cannot set this header)", async () => {
  let called = false;
  const inboxWriterStub = { async reopenWindow() { called = true; return { reopened: 0 }; } };
  const { env } = makeEnv({ devAdmin: "dev@handsontable.com", inboxWriterStub });
  const req = new Request("https://demos.handsontable.com/grafana/_o11y/reopen", {
    method: "POST",
    headers: { "content-type": "text/plain", Origin: "https://demos.handsontable.com" },
    body: JSON.stringify({ fromMs: 0, toMs: 1000 }),
  });

  const res = await handleReopen(req, env, {});

  assert.equal(res.status, 415);
  assert.equal(called, false);
});

test("B-M9: application/json with parameters (charset) is still accepted", async () => {
  const inboxWriterStub = { async reopenWindow() { return { reopened: 0 }; } };
  const { env } = makeEnv({ devAdmin: "dev@handsontable.com", inboxWriterStub });
  const req = new Request("https://demos.handsontable.com/grafana/_o11y/reopen", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", Origin: "https://demos.handsontable.com" },
    body: JSON.stringify({ fromMs: 0, toMs: 1000 }),
  });

  const res = await handleReopen(req, env, {});
  assert.equal(res.status, 200);
});

test("B-M9: a window wider than the 7-day retention is refused with 400, never reaching the ledger", async () => {
  let called = false;
  const inboxWriterStub = { async reopenWindow() { called = true; return { reopened: 0 }; } };
  const { env } = makeEnv({ devAdmin: "dev@handsontable.com", inboxWriterStub });
  const eightDaysMs = 8 * 24 * 60 * 60 * 1000;
  const req = new Request("https://demos.handsontable.com/grafana/_o11y/reopen", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ fromMs: 0, toMs: eightDaysMs }),
  });

  const res = await handleReopen(req, env, {});

  assert.equal(res.status, 400);
  assert.equal(called, false);
});
