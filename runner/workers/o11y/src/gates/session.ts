// Replaces the deleted Cloudflare Access gate: `/grafana/*` and
// `POST /grafana/_o11y/reopen` gate on the Worker's own HMAC-signed session
// cookie, minted once a Handsontable login broker token (ADR-0007) has been
// verified through `gates/broker.ts`. `grafana/login.ts` owns the
// login/callback/session/logout routes that mint and clear the two cookies
// this file signs and verifies; this file has no route of its own.

import { jwtVerify, SignJWT } from "jose";
import { PRODUCTION_HOST } from "./util.js";
import type { Env } from "../env.js";

export interface SessionIdentity {
  email: string;
}

/** ADR-0041 §B.1: every request reaches the o11y worker on this hostname in
 *  production. Used for `return_to` and the `aud` claim on every signed
 *  token; neither must ever be derived from a client-sent `Host`. */
export const PUBLIC_ORIGIN = `https://${PRODUCTION_HOST}`;

/**
 * The origin `grafana/login.ts#handleLogin` builds `return_to` against, and
 * the `aud` every token is signed for. Locally it must resolve to the real
 * `wrangler dev` origin (`box.ts`'s `O11Y_LOCAL_PUBLIC_ORIGIN` pattern), or
 * the broker callback lands on a host this route doesn't run on.
 * `O11Y_LOCAL_PUBLIC_ORIGIN` unset falls back to `O11Y_DEV_PORT`'s default
 * (`scripts/o11y-dev.mjs`, `docs/run-and-deploy.md`). Gated on
 * `O11Y_ENV === "local"` only: since it is also the token `aud`, this is
 * what stops a `wrangler dev` session from being accepted in production.
 */
export function publicOrigin(env: Env): string {
  if (env.O11Y_ENV === "local") {
    return env.O11Y_LOCAL_PUBLIC_ORIGIN || "http://localhost:4200";
  }
  return PUBLIC_ORIGIN;
}

// `__Host-` refuses `Domain=`, so a subdomain (e.g. a Tier-2 preview host)
// cannot toss a cookie to lock a victim out of `/grafana/*`. `Path=/` also
// reaches `/telemetry/*` and other workers on the host, but both are
// HttpOnly and unread there, so it's inert. Exported for
// `pipeline/o11y-session.test.mjs`'s assertions.
export const SESSION_COOKIE = "__Host-o11y_session";
export const LOGIN_COOKIE = "__Host-o11y_login";
const COOKIE_PATH = "/";

/** `typ` distinguishes the two cookies' payload shapes; the actual key
 *  separation is the HKDF `info` string below, not this claim alone. */
export const SESSION_TYP = "o11y_session";
const LOGIN_TYP = "o11y_login";

/** Capped at `min(now + 12h, brokerTokenExp)`: a stolen 1h broker token
 *  (DEV-3088) must not become an unrevocable 12h session. See ADR-0041 §M,
 *  {@link computeSessionTtlSeconds}. */
export const SESSION_MAX_TTL_SECONDS = 12 * 60 * 60;
/** Used when the broker token carries no readable `exp` claim
 *  (`gates/broker.ts#resolveBrokerIdentity`). 1h matches the authoring
 *  app's own broker-token lifetime. */
export const SESSION_FALLBACK_TTL_SECONDS = 60 * 60;
/** Login-CSRF/fixation window: long enough for a real Google sign-in
 *  round trip, short enough that a leaked login cookie is useless quickly. */
const LOGIN_TTL_SECONDS = 10 * 60;

/** Shorter than this is treated as MISSING (every gate fails closed). 32
 *  bytes matches the runbook's `openssl rand -hex 32`, measured in UTF-8
 *  bytes so hex and raw high-entropy text clear the same bar. */
const MIN_SECRET_BYTES = 32;

/** Present AND at least {@link MIN_SECRET_BYTES} long. `grafana/login.ts`
 *  checks this BEFORE doing any other work on `/login`/`/session`, so a
 *  misconfigured secret answers a clear 500 rather than an opaque signing
 *  failure. `verifySession`/`verifyLoginCookie` do not need to call this
 *  separately — {@link deriveKey} enforces the same floor and their
 *  `catch` already treats any failure as "not authenticated". */
export function isSessionSecretValid(env: Env): boolean {
  return !!env.O11Y_SESSION_SECRET && new TextEncoder().encode(env.O11Y_SESSION_SECRET).byteLength >= MIN_SECRET_BYTES;
}

const SESSION_HKDF_INFO = "o11y_session/v1";
const LOGIN_HKDF_INFO = "o11y_login/v1";

/** One derived `CryptoKey` per (env, purpose): HKDF-SHA256, pure domain
 *  separation (not a password KDF), keyed by
 *  {@link SESSION_HKDF_INFO}/{@link LOGIN_HKDF_INFO} so a broken login key
 *  does not imply the session key is broken too. Keyed by `env` identity
 *  (`WeakMap`), never the secret string, so the raw secret is never held
 *  as a cache key. Throws when the secret is missing or short. */
const derivedKeyCache = new WeakMap<Env, Map<string, Promise<CryptoKey>>>();

function secretBytes(env: Env): Uint8Array {
  if (!env.O11Y_SESSION_SECRET) throw new Error("O11Y_SESSION_SECRET is not configured");
  const bytes = new TextEncoder().encode(env.O11Y_SESSION_SECRET);
  if (bytes.byteLength < MIN_SECRET_BYTES) {
    throw new Error(`O11Y_SESSION_SECRET must be at least ${MIN_SECRET_BYTES} bytes (got ${bytes.byteLength})`);
  }
  return bytes;
}

async function deriveKey(env: Env, info: string): Promise<CryptoKey> {
  let perEnv = derivedKeyCache.get(env);
  if (!perEnv) {
    perEnv = new Map();
    derivedKeyCache.set(env, perEnv);
  }
  let cached = perEnv.get(info);
  if (!cached) {
    cached = (async () => {
      const secret = secretBytes(env);
      const keyMaterial = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
      return crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(info) },
        keyMaterial,
        { name: "HMAC", hash: "SHA-256", length: 256 },
        false,
        ["sign", "verify"],
      );
    })();
    perEnv.set(info, cached);
  }
  return cached;
}

/** Test-only: lets `pipeline/o11y-session.test.mjs` sign a deliberately
 *  malformed token (missing `exp`, a wrong `v`, a wrong `aud`) with the
 *  SAME derived key `verifySession` actually verifies against — proving the
 *  claim checks themselves reject it, not merely an untested signature
 *  mismatch. Never imported by production code. */
export async function _deriveSessionKeyForTests(env: Env): Promise<CryptoKey> {
  return deriveKey(env, SESSION_HKDF_INFO);
}
/** Test-only counterpart for the login-nonce key. See
 *  {@link _deriveSessionKeyForTests}'s doc comment. */
export async function _deriveLoginKeyForTests(env: Env): Promise<CryptoKey> {
  return deriveKey(env, LOGIN_HKDF_INFO);
}

/** Every value present for `name` in the `Cookie` header, in header order.
 *  A single-match lookup would resolve a duplicate name
 *  (`o11y_session=junk; o11y_session=<valid>`) to the attacker-tossed first
 *  value. `__Host-` already stops a cross-host toss from being stored, but
 *  this is defence in depth for any other source of a duplicate (a proxy
 *  that folds headers oddly); every verify function below tries each value
 *  in turn and accepts the first that verifies. */
function readCookieValues(req: Request, name: string): string[] {
  const raw = req.headers.get("cookie");
  if (!raw) return [];
  const values: string[] = [];
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) values.push(part.slice(eq + 1).trim());
  }
  return values;
}

function cookieHeader(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=${COOKIE_PATH}; Max-Age=${maxAgeSeconds}`;
}

function clearCookieHeader(name: string): string {
  // Max-Age=0 rather than a past Expires date — every runtime this Worker
  // targets (Workers itself, real browsers) treats 0 identically, and it
  // needs no clock formatting.
  return `${name}=; HttpOnly; Secure; SameSite=Lax; Path=${COOKIE_PATH}; Max-Age=0`;
}

// ---- session cookie ---------------------------------------------------

/** `ttlSeconds` is the caller's decision (`grafana/login.ts#handleSession`
 *  computes it via {@link computeSessionTtlSeconds}); this function has no
 *  default of its own, so the cap cannot be silently bypassed by a call site
 *  that forgets to pass one. */
export async function signSessionCookie(env: Env, email: string, ttlSeconds: number): Promise<string> {
  const key = await deriveKey(env, SESSION_HKDF_INFO);
  return new SignJWT({ email, typ: SESSION_TYP, v: 1 })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .setAudience(publicOrigin(env))
    .sign(key);
}

export function sessionSetCookieHeader(token: string, ttlSeconds: number): string {
  return cookieHeader(SESSION_COOKIE, token, ttlSeconds);
}

export function sessionClearCookieHeader(): string {
  return clearCookieHeader(SESSION_COOKIE);
}

/**
 * `min(now + 12h, brokerExpSeconds)`, never a flat 12h.
 * `grafana/login.ts#handleSession` is the only caller, right after
 * `gates/broker.ts#resolveBrokerIdentity` has accepted the token;
 * `brokerExpSeconds` is read from that same token's own payload, never
 * re-verified here. A missing, unparseable or already-past `exp` falls back
 * to {@link SESSION_FALLBACK_TTL_SECONDS} (1h) rather than the 12h ceiling
 * — the conservative direction to err in.
 */
export function computeSessionTtlSeconds(
  brokerExpSeconds: number | null,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): number {
  if (brokerExpSeconds !== null && brokerExpSeconds > nowSeconds) {
    return Math.min(brokerExpSeconds - nowSeconds, SESSION_MAX_TTL_SECONDS);
  }
  return SESSION_FALLBACK_TTL_SECONDS;
}

/**
 * Verifies the `__Host-o11y_session` cookie's HMAC signature, expiry,
 * audience and claims, returning the identity it carries or `null`.
 *
 * `DEV_ADMIN` is honoured **only** when `O11Y_ENV === "local"`, fail-closed:
 * a production deploy's `O11Y_ENV` always comes from `wrangler.jsonc`'s
 * committed `vars` (never a secret), so an accidental `DEV_ADMIN` in
 * production still could not bypass the session check.
 */
export async function verifySession(req: Request, env: Env): Promise<SessionIdentity | null> {
  if (env.O11Y_ENV === "local" && env.DEV_ADMIN) {
    return { email: env.DEV_ADMIN };
  }

  const tokens = readCookieValues(req, SESSION_COOKIE);
  if (tokens.length === 0) return null;

  let key: CryptoKey;
  try {
    key = await deriveKey(env, SESSION_HKDF_INFO);
  } catch {
    // Missing or too-short secret — treated identically to "not authenticated".
    return null;
  }

  for (const token of tokens) {
    try {
      // `exp`/`iat` are required (`jwtVerify` only checks `exp` when
      // present), and `audience` binds the token to the environment it was
      // minted in, so a cookie signed by `wrangler dev` cannot be replayed
      // in production even under a shared secret value.
      const { payload } = await jwtVerify(token, key, {
        algorithms: ["HS256"],
        audience: publicOrigin(env),
        requiredClaims: ["exp", "iat", "aud"],
      });
      if (payload["typ"] !== SESSION_TYP) continue;
      if (payload["v"] !== 1) continue;
      const email = payload["email"];
      if (typeof email === "string" && email.length > 0) return { email };
    } catch {
      // Forged signature, expired `exp`, wrong audience, or a tampered
      // payload all land here — try the next duplicate value, if any.
    }
  }
  return null;
}

// ---- login-nonce cookie -------------------------------------------------

export interface LoginState {
  nonce: string;
  next: string;
}

export async function signLoginCookie(env: Env, state: LoginState): Promise<string> {
  const key = await deriveKey(env, LOGIN_HKDF_INFO);
  return new SignJWT({ n: state.nonce, next: state.next, typ: LOGIN_TYP })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${LOGIN_TTL_SECONDS}s`)
    .setAudience(publicOrigin(env))
    .sign(key);
}

export function loginSetCookieHeader(token: string): string {
  return cookieHeader(LOGIN_COOKIE, token, LOGIN_TTL_SECONDS);
}

export function loginClearCookieHeader(): string {
  return clearCookieHeader(LOGIN_COOKIE);
}

/** Verifies the `__Host-o11y_login` cookie the same way {@link verifySession}
 *  verifies the session cookie, and returns the nonce/`next` it carries, or
 *  `null`. This is the login-CSRF/fixation binding:
 *  `grafana/login.ts#handleSession` requires the body's `n` to equal this
 *  cookie's `nonce`, and requires the cookie to be PRESENT at all — a
 *  missing `__Host-o11y_login` cookie must be a hard refusal, not just a
 *  mismatched-nonce case. */
export async function verifyLoginCookie(req: Request, env: Env): Promise<LoginState | null> {
  const tokens = readCookieValues(req, LOGIN_COOKIE);
  if (tokens.length === 0) return null;

  let key: CryptoKey;
  try {
    key = await deriveKey(env, LOGIN_HKDF_INFO);
  } catch {
    return null;
  }

  for (const token of tokens) {
    try {
      const { payload } = await jwtVerify(token, key, {
        algorithms: ["HS256"],
        audience: publicOrigin(env),
        requiredClaims: ["exp", "iat", "aud"],
      });
      if (payload["typ"] !== LOGIN_TYP) continue;
      const nonce = payload["n"];
      const next = payload["next"];
      if (typeof nonce === "string" && typeof next === "string") return { nonce, next };
    } catch {
      // try the next duplicate value, if any
    }
  }
  return null;
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

/**
 * Only a same-origin path under `/grafana/`, never the reserved
 * `/grafana/_o11y/` namespace (the login machinery's own routes). Anything
 * else falls back to `/grafana/`. `next` never reaches the broker (it rides
 * only inside the signed `o11y_login` cookie), so this validator is the
 * only defense, on both the mint side (`handleLogin`) and read side
 * (`handleSession`).
 *
 * Parses with `new URL(raw, publicOrigin(env))` and re-derives the check
 * from the normalized `pathname`, rather than a string-prefix test:
 * `/grafana/../api/admin` and `/grafana/%2e%2e/api/admin` both pass a
 * prefix test yet resolve outside `/grafana/` once a browser normalizes the
 * dot segments — normalizing here, server-side, closes that gap.
 */
export function sanitizeNext(raw: string | null | undefined, env: Env): string {
  if (!raw) return DEFAULT_NEXT;
  let url: URL;
  try {
    url = new URL(raw, publicOrigin(env));
  } catch {
    return DEFAULT_NEXT;
  }
  if (url.origin !== publicOrigin(env)) return DEFAULT_NEXT;
  if (!url.pathname.startsWith(GRAFANA_PREFIX)) return DEFAULT_NEXT;
  if (url.pathname.startsWith(RESERVED_PREFIX)) return DEFAULT_NEXT;
  return url.pathname + url.search;
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
