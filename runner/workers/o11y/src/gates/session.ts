// Replaces the deleted Cloudflare Access gate. Controller decision K1 (the
// feasibility probe concluded no Cloudflare Access application is needed):
// `/grafana/*` and `POST /grafana/_o11y/reopen` gate on the Worker's own HMAC-signed
// session cookie, minted once a Handsontable login broker token (ADR-0007)
// has been verified through `gates/broker.ts`. `grafana/login.ts` owns the
// login/callback/session/logout routes that mint and clear the two cookies
// this file signs and verifies; this file has no route of its own.
//
// `verifySession` keeps `verifyAccess`'s exact contract (COMMON.md pinned
// interface 3, superseded by the K1 controller ruling): `(req, env) =>
// Promise<{ email } | null>`, honouring `DEV_ADMIN` only when
// `O11Y_ENV === "local"` (fail-closed, unchanged from the Access gate).
//
// K1 fix round (security review of the broker login round trip,
// findings I1/I2/M2): the review's live probe found a 1-byte secret signed
// and verified, a session token with no `exp` or `v:99` verified, and a
// tossed `Domain=` cookie could lock a victim out with no way for login or
// logout to clear it. Fixed here: `O11Y_SESSION_SECRET` must be at least 32
// bytes or every gate fails closed; the session and login-nonce cookies are
// signed with SEPARATE HKDF-derived keys (`o11y_session/v1`/`o11y_login/v1`)
// so an anonymous `GET /login` — which hands out a readable, Worker-signed
// JWT to anyone — never yields a known-plaintext sample under the SAME key
// that guards a session; both cookies use the `__Host-` prefix (`Path=/`,
// `Secure`, no `Domain`), which browsers refuse to let a subdomain toss;
// both tokens require `exp`/`iat`, pin `v: 1`, and are bound to `aud:
// publicOrigin(env)` so a cookie minted under `wrangler dev` cannot be
// replayed against production even if the two secrets happen to match.

import { jwtVerify, SignJWT } from "jose";
import { PRODUCTION_HOST } from "./util.js";
import type { Env } from "../env.js";

export interface SessionIdentity {
  email: string;
}

/** ADR-0041 §B.1: every request reaches the o11y worker on this hostname in
 *  production. Used for the `return_to` the login route builds, and as the
 *  `aud` claim every signed token carries (M2) — both values that must
 *  never be attacker-influenced, so neither is ever derived from a
 *  client-sent `Host`. */
export const PUBLIC_ORIGIN = `https://${PRODUCTION_HOST}`;

/**
 * The origin `grafana/login.ts#handleLogin` builds `return_to` against, and
 * the `aud` every token minted in THIS request is signed for. Locally this
 * MUST resolve to the actual `wrangler dev` origin (mirrors `box.ts`'s own
 * `O11Y_LOCAL_PUBLIC_ORIGIN` → `GF_SERVER_ROOT_URL` pattern) — a real local
 * broker login (`http://localhost` is on the broker's default allowlist,
 * feasibility report §3) otherwise redirects the callback at the hardcoded
 * PRODUCTION host, which does not run this Worker's `/grafana/_o11y/callback`
 * route at all and can never complete. Found by K1's own real local round
 * trip against a stubbed broker, not guessed. `O11Y_LOCAL_PUBLIC_ORIGIN`
 * unset falls back to `O11Y_DEV_PORT`'s own default (`scripts/o11y-dev.mjs`,
 * `docs/run-and-deploy.md`).
 *
 * Gated strictly on `O11Y_ENV === "local"` (fix round M2): this is also the
 * `aud` bound into every token, so ONLY this check stands between a
 * `wrangler dev` session and a production one signed with the same secret
 * value (e.g. a developer testing locally against the real
 * `O11Y_SESSION_SECRET`) — `verifySession`/`verifyLoginCookie` verify
 * `audience: publicOrigin(env)`, so a token minted while `O11Y_ENV=local`
 * carries the local origin and is refused by a production Worker (whose own
 * `O11Y_ENV` always comes from `wrangler.jsonc`'s committed `vars`, never a
 * secret) regardless of the secret.
 */
export function publicOrigin(env: Env): string {
  if (env.O11Y_ENV === "local") {
    return env.O11Y_LOCAL_PUBLIC_ORIGIN || "http://localhost:4200";
  }
  return PUBLIC_ORIGIN;
}

// `__Host-` (fix round I2): requires `Secure`, `Path=/`, and refuses a
// `Domain=` attribute outright — browsers will not even STORE a `Set-Cookie`
// claiming this prefix unless every one of those conditions holds, and will
// not accept a cookie of this name set via `document.cookie` from a
// subdomain either. That closes both halves of the review's I2 finding: an
// anonymous Tier-2 preview host (`*.demos.handsontable.com`, publicly
// obtainable — feasibility §5) tossing `Domain=demos.handsontable.com` to
// lock a victim out of `/grafana/*` with no way for login or logout to clear
// it, and the matching login-CSRF variant against `o11y_login`. Trade-off,
// accepted per the feasibility report and the review: `Path=/` means both
// cookies are now also sent to `/telemetry/*`, the API worker and the
// authoring app on the same host — both are HttpOnly (no `document.cookie`
// exposure) and neither of those code paths reads an incoming `Cookie`
// header at all (checked: no `req.headers.get("cookie")` anywhere in
// `workers/api/src` or `apps/authoring/src`), so they are inert there.
// Exported (not just `const`) so `pipeline/o11y-session.test.mjs` builds its
// assertions and hand-crafted test tokens against these exact names/claim
// values rather than a second, hand-copied literal that could silently
// drift from what the code actually uses.
export const SESSION_COOKIE = "__Host-o11y_session";
export const LOGIN_COOKIE = "__Host-o11y_login";
const COOKIE_PATH = "/";

/** `typ` claims distinguish the two cookies' PAYLOAD SHAPE (a login-nonce
 *  token can never be mistaken for a session token's fields even if it were
 *  somehow verified under the wrong key) — the actual key separation is now
 *  the HKDF `info` string below (fix round I1), not this claim alone. */
export const SESSION_TYP = "o11y_session";
export const LOGIN_TYP = "o11y_login";

/** I3 (controller ruling, security review): the session is capped at
 *  `min(now + 12h, brokerTokenExp)` — never a flat 12h regardless of the
 *  broker token's own lifetime. Exported so `grafana/login.ts#handleSession`
 *  (the only caller with the broker token's `exp` in hand) can compute the
 *  actual TTL through {@link computeSessionTtlSeconds}. See that function's
 *  own doc comment, and ADR-0041 §M's K1 delta, for why this exists: before
 *  this cap, a 1h stolen broker token (DEV-3088) could be turned into an
 *  unrevocable 12h Grafana session. */
export const SESSION_MAX_TTL_SECONDS = 12 * 60 * 60;
/** Used when the broker token carries no readable `exp` claim (see
 *  `gates/broker.ts#resolveBrokerIdentity`'s doc comment for exactly when
 *  that happens) — 1h matches the authoring app's own broker-token
 *  lifetime, so an operator relying on "how long does a login last"
 *  intuition from that surface is not surprised here. */
export const SESSION_FALLBACK_TTL_SECONDS = 60 * 60;
/** Login-CSRF/fixation window: long enough for a real Google sign-in
 *  round trip, short enough that a leaked login cookie is useless quickly. */
const LOGIN_TTL_SECONDS = 10 * 60;

/** I1: a secret shorter than this is treated exactly like a MISSING one —
 *  every gate fails closed, `/login` and `/session` answer 500. 32 bytes
 *  matches the runbook's own `openssl rand -hex 32` instruction; this is
 *  what actually enforces it instead of merely suggesting it. Measured in
 *  UTF-8 BYTES, not characters — a secret pasted as hex (64 hex chars = 32
 *  bytes) or as raw high-entropy text both need to clear the same bar. */
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

/** One derived `CryptoKey` per (env, purpose) pair, cached for the isolate's
 *  lifetime — HKDF-SHA256 with an empty salt (the secret itself is already
 *  high-entropy; HKDF here is purely a domain-separation primitive, not a
 *  password KDF) and `info` = {@link SESSION_HKDF_INFO}/{@link LOGIN_HKDF_INFO}.
 *  Fix round I1: before this, both cookies were signed with the literal
 *  `O11Y_SESSION_SECRET` bytes under the same key, so the review's own
 *  probe — an anonymous `GET /login` — handed any visitor a known-plaintext
 *  HMAC sample signed with the SAME key that guards a session. Deriving
 *  separate keys means a broken or brute-forced login-cookie key no longer
 *  implies the session key is broken too (and vice versa).
 *
 *  Keyed by `env` object identity (a `WeakMap`), never by the secret's own
 *  string value — so nothing here ever has to hold the raw secret as a
 *  cache key in long-lived memory. Throws (via {@link secretBytes}) when
 *  the secret is missing or short; every caller below awaits this inside a
 *  `try`/`catch` (or a caller that has already checked
 *  {@link isSessionSecretValid}), so that failure always resolves to the
 *  same "not authenticated" / 500 outcomes a missing secret always had. */
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

/** Every value present for `name` in the `Cookie` header, in header order
 *  (fix round I2: the review's probe found the OLD single-match
 *  `readCookie` resolves `o11y_session=junk; o11y_session=<valid>` to
 *  `null` — the first, attacker-tossed value wins and the real one is never
 *  even tried). `__Host-` already stops a genuinely cross-host toss from
 *  ever being stored, but this is defence in depth for any other source of
 *  a duplicate name (a stale pre-`__Host-` cookie from before this fix, a
 *  proxy that folds headers oddly) — every verify function below tries each
 *  value in turn and accepts the first that verifies. */
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

/** `ttlSeconds` is the caller's decision (I3: `grafana/login.ts#handleSession`
 *  computes it via {@link computeSessionTtlSeconds}) — this function has no
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
 * I3: the session TTL is `min(now + 12h, brokerExpSeconds)`, never a flat
 * 12h — `grafana/login.ts#handleSession` is the only caller, right after
 * `gates/broker.ts#resolveBrokerIdentity` has returned an identity (i.e.
 * the broker has already accepted the token; `brokerExpSeconds` is read
 * from that SAME token's own payload, never trusted as a signature-checked
 * value in its own right — see that function's doc comment). A missing,
 * unparseable, or already-past `exp` falls back to
 * {@link SESSION_FALLBACK_TTL_SECONDS} (1h) rather than the 12h ceiling —
 * treating "we can't read how long this token is good for" the same as "not
 * very long" is the conservative direction to err in.
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

  const tokens = readCookieValues(req, SESSION_COOKIE);
  if (tokens.length === 0) return null;

  let key: CryptoKey;
  try {
    key = await deriveKey(env, SESSION_HKDF_INFO);
  } catch {
    // Missing or too-short secret — treated identically to "not
    // authenticated" (I1: fail closed exactly like a missing secret did).
    return null;
  }

  for (const token of tokens) {
    try {
      // M2: `exp`/`iat` are now REQUIRED (a token with no `exp` used to
      // verify forever — `jwtVerify` only checks `exp` when present), and
      // `audience` binds the token to the environment it was minted in, so
      // a cookie signed by `wrangler dev` cannot be replayed in production
      // even under a shared secret value.
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
 *  verifies the session cookie — signature, expiry, audience, `typ`, every
 *  duplicate value tried in turn — and returns the nonce/`next` it carries,
 *  or `null`. This is the login-CSRF/fixation binding:
 *  `grafana/login.ts#handleSession` requires the body's `n` to equal this
 *  cookie's `nonce` before ever calling the broker, and — as important —
 *  requires this cookie to be PRESENT at all: a request with no
 *  `__Host-o11y_login` cookie returns `null` here, which
 *  `handleSession` must treat as a hard refusal (fix round M7: the review
 *  found no test exercised "no login cookie at all", the real shape a
 *  login-CSRF attack takes, only a mismatched-nonce case). */
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
 * Only a same-origin path under `/grafana/`, never under the reserved
 * `/grafana/_o11y/` namespace (the login machinery's own routes). Anything
 * else falls back to `/grafana/`. `next` never reaches the broker (it rides
 * only inside the signed `o11y_login` cookie), so the broker round trip
 * cannot influence this value at all — this validator is the only defense,
 * and it runs on both the mint side (`handleLogin`) and read side
 * (`handleSession`, defence in depth against a cookie forged some other
 * way).
 *
 * Fix round M1 (security review): the OLD version was a string-prefix test,
 * not a URL parse — `raw` beginning `/grafana/` was accepted verbatim, so
 * `/grafana/../api/admin` and the WHATWG-decoded `/grafana/%2e%2e/api/admin`
 * both passed (the leading literal matched) and then resolved OUTSIDE
 * `/grafana/` once a browser's `location.replace` normalized the dot
 * segments. Parsing with `new URL(raw, publicOrigin(env))` first and
 * re-deriving the check from the NORMALIZED `pathname` closes that: the
 * browser's own path-normalization runs here, server-side, before the
 * `/grafana/`-prefix check, instead of after it on the client.
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
