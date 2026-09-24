// `GET /grafana/_o11y/login`, `GET /grafana/_o11y/callback`,
// `POST /grafana/_o11y/session`, `POST /grafana/_o11y/logout` — the broker
// login round trip that replaces Cloudflare Access for `/grafana/*`
// (controller decision K1; see
// `.superpowers/sdd/README/final/broker-grafana-feasibility.md` and
// ADR-0041 §B.5/§H).
//
// None of these four routes ever calls `getGrafanaBoxStub` — an
// unauthenticated visitor (login, callback) or a not-yet-authenticated POST
// (session) must never wake the box, the same "gate first, box second"
// ordering `grafana/proxy.ts` already enforces for the proxy route itself.

import {
  isSameOrigin,
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
import { resolveBrokerIdentity } from "../gates/broker.js";
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

// ---- GET /grafana/_o11y/login --------------------------------------------

export const handleLogin: RouteHandler = async (req, env) => {
  if (!env.O11Y_SESSION_SECRET) {
    return new Response("Grafana sign-in is not configured (O11Y_SESSION_SECRET unset).", { status: 500 });
  }

  const url = new URL(req.url);
  const next = sanitizeNext(url.searchParams.get("next"));
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

export const handleCallback: RouteHandler = async () => {
  const hash = await scriptSha256Base64(CALLBACK_SCRIPT);
  // No third-party resources of any kind: `default-src 'none'` refuses
  // everything not explicitly allowed; `script-src` allows only this exact
  // inline script (no CDN, no `unsafe-inline`); `connect-src 'self'` is the
  // one network call the page makes; `base-uri 'none'` blocks a `<base>`
  // injection from retargeting a relative URL this page never uses anyway.
  const csp = [
    "default-src 'none'",
    `script-src 'sha256-${hash}'`,
    "connect-src 'self'",
    "base-uri 'none'",
  ].join("; ");

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
    headers: {
      "content-type": "text/html; charset=utf-8",
      // The broker JWT sits in this page's own URL fragment until the
      // script strips it — never persisted, and this stops it leaking
      // through history-adjacent caches or a proxy re-fetch of this page.
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": csp,
    },
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
  if (!env.O11Y_SESSION_SECRET) return jsonResponse({ error: "not_configured" }, 500);
  if (!isSameOrigin(req)) return jsonResponse({ error: "bad_origin" }, 403);
  if (!contentTypeIsJson(req)) return jsonResponse({ error: "expected content-type: application/json" }, 415);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }
  if (!isSessionBody(body)) return jsonResponse({ error: "expected { token: string, n: string }" }, 400);

  // Login-CSRF / fixation binding (feasibility report design): the state
  // this browser itself minted at `/login` must still be present and must
  // name the SAME nonce the callback's `?n=` carried — an attacker who
  // tricks a victim into visiting a crafted `/callback?n=<attacker's own
  // nonce>#token=<attacker's own token>` cannot complete this exchange
  // without also forging the victim's signed `o11y_login` cookie.
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

  const sessionToken = await signSessionCookie(env, identity.email);
  const headers = new Headers();
  headers.append("Set-Cookie", sessionSetCookieHeader(sessionToken));
  headers.append("Set-Cookie", loginClearCookieHeader());
  return jsonResponse({ next: sanitizeNext(state.next) }, 200, headers);
};

// ---- POST /grafana/_o11y/logout ------------------------------------------

export const handleLogout: RouteHandler = async (req) => {
  if (!isSameOrigin(req)) return jsonResponse({ error: "bad_origin" }, 403);
  if (!contentTypeIsJson(req)) return jsonResponse({ error: "expected content-type: application/json" }, 415);

  return new Response(null, {
    status: 302,
    headers: { Location: "/", "Set-Cookie": sessionClearCookieHeader() },
  });
};
