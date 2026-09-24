// `GET /grafana/_o11y/login`, `GET /grafana/_o11y/callback`,
// `POST /grafana/_o11y/session`, `GET /grafana/_o11y/logout` (a same-origin
// sign-out page), `POST /grafana/_o11y/logout` (the actual state-clearing
// action) — the broker login round trip that replaces Cloudflare Access for
// `/grafana/*` (controller decision K1; see
// `.superpowers/sdd/README/final/broker-grafana-feasibility.md` and
// ADR-0041 §B.5/§H).
//
// None of these routes ever calls `getGrafanaBoxStub` — an unauthenticated
// visitor (login, callback, the logout page) or a not-yet-authenticated POST
// (session) must never wake the box, the same "gate first, box second"
// ordering `grafana/proxy.ts` already enforces for the proxy route itself.
//
// K1 fix round (security review `.superpowers/sdd/README/final/K1-review.md`):
// - I3: the session TTL is capped at the broker token's own `exp`
//   (`gates/session.ts#computeSessionTtlSeconds`), not a flat 12h.
// - M3: `/login` refuses a missing/invalid secret or broker URL with a clear
//   500 instead of building a broken redirect, and both `/login` and
//   `/session` sit behind the existing `RATE_LIMITER` binding, keyed by IP —
//   an anonymous caller replaying their own login cookie's nonce for 10
//   minutes, or hammering `/login`, no longer gets an unbounded number of
//   free `/broker/userinfo` round trips out of this Worker.
// - M4: the callback page's CSP also refuses framing and form submission,
//   plus `X-Content-Type-Options: nosniff`.
// - M5: logout now clears BOTH cookies in one response, and a small
//   same-origin page under `/grafana/_o11y/logout` (GET) gives a person an
//   actual link to reach — the state-clearing request it fires is still the
//   CSRF-protected `POST` this file already had.
// - M7: `handleSession` refusing a request with no `o11y_login` cookie at
//   all (not just a mismatched nonce) is the real login-CSRF shape the
//   review's own test-gap note names — see the test file for the guard this
//   protects.

import {
  computeSessionTtlSeconds,
  isSameOrigin,
  isSessionSecretValid,
  loginClearCookieHeader,
  loginSetCookieHeader,
  mintNonce,
  publicOrigin,
  sanitizeNext,
  sessionClearCookieHeader,
  sessionSetCookieHeader,
  signLoginCookie,
  signSessionCookie,
  verifyLoginCookie,
} from "../gates/session.js";
import { isValidBrokerUrl, resolveBrokerIdentity } from "../gates/broker.js";
import { checkRateLimit } from "../gates/rate-limit.js";
import type { Env } from "../env.js";
import type { RouteHandler } from "../router.js";

function jsonResponse(body: unknown, status: number, headers?: HeadersInit): Response {
  const h = new Headers(headers);
  h.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { status, headers: h });
}

function contentTypeIsJson(req: Request): boolean {
  const raw = req.headers.get("content-type");
  if (!raw) return false;
  return raw.split(";")[0]?.trim().toLowerCase() === "application/json";
}

/** M3: keyed on `cf-connecting-ip` (the same header `gates/browser.ts` uses
 *  for `collect`/`lite`), prefixed per route so an attacker hammering one of
 *  these two routes cannot also exhaust the other's budget for the same IP.
 *  Shares `wrangler.jsonc`'s single `RATE_LIMITER` binding/namespace — a
 *  distinct key still gets its own counting bucket. */
async function rateLimited(req: Request, env: Env, prefix: string): Promise<boolean> {
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  const result = await checkRateLimit(env, `${prefix}:${ip}`);
  return !result.ok;
}

/** `handleLogin`'s own pre-flight: a misconfigured secret or broker URL
 *  must answer a clear, static 500 — never a redirect built from a broken
 *  value (M3's probed failure: an empty `LOGIN_BROKER_URL` produced
 *  `Location: /broker/login?...`, sending the browser at this Worker's own,
 *  nonexistent route). */
function configurationError(env: Env): string | null {
  if (!isSessionSecretValid(env)) return "Grafana sign-in is not configured (O11Y_SESSION_SECRET unset or too short).";
  if (!isValidBrokerUrl(env)) return "Grafana sign-in is not configured (LOGIN_BROKER_URL unset or invalid).";
  return null;
}

// ---- GET /grafana/_o11y/login --------------------------------------------

export const handleLogin: RouteHandler = async (req, env) => {
  const configError = configurationError(env);
  if (configError) return new Response(configError, { status: 500 });

  if (await rateLimited(req, env, "o11y-login")) {
    return new Response("Too many sign-in attempts. Try again shortly.", { status: 429 });
  }

  const url = new URL(req.url);
  const next = sanitizeNext(url.searchParams.get("next"), env);
  const nonce = mintNonce();
  const loginCookie = await signLoginCookie(env, { nonce, next });

  // `next` rides ONLY inside the signed `o11y_login` cookie — never in
  // `return_to` — so the broker round trip cannot influence it at all
  // (feasibility report, "Open redirect"). `return_to` carries only the
  // nonce, which the callback echoes back as `?n=`.
  const returnTo = `${publicOrigin(env)}/grafana/_o11y/callback?n=${encodeURIComponent(nonce)}`;
  const location = `${env.LOGIN_BROKER_URL}/broker/login?return_to=${encodeURIComponent(returnTo)}`;

  return new Response(null, {
    status: 302,
    headers: { Location: location, "Set-Cookie": loginSetCookieHeader(loginCookie) },
  });
};

// ---- GET /grafana/_o11y/callback -----------------------------------------

/**
 * The callback page's own script, hash-pinned into the CSP below (no
 * `unsafe-inline`). Strips the URL fragment with `history.replaceState`
 * BEFORE anything else — the feasibility report's "Token-in-URL leakage"
 * risk requires this to be the very first thing the page does, ahead of the
 * `fetch` — then POSTs the token same-origin to `/grafana/_o11y/session`
 * and navigates only to whatever that endpoint returns (never to a
 * caller-controlled value: `sanitizeNext` runs server-side on `next` before
 * it is ever handed back here).
 */
const CALLBACK_SCRIPT = `(function(){
  var hash = new URLSearchParams(location.hash.slice(1));
  var n = new URLSearchParams(location.search).get("n") || "";
  history.replaceState(null, "", location.pathname);
  var msg = document.getElementById("m");
  if (hash.get("error")) { msg.textContent = "Sign-in failed. Try again."; return; }
  var token = hash.get("token");
  if (!token) { msg.textContent = "Sign-in failed. Try again."; return; }
  fetch("/grafana/_o11y/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: token, n: n })
  }).then(function (res) {
    if (!res.ok) { msg.textContent = "Sign-in failed. Try again."; return null; }
    return res.json();
  }).then(function (body) {
    if (body && body.next) location.replace(body.next);
  }).catch(function () {
    msg.textContent = "Sign-in failed. Try again.";
  });
})();`;

async function scriptSha256Base64(script: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script));
  let bin = "";
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Shared by the callback page and the logout page (M5) — both are static,
 *  script-only pages with no form and no reason to ever be framed. M4: adds
 *  `frame-ancestors 'none'` (the review: "the callback page can be framed
 *  by any origin... a same-site preview host would even get the Lax cookie
 *  sent inside the frame") and `form-action 'none'` (defence in depth —
 *  neither page has a `<form>`, but nothing should ever be able to add
 *  one). `X-Content-Type-Options: nosniff` sits alongside it, not inside
 *  the CSP string — a separate header, not a CSP directive. */
async function staticPageHeaders(script: string): Promise<HeadersInit> {
  const hash = await scriptSha256Base64(script);
  const csp = [
    "default-src 'none'",
    `script-src 'sha256-${hash}'`,
    "connect-src 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join("; ");
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "content-security-policy": csp,
    "x-content-type-options": "nosniff",
  };
}

export const handleCallback: RouteHandler = async () => {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Signing in — Handsontable observability</title>
</head>
<body>
<p id="m">Signing in…</p>
<script>${CALLBACK_SCRIPT}</script>
</body>
</html>
`;

  return new Response(html, {
    status: 200,
    // The broker JWT sits in this page's own URL fragment until the script
    // strips it — never persisted, and `no-store`/`no-referrer` stop it
    // leaking through history-adjacent caches or a proxy re-fetch of this
    // page.
    headers: await staticPageHeaders(CALLBACK_SCRIPT),
  });
};

// ---- POST /grafana/_o11y/session -----------------------------------------

interface SessionBody {
  token: string;
  n: string;
}

function isSessionBody(value: unknown): value is SessionBody {
  const v = value as Partial<SessionBody> | null;
  return typeof v === "object" && v !== null && typeof v.token === "string" && v.token.length > 0 &&
    typeof v.n === "string" && v.n.length > 0;
}

export const handleSession: RouteHandler = async (req, env) => {
  if (!isSessionSecretValid(env)) return jsonResponse({ error: "not_configured" }, 500);
  if (!isSameOrigin(req)) return jsonResponse({ error: "bad_origin" }, 403);
  if (!contentTypeIsJson(req)) return jsonResponse({ error: "expected content-type: application/json" }, 415);

  if (await rateLimited(req, env, "o11y-session")) {
    return jsonResponse({ error: "rate_limited" }, 429);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }
  if (!isSessionBody(body)) return jsonResponse({ error: "expected { token: string, n: string }" }, 400);

  // Login-CSRF / fixation binding (feasibility report design): the state
  // this browser itself minted at `/login` must still be present (M7: a
  // request with NO `o11y_login` cookie at all is refused here too — the
  // real shape a login-CSRF attempt takes, not merely a mismatched nonce)
  // and must name the SAME nonce the callback's `?n=` carried — an attacker
  // who tricks a victim into visiting a crafted
  // `/callback?n=<attacker's own nonce>#token=<attacker's own token>`
  // cannot complete this exchange without also forging the victim's signed
  // `o11y_login` cookie.
  const state = await verifyLoginCookie(req, env);
  if (!state || state.nonce !== body.n) {
    return jsonResponse({ error: "nonce_mismatch" }, 401);
  }

  // One live verification against the broker (never cached, never trusted
  // beyond this single call) — the broker JWT itself is discarded the
  // moment this returns; it is NEVER stored, logged, or placed in any
  // cookie. Only the email it names ends up in `o11y_session`.
  const identity = await resolveBrokerIdentity(env, body.token);
  if (!identity) return jsonResponse({ error: "not_authorized" }, 401);

  // I3: capped at the broker token's own `exp`, not a flat 12h — see
  // `computeSessionTtlSeconds`'s own doc comment for why, and ADR-0041 §M's
  // K1 delta for the DEV-3088 blast-radius reasoning.
  const ttlSeconds = computeSessionTtlSeconds(identity.exp);
  const sessionToken = await signSessionCookie(env, identity.email, ttlSeconds);
  const headers = new Headers();
  headers.append("Set-Cookie", sessionSetCookieHeader(sessionToken, ttlSeconds));
  headers.append("Set-Cookie", loginClearCookieHeader());
  return jsonResponse({ next: sanitizeNext(state.next, env) }, 200, headers);
};

// ---- GET /grafana/_o11y/logout (a same-origin sign-out page, M5) --------

/** Fires the actual, CSRF-protected `POST /grafana/_o11y/logout` from a
 *  same-origin script (never a bare `<a href>`/GET — that would make
 *  logout forgeable by any cross-site top-level navigation under
 *  `SameSite=Lax`, which the review explicitly credited the existing route
 *  for NOT being: "The route is not CSRF-able... needs POST, an exact
 *  Origin and JSON"). This page exists only so a person has somewhere to
 *  click — Grafana's own sign-out menu item is disabled
 *  (`grafana.ini:23`). */
const LOGOUT_SCRIPT = `(function(){
  var msg = document.getElementById("m");
  fetch("/grafana/_o11y/logout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  }).then(function () {
    location.replace("/grafana/");
  }).catch(function () {
    msg.textContent = "Sign-out failed. Try again.";
  });
})();`;

export const handleLogoutPage: RouteHandler = async () => {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Signing out — Handsontable observability</title>
</head>
<body>
<p id="m">Signing out…</p>
<script>${LOGOUT_SCRIPT}</script>
</body>
</html>
`;
  return new Response(html, { status: 200, headers: await staticPageHeaders(LOGOUT_SCRIPT) });
};

// ---- POST /grafana/_o11y/logout -------------------------------------------

export const handleLogout: RouteHandler = async (req) => {
  if (!isSameOrigin(req)) return jsonResponse({ error: "bad_origin" }, 403);
  if (!contentTypeIsJson(req)) return jsonResponse({ error: "expected content-type: application/json" }, 415);

  // M5: clears BOTH cookies — the old version left `o11y_login` behind
  // (harmless on its own short TTL, but "logout clears state" should mean
  // all of it).
  const headers = new Headers({ Location: "/" });
  headers.append("Set-Cookie", sessionClearCookieHeader());
  headers.append("Set-Cookie", loginClearCookieHeader());
  return new Response(null, { status: 302, headers });
};
