// The o11y worker's own copy of the API worker's broker-verification logic
// (`workers/api/src/auth.ts#authenticate`'s broker branch, ~15 lines).
// Deliberately duplicated rather than shared across worker trees — the
// feasibility report (§4 "Reuse from the API worker") found the reusable
// surface too small, and too different in shape, to be worth a cross-worker
// dependency: this Worker has no D1, no `hot_pat_` token store, and no
// `DEV_AUTH_EMAIL` loopback branch of its own (that bypass is `DEV_ADMIN`,
// gated in `gates/session.ts`).
//
// Called exactly once per login, from `grafana/login.ts#handleSession` —
// never per `/grafana/*` request (that would be a live Render round trip on
// every dashboard panel query, which `gates/session.ts#verifySession`
// avoids entirely by trusting the Worker's own signed cookie instead).
//
// K1 fix round (security review, findings I3/M3): the broker call now times
// out and refuses to follow a redirect (M3), and `resolveBrokerIdentity`
// also returns the broker token's own `exp` claim — read WITHOUT verifying
// its signature, safe only because it is read AFTER `/broker/userinfo` has
// already accepted the token as live (I3) — so `grafana/login.ts` can cap
// the Grafana session at the token's own lifetime instead of always minting
// a flat 12h session regardless of how long the presented token was
// actually good for.

import type { Env } from "../env.js";

/** Mirrors `PAT_PREFIX` in `workers/api/src/token.ts` and
 *  `apps/authoring/src/auth.ts` — the three must agree, and none of them can
 *  import across worker/app boundaries. */
const PAT_PREFIX = "hot_pat_";

/** M3: bounds how long `POST /grafana/_o11y/session` can be held open by a
 *  slow broker (a Render cold start, say) — without this, a hanging
 *  `/broker/userinfo` call left the callback page's spinner unbounded, even
 *  though the eventual outcome was already fail-closed. */
const BROKER_FETCH_TIMEOUT_MS = 10_000;

export interface BrokerIdentity {
  email: string;
  /** The broker token's own `exp` claim (unix seconds), decoded from the
   *  token's payload segment WITHOUT verifying its signature — this Worker
   *  has no way to verify a broker-signed JWT at all (the feasibility
   *  report: "there is no JWKS and no public key... hot-mcp explicitly
   *  refused to share it"). That is safe ONLY here, ONLY after
   *  `/broker/userinfo` has already accepted the token as live: this value
   *  is never itself treated as proof of anything, only as an upper bound
   *  on a session the caller has ALREADY decided to mint. `null` when the
   *  token has no `exp` claim, or isn't even JWT-shaped — callers must fall
   *  back to a conservative TTL rather than trust an unbounded one
   *  (`gates/session.ts#computeSessionTtlSeconds`, I3). */
  exp: number | null;
}

/** `true` when the URL is a real, well-formed broker endpoint this Worker
 *  should ever call: `https:` always, or `http://localhost`/`127.0.0.1`
 *  strictly when `O11Y_ENV === "local"` (mirrors the broker's OWN allowlist
 *  rule for `return_to`, feasibility report §3 — "`localhost` over `http:`
 *  is allowed"). Fix round M3: an empty or malformed `LOGIN_BROKER_URL` used
 *  to build a relative `Location` header (`grafana/login.ts`'s probed
 *  behaviour: `Location: /broker/login?...`, which sends the browser back
 *  at THIS Worker's own `/broker/login`, a 404, instead of failing
 *  cleanly) — this is what lets `handleLogin` refuse with a clear 500
 *  instead. */
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
      // M3: a broker response that tries to redirect is refused outright.
      // `redirect: "error"` is what a browser's `fetch` supports for this —
      // the Workers runtime does NOT implement it at all (confirmed live,
      // K1's own local round trip: `TypeError: Invalid redirect value, must
      // be one of "follow" or "manual"` — `"error"` "does not make sense at
      // the edge", per that exact runtime error message). `redirect:
      // "manual"` is the Workers-supported equivalent: the fetch returns
      // the 3xx response ITSELF, unfollowed, instead of throwing — so the
      // `res.status` check below is what actually refuses it, standing in
      // for what `redirect: "error"` would have done. Whether the Workers
      // runtime would otherwise forward the `Authorization` header across a
      // cross-origin redirect was flagged PLAUSIBLE-but-unverified in the
      // review; never following one at all makes that question moot either
      // way. `AbortSignal.timeout` bounds a slow broker (a Render cold
      // start) instead of holding `POST /session` open indefinitely.
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
