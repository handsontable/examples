// K1 — the broker login round trip that replaces Cloudflare Access for
// `/grafana/*` (`gates/session.ts`, `gates/broker.ts`, `grafana/login.ts`).
// Run against the real gate/route functions under plain `node --test` via
// `o11y-worker-hooks.mjs`, the same harness `o11y-gates.test.mjs` and
// `o11y-grafana-proxy.test.mjs` already use.
//
// Fix round (security review `.superpowers/sdd/README/final/K1-review.md`):
// this file was rewritten to cover I1 (secret strength + HKDF key
// separation), I2 (`__Host-` cookies + duplicate-cookie recovery), I3
// (session TTL capped at the broker token's own `exp`), and the M1-M7
// regressions the review's "by inspection" section named — each guard below
// was spot-checked failing with its code reverted; see the Fix round
// section of `.superpowers/sdd/README/final/K1-report.md` for the sample.
//
// Run: node --experimental-strip-types --test pipeline/o11y-session.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./fixtures/o11y-worker-hooks.mjs", import.meta.url);

const { SignJWT } = await import("jose");

const {
  SESSION_COOKIE,
  SESSION_TYP,
  LOGIN_COOKIE,
  SESSION_MAX_TTL_SECONDS,
  SESSION_FALLBACK_TTL_SECONDS,
  computeSessionTtlSeconds,
  isBrowserNavigation,
  isSameOrigin,
  isSessionSecretValid,
  loginClearCookieHeader,
  loginSetCookieHeader,
  publicOrigin,
  sanitizeNext,
  sessionClearCookieHeader,
  sessionSetCookieHeader,
  signLoginCookie,
  signSessionCookie,
  verifyLoginCookie,
  verifySession,
  _deriveSessionKeyForTests,
  _deriveLoginKeyForTests,
} = await import("../workers/o11y/src/gates/session.ts");
const { isValidBrokerUrl, resolveBrokerIdentity } = await import("../workers/o11y/src/gates/broker.ts");
const { handleCallback, handleLogin, handleLogout, handleLogoutPage, handleSession } = await import(
  "../workers/o11y/src/grafana/login.ts"
);

function baseEnv(overrides = {}) {
  return {
    O11Y_ENV: "production",
    LOGIN_BROKER_URL: "https://mcp-auth-proxy.example.test",
    O11Y_SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
    RATE_LIMITER: { limit: async () => ({ success: true }) },
    ...overrides,
  };
}

/** Reads one cookie's value out of a `Set-Cookie` header string. */
function cookieValue(setCookieHeader, name) {
  const m = new RegExp(`^${name}=([^;]*)`).exec(setCookieHeader);
  return m ? m[1] : null;
}

function allSetCookies(res) {
  return [...res.headers.entries()].filter(([k]) => k.toLowerCase() === "set-cookie").map(([, v]) => v);
}

// ---- I1: secret strength + HKDF key separation ---------------------------

test("I1: isSessionSecretValid requires at least 32 UTF-8 bytes", () => {
  assert.equal(isSessionSecretValid(baseEnv({ O11Y_SESSION_SECRET: "x".repeat(31) })), false);
  assert.equal(isSessionSecretValid(baseEnv({ O11Y_SESSION_SECRET: "x".repeat(32) })), true);
  assert.equal(isSessionSecretValid(baseEnv({ O11Y_SESSION_SECRET: undefined })), false);
});

test("I1: a short secret fails closed on every path (verifySession, /login, /session)", async () => {
  const shortEnv = baseEnv({ O11Y_SESSION_SECRET: "too-short" });

  // Sign a token under a DIFFERENT, valid-length secret (simulating an
  // attacker who somehow obtained a plausible-looking cookie) — even so,
  // a server configured with a short secret must never accept it: the
  // short secret itself is the thing that must fail closed, independent of
  // what the presented cookie contains.
  const foreignEnv = baseEnv({ O11Y_SESSION_SECRET: "a-totally-different-32-byte-secret!" });
  const foreignKey = await _deriveSessionKeyForTests(foreignEnv);
  const token = await new SignJWT({ email: "artur.medrygal@handsontable.com", typ: SESSION_TYP, v: 1 })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .setAudience(publicOrigin(shortEnv))
    .sign(foreignKey);

  const req = new Request("https://demos.handsontable.com/grafana/", {
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  });
  assert.equal(await verifySession(req, shortEnv), null);

  const loginRes = await handleLogin(new Request("https://demos.handsontable.com/grafana/_o11y/login"), shortEnv, {});
  assert.equal(loginRes.status, 500);

  const sessionRes = await handleSession(
    new Request("https://demos.handsontable.com/grafana/_o11y/session", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: "https://demos.handsontable.com" },
      body: JSON.stringify({ token: "x", n: "y" }),
    }),
    shortEnv,
    {},
  );
  assert.equal(sessionRes.status, 500);
});

test("I1: the session cookie is NOT verifiable with the raw secret bytes directly (HKDF domain separation)", async () => {
  const env = baseEnv();
  const rawSecretKeyToken = await new SignJWT({ email: "artur.medrygal@handsontable.com", typ: SESSION_TYP, v: 1 })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .setAudience(publicOrigin(env))
    .sign(new TextEncoder().encode(env.O11Y_SESSION_SECRET));

  const req = new Request("https://demos.handsontable.com/grafana/", {
    headers: { cookie: `${SESSION_COOKIE}=${rawSecretKeyToken}` },
  });
  assert.equal(
    await verifySession(req, env),
    null,
    "a token signed with the raw secret bytes (not the HKDF-derived session key) must be rejected",
  );
});

test("I1: the login-nonce key and the session key are different derived keys", async () => {
  const env = baseEnv();
  const loginKey = await _deriveLoginKeyForTests(env);
  const sessionKey = await _deriveSessionKeyForTests(env);

  // A token honestly built with the SESSION shape but signed under the
  // LOGIN key must not verify as a session — proves the two purposes use
  // genuinely different key material, not just a shared key plus a `typ`
  // label.
  const crossSignedToken = await new SignJWT({ email: "artur.medrygal@handsontable.com", typ: SESSION_TYP, v: 1 })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .setAudience(publicOrigin(env))
    .sign(loginKey);
  const req = new Request("https://demos.handsontable.com/grafana/", {
    headers: { cookie: `${SESSION_COOKIE}=${crossSignedToken}` },
  });
  assert.equal(await verifySession(req, env), null);
  assert.notDeepEqual(loginKey, sessionKey);
});

// ---- I2: __Host- cookies, duplicate/tossed-cookie recovery ---------------

test("I2: both cookie names use the __Host- prefix", () => {
  assert.equal(SESSION_COOKIE, "__Host-o11y_session");
  assert.equal(LOGIN_COOKIE, "__Host-o11y_login");
});

test("I2: the session and login Set-Cookie headers satisfy every __Host- requirement (Path=/, Secure, no Domain)", async () => {
  const env = baseEnv();
  const sessionToken = await signSessionCookie(env, "artur.medrygal@handsontable.com", 3600);
  const sessionHeader = sessionSetCookieHeader(sessionToken, 3600);
  const loginToken = await signLoginCookie(env, { nonce: "n", next: "/grafana/" });
  const loginHeader = loginSetCookieHeader(loginToken);

  for (const header of [sessionHeader, loginHeader]) {
    assert.match(header, /Path=\//, "must be Path=/ — __Host- refuses any other Path");
    assert.match(header, /Secure/);
    assert.match(header, /HttpOnly/);
    assert.match(header, /SameSite=Lax/);
    assert.doesNotMatch(header, /Domain=/i, "__Host- refuses a Domain attribute entirely");
  }
});

test("I2 (tossed-cookie lockout): a junk value ahead of the real one in the Cookie header no longer locks verification out", async () => {
  const env = baseEnv();
  const validToken = await signSessionCookie(env, "artur.medrygal@handsontable.com", 3600);
  const req = new Request("https://demos.handsontable.com/grafana/", {
    headers: { cookie: `${SESSION_COOKIE}=junk-tossed-value; ${SESSION_COOKIE}=${validToken}` },
  });
  const result = await verifySession(req, env);
  assert.deepEqual(result, { email: "artur.medrygal@handsontable.com" }, "the real cookie must still be found and verified");
});

test("I2 (fixation): verifyLoginCookie also recovers the valid value when a junk duplicate precedes it", async () => {
  const env = baseEnv();
  const validToken = await signLoginCookie(env, { nonce: "real-nonce", next: "/grafana/" });
  const req = new Request("https://demos.handsontable.com/grafana/_o11y/session", {
    headers: { cookie: `${LOGIN_COOKIE}=junk; ${LOGIN_COOKIE}=${validToken}` },
  });
  const state = await verifyLoginCookie(req, env);
  assert.deepEqual(state, { nonce: "real-nonce", next: "/grafana/" });
});

test("I2: sessionClearCookieHeader / loginClearCookieHeader also satisfy __Host- (Path=/, Secure, Max-Age=0)", () => {
  assert.match(sessionClearCookieHeader(), new RegExp(`^${SESSION_COOKIE}=;.*HttpOnly.*Secure.*Max-Age=0`));
  assert.match(sessionClearCookieHeader(), /Path=\//);
  assert.doesNotMatch(sessionClearCookieHeader(), /Domain=/i);
  assert.match(loginClearCookieHeader(), new RegExp(`^${LOGIN_COOKIE}=;.*HttpOnly.*Secure.*Max-Age=0`));
});

// ---- I3: session TTL capped at the broker token's own exp -----------------

test("I3: computeSessionTtlSeconds caps at 12h even when the broker token's exp is much further out", () => {
  const now = 1_000_000;
  const farFuture = now + 100 * 60 * 60; // 100h out
  assert.equal(computeSessionTtlSeconds(farFuture, now), SESSION_MAX_TTL_SECONDS);
});

test("I3: computeSessionTtlSeconds returns the token's own remaining lifetime when it is under 12h", () => {
  const now = 1_000_000;
  const in30Min = now + 30 * 60;
  assert.equal(computeSessionTtlSeconds(in30Min, now), 30 * 60);
});

test("I3: computeSessionTtlSeconds falls back to 1h when exp is missing or already past", () => {
  const now = 1_000_000;
  assert.equal(computeSessionTtlSeconds(null, now), SESSION_FALLBACK_TTL_SECONDS);
  assert.equal(computeSessionTtlSeconds(now - 10, now), SESSION_FALLBACK_TTL_SECONDS);
});

async function brokerJwtWithExp(expSeconds) {
  // Only the SHAPE matters (3 dot-separated segments, a JSON payload with
  // `exp`) — this Worker never verifies the broker's own signature
  // (`gates/broker.ts`'s own doc comment), so an arbitrary HS256 token
  // stands in fine for "a broker-issued JWT".
  return new SignJWT({ sub: "stub" })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(expSeconds)
    .sign(new TextEncoder().encode("irrelevant-broker-secret-not-ours-32b"));
}

async function loginThenSession(env, { tokenResponse, brokerToken = "a-real-broker-token", nOverride } = {}) {
  const loginRes = await handleLogin(new Request("https://demos.handsontable.com/grafana/_o11y/login"), env, {});
  const loginCookieValue = cookieValue(loginRes.headers.get("Set-Cookie"), LOGIN_COOKIE);
  const location = loginRes.headers.get("Location");
  const returnTo = decodeURIComponent(location.split("return_to=")[1]);
  const realNonce = new URL(returnTo).searchParams.get("n");
  const n = nOverride ?? realNonce;

  const sessionReq = new Request("https://demos.handsontable.com/grafana/_o11y/session", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Origin: "https://demos.handsontable.com",
      cookie: `${LOGIN_COOKIE}=${loginCookieValue}`,
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

test("I3 end-to-end: a 1h-lifetime broker token mints a session capped near 1h, not 12h", async () => {
  const env = baseEnv();
  const nowSec = Math.floor(Date.now() / 1000);
  const brokerToken = await brokerJwtWithExp(nowSec + 60 * 60);

  const res = await loginThenSession(env, { brokerToken });
  assert.equal(res.status, 200);
  const setCookies = allSetCookies(res);
  const sessionCookie = setCookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  const maxAge = Number(/Max-Age=(\d+)/.exec(sessionCookie)[1]);
  assert.ok(maxAge <= 60 * 60 && maxAge > 60 * 60 - 30, `expected ~1h, got ${maxAge}s`);
  assert.ok(maxAge < SESSION_MAX_TTL_SECONDS, "must be far under the 12h ceiling");
});

test("I3 end-to-end: a broker token with no readable exp falls back to the 1h session, not 12h", async () => {
  const env = baseEnv();
  const res = await loginThenSession(env, { brokerToken: "not-a-jwt-shaped-token" });
  assert.equal(res.status, 200);
  const setCookies = allSetCookies(res);
  const sessionCookie = setCookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  const maxAge = Number(/Max-Age=(\d+)/.exec(sessionCookie)[1]);
  assert.equal(maxAge, SESSION_FALLBACK_TTL_SECONDS);
});

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

test("verifySession: a validly signed cookie returns the email it carries", async () => {
  const env = baseEnv();
  const token = await signSessionCookie(env, "artur.medrygal@handsontable.com", 3600);
  const req = new Request("https://demos.handsontable.com/grafana/", {
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  });
  const result = await verifySession(req, env);
  assert.deepEqual(result, { email: "artur.medrygal@handsontable.com" });
});

test("verifySession: a tampered cookie (payload edited after signing) is rejected", async () => {
  const env = baseEnv();
  const token = await signSessionCookie(env, "artur.medrygal@handsontable.com", 3600);
  const parts = token.split(".");
  const tampered = [parts[0], parts[1].slice(0, -1) + (parts[1].at(-1) === "a" ? "b" : "a"), parts[2]].join(".");
  const req = new Request("https://demos.handsontable.com/grafana/", {
    headers: { cookie: `${SESSION_COOKIE}=${tampered}` },
  });
  assert.equal(await verifySession(req, env), null);
});

test("verifySession: a cookie forged with the wrong secret is rejected", async () => {
  const mintingEnv = baseEnv({ O11Y_SESSION_SECRET: "a-completely-different-secret-value-1234" });
  const token = await signSessionCookie(mintingEnv, "artur.medrygal@handsontable.com", 3600);
  const req = new Request("https://demos.handsontable.com/grafana/", {
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  });
  assert.equal(await verifySession(req, baseEnv()), null);
});

test("verifySession: an expired cookie is rejected", async () => {
  const env = baseEnv();
  const key = await _deriveSessionKeyForTests(env);
  const expired = await new SignJWT({ email: "artur.medrygal@handsontable.com", typ: SESSION_TYP, v: 1 })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 1)
    .setAudience(publicOrigin(env))
    .sign(key);
  const req = new Request("https://demos.handsontable.com/grafana/", {
    headers: { cookie: `${SESSION_COOKIE}=${expired}` },
  });
  assert.equal(await verifySession(req, env), null);
});

test("verifySession: a login-nonce cookie's own token is not accepted as a session (typ mismatch)", async () => {
  const env = baseEnv();
  const loginToken = await signLoginCookie(env, { nonce: "abc", next: "/grafana/" });
  const req = new Request("https://demos.handsontable.com/grafana/", {
    headers: { cookie: `${SESSION_COOKIE}=${loginToken}` },
  });
  assert.equal(await verifySession(req, env), null);
});

// ---- M2: version, required exp, and audience/environment binding ---------

test("M2: a session token with v !== 1 is rejected", async () => {
  const env = baseEnv();
  const key = await _deriveSessionKeyForTests(env);
  const token = await new SignJWT({ email: "artur.medrygal@handsontable.com", typ: SESSION_TYP, v: 99 })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .setAudience(publicOrigin(env))
    .sign(key);
  const req = new Request("https://demos.handsontable.com/grafana/", { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
  assert.equal(await verifySession(req, env), null);
});

test("M2: a session token with no exp claim is rejected (does not verify forever)", async () => {
  const env = baseEnv();
  const key = await _deriveSessionKeyForTests(env);
  // jose's SignJWT only sets `exp` when told to — omit it entirely.
  const token = await new SignJWT({ email: "artur.medrygal@handsontable.com", typ: SESSION_TYP, v: 1 })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setAudience(publicOrigin(env))
    .sign(key);
  const req = new Request("https://demos.handsontable.com/grafana/", { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
  assert.equal(await verifySession(req, env), null);
});

test("M2: a session token with the wrong audience is rejected", async () => {
  const env = baseEnv();
  const key = await _deriveSessionKeyForTests(env);
  const token = await new SignJWT({ email: "artur.medrygal@handsontable.com", typ: SESSION_TYP, v: 1 })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .setAudience("https://evil.example")
    .sign(key);
  const req = new Request("https://demos.handsontable.com/grafana/", { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
  assert.equal(await verifySession(req, env), null);
});

test("M2: a local-minted session cannot be replayed against production, even under the same secret", async () => {
  const sharedSecret = "shared-between-local-and-prod-32-bytes!";
  const localEnv = baseEnv({ O11Y_ENV: "local", O11Y_SESSION_SECRET: sharedSecret, O11Y_LOCAL_PUBLIC_ORIGIN: "http://localhost:4200" });
  const token = await signSessionCookie(localEnv, "artur.medrygal@handsontable.com", 3600);

  const prodEnv = baseEnv({ O11Y_ENV: "production", O11Y_SESSION_SECRET: sharedSecret });
  const req = new Request("https://demos.handsontable.com/grafana/", { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
  assert.equal(await verifySession(req, prodEnv), null, "a local-audience token must be refused in production");
});

test("M2: publicOrigin ignores O11Y_LOCAL_PUBLIC_ORIGIN outside O11Y_ENV=local", () => {
  const env = baseEnv({ O11Y_ENV: "production", O11Y_LOCAL_PUBLIC_ORIGIN: "http://localhost:9999" });
  assert.equal(publicOrigin(env), "https://demos.handsontable.com");
});

// ---- gates/session.ts: sanitizeNext (open-redirect defense) -------------

test("sanitizeNext: a same-origin /grafana/ path is preserved", () => {
  const env = baseEnv();
  assert.equal(sanitizeNext("/grafana/d/abc?x=1", env), "/grafana/d/abc?x=1");
  assert.equal(sanitizeNext("/grafana", env), "/grafana/");
});

test("M1: sanitizeNext resolves dot segments before checking the /grafana/ prefix", () => {
  const env = baseEnv();
  assert.equal(sanitizeNext("/grafana/../api/admin", env), "/grafana/");
  assert.equal(sanitizeNext("/grafana/%2e%2e/api/admin", env), "/grafana/");
  assert.equal(sanitizeNext("/grafana/x/../_o11y/login", env), "/grafana/");
  // `%2f` is NOT decoded to `/` by URL path normalization (WHATWG spec, and
  // matches a real browser's own `location.replace` behaviour) — this
  // stays a single, harmless path segment literally named
  // `..%2f..%2fapi`, still under `/grafana/`, never resolved across the
  // encoded separators. Documented here so a future "helpfully" pre-decode
  // doesn't get added without someone noticing it would reopen exactly the
  // traversal `%2e%2e` (a literal dot, not a slash) demonstrates above.
  assert.equal(sanitizeNext("/grafana/..%2f..%2fapi/admin", env), "/grafana/..%2f..%2fapi/admin");
  // A dot segment that still resolves INSIDE /grafana/ is fine.
  assert.equal(sanitizeNext("/grafana/d/../d/abc", env), "/grafana/d/abc");
});

test("sanitizeNext: every open-redirect shape falls back to /grafana/", () => {
  const env = baseEnv();
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
    assert.equal(sanitizeNext(input, env), "/grafana/", `expected /grafana/ fallback for ${JSON.stringify(input)}`);
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

// ---- gates/broker.ts: isValidBrokerUrl / resolveBrokerIdentity ------------

test("M3: isValidBrokerUrl accepts https always; accepts http://localhost only when O11Y_ENV=local; rejects everything else", () => {
  assert.equal(isValidBrokerUrl(baseEnv({ LOGIN_BROKER_URL: "https://mcp-auth-proxy.example.test" })), true);
  assert.equal(isValidBrokerUrl(baseEnv({ O11Y_ENV: "local", LOGIN_BROKER_URL: "http://localhost:6102" })), true);
  assert.equal(isValidBrokerUrl(baseEnv({ O11Y_ENV: "local", LOGIN_BROKER_URL: "http://127.0.0.1:6102" })), true);
  assert.equal(isValidBrokerUrl(baseEnv({ O11Y_ENV: "production", LOGIN_BROKER_URL: "http://localhost:6102" })), false);
  assert.equal(isValidBrokerUrl(baseEnv({ LOGIN_BROKER_URL: "" })), false);
  assert.equal(isValidBrokerUrl(baseEnv({ LOGIN_BROKER_URL: "not a url" })), false);
  assert.equal(isValidBrokerUrl(baseEnv({ LOGIN_BROKER_URL: "http://evil.example" })), false, "a bare http:// non-local host is never allowed");
});

test("M3: the broker fetch is called with a timeout signal and refuses to follow a redirect", async (t) => {
  const env = baseEnv();
  const realFetch = globalThis.fetch;
  let capturedInit;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async (_url, init) => {
    capturedInit = init;
    return new Response(JSON.stringify({ email: "artur.medrygal@handsontable.com" }), { status: 200 });
  };
  await resolveBrokerIdentity(env, "a-broker-token");
  assert.ok(capturedInit.signal instanceof AbortSignal, "must pass an AbortSignal");
  assert.equal(capturedInit.redirect, "error", "must refuse to follow a redirect");
});

test("resolveBrokerIdentity: a @handsontable.com userinfo response resolves", async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ email: "artur.medrygal@handsontable.com" }), { status: 200 });

  const result = await resolveBrokerIdentity(baseEnv(), "a-broker-token");
  assert.deepEqual(result, { email: "artur.medrygal@handsontable.com", exp: null });
});

test("M7: resolveBrokerIdentity rejects lookalike emails (case-sensitive, exact @handsontable.com suffix)", async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  const cases = ["x@handsontable.com.evil", "x@evilhandsontable.com", "X@HANDSONTABLE.COM", "x@handsontable.co"];
  for (const email of cases) {
    globalThis.fetch = async () => new Response(JSON.stringify({ email }), { status: 200 });
    const result = await resolveBrokerIdentity(baseEnv(), "a-broker-token");
    assert.equal(result, null, `expected ${email} to be refused`);
  }
});

test("M7: resolveBrokerIdentity rejects a non-string email (array, null, number)", async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  for (const email of [["artur.medrygal@handsontable.com"], null, 12345]) {
    globalThis.fetch = async () => new Response(JSON.stringify({ email }), { status: 200 });
    assert.equal(await resolveBrokerIdentity(baseEnv(), "a-broker-token"), null);
  }
});

test("M7: resolveBrokerIdentity fails closed when the broker fetch throws", async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async () => { throw new Error("network down"); };
  assert.equal(await resolveBrokerIdentity(baseEnv(), "a-broker-token"), null);
});

test("M7: resolveBrokerIdentity fails closed when the broker returns non-JSON", async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async () => new Response("<html>not json</html>", { status: 200 });
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

// ---- grafana/login.ts: the six routes -----------------------------------

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
  assert.match(setCookie, new RegExp(`^${LOGIN_COOKIE}=`));
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Path=\//);

  const loginToken = cookieValue(setCookie, LOGIN_COOKIE);
  const state = await verifyLoginCookie(
    new Request("https://demos.handsontable.com/grafana/_o11y/login", { headers: { cookie: `${LOGIN_COOKIE}=${loginToken}` } }),
    env,
  );
  assert.equal(state.next, "/grafana/", "an open-redirect next= must never survive into the login cookie");
});

test("M3: GET /login returns 500 (not a broken relative redirect) when LOGIN_BROKER_URL is invalid", async () => {
  const env = baseEnv({ LOGIN_BROKER_URL: "" });
  const res = await handleLogin(new Request("https://demos.handsontable.com/grafana/_o11y/login"), env, {});
  assert.equal(res.status, 500);
  assert.equal(res.headers.get("Location"), null);
});

test("M3: GET /login is rate-limited", async () => {
  const env = baseEnv({ RATE_LIMITER: { limit: async () => ({ success: false }) } });
  const res = await handleLogin(new Request("https://demos.handsontable.com/grafana/_o11y/login"), env, {});
  assert.equal(res.status, 429);
});

test("GET /grafana/_o11y/callback: strict CSP (framing and forms refused too), no-store, referrer-policy, nosniff, no third-party script", async () => {
  const res = await handleCallback(new Request("https://demos.handsontable.com/grafana/_o11y/callback?n=x"), baseEnv(), {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  const csp = res.headers.get("content-security-policy");
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'sha256-/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /form-action 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  const html = await res.text();
  assert.doesNotMatch(html, /<script[^>]+src=/, "the callback page must load no external script");
});

test("POST /grafana/_o11y/session: the full login round trip mints a session cookie and clears the login cookie", async () => {
  const env = baseEnv();
  const res = await loginThenSession(env);

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.next, "/grafana/");

  const setCookies = allSetCookies(res);
  const sessionCookie = setCookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  const loginClear = setCookies.find((c) => c.startsWith(`${LOGIN_COOKIE}=`));
  assert.ok(sessionCookie, "must set the session cookie");
  assert.match(loginClear, /Max-Age=0/, "must clear the login cookie");
  // Session cookie attributes, asserted directly (M7: previously only the
  // LOGIN cookie's attributes were checked anywhere).
  assert.match(sessionCookie, /HttpOnly/);
  assert.match(sessionCookie, /Secure/);
  assert.match(sessionCookie, /SameSite=Lax/);
  assert.match(sessionCookie, /Path=\//);

  // The broker JWT itself must never appear in ANY Set-Cookie header —
  // only our own signed session token (a DIFFERENT string) may.
  for (const c of setCookies) {
    assert.doesNotMatch(c, /a-real-broker-token/);
  }

  const sessionToken = cookieValue(sessionCookie, SESSION_COOKIE);
  const verifyReq = new Request("https://demos.handsontable.com/grafana/", {
    headers: { cookie: `${SESSION_COOKIE}=${sessionToken}` },
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

test("M7: POST /grafana/_o11y/session with NO o11y_login cookie at all is rejected (the real login-CSRF shape)", async () => {
  const env = baseEnv();
  const req = new Request("https://demos.handsontable.com/grafana/_o11y/session", {
    method: "POST",
    headers: { "content-type": "application/json", Origin: "https://demos.handsontable.com" },
    body: JSON.stringify({ token: "attacker-token", n: "attacker-chosen-nonce" }),
  });
  const res = await handleSession(req, env, {});
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

test("M3: POST /grafana/_o11y/session is rate-limited", async () => {
  const env = baseEnv({ RATE_LIMITER: { limit: async () => ({ success: false }) } });
  const req = new Request("https://demos.handsontable.com/grafana/_o11y/session", {
    method: "POST",
    headers: { "content-type": "application/json", Origin: "https://demos.handsontable.com" },
    body: JSON.stringify({ token: "x", n: "y" }),
  });
  const res = await handleSession(req, env, {});
  assert.equal(res.status, 429);
});

test("M5: POST /grafana/_o11y/logout clears BOTH cookies and redirects home, only for a same-origin JSON request", async () => {
  const env = baseEnv();
  const okReq = new Request("https://demos.handsontable.com/grafana/_o11y/logout", {
    method: "POST",
    headers: { "content-type": "application/json", Origin: "https://demos.handsontable.com" },
  });
  const okRes = await handleLogout(okReq, env, {});
  assert.equal(okRes.status, 302);
  assert.equal(okRes.headers.get("Location"), "/");
  const setCookies = allSetCookies(okRes);
  assert.ok(setCookies.some((c) => c.startsWith(`${SESSION_COOKIE}=;`) && c.includes("Max-Age=0")));
  assert.ok(setCookies.some((c) => c.startsWith(`${LOGIN_COOKIE}=;`) && c.includes("Max-Age=0")), "logout must also clear the login cookie");

  const crossOriginReq = new Request("https://demos.handsontable.com/grafana/_o11y/logout", {
    method: "POST",
    headers: { "content-type": "application/json", Origin: "https://evil.example" },
  });
  const badRes = await handleLogout(crossOriginReq, env, {});
  assert.equal(badRes.status, 403);
});

test("M5: GET /grafana/_o11y/logout serves a same-origin sign-out page that POSTs to the real logout route", async () => {
  const res = await handleLogoutPage(new Request("https://demos.handsontable.com/grafana/_o11y/logout"), baseEnv(), {});
  assert.equal(res.status, 200);
  const csp = res.headers.get("content-security-policy");
  assert.match(csp, /frame-ancestors 'none'/);
  const html = await res.text();
  assert.match(html, /method: "POST"/);
  assert.match(html, /\/grafana\/_o11y\/logout/);
  assert.doesNotMatch(html, /<form/i, "no actual <form> — the POST is a same-origin fetch, not a submittable form");
});

// Sanity check on the raw cookie-clearing helpers the route handlers above
// build on, directly.
test("sessionClearCookieHeader / loginClearCookieHeader: Max-Age=0, HttpOnly, Secure", () => {
  assert.match(sessionClearCookieHeader(), new RegExp(`^${SESSION_COOKIE}=;.*HttpOnly.*Secure.*Max-Age=0`));
  assert.match(loginClearCookieHeader(), new RegExp(`^${LOGIN_COOKIE}=;.*HttpOnly.*Secure.*Max-Age=0`));
});
