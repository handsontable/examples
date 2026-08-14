// Internal-team auth via the Handsontable Google login broker (ADR-0007).
// Write endpoints require a broker JWT; we re-validate it server-side and trust
// only the returned email. No service account, no app-wide credential.

import type { Env } from "./env.js";

export interface Identity {
  email: string;
  sub?: string;
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

/** Length-independent comparison, so a wrong secret cannot be found byte by byte. */
function secretsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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
  if (!presented || !secretsMatch(presented, expected)) return null;

  const author = normalizeEmail(request.headers.get("X-Demo-Author"));
  // The same team-only rule the broker path enforces on the address it is handed.
  if (!author.endsWith("@handsontable.com")) return null;
  return { email: author };
}

export async function authenticate(request: Request, env: Env): Promise<Identity | null> {
  const devEmail = (env as { DEV_AUTH_EMAIL?: string }).DEV_AUTH_EMAIL;
  if (devEmail && isLocalRequest(request)) return { email: devEmail };

  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;

  try {
    const res = await fetch(`${env.LOGIN_BROKER_URL}/broker/userinfo`, {
      headers: { Authorization: auth },
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
