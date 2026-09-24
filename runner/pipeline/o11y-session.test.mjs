// K1 — the broker login round trip that replaces Cloudflare Access for
// `/grafana/*` (`gates/session.ts`, `gates/broker.ts`, `grafana/login.ts`).
// Run against the real gate/route functions under plain `node --test` via
// `o11y-worker-hooks.mjs`, the same harness `o11y-gates.test.mjs` and
// `o11y-grafana-proxy.test.mjs` already use.
//
// Run: node --experimental-strip-types --test pipeline/o11y-session.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./fixtures/o11y-worker-hooks.mjs", import.meta.url);

const { SignJWT } = await import("jose");

const {
  isBrowserNavigation,
  isSameOrigin,
  loginClearCookieHeader,
  sanitizeNext,
  sessionClearCookieHeader,
  signLoginCookie,
  signSessionCookie,
  verifyLoginCookie,
  verifySession,
} = await import("../workers/o11y/src/gates/session.ts");
const { resolveBrokerIdentity } = await import("../workers/o11y/src/gates/broker.ts");
const { handleCallback, handleLogin, handleLogout, handleSession } = await import(
  "../workers/o11y/src/grafana/login.ts"
);

function baseEnv(overrides = {}) {
  return {
    O11Y_ENV: "production",
    LOGIN_BROKER_URL: "https://mcp-auth-proxy.example.test",
    O11Y_SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
    ...overrides,
  };
}

/** Reads one cookie's value out of a `Set-Cookie` header string (the test
 *  double's Headers never folds multiple `Set-Cookie` into one string the
 *  way a real fetch Response would, so callers pass the specific header
 *  instance they want). */
function cookieValue(setCookieHeader, name) {
  const m = new RegExp(`^${name}=([^;]*)`).exec(setCookieHeader);
  return m ? m[1] : null;
}

// ---- gates/session.ts: verifySession -------------------------------------

test("verifySession: DEV_ADMIN bypasses only when O11Y_ENV is local, never in production", async () => {
  const req = new Request("https://demos.handsontable.com/grafana/");
  const local = await verifySession(req, baseEnv({ O11Y_ENV: "local", DEV_ADMIN: "dev@handsontable.com" }));
  assert.deepEqual(local, { email: "dev@handsontable.com" });

  const prod = await verifySession(req, baseEnv({ O11Y_ENV: "production", DEV_ADMIN: "dev@handsontable.com" }));
  assert.equal(prod, null, "DEV_ADMIN must never bypass the session check in production, even with a set value");
});

test("verifySession: no cookie at all is refused", async () => {
  const req = new Request("https://demos.handsontable.com/grafana/");
  const result = await verifySession(req, baseEnv());
  assert.equal(result, null);
});

test("verifySession: an unconfigured O11Y_SESSION_SECRET fails closed", async () => {
  const req = new Request("https://demos.handsontable.com/grafana/", {
    headers: { cookie: "o11y_session=whatever" },
  });
  const result = await verifySession(req, baseEnv({ O11Y_SESSION_SECRET: undefined }));
  assert.equal(result, null);
});

test("verifySession: a validly signed cookie returns the email it carries", async () => {
  const env = baseEnv();
  const token = await signSessionCookie(env, "artur.medrygal@handsontable.com");
  const req = new Request("https://demos.handsontable.com/grafana/", {
    headers: { cookie: `o11y_session=${token}` },
  });
  const result = await verifySession(req, env);
  assert.deepEqual(result, { email: "artur.medrygal@handsontable.com" });
});

test("verifySession: a tampered cookie (payload edited after signing) is rejected", async () => {
  const env = baseEnv();
  const token = await signSessionCookie(env, "artur.medrygal@handsontable.com");
  const parts = token.split(".");
  // Flip one character in the payload segment — jose's signature check must
  // catch this before the (now-attacker-controlled) email is ever read.
  const tampered = [
    parts[0],
    parts[1].slice(0, -1) + (parts[1].at(-1) === "a" ? "b" : "a"),
    parts[2],
  ].join(".");
  const req = new Request("https://demos.handsontable.com/grafana/", {
    headers: { cookie: `o11y_session=${tampered}` },
  });
  assert.equal(await verifySession(req, env), null);
});

test("verifySession: a cookie forged with the wrong secret is rejected", async () => {
  const mintingEnv = baseEnv({ O11Y_SESSION_SECRET: "a-completely-different-secret-value-1234" });
  const token = await signSessionCookie(mintingEnv, "artur.medrygal@handsontable.com");
  const req = new Request("https://demos.handsontable.com/grafana/", {
    headers: { cookie: `o11y_session=${token}` },
  });
  assert.equal(await verifySession(req, baseEnv()), null);
});

test("verifySession: an expired cookie is rejected", async () => {
  const env = baseEnv();
  const expired = await new SignJWT({ email: "artur.medrygal@handsontable.com", typ: "o11y_session", v: 1 })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 1)
    .sign(new TextEncoder().encode(env.O11Y_SESSION_SECRET));
  const req = new Request("https://demos.handsontable.com/grafana/", {
    headers: { cookie: `o11y_session=${expired}` },
  });
  assert.equal(await verifySession(req, env), null);
});

test("verifySession: a login-nonce cookie's own token is not accepted as a session (typ mismatch)", async () => {
  const env = baseEnv();
  const loginToken = await signLoginCookie(env, { nonce: "abc", next: "/grafana/" });
  const req = new Request("https://demos.handsontable.com/grafana/", {
    headers: { cookie: `o11y_session=${loginToken}` },
  });
  assert.equal(await verifySession(req, env), null);
});

// ---- gates/session.ts: sanitizeNext (open-redirect defense) -------------

test("sanitizeNext: a same-origin /grafana/ path is preserved", () => {
  assert.equal(sanitizeNext("/grafana/d/abc?x=1"), "/grafana/d/abc?x=1");
  assert.equal(sanitizeNext("/grafana"), "/grafana/");
});

test("sanitizeNext: every open-redirect shape falls back to /grafana/", () => {
  const badInputs = [
    null,
    undefined,
    "",
    "//evil.example",
    "/\\evil.example",
    "https://evil.example/grafana/",
    "http://evil.example",
    "javascript:alert(1)",
    "/not-grafana",
    "/grafana/_o11y/session",
    "/grafana/_o11y/login?next=/grafana/",
  ];
  for (const input of badInputs) {
    assert.equal(sanitizeNext(input), "/grafana/", `expected /grafana/ fallback for ${JSON.stringify(input)}`);
  }
});

// ---- gates/session.ts: isBrowserNavigation / isSameOrigin ----------------

test("isBrowserNavigation: Sec-Fetch-Mode: navigate, or an html Accept header, is a navigation", () => {
  assert.equal(isBrowserNavigation(new Request("https://demos.handsontable.com/grafana/", {
    headers: { "sec-fetch-mode": "navigate" },
  })), true);
  assert.equal(isBrowserNavigation(new Request("https://demos.handsontable.com/grafana/", {
    headers: { accept: "text/html,application/xhtml+xml" },
  })), true);
});

test("isBrowserNavigation: an XHR/fetch (cors mode, json Accept, or no signal at all) is not a navigation", () => {
  assert.equal(isBrowserNavigation(new Request("https://demos.handsontable.com/grafana/api/ds/query", {
    headers: { "sec-fetch-mode": "cors", accept: "application/json" },
  })), false);
  assert.equal(isBrowserNavigation(new Request("https://demos.handsontable.com/grafana/api/ds/query")), false);
});

test("isSameOrigin: only an Origin matching the request's own origin passes", () => {
  assert.equal(isSameOrigin(new Request("https://demos.handsontable.com/grafana/_o11y/reopen", {
    headers: { Origin: "https://demos.handsontable.com" },
  })), true);
  assert.equal(isSameOrigin(new Request("https://demos.handsontable.com/grafana/_o11y/reopen", {
    headers: { Origin: "https://preview-host.demos.handsontable.com" },
  })), false, "another *.handsontable.com host is same-SITE but not same-ORIGIN");
  assert.equal(isSameOrigin(new Request("https://demos.handsontable.com/grafana/_o11y/reopen")), false);
});

// ---- gates/broker.ts: resolveBrokerIdentity ------------------------------

test("resolveBrokerIdentity: a @handsontable.com userinfo response resolves", async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ email: "artur.medrygal@handsontable.com" }), { status: 200 });

  const result = await resolveBrokerIdentity(baseEnv(), "a-broker-token");
  assert.deepEqual(result, { email: "artur.medrygal@handsontable.com" });
});

test("resolveBrokerIdentity: a non-@handsontable.com email is refused", async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({ email: "someone@gmail.com" }), { status: 200 });

  assert.equal(await resolveBrokerIdentity(baseEnv(), "a-broker-token"), null);
});

test("resolveBrokerIdentity: a hot_pat_ persistent API token is refused before ever calling the broker", async (t) => {
  let called = false;
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async () => { called = true; return new Response("{}", { status: 200 }); };

  const result = await resolveBrokerIdentity(baseEnv(), "hot_pat_abc123");
  assert.equal(result, null);
  assert.equal(called, false, "a hot_pat_ token must never be forwarded to the broker");
});

test("resolveBrokerIdentity: a non-ok broker response is refused", async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async () => new Response("unauthorized", { status: 401 });

  assert.equal(await resolveBrokerIdentity(baseEnv(), "a-broker-token"), null);
});

// ---- grafana/login.ts: the four routes -----------------------------------

test("GET /grafana/_o11y/login: 302s to the broker with a callback return_to, sets the login cookie, sanitizes next", async () => {
  const env = baseEnv();
  const req = new Request("https://demos.handsontable.com/grafana/_o11y/login?next=https://evil.example/x");
  const res = await handleLogin(req, env, {});

  assert.equal(res.status, 302);
  const location = res.headers.get("Location");
  assert.ok(location.startsWith(`${env.LOGIN_BROKER_URL}/broker/login?return_to=`));
  const returnTo = decodeURIComponent(location.split("return_to=")[1]);
  assert.ok(returnTo.startsWith("https://demos.handsontable.com/grafana/_o11y/callback?n="));

  const setCookie = res.headers.get("Set-Cookie");
  assert.match(setCookie, /^o11y_login=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Lax/);

  const loginToken = cookieValue(setCookie, "o11y_login");
  const state = await verifyLoginCookie(
    new Request("https://demos.handsontable.com/grafana/_o11y/login", { headers: { cookie: `o11y_login=${loginToken}` } }),
    env,
  );
  assert.equal(state.next, "/grafana/", "an open-redirect next= must never survive into the login cookie");
});

test("GET /grafana/_o11y/callback: strict CSP, no-store, referrer-policy, and no third-party script", async () => {
  const res = await handleCallback(new Request("https://demos.handsontable.com/grafana/_o11y/callback?n=x"), baseEnv(), {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  const csp = res.headers.get("content-security-policy");
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'sha256-/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  const html = await res.text();
  assert.doesNotMatch(html, /<script[^>]+src=/, "the callback page must load no external script");
});

async function loginThenSession(env, { tokenResponse, brokerToken = "a-real-broker-token", nOverride } = {}) {
  const loginRes = await handleLogin(new Request("https://demos.handsontable.com/grafana/_o11y/login"), env, {});
  const loginCookieValue = cookieValue(loginRes.headers.get("Set-Cookie"), "o11y_login");
  const location = loginRes.headers.get("Location");
  const returnTo = decodeURIComponent(location.split("return_to=")[1]);
  const realNonce = new URL(returnTo).searchParams.get("n");
  const n = nOverride ?? realNonce;

  const sessionReq = new Request("https://demos.handsontable.com/grafana/_o11y/session", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Origin: "https://demos.handsontable.com",
      cookie: `o11y_login=${loginCookieValue}`,
    },
    body: JSON.stringify({ token: brokerToken, n }),
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => tokenResponse ?? new Response(JSON.stringify({ email: "artur.medrygal@handsontable.com" }), { status: 200 });
  try {
    return await handleSession(sessionReq, env, {});
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("POST /grafana/_o11y/session: the full login round trip mints a session cookie and clears the login cookie", async () => {
  const env = baseEnv();
  const res = await loginThenSession(env);

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.next, "/grafana/");

  const setCookies = [...res.headers.entries()].filter(([k]) => k.toLowerCase() === "set-cookie").map(([, v]) => v);
  const sessionCookie = setCookies.find((c) => c.startsWith("o11y_session="));
  const loginClear = setCookies.find((c) => c.startsWith("o11y_login="));
  assert.ok(sessionCookie, "must set o11y_session");
  assert.match(loginClear, /Max-Age=0/, "must clear o11y_login");

  // The broker JWT itself must never appear in ANY Set-Cookie header —
  // only our own signed session token (a DIFFERENT string) may.
  for (const c of setCookies) {
    assert.doesNotMatch(c, /a-real-broker-token/);
  }

  const sessionToken = cookieValue(sessionCookie, "o11y_session");
  const verifyReq = new Request("https://demos.handsontable.com/grafana/", {
    headers: { cookie: `o11y_session=${sessionToken}` },
  });
  const identity = await verifySession(verifyReq, env);
  assert.deepEqual(identity, { email: "artur.medrygal@handsontable.com" });
});

test("POST /grafana/_o11y/session: a nonce mismatch is rejected", async () => {
  const env = baseEnv();
  const res = await loginThenSession(env, { nOverride: "some-other-nonce" });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, "nonce_mismatch");
});

test("POST /grafana/_o11y/session: a non-@handsontable.com broker identity is rejected", async () => {
  const env = baseEnv();
  const res = await loginThenSession(env, {
    tokenResponse: new Response(JSON.stringify({ email: "someone@gmail.com" }), { status: 200 }),
  });
  assert.equal(res.status, 401);
});

test("POST /grafana/_o11y/session: a cross-origin Origin is refused (403), never reaching the broker", async () => {
  const env = baseEnv();
  let called = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { called = true; return new Response("{}", { status: 200 }); };
  try {
    const req = new Request("https://demos.handsontable.com/grafana/_o11y/session", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ token: "x", n: "y" }),
    });
    const res = await handleSession(req, env, {});
    assert.equal(res.status, 403);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("POST /grafana/_o11y/session: a non-JSON content-type is refused with 415", async () => {
  const env = baseEnv();
  const req = new Request("https://demos.handsontable.com/grafana/_o11y/session", {
    method: "POST",
    headers: { "content-type": "text/plain", Origin: "https://demos.handsontable.com" },
    body: "token=x",
  });
  const res = await handleSession(req, env, {});
  assert.equal(res.status, 415);
});

test("POST /grafana/_o11y/logout: clears the session cookie and redirects home, only for a same-origin JSON request", async () => {
  const env = baseEnv();
  const okReq = new Request("https://demos.handsontable.com/grafana/_o11y/logout", {
    method: "POST",
    headers: { "content-type": "application/json", Origin: "https://demos.handsontable.com" },
  });
  const okRes = await handleLogout(okReq, env, {});
  assert.equal(okRes.status, 302);
  assert.equal(okRes.headers.get("Location"), "/");
  assert.match(okRes.headers.get("Set-Cookie"), /^o11y_session=;.*Max-Age=0/);

  const crossOriginReq = new Request("https://demos.handsontable.com/grafana/_o11y/logout", {
    method: "POST",
    headers: { "content-type": "application/json", Origin: "https://evil.example" },
  });
  const badRes = await handleLogout(crossOriginReq, env, {});
  assert.equal(badRes.status, 403);
});

// Sanity check on the raw cookie-clearing helpers the route handlers above
// build on, directly.
test("sessionClearCookieHeader / loginClearCookieHeader: Max-Age=0, HttpOnly, Secure", () => {
  assert.match(sessionClearCookieHeader(), /^o11y_session=;.*HttpOnly.*Secure.*Max-Age=0/);
  assert.match(loginClearCookieHeader(), /^o11y_login=;.*HttpOnly.*Secure.*Max-Age=0/);
});
