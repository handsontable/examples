// Replaces `gates/access.ts` (Cloudflare Access). Controller decision K1
// (`.superpowers/sdd/README/final/broker-grafana-feasibility.md`): `/grafana/*`
// and `POST /grafana/_o11y/reopen` gate on the Worker's own HMAC-signed
// session cookie, minted once a Handsontable login broker token (ADR-0007)
// has been verified through `gates/broker.ts`. `grafana/login.ts` owns the
// login/callback/session/logout routes that mint and clear the two cookies
// this file signs and verifies; this file has no route of its own.
//
// `verifySession` keeps `verifyAccess`'s exact contract (COMMON.md pinned
// interface 3, superseded by the K1 controller ruling): `(req, env) =>
// Promise<{ email } | null>`, honouring `DEV_ADMIN` only when
// `O11Y_ENV === "local"` (fail-closed, unchanged from the Access gate).

import { jwtVerify, SignJWT } from "jose";
import { PRODUCTION_HOST } from "./util.js";
import type { Env } from "../env.js";

export interface SessionIdentity {
  email: string;
}

/** ADR-0041 §B.1: every request reaches the o11y worker on this hostname in
 *  production. Used for the `return_to` the login route builds — a value
 *  that must never be attacker-influenced, so it is never derived from a
 *  client-sent `Host`. */
export const PUBLIC_ORIGIN = `https://${PRODUCTION_HOST}`;

/**
 * The origin `grafana/login.ts#handleLogin` builds `return_to` against.
 * Locally this MUST resolve to the actual `wrangler dev` origin (mirrors
 * `box.ts`'s own `O11Y_LOCAL_PUBLIC_ORIGIN` → `GF_SERVER_ROOT_URL` pattern)
 * — a real local broker login (`http://localhost` is on the broker's
 * default allowlist, feasibility report §3) otherwise redirects the
 * callback at the hardcoded PRODUCTION host, which does not run this
 * Worker's `/grafana/_o11y/callback` route at all and can never complete.
 * Found by K1's own real local round trip against a stubbed broker, not
 * guessed. `O11Y_LOCAL_PUBLIC_ORIGIN` unset falls back to `O11Y_DEV_PORT`'s
 * own default (`scripts/o11y-dev.mjs`, `docs/run-and-deploy.md`).
 */
export function publicOrigin(env: Env): string {
  if (env.O11Y_ENV === "local") {
    return env.O11Y_LOCAL_PUBLIC_ORIGIN || "http://localhost:4200";
  }
  return PUBLIC_ORIGIN;
}

const SESSION_COOKIE = "o11y_session";
const LOGIN_COOKIE = "o11y_login";
/** `Path=/grafana`, not `/`: this cookie has no business on `/telemetry/*`
 *  or anywhere outside the surface it gates. */
const SESSION_PATH = "/grafana";
/** Narrower than the session cookie — this one only needs to reach the
 *  `/grafana/_o11y/session` exchange endpoint. */
const LOGIN_PATH = "/grafana/_o11y";
/** `typ` claims distinguish the two cookies under the same signing key so a
 *  login-nonce token can never be replayed as a session token or vice versa
 *  — the same anti-confusion pattern the broker's own `typ:"broker_state"` /
 *  `typ:"broker_token"` claims use (feasibility report §1). */
const SESSION_TYP = "o11y_session";
const LOGIN_TYP = "o11y_login";
/** No sliding renewal (a judgement call the feasibility report left open) —
 *  one fixed lifetime, holding only email + expiry + a version, exactly as
 *  the controller's requirements specify. Rotating `O11Y_SESSION_SECRET` is
 *  the emergency revoke; letting a session simply expire is the normal one. */
const SESSION_TTL_SECONDS = 12 * 60 * 60;
/** Login-CSRF/fixation window: long enough for a real Google sign-in
 *  round trip, short enough that a leaked login cookie is useless quickly. */
const LOGIN_TTL_SECONDS = 10 * 60;

function sessionKey(env: Env): Uint8Array {
  if (!env.O11Y_SESSION_SECRET) throw new Error("O11Y_SESSION_SECRET is not configured");
  return new TextEncoder().encode(env.O11Y_SESSION_SECRET);
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function cookieHeader(name: string, value: string, path: string, maxAgeSeconds: number): string {
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=${path}; Max-Age=${maxAgeSeconds}`;
}

function clearCookieHeader(name: string, path: string): string {
  // Max-Age=0 rather than a past Expires date — every runtime this Worker
  // targets (Workers itself, real browsers) treats 0 identically, and it
  // needs no clock formatting.
  return `${name}=; HttpOnly; Secure; SameSite=Lax; Path=${path}; Max-Age=0`;
}

// ---- session cookie ---------------------------------------------------

export async function signSessionCookie(env: Env, email: string): Promise<string> {
  return new SignJWT({ email, typ: SESSION_TYP, v: 1 })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(sessionKey(env));
}

export function sessionSetCookieHeader(token: string): string {
  return cookieHeader(SESSION_COOKIE, token, SESSION_PATH, SESSION_TTL_SECONDS);
}

export function sessionClearCookieHeader(): string {
  return clearCookieHeader(SESSION_COOKIE, SESSION_PATH);
}

/**
 * Verifies the `o11y_session` cookie's HMAC signature, expiry and `typ`
 * claim, returning the identity it carries or `null`.
 *
 * `DEV_ADMIN` is honoured **only** when `O11Y_ENV === "local"` — fail-closed
 * the same way `verifyAccess` documented it: a production deploy's
 * `O11Y_ENV` always comes from `wrangler.jsonc`'s committed `vars` block
 * (never a secret), so `DEV_ADMIN` being accidentally set in production
 * still could not bypass the session check, because the environment check
 * comes first.
 */
export async function verifySession(req: Request, env: Env): Promise<SessionIdentity | null> {
  if (env.O11Y_ENV === "local" && env.DEV_ADMIN) {
    return { email: env.DEV_ADMIN };
  }

  if (!env.O11Y_SESSION_SECRET) return null;

  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, sessionKey(env), { algorithms: ["HS256"] });
    if (payload["typ"] !== SESSION_TYP) return null;
    const email = payload["email"];
    return typeof email === "string" && email.length > 0 ? { email } : null;
  } catch {
    // Forged signature, expired `exp`, or a tampered payload all land here —
    // `jwtVerify` throws for every one of them; none is distinguished, all
    // are refused.
    return null;
  }
}

// ---- login-nonce cookie -------------------------------------------------

export interface LoginState {
  nonce: string;
  next: string;
}

export async function signLoginCookie(env: Env, state: LoginState): Promise<string> {
  return new SignJWT({ n: state.nonce, next: state.next, typ: LOGIN_TYP })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${LOGIN_TTL_SECONDS}s`)
    .sign(sessionKey(env));
}

export function loginSetCookieHeader(token: string): string {
  return cookieHeader(LOGIN_COOKIE, token, LOGIN_PATH, LOGIN_TTL_SECONDS);
}

export function loginClearCookieHeader(): string {
  return clearCookieHeader(LOGIN_COOKIE, LOGIN_PATH);
}

/** Verifies the `o11y_login` cookie the same way {@link verifySession}
 *  verifies the session cookie — signature, expiry, `typ` — and returns the
 *  nonce/`next` it carries, or `null`. This is the login-CSRF/fixation
 *  binding: `grafana/login.ts#handleSession` requires the body's `n` to
 *  equal this cookie's `nonce` before ever calling the broker. */
export async function verifyLoginCookie(req: Request, env: Env): Promise<LoginState | null> {
  if (!env.O11Y_SESSION_SECRET) return null;
  const token = readCookie(req, LOGIN_COOKIE);
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, sessionKey(env), { algorithms: ["HS256"] });
    if (payload["typ"] !== LOGIN_TYP) return null;
    const nonce = payload["n"];
    const next = payload["next"];
    if (typeof nonce !== "string" || typeof next !== "string") return null;
    return { nonce, next };
  } catch {
    return null;
  }
}

export function mintNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---- `next` validator (open-redirect defense) ----------------------------

const GRAFANA_PREFIX = "/grafana/";
const RESERVED_PREFIX = "/grafana/_o11y/";
const DEFAULT_NEXT = "/grafana/";
/** RFC 3986 scheme grammar — `next=https://evil` or `javascript:...` must
 *  never reach `location.replace`, and this rejects the scheme form
 *  regardless of which scheme it names. */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Only a same-origin path under `/grafana/`, never under the reserved
 * `/grafana/_o11y/` namespace (the login machinery's own routes), and never
 * a scheme- or host-carrying string (`//evil.example`, `https://evil`,
 * `/\evil` — the backslash form some browsers still treat as a host
 * separator). Anything else falls back to `/grafana/`. `next` never reaches
 * the broker (it rides only inside the signed `o11y_login` cookie), so the
 * broker round trip cannot influence this value at all — this validator is
 * the only defense, and it runs on both the mint side (`handleLogin`) and
 * read side (`handleSession`, defence in depth against a cookie forged some
 * other way).
 */
export function sanitizeNext(raw: string | null | undefined): string {
  if (!raw) return DEFAULT_NEXT;
  if (raw.startsWith("//") || raw.startsWith("/\\") || SCHEME_RE.test(raw)) return DEFAULT_NEXT;
  if (raw !== "/grafana" && !raw.startsWith(GRAFANA_PREFIX)) return DEFAULT_NEXT;
  const path = raw === "/grafana" ? "/grafana/" : raw;
  if (path.startsWith(RESERVED_PREFIX)) return DEFAULT_NEXT;
  return path;
}

// ---- navigation classification (redirect vs. 401) ------------------------

/**
 * A top-level browser navigation — `Sec-Fetch-Mode: navigate`, or an
 * `Accept` header naming `text/html` (the signal every browser sends on a
 * document request, Fetch-Metadata-aware or not). Everything else (no
 * signal at all — `curl`, most tooling — or an explicit non-navigate mode
 * such as `cors`/`no-cors`/`same-origin`) is treated as a background
 * request. Used only to choose 302-to-login vs. 401-JSON on an
 * unauthenticated request to `/grafana/*` — never to decide whether to wake
 * the box (that is `grafana/proxy.ts#isTopLevelNavigation`'s separate,
 * fail-open rule, kept exactly as it was).
 */
export function isBrowserNavigation(req: Request): boolean {
  if (req.headers.get("sec-fetch-mode") === "navigate") return true;
  const accept = req.headers.get("accept");
  return accept !== null && accept.includes("text/html");
}

// ---- same-origin check (CSRF: session, logout, reopen) -------------------

/**
 * Exact same-origin check against the request's own URL — not a fixed
 * `https://demos.handsontable.com` compare, so this also holds under local
 * `wrangler dev` (`http://localhost:<port>`). SameSite=Lax already blocks a
 * cross-site fetch/XHR from carrying either cookie, but a request from
 * another `*.handsontable.com` origin (a Tier-2 preview host, say) is
 * same-site, not cross-site, and Lax does not stop that — this is the
 * actual CSRF defense for the three state-changing routes that need one.
 */
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get("Origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(req.url).origin;
  } catch {
    return false;
  }
}
