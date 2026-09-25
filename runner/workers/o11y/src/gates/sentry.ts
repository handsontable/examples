// ADR §B.5 `hooks/sentry` row: `sentry-hook-signature` HMAC. Sentry's
// internal-integration signature scheme: HMAC-SHA256 of the raw request body
// under the integration's client secret, hex-encoded, compared
// constant-time — https://docs.sentry.io/product/integrations/integration-platform/webhooks/#request-signatures.

import type { Env } from "../env.js";
import { type GateResult, drop, ok } from "./types.js";
import { constantTimeEquals, hmacSha256Hex } from "./util.js";

/** `rawBody` must be the exact bytes Sentry signed — read before any parsing,
 *  never re-serialized JSON (which can reorder keys or normalise whitespace
 *  and silently break the signature). Fails closed when
 *  `env.SENTRY_HOOK_SECRET` is absent, same rule as {@link checkExportSecret}. */
export async function checkSentryHmac(req: Request, env: Env, rawBody: string): Promise<GateResult> {
  const configured = env.SENTRY_HOOK_SECRET;
  if (!configured) return drop("hmac", 401, "SENTRY_HOOK_SECRET not configured");
  const provided = req.headers.get("sentry-hook-signature");
  if (!provided) return drop("hmac", 401);
  const expected = await hmacSha256Hex(configured, rawBody);
  if (!constantTimeEquals(provided.toLowerCase(), expected.toLowerCase())) return drop("hmac", 401);
  return ok();
}
