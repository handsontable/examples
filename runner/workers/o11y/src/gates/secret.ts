// ADR §B.5 `v1/logs` row: `x-o11y-secret` header set on the export
// destination, constant-time compare. Also the `deploy` route's fallback
// (ADR §B.5 `deploy` row: "GitHub OIDC token … secret fallback").

import type { Env } from "../env.js";
import { type GateResult, drop, ok } from "./types.js";
import { constantTimeEquals } from "./util.js";

/** Fails closed when `env.O11Y_EXPORT_SECRET` is absent (unset in
 *  `.dev.vars`, or the secret was never `wrangler secret put` — the same rule
 *  `DEV_ADMIN` documents in `env.ts`): an unset secret must never make the
 *  gate a no-op. */
export function checkExportSecret(req: Request, env: Env): GateResult {
  const configured = env.O11Y_EXPORT_SECRET;
  if (!configured) return drop("secret", 401, "O11Y_EXPORT_SECRET not configured");
  const provided = req.headers.get("x-o11y-secret");
  if (!provided || !constantTimeEquals(provided, configured)) return drop("secret", 401);
  return ok();
}
