// The one place every route handler goes to answer a request and, in the
// same call, write the `o11y.ingest` Analytics Engine point ADR §B.5 requires
// ("every drop writes an `o11y.ingest` point with its reason") and §B.2
// requires for an accepted/duplicate batch. Centralising this is also what
// makes exit criterion 4 provable: a batch with N accepted and M duplicate
// records writes exactly one `accepted` point (count=N) and one `duplicate`
// point (count=M) — never one point per record, which would make "the same
// export body delivered twice … produces one copy" hard to distinguish from
// "…produces one point per record, indistinguishable from N separate
// deliveries" in a query (T02-D, see the task Outcome).

import { toAePoint, type CommonResourceAttrs } from "@handsontable/demo-runtime/telemetry";
import type { Env } from "../env.js";
import type { GateDrop } from "../gates/types.js";
import { writePoint } from "./points.js";

/** `o11y.ingest`'s own emitter identity (§5: "Emitted by: o11y worker") — not
 *  derived from the request, always this Worker's own `service.*`.
 *  `SERVICE_VERSION` is a T02 addition to `wrangler.jsonc`'s `vars` (see the
 *  task Outcome): nothing else needed the o11y worker's own deploy identity
 *  before this metric did. Falls back to `"dev"` under `wrangler dev`, where
 *  no deploy script sets it. */
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
  return new Response(JSON.stringify({ error: drop.reason }), { status: drop.status, headers: JSON_HEADERS });
}

/** One dropped record inside an otherwise-accepted batch (T00-D10: a
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
 *  from {@link recordInvalidItem} (fix round, I3): the task's own Scope text
 *  ("drop records over 256 KB") and the doc comment on `otlp.ts#OtlpProcessResult`
 *  both already called this `reason=size`, but the route handler was writing
 *  it through `recordInvalidItem` (`reason: "invalid_item"`) instead — a real
 *  observability gap, since an operator querying `o11y.ingest` by
 *  `reason="size"` to watch for oversized payloads would have seen nothing.
 *  Used by both the OTLP and Faro ingest paths (I2 added the Faro-side size
 *  check this shares with). */
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
