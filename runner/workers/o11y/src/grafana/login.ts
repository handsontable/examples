// `GET /grafana/_o11y/login|callback`, `POST /grafana/_o11y/session`,
// `GET /grafana/_o11y/logout` (a same-origin sign-out page),
// `POST /grafana/_o11y/logout` (the actual state-clearing action) — the
// broker login round trip that replaces Cloudflare Access (ADR-0041
// §B.5/§H). None of these routes ever calls `getGrafanaBoxStub` — the same
// "gate first, box second" ordering `grafana/proxy.ts` enforces.

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
import { checkRateLimit, RATE_LIMIT_PERIOD_SECONDS } from "../gates/rate-limit.js";
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

/** Keyed on `cf-connecting-ip`, prefixed per route so an attacker
 *  hammering one route cannot exhaust the other's budget for the same IP.
 *  Returns the `Retry-After` seconds to send when rate-limited, `null`
 *  otherwise — a scripted client hitting this 429 gets the same back-off
 *  signal `respond.ts#respondDrop` already gives the telemetry routes. */
async function rateLimited(req: Request, env: Env, prefix: string): Promise<number | null> {
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  const result = await checkRateLimit(env, `${prefix}:${ip}`);
  if (result.ok) return null;
  return result.retryAfterSeconds ?? RATE_LIMIT_PERIOD_SECONDS;
}

/** `handleLogin`'s own pre-flight: a misconfigured secret or broker URL
 *  answers a clear, static 500 — never a redirect built from a broken
 *  value. */
function configurationError(env: Env): string | null {
  if (!isSessionSecretValid(env)) return "Grafana sign-in is not configured (O11Y_SESSION_SECRET unset or too short).";
  if (!isValidBrokerUrl(env)) return "Grafana sign-in is not configured (LOGIN_BROKER_URL unset or invalid).";
  return null;
}

// ---- GET /grafana/_o11y/login --------------------------------------------

export const handleLogin: RouteHandler = async (req, env) => {
  const configError = configurationError(env);
  if (configError) return new Response(configError, { status: 500 });

  const retryAfter = await rateLimited(req, env, "o11y-login");
  if (retryAfter !== null) {
    return new Response("Too many sign-in attempts. Try again shortly.", {
      status: 429,
      headers: { "retry-after": String(retryAfter) },
    });
  }

  const url = new URL(req.url);
  const next = sanitizeNext(url.searchParams.get("next"), env);
  const nonce = mintNonce();
  const loginCookie = await signLoginCookie(env, { nonce, next });

  // `next` rides ONLY inside the signed `o11y_login` cookie, never in
  // `return_to` (an open-redirect risk otherwise). `return_to` carries
  // only the nonce, echoed back by the callback as `?n=`.
  const returnTo = `${publicOrigin(env)}/grafana/_o11y/callback?n=${encodeURIComponent(nonce)}`;
  const location = `${env.LOGIN_BROKER_URL}/broker/login?return_to=${encodeURIComponent(returnTo)}`;

  return new Response(null, {
    status: 302,
    headers: { Location: location, "Set-Cookie": loginSetCookieHeader(loginCookie) },
  });
};

// ---- GET /grafana/_o11y/callback -----------------------------------------

/**
 * The callback page's own script, hash-pinned into the CSP below. Strips
 * the URL fragment with `history.replaceState` BEFORE the `fetch`, so a
 * token-in-URL never lingers in browser history — then POSTs the token
 * same-origin to `/grafana/_o11y/session` and navigates only to whatever
 * that endpoint returns (`sanitizeNext` runs server-side).
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

/** Shared by the callback page and the logout page — both are static,
 *  script-only pages with no form and no reason to ever be framed. Adds
 *  `frame-ancestors 'none'` (the callback page must not be framed by any
 *  origin, or a same-site preview host would get the Lax cookie sent
 *  inside the frame) and `form-action 'none'` (defence in depth — neither
 *  page has a `<form>`, but nothing should ever be able to add one).
 *  `X-Content-Type-Options: nosniff` sits alongside it, not inside the CSP
 *  string — a separate header, not a CSP directive. */
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
    // The broker JWT sits in this page's own URL fragment until the
    // script strips it; `no-store`/`no-referrer` stop it leaking through
    // history-adjacent caches.
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

  const retryAfter = await rateLimited(req, env, "o11y-session");
  if (retryAfter !== null) {
    return jsonResponse({ error: "rate_limited" }, 429, { "retry-after": String(retryAfter) });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }
  if (!isSessionBody(body)) return jsonResponse({ error: "expected { token: string, n: string }" }, 400);

  // Login-CSRF binding: the state minted at `/login` must still be
  // present (a missing `o11y_login` cookie is refused too) and must name
  // the SAME nonce the callback's `?n=` carried, so an attacker cannot
  // complete the exchange without forging the victim's signed cookie.
  const state = await verifyLoginCookie(req, env);
  if (!state || state.nonce !== body.n) {
    return jsonResponse({ error: "nonce_mismatch" }, 401);
  }

  // One live verification against the broker, never cached: the JWT is
  // discarded the moment this returns, never stored, logged, or cookied.
  const identity = await resolveBrokerIdentity(env, body.token);
  if (!identity) return jsonResponse({ error: "not_authorized" }, 401);

  // Capped at the broker token's own `exp`, not a flat 12h — see
  // `computeSessionTtlSeconds`'s own doc comment for why, and ADR-0041 §M's
  // DEV-3088 blast-radius reasoning.
  const ttlSeconds = computeSessionTtlSeconds(identity.exp);
  const sessionToken = await signSessionCookie(env, identity.email, ttlSeconds);
  const headers = new Headers();
  headers.append("Set-Cookie", sessionSetCookieHeader(sessionToken, ttlSeconds));
  headers.append("Set-Cookie", loginClearCookieHeader());
  return jsonResponse({ next: sanitizeNext(state.next, env) }, 200, headers);
};

// ---- GET /grafana/_o11y/logout (a same-origin sign-out page) ------------

/** Fires the actual, CSRF-protected `POST /grafana/_o11y/logout` from a
 *  same-origin script — a bare `<a href>`/GET would be forgeable under
 *  `SameSite=Lax`. Grafana's own sign-out menu item is disabled. */
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

  // Clears BOTH cookies — leaving `o11y_login` behind would be harmless on
  // its own short TTL, but "logout clears state" should mean all of it.
  const headers = new Headers({ Location: "/" });
  headers.append("Set-Cookie", sessionClearCookieHeader());
  headers.append("Set-Cookie", loginClearCookieHeader());
  return new Response(null, { status: 302, headers });
};
