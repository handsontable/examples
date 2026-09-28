// The o11y worker's own copy of the API worker's broker-verification logic
// (`workers/api/src/auth.ts#authenticate`'s broker branch). Deliberately
// duplicated rather than shared: this Worker has no D1, no `hot_pat_`
// token store, and no `DEV_AUTH_EMAIL` loopback (that bypass is
// `DEV_ADMIN`, in `gates/session.ts`). Called once per login, from
// `grafana/login.ts#handleSession`, never per `/grafana/*` request.

import type { Env } from "../env.js";

/** Mirrors `PAT_PREFIX` in `workers/api/src/token.ts` and
 *  `apps/authoring/src/auth.ts` — the three must agree, and none of them can
 *  import across worker/app boundaries. */
const PAT_PREFIX = "hot_pat_";

/** Bounds how long `POST /grafana/_o11y/session` can be held open by a
 *  slow broker (a Render cold start, say), rather than leaving the
 *  callback page's spinner unbounded. */
const BROKER_FETCH_TIMEOUT_MS = 10_000;

export interface BrokerIdentity {
  email: string;
  /** The token's own `exp` (unix seconds), decoded WITHOUT verifying its
   *  signature (this Worker has no JWKS) — safe only because it's read
   *  AFTER `/broker/userinfo` accepted the token as live; used only as an
   *  upper bound, never as proof. `null` falls back to a conservative TTL
   *  (`gates/session.ts#computeSessionTtlSeconds`). */
  exp: number | null;
}

/** `true` when the URL is a real, well-formed broker endpoint this Worker
 *  should call: `https:` always, or `http://localhost`/`127.0.0.1` when
 *  `O11Y_ENV === "local"` (mirrors the broker's own allowlist for
 *  `return_to`). An empty or malformed `LOGIN_BROKER_URL` would otherwise
 *  build a relative `Location` header that sends the browser back at this
 *  Worker's own `/broker/login` (a 404) instead of failing cleanly; this
 *  lets `handleLogin` refuse with a clear 500 instead. */
export function isValidBrokerUrl(env: Env): boolean {
  let url: URL;
  try {
    url = new URL(env.LOGIN_BROKER_URL);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  if (env.O11Y_ENV === "local" && url.protocol === "http:") {
    return url.hostname === "localhost" || url.hostname === "127.0.0.1";
  }
  return false;
}

/** Decodes (never verifies — see {@link BrokerIdentity.exp}'s doc comment)
 *  a JWT's payload segment and reads its numeric `exp` claim, or `null` on
 *  any failure: not three dot-separated segments, invalid base64url, invalid
 *  JSON, or an `exp` that isn't a finite number. */
function decodeJwtExpSeconds(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const segment = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const padded = segment + "=".repeat((4 - (segment.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp : null;
  } catch {
    return null;
  }
}

/**
 * Resolves a broker token to a verified `@handsontable.com` identity, or
 * `null` on any failure (wrong shape, non-2xx, unreachable broker, a
 * non-team email, a redirecting response, a timeout). Never throws.
 *
 * Refuses anything shaped like one of OUR OWN persistent API tokens before
 * ever calling the broker — the same reasoning `workers/api/src/auth.ts`
 * gives for its own ordering: shipping our own credential to a third-party
 * host on a failed local check would be a silent downgrade from "rejected"
 * to "forwarded", and this Worker has no local token store to check it
 * against in the first place.
 */
export async function resolveBrokerIdentity(env: Env, token: string): Promise<BrokerIdentity | null> {
  if (!isValidBrokerUrl(env)) return null;
  if (token.startsWith(PAT_PREFIX)) return null;

  try {
    const res = await fetch(`${env.LOGIN_BROKER_URL}/broker/userinfo`, {
      headers: { Authorization: `Bearer ${token}` },
      // A broker response that tries to redirect is refused outright. The
      // Workers runtime does not implement `redirect: "error"` (throws
      // "Invalid redirect value, must be one of \"follow\" or \"manual\"");
      // `redirect: "manual"` returns the 3xx response unfollowed instead,
      // so the `res.status` check below is what actually refuses it.
      // `AbortSignal.timeout` bounds a slow broker instead of holding
      // `POST /session` open indefinitely.
      redirect: "manual",
      signal: AbortSignal.timeout(BROKER_FETCH_TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400) return null;
    if (!res.ok) return null;
    const info = (await res.json()) as { email?: unknown };
    if (typeof info.email !== "string" || !info.email.endsWith("@handsontable.com")) return null;
    return { email: info.email, exp: decodeJwtExpSeconds(token) };
  } catch {
    return null;
  }
}
