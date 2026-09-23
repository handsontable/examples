// `POST /grafana/_o11y/reopen` (ADR §B.3/§J, contract §1): manual ledger
// re-open for a time window. Access-gated exactly like `/grafana/*` — the
// contract's own gate table lists it under the same row.

import { verifyAccess } from "../gates/access.js";
import { inboxWriter } from "../inbox/accessor.js";
import type { RouteHandler } from "../router.js";

interface ReopenBody {
  fromMs: number;
  toMs: number;
}

function isReopenBody(value: unknown): value is ReopenBody {
  const v = value as Partial<ReopenBody> | null;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.fromMs === "number" &&
    typeof v.toMs === "number" &&
    Number.isFinite(v.fromMs) &&
    Number.isFinite(v.toMs) &&
    v.fromMs < v.toMs
  );
}

export const handleReopen: RouteHandler = async (req, env) => {
  const identity = await verifyAccess(req, env);
  if (!identity) return new Response("Forbidden", { status: 403 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), { status: 400 });
  }
  if (!isReopenBody(body)) {
    return new Response(JSON.stringify({ error: "expected { fromMs: number, toMs: number }, fromMs < toMs" }), {
      status: 400,
    });
  }

  const result = await inboxWriter(env).reopenWindow(body.fromMs, body.toMs);
  console.log(JSON.stringify({ event: "o11y.reopen", by: identity.email, ...body, reopened: result.reopened }));

  return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
};
