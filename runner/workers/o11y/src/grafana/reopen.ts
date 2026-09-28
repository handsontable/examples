// `POST /grafana/_o11y/reopen` (ADR §B.3/§J, contract §1): manual ledger
// re-open for a time window. Session-gated exactly like `/grafana/*`.
// Requires exact `application/json` content-type: without it, this route
// would be reachable via a cross-site "simple" request with no preflight.
// An exact `Origin` check sits on top, since `o11y_session` is
// `SameSite=Lax`. The window is capped to the 7-day retention.

import { isSameOrigin, verifySession } from "../gates/session.js";
import { inboxWriter } from "../inbox/accessor.js";
import { reopenWindowExceedsRetention } from "../inbox/ledger.js";
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

/** Only `application/json` is accepted — this is the actual CSRF defense
 *  (see this file's header): it forces a preflight for any cross-origin
 *  caller. */
function hasJsonContentType(req: Request): boolean {
  const raw = req.headers.get("content-type");
  if (!raw) return false;
  const mediaType = raw.split(";")[0]?.trim().toLowerCase();
  return mediaType === "application/json";
}

export const handleReopen: RouteHandler = async (req, env) => {
  const identity = await verifySession(req, env);
  if (!identity) return new Response("Forbidden", { status: 403 });

  if (!isSameOrigin(req)) {
    return new Response(JSON.stringify({ error: "bad_origin" }), { status: 403 });
  }

  if (!hasJsonContentType(req)) {
    return new Response(JSON.stringify({ error: "expected content-type: application/json" }), { status: 415 });
  }

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
  if (reopenWindowExceedsRetention(body.fromMs, body.toMs)) {
    return new Response(JSON.stringify({ error: "window exceeds the 7-day retention cap" }), { status: 400 });
  }

  const result = await inboxWriter(env).reopenWindow(body.fromMs, body.toMs);
  console.log(JSON.stringify({ event: "o11y.reopen", by: identity.email, ...body, reopened: result.reopened }));

  return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
};
