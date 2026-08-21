// D1 access for persistent API tokens (DEV-2583, ADR-0037). The decisions live
// in `token.ts` (pure, unit-tested); this file only moves bytes.
//
// Nothing here ever selects or returns `token_hash` to a caller: `verifyToken`
// compares it in place and hands back a row without it, so a listing cannot
// leak the digest by accident.

import type { Env } from "./env.js";
import { constantTimeEquals } from "./constant-time.js";
import { hashToken, parseTokenId, touchThreshold } from "./token.js";

/** A token as the listing shows it — no digest, no plaintext, ever. */
export interface TokenView {
  id: string;
  name: string;
  created_by: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
}

const VIEW_COLUMNS = "id, name, created_by, created_at, last_used_at, revoked_at, revoked_by";

export async function createToken(
  env: Env,
  args: { id: string; name: string; tokenHash: string; createdBy: string; now: string },
): Promise<TokenView> {
  await env.DB.prepare(
    `INSERT INTO api_tokens (id, name, token_hash, created_by, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(args.id, args.name, args.tokenHash, args.createdBy, args.now).run();
  return {
    id: args.id,
    name: args.name,
    created_by: args.createdBy,
    created_at: args.now,
    last_used_at: null,
    revoked_at: null,
    revoked_by: null,
  };
}

/** Every token in the organization, live and revoked, newest first (ADR-0037). */
export async function listTokens(env: Env): Promise<TokenView[]> {
  const rows = await env.DB.prepare(
    `SELECT ${VIEW_COLUMNS} FROM api_tokens ORDER BY created_at DESC`,
  ).all<TokenView>();
  return rows.results ?? [];
}

/**
 * Revoke a token. Idempotent: `revoked_at IS NULL` in the WHERE means a second
 * revoke leaves the first one's timestamp and attribution alone rather than
 * rewriting history. Returns whether such a token exists at all, so the route
 * can tell 404 from "already dead".
 */
export async function revokeToken(
  env: Env,
  args: { id: string; revokedBy: string; now: string },
): Promise<boolean> {
  await env.DB.prepare(
    `UPDATE api_tokens SET revoked_at = ?, revoked_by = ?
     WHERE id = ? AND revoked_at IS NULL`,
  ).bind(args.now, args.revokedBy, args.id).run();
  const row = await env.DB.prepare("SELECT id FROM api_tokens WHERE id = ?")
    .bind(args.id).first<{ id: string }>();
  return row !== null;
}

/**
 * Verify a presented token and return the address it acts as, or null.
 *
 * One primary-key read. The digest comparison is length-independent
 * (`constantTimeEquals`, shared with the MCP secret path) even though both sides are hex: the cost is
 * nothing and the alternative invites a future refactor to introduce a leak.
 * Revocation is read from the same row, so it takes effect on the next request
 * with no cache to invalidate.
 */
export async function verifyToken(
  env: Env,
  presented: string,
  now: string,
): Promise<{ id: string; createdBy: string } | null> {
  const id = parseTokenId(presented);
  if (!id) return null;

  const row = await env.DB.prepare(
    "SELECT id, token_hash, created_by, last_used_at, revoked_at FROM api_tokens WHERE id = ?",
  ).bind(id).first<{
    id: string;
    token_hash: string;
    created_by: string;
    last_used_at: string | null;
    revoked_at: string | null;
  }>();
  if (!row || row.revoked_at) return null;
  // A row with no usable digest is not a token. `token_hash` is NOT NULL in the
  // schema, so this only happens to a hand-edited row or one caught mid-backfill
  // by a future migration — but a 500 out of the auth path would be a worse
  // answer to that than a refusal, and it would be reported as an outage.
  if (typeof row.token_hash !== "string" || row.token_hash === "") return null;
  if (!constantTimeEquals(await hashToken(presented), row.token_hash)) return null;

  await touchToken(env, id, now);
  return { id, createdBy: row.created_by };
}

/**
 * Record use, at most once per clock hour per token.
 *
 * A single conditional UPDATE rather than a read followed by a write: there is
 * no window for two concurrent requests to both decide they are the first this
 * hour, and no `ctx` has to be threaded through the two dozen `authenticate()`
 * call sites to defer the write.
 */
export async function touchToken(env: Env, id: string, now: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE api_tokens SET last_used_at = ?
     WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)`,
  ).bind(now, id, touchThreshold(now)).run();
}
