// `POST /telemetry/lite` — the §9 lite beacon from `/d` and `/embed`'s
// standalone reporter (ADR §C.5, T08). Reuses T02's ingest machinery
// end-to-end: the browser gate (`checkBrowserGates`), the capped body reader,
// the shared converter (T00-D6's beacon order: `beaconToRecord` → `scrubTelemetry`,
// the *reverse* of the Faro path), `withResourceAttrDefaults`, `hashRecord`,
// `InboxWriter.ingest` on the `browser` tenant, and `respond.ts`'s single
// `o11y.ingest` point per outcome.
//
// One request is always exactly one beacon (§9's payload has no batch shape),
// unlike `/telemetry/collect`'s `TransportBody` array — so this route has no
// per-item loop and writes at most one `error.uncaught`/`web_vital` point.

import {
  beaconToRecord,
  feedsNewFingerprintAlert,
  fingerprint,
  INBOX_RECORD_MAX_BYTES,
  isValidLitePayload,
  LITE_PAYLOAD_MAX_BYTES,
  scrubTelemetry,
  toAePoint,
  type AePoint,
  type LiteBeaconPayload,
  type ServiceIdentity,
  type Surface,
} from "@handsontable/demo-runtime/telemetry";
import type { Env, IngestItem } from "./env.js";
import { checkBrowserGates } from "./gates/browser.js";
import { inboxWriter } from "./inbox/accessor.js";
import { BodyTooLargeError, readCappedBytes } from "./normalise/read-body.js";
import { scrubBodyText } from "./normalise/text-scrub.js";
import { hashRecord } from "./normalise/hash.js";
import { withResourceAttrDefaults, writePoint } from "./normalise/points.js";
import { recordOversizeDrop, respondDrop, respondIngested } from "./normalise/respond.js";
import { registerRoute } from "./router.js";

/** §3: the lite beacon has no natural build identity the way the authoring
 *  app or a Worker deploy does (a client with no bundle of its own cannot
 *  report its own `service.version`) — `"unknown"` is `withResourceAttrDefaults`'s
 *  own fallback for exactly this "no natural value" case (`normalise/points.ts`'s
 *  doc comment), restated explicitly here rather than left to that default,
 *  since this is the *only* record shape in the o11y worker built with this
 *  identity from the start rather than falling into it. */
function liteServiceIdentity(env: Env): ServiceIdentity {
  return { name: "demos-embed", version: "unknown", environment: env.O11Y_ENV };
}

/** §7's fingerprint input for a lite `err` payload: the error's own name and
 *  (truncated, client-side) message — **never the stack** (T08-D, see the
 *  task Outcome). `convert.ts#beaconBody`'s stored `body` includes the stack
 *  for a human reading Loki; folding it into the fingerprint too would mean a
 *  hashed chunk name or line number in the first frame mints a "new"
 *  fingerprint on every rebuild that shifts one, exactly the DEV-2853 ladder
 *  problem the contract's own `normalizeMonitorMessage` exists to collapse —
 *  and unlike `demo-runtime`, `d`/`embed` surfaces feed the new-fingerprint
 *  alert (`feedsNewFingerprintAlert`), so a false "new" here pages someone. */
function liteErrorFingerprintMessage(payload: Extract<LiteBeaconPayload, { t: "err" }>): string {
  return `${payload.n}: ${payload.m}`;
}

async function handleLite(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // The contract's own payload cap doubles as this route's request-body cap
  // (§9: "≤ 2 KB") — there is no larger "batch" shape to allow room for, the
  // way `COLLECT_MAX_BYTES` allows for a whole Faro `TransportBody`.
  const gate = await checkBrowserGates(req, env, LITE_PAYLOAD_MAX_BYTES);
  if (!gate.ok) return respondDrop(env, ctx, gate);

  let bytes: Uint8Array;
  try {
    bytes = await readCappedBytes(req, LITE_PAYLOAD_MAX_BYTES);
  } catch (err) {
    if (err instanceof BodyTooLargeError) return respondDrop(env, ctx, { ok: false, reason: "size", status: 413 });
    return respondDrop(env, ctx, { ok: false, reason: "parse", status: 400 });
  }

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return respondDrop(env, ctx, { ok: false, reason: "parse", status: 400 });
  }

  // The one place every field of an untrusted, client-crafted beacon is
  // re-checked (T00-D5's own doc comment on `isValidLitePayload`): shape,
  // per-field caps, and — decisively — the total serialized size again, so a
  // payload that grew past 2 KB only once JSON-decoded (impossible for valid
  // JSON, but not assumed here) is still caught.
  if (!isValidLitePayload(body)) {
    return respondDrop(env, ctx, { ok: false, reason: "invalid_item", status: 400 });
  }

  const receivedAtMs = Date.now();
  const service = liteServiceIdentity(env);

  // T00-D6, beacon order (the reverse of Faro's): convert first, scrub the
  // built record second — `beaconToRecord`'s own fields (`m`, `st`) never
  // passed through `scrubTelemetry` before this point.
  const record = beaconToRecord(body, { service, receivedAtMs });
  // Never `null` here: only a Faro item (`isFaroItem`) can make `scrubTelemetry`
  // drop the record entirely (a console item, §3); the OTLP-record branch
  // always returns its scrubbed clone.
  const scrubbed = scrubTelemetry(record)!;
  // T02-D's own extra pass (`text-scrub.ts`): `scrubTelemetry` only strips a
  // query string from a *discrete* URL-shaped field, never one embedded
  // inside free body text — and a beacon's `st` (a stack) routinely carries a
  // bundler's cache-busting `?t=`/`?v=` on a chunk URL.
  scrubbed.body = scrubBodyText(scrubbed.body);
  withResourceAttrDefaults(scrubbed.resourceAttributes, env);

  if (new TextEncoder().encode(JSON.stringify(scrubbed)).length > INBOX_RECORD_MAX_BYTES) {
    // Unreachable in practice — the whole request body is already capped at
    // `LITE_PAYLOAD_MAX_BYTES` (2 KB), far under `INBOX_RECORD_MAX_BYTES`
    // (256 KB) — kept for the same defence-in-depth reason the Faro and OTLP
    // paths both carry this check (I2, T02's task Outcome).
    recordOversizeDrop(env, ctx, "lite beacon record exceeds 256 KB");
    return respondIngested(env, ctx, "lite", { accepted: 0, duplicate: 0 }, bytes.byteLength);
  }

  const aePoints: AePoint[] = [];
  const common = { service_name: service.name, service_version: service.version, environment: service.environment };
  let itemFingerprint: string | undefined;

  if (body.t === "err") {
    const fp = fingerprint(body.s, liteErrorFingerprintMessage(body));
    itemFingerprint = feedsNewFingerprintAlert(body.s as Surface) ? fp : undefined;
    aePoints.push(
      toAePoint("error.uncaught", { count: 1 }, { ...common, surface: body.s, fingerprint: fp, demo_id: body.demo }),
    );
  } else {
    aePoints.push(
      toAePoint(
        "web_vital",
        { value: body.val },
        {
          ...common,
          surface: body.s,
          framework: body.fw,
          ht_major: body.ht,
          reason: body.n,
          device: body.dev,
          demo_id: body.demo,
        },
      ),
    );
  }

  const hash = await hashRecord({
    body: scrubbed.body,
    resourceAttributes: scrubbed.resourceAttributes,
    attributes: scrubbed.attributes ?? {},
    // The beacon's own raw, un-clamped event time (§8: "the record's own raw
    // source timestamp, exactly as received") — `ts` is epoch ms, restated as
    // a string, the same way OTLP's raw `time_unix_nano` is.
    rawEventTime: String(body.ts),
  });

  const item: IngestItem = { hash, record: scrubbed, fingerprint: itemFingerprint };
  const result = await inboxWriter(env).ingest("browser", receivedAtMs, [item]);
  let accepted = 0;
  let duplicate = 0;
  for (const r of result.results) r.outcome === "duplicate" ? duplicate++ : accepted++;

  // `writePoint` (`normalise/points.ts`) is what every other route's own
  // metric extraction uses (`normalise/faro.ts`'s `processOneItem` for the
  // browser metrics inside a Faro batch) — this route's points are
  // `error.uncaught`/`web_vital`, not the `o11y.ingest` self-metric
  // `respond.ts`'s helpers write, but the sink and the `ctx.waitUntil`/never-
  // throw contract are the same for every point this Worker writes.
  //
  // Fix round (finding A-I4): only write this route's own metric point when
  // the record was actually a NEW record — the previous unconditional write
  // meant a duplicated beacon (a `sendBeacon` retry, a redelivered request)
  // wrote a second `error.uncaught`/`web_vital` point even while the
  // matching `o11y.ingest` point already said `duplicate`.
  if (accepted > 0) {
    for (const point of aePoints) writePoint(env, ctx, point);
  }

  return respondIngested(env, ctx, "lite", { accepted, duplicate }, bytes.byteLength);
}

registerRoute("POST", "/telemetry/lite", handleLite);
