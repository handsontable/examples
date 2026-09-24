// `POST /grafana/_o11y/reopen` (ADR §B.3/§J, contract §1): manual ledger
// re-open for a time window. Session-gated exactly like `/grafana/*` (K1:
// the Worker's own cookie, not Cloudflare Access) — the contract's own gate
// table lists it under the same row.
//
// F2 fix (final review, B-M9): this route used to call `req.json()`
// regardless of `content-type`, which makes it reachable by a cross-site
// "simple" request (`fetch(url, { mode: "no-cors", body: '{"fromMs":...}' })`
// — the browser sends that with `content-type: text/plain`, no CORS
// preflight). Requiring an exact `application/json` content-type forces a
// real CORS preflight (which a cross-origin page cannot pass without an
// explicit allow from this Worker, and none is granted), closing that path.
// K1 adds an exact `Origin` check on top: `o11y_session` is `SameSite=Lax`,
// which does not stop a same-SITE (not same-origin — another
// `*.handsontable.com` host, e.g. a Tier-2 preview) caller from attaching
// it — see `gates/session.ts#isSameOrigin`'s own doc comment. The window is
// also capped to the 7-day retention (`ledger.ts`'s own `KEY_RETENTION_MS`)
// — a wider window can never find anything (see `writer.ts#reopenWindow`'s
// doc comment) and, pre-fix, made mass replay/extra-wake amplification
// cheap for whoever could reach this route at all.

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

/** Only `application/json` (optionally with parameters, e.g. `; charset=utf-8`)
 *  is accepted — anything else (including the ABSENCE of a content-type,
 *  which a "simple" cross-site request can produce just as easily as
 *  `text/plain`) is refused. This is the actual CSRF defense (see this
 *  file's header): it forces a preflight for any cross-origin caller. */
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
