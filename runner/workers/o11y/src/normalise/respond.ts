// The one place every route handler goes to answer a request and, in the
// same call, write the `o11y.ingest` Analytics Engine point ADR §B.5
// requires ("every drop writes an `o11y.ingest` point with its reason")
// and §B.2 requires for an accepted/duplicate batch. Centralising this is
// also what makes ADR-0041 §L.4 provable: a batch with N accepted and M
// duplicate records writes exactly one `accepted` point (count=N) and one
// `duplicate` point (count=M) — never one point per record, which would
// make "delivered twice produces one copy" indistinguishable from "N
// separate deliveries" in a query.

import { toAePoint, type CommonResourceAttrs } from "@handsontable/demo-runtime/telemetry";
import type { Env } from "../env.js";
import type { GateDrop } from "../gates/types.js";
import { writePoint } from "./points.js";

/** `o11y.ingest`'s own emitter identity (§5: "Emitted by: o11y worker") —
 *  not derived from the request, always this Worker's own `service.*`.
 *  Falls back to `"dev"` under `wrangler dev`, where no deploy script sets
 *  `SERVICE_VERSION`. */
export function o11ySelfIdentity(env: Env): CommonResourceAttrs {
  return {
    service_name: "demos-o11y",
    service_version: env.SERVICE_VERSION ?? "dev",
    environment: env.O11Y_ENV,
  };
}

const JSON_HEADERS = { "content-type": "application/json" } as const;

/** Answers a gate rejection and records it. `bytes` is the request's
 *  (compressed, on-wire) size when known — `0` is fine for a gate that never
 *  read the body. */
export function respondDrop(env: Env, ctx: ExecutionContext, drop: GateDrop, bytes = 0): Response {
  writePoint(
    env,
    ctx,
    toAePoint(
      "o11y.ingest",
      { count: 1, bytes },
      { ...o11ySelfIdentity(env), reason: drop.reason, outcome: "dropped" },
    ),
  );
  const headers: Record<string, string> = { ...JSON_HEADERS };
  // A 429 without `Retry-After` leaves Faro guessing its back-off.
  if (drop.retryAfterSeconds !== undefined) headers["retry-after"] = String(drop.retryAfterSeconds);
  return new Response(JSON.stringify({ error: drop.reason }), { status: drop.status, headers });
}

/** One dropped record inside an otherwise-accepted batch (a
 *  client-controlled `outcome`/`reason`/`item.type` that fails `toAePoint`'s
 *  or `faroItemToRecord`'s runtime validation) — the batch itself still
 *  answers `2xx` for its other records; this only accounts the one item. */
export function recordInvalidItem(env: Env, ctx: ExecutionContext, detail: string): void {
  writePoint(
    env,
    ctx,
    toAePoint(
      "o11y.ingest",
      { count: 1, bytes: 0 },
      { ...o11ySelfIdentity(env), reason: "invalid_item", outcome: "dropped" },
    ),
  );
  console.warn("[o11y] dropped invalid item:", detail);
}

/** One well-formed record dropped only for being over `INBOX_RECORD_MAX_BYTES`
 *  (256 KB, ADR §B.2 step 1) inside an otherwise-accepted batch — distinct
 *  from {@link recordInvalidItem} so an operator querying `o11y.ingest` by
 *  `reason="size"` to watch for oversized payloads actually sees something.
 *  Used by both the OTLP and Faro ingest paths. */
export function recordOversizeDrop(env: Env, ctx: ExecutionContext, detail: string): void {
  writePoint(
    env,
    ctx,
    toAePoint(
      "o11y.ingest",
      { count: 1, bytes: 0 },
      { ...o11ySelfIdentity(env), reason: "size", outcome: "dropped" },
    ),
  );
  console.warn("[o11y] dropped oversize record:", detail);
}

/** Answers an accepted request after the `InboxWriter` commit, writing one
 *  `accepted` point (if any records were newly stored) and one `duplicate`
 *  point (if any were deduped) — `reason` is the route's short name
 *  (`"collect"`, `"lite"`, `"v1/logs"`, `"deploy"`, `"hooks/sentry"`), so
 *  `o11y.ingest`'s per-source volume is queryable the same way a dropped
 *  request's gate name is. */
export function respondIngested(
  env: Env,
  ctx: ExecutionContext,
  route: string,
  counts: { accepted: number; duplicate: number },
  bytes: number,
): Response {
  if (counts.accepted > 0) {
    writePoint(
      env,
      ctx,
      toAePoint(
        "o11y.ingest",
        { count: counts.accepted, bytes },
        { ...o11ySelfIdentity(env), reason: route, outcome: "accepted" },
      ),
    );
  }
  if (counts.duplicate > 0) {
    writePoint(
      env,
      ctx,
      toAePoint(
        "o11y.ingest",
        { count: counts.duplicate, bytes: 0 },
        { ...o11ySelfIdentity(env), reason: route, outcome: "duplicate" },
      ),
    );
  }
  return new Response(null, { status: 204 });
}
