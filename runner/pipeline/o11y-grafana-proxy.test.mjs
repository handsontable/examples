// `/grafana/*` and `POST /grafana/_o11y/reopen` (workers/o11y/src/grafana/{proxy,reopen}.ts,
// ADR-0041 §B.5/§H) — route-level, against fake `GRAFANA_BOX`/`INBOX_WRITER`
// stubs (no real Container/DO needed: these handlers only call methods on
// the stub returned by `getGrafanaBoxStub`/`inboxWriter`).
//
// Run: node --experimental-strip-types --test pipeline/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./fixtures/o11y-worker-hooks.mjs", import.meta.url);

const { handleGrafana } = await import("../workers/o11y/src/grafana/proxy.ts");
const { handleReopen } = await import("../workers/o11y/src/grafana/reopen.ts");
const { wakingPageHtml } = await import("../workers/o11y/src/grafana/waking-page.ts");

function makeBoxStub(overrides = {}) {
  const calls = { wake: [], noteVisitorActivity: 0, containerFetch: [] };
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
    async containerFetch(request) {
      calls.containerFetch.push(request);
      return overrides.containerFetchResponse ?? new Response("grafana-body", { status: 200 });
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
      ACCESS_TEAM_DOMAIN: "handsontable.cloudflareaccess.com",
      ACCESS_AUD: "test-aud",
      GRAFANA_BOX: makeGrafanaBoxNamespace(box),
      INBOX_WRITER: makeInboxWriterNamespace(
        inboxWriterStub ?? { async reopenWindow() { return { reopened: 0 }; } },
      ),
    },
    box,
  };
}

// ---- /grafana/* -----------------------------------------------------------

test("/grafana/* without a JWT (and no local bypass) answers 403", async () => {
  const { env } = makeEnv({ o11yEnv: "production" });
  const req = new Request("https://demos.handsontable.com/grafana/d/abc");
  const res = await handleGrafana(req, env, {});
  assert.equal(res.status, 403);
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

  const upstream = box.calls.containerFetch[0];
  assert.equal(upstream.headers.get("x-o11y-grafana-user"), "dev@handsontable.com");
});

test("/grafana/* preserves the original Host and path (never rewrites to a synthetic origin)", async () => {
  const box = makeBoxStub({ ready: true });
  const { env } = makeEnv({ devAdmin: "dev@handsontable.com", boxStub: box });
  const req = new Request("https://demos.handsontable.com/grafana/api/ds/query?x=1", { method: "POST" });

  await handleGrafana(req, env, {});

  const upstream = box.calls.containerFetch[0];
  assert.equal(new URL(upstream.url).host, "demos.handsontable.com");
  assert.equal(new URL(upstream.url).pathname, "/grafana/api/ds/query");
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

const JSON_HEADERS = { "content-type": "application/json" };

test("POST /grafana/_o11y/reopen requires Access too", async () => {
  const { env } = makeEnv({ o11yEnv: "production" });
  const req = new Request("https://demos.handsontable.com/grafana/_o11y/reopen", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ fromMs: 0, toMs: 1 }),
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
    headers: { "content-type": "text/plain" },
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
    headers: { "content-type": "application/json; charset=utf-8" },
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
