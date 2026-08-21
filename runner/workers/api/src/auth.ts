// Internal-team auth via the Handsontable Google login broker (ADR-0007).
// Write endpoints require a broker JWT; we re-validate it server-side and trust
// only the returned email. No service account, no app-wide credential.
//
// Since ADR-0037 there is a second credential class: a persistent API token,
// minted by us and verified here rather than by the broker. The two are told
// apart by prefix *before* anything touches the network, and never fall through
// to one another — a token that reached `/broker/userinfo` because the local
// lookup missed would have shipped our own permanent credential to a
// third-party host, and the failure would look like a slow success.

import type { Env } from "./env.js";
import { constantTimeEquals } from "./constant-time.js";
import { isTokenBearerValue } from "./token.js";
import { verifyToken } from "./token-store.js";

export interface Identity {
  email: string;
  sub?: string;
  /**
   * The id of the persistent API token this request authenticated with, if it
   * did (ADR-0037). Absent for a person signed in through the broker.
   *
   * A token acts as its creator's address, so `email` is all any existing
   * caller needs and none of them changed. This field is what the capability
   * fence reads — the four things a token may not do — and what an audit trail
   * would follow back to a row in `api_tokens`.
   */
  via?: string;
}

/** Did this request authenticate with an API token rather than a broker login? */
export function isTokenIdentity(identity: Identity | null): boolean {
  return !!identity?.via;
}

/**
 * The bearer credential in an `Authorization` header, or null.
 *
 * The single parser for both callers below, deliberately: RFC 7235 spells the
 * header `auth-scheme 1*SP token68`, so `Bearer  hot_pat_...` — two spaces, a
 * stray tab, a typo in a `curl -H` — is a well-formed header. Slicing a fixed
 * `"Bearer "` off the front leaves that whitespace attached, the value then
 * misses the `hot_pat_` prefix test, and the consequences are the two things
 * this feature exists to prevent: the credential gets forwarded to the broker,
 * and the fence on the anonymous-capable routes reads it as no credential at all
 * (Bugbot, #252). Two parsers would be two chances to reintroduce that.
 *
 * The scheme match is case-insensitive, as RFC 7235 says it is, and that is
 * load-bearing rather than pedantry: `bearer hot_pat_...` returning null here
 * would fall through to the `DEV_AUTH_EMAIL` bypass on a loopback host and be
 * granted a *person* identity with no `via`, so the capability fence would not
 * engage — the very failure the ordering below exists to prevent.
 */
export function bearerFrom(request: Request): string | null {
  const auth = request.headers.get("Authorization");
  if (!auth) return null;
  const match = /^Bearer[ \t]+(.+)$/i.exec(auth.trim());
  const value = match?.[1]?.trim();
  return value ? value : null;
}

/**
 * Is the caller presenting an API token, whether or not it is a valid one?
 *
 * For the routes that admit anonymous callers — chat and the theme generator,
 * which are budget-gated rather than sign-in-gated — where "no identity" and
 * "a token identity" must be told apart before any work is done. Reads the
 * header only: a malformed token of ours is still ours, and is refused rather
 * than treated as an anonymous visitor.
 */
export function presentsToken(request: Request): boolean {
  return isTokenBearerValue(bearerFrom(request));
}

/**
 * `wrangler dev` serves on loopback; every deployed origin is a real hostname.
 *
 * `*.localhost` has to count too — a local Tier-2 session hands the browser a
 * preview URL shaped `<port>-<sessionId>-<token>.localhost:8787`, and those
 * requests come back through this Worker. `.localhost` is reserved for loopback
 * (RFC 6761), so it can never be a deployed origin.
 */
function isLocalRequest(request: Request): boolean {
  try {
    const { hostname } = new URL(request.url);
    return (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

/**
 * Validate the caller's broker token and return their identity, or null.
 *
 * Local dev bypass: DEV_AUTH_EMAIL (set in the gitignored `.dev.vars`) stands in
 * for a broker login. It is honoured **only** for requests to a loopback host, so
 * the variable reaching a deployed Worker cannot turn into an auth bypass — the
 * "never set this in production" comment this replaced was the only thing
 * enforcing that before.
 */
/**
 * The form the service path asserts an address in, and the basis for comparing two.
 *
 * Deliberately NOT applied to what the broker path returns: that value is also the key
 * `profiles` reads, so changing its case would lose someone's saved name and avatar.
 * `created_by` is compared as a string, so the fix for a mixed-case owner is to fold case
 * when comparing (`sameOwner()`, and `LOWER(created_by)` in the listing) rather than to
 * rewrite the identity everything else already depends on.
 */
export function normalizeEmail(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/** Do two stored/asserted addresses identify the same person? Case-insensitive on
 *  purpose: rows written before addresses were normalised must keep working. */
export function sameOwner(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeEmail(a);
  return left !== "" && left === normalizeEmail(b);
}

/**
 * Authenticate a **trusted service** (the Handsontable MCP) acting for a named team
 * member — the headless demo-creation path (DEV-2501, ADR-0033).
 *
 * Deliberately NOT the broker path above. That one guards every existing write endpoint
 * and carries far more authority than this feature needs; here the shared secret says only
 * "a service we provisioned is calling", and `X-Demo-Author` says whose demo this becomes.
 * The caller takes that address from its own verified session, never from a user's prompt.
 *
 * Fails closed when `MCP_SHARED_SECRET` is unset, so a Worker deployed without the
 * secret has no service path at all rather than an open one.
 */
export async function authenticateService(request: Request, env: Env): Promise<Identity | null> {
  const expected = (env as { MCP_SHARED_SECRET?: string }).MCP_SHARED_SECRET;
  if (!expected) return null;

  const presented = request.headers.get("X-MCP-Secret");
  if (!presented || !constantTimeEquals(presented, expected)) return null;

  const author = normalizeEmail(request.headers.get("X-Demo-Author"));
  // The same team-only rule the broker path enforces on the address it is handed.
  if (!author.endsWith("@handsontable.com")) return null;
  return { email: author };
}

export async function authenticate(request: Request, env: Env): Promise<Identity | null> {
  const bearer = bearerFrom(request);

  // A persistent API token is ours to verify (ADR-0037). Discriminated on the
  // prefix and answered locally either way: a malformed or revoked `hot_pat_…`
  // is refused here rather than forwarded to the broker.
  //
  // Ahead of the DEV_AUTH_EMAIL bypass below, deliberately. Every developer is
  // told to put that variable in `.dev.vars` (docs/run-and-deploy.md), so with
  // the bypass first a presented token was accepted as a *person* — `via` never
  // set, the capability fence never engaged, and `wrangler dev` therefore
  // behaving as the exact opposite of production on the one thing this feature
  // is careful about. Presenting a token now means being treated as one, wherever
  // the Worker is running.
  if (bearer !== null && isTokenBearerValue(bearer)) {
    const verified = await verifyToken(env, bearer, new Date().toISOString());
    if (!verified) return null;
    // The same team-only rule the broker path enforces. The address was already
    // verified when the token was minted; re-asserting it means a row written
    // before that rule, or by a future path that forgets it, still cannot widen
    // who this Worker will act for.
    if (!verified.createdBy.endsWith("@handsontable.com")) return null;
    return { email: verified.createdBy, via: verified.id };
  }

  const devEmail = (env as { DEV_AUTH_EMAIL?: string }).DEV_AUTH_EMAIL;
  if (devEmail && isLocalRequest(request)) return { email: devEmail };

  if (bearer === null) return null;

  try {
    const res = await fetch(`${env.LOGIN_BROKER_URL}/broker/userinfo`, {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    if (!res.ok) return null;
    // Email and `sub` are all there is: the broker's authorize redirect asks for
    // `scope=openid email`, so no `name` or `picture` claim exists to read. Display
    // names come from the address's own `name.surname` shape instead — ADR-0007.
    const info = (await res.json()) as { email?: string; sub?: string };
    // Returned exactly as the broker gave it, on purpose: `profiles` looks this address up
    // by exact match, so normalising here would hide an existing display name or avatar and
    // let the next save write a second row. Case differences are handled where they matter —
    // `sameOwner()` and the listing query fold case (review of PR #170).
    if (!info.email || !info.email.endsWith("@handsontable.com")) return null;
    return { email: info.email, sub: info.sub };
  } catch {
    return null;
  }
}
