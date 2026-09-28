// ADR §B.2 step 1 (Faro half) + §6's item → Analytics Engine / inbox table.
// Order: `scrubTelemetry(item)` → `faroItemToRecord(scrubbedItem, …)`.
// Faro's transport posts a `TransportBody` (one shared `meta` plus separate
// `exceptions`/`logs`/`measurements`/`events`/`traces` arrays), not an array
// of items; this module reconstructs `{type, payload, meta}` items from it.
// `traces` is never unpacked (ADR §C.4): any item there is invalid.

import {
  ATTR_HOT_DEMO_ID,
  ATTR_HOT_FRAMEWORK,
  ATTR_HOT_HT_MAJOR,
  ATTR_HOT_OUTCOME,
  ATTR_HOT_SURFACE,
  ATTR_HOT_TIER,
  fingerprint as computeFingerprint,
  faroItemToRecord,
  feedsNewFingerprintAlert,
  INBOX_RECORD_MAX_BYTES,
  isValidFingerprint,
  METRICS,
  scrubTelemetry,
  toAePoint,
  type AePoint,
  type HtMajor,
  type MetricName,
  type MetricValues,
  type ScrubbableFaroItem,
  type ServiceIdentity,
  type Surface,
  type Tier,
} from "@handsontable/demo-runtime/telemetry";
import type { Env, IngestItem } from "../env.js";
import { readAeOnlyAttrs } from "./browser-attrs.js";
import { hashRecord } from "./hash.js";
import { withResourceAttrDefaults } from "./points.js";
import { scrubAttributeValues, scrubBodyText } from "./text-scrub.js";

/** Bounds a Faro `TransportBody` batch, generous headroom over the SDK's
 *  own limit (50 items) — an unbounded batch let a client inflate AE
 *  points/dedupe load (measured ~16.7k items in one 1 MB body).
 *  `handleCollect` rejects the whole request above this, like an oversized
 *  body. */
export const MAX_FARO_ITEMS_PER_BODY = 200;

/** Total item count across every unpacked kind (`traces` included, since a
 *  trace item still counts toward the cap even though it is always
 *  rejected as invalid) — used by `index.ts#handleCollect` before this
 *  module does any real work on the batch. */
export function countFaroItems(body: unknown): number {
  if (typeof body !== "object" || body === null) return 0;
  const wire = body as Record<string, unknown>;
  let count = 0;
  for (const key of ["exceptions", "logs", "measurements", "events", "traces"]) {
    const list = wire[key];
    if (Array.isArray(list)) count += list.length;
  }
  return count;
}

const ITEM_KIND_BY_BODY_KEY: Readonly<Record<string, ScrubbableFaroItem["type"]>> = {
  exceptions: "exception",
  logs: "log",
  measurements: "measurement",
  events: "event",
};

const LITE_VITAL_KEYS: Readonly<Record<string, string>> = {
  lcp: "LCP",
  inp: "INP",
  cls: "CLS",
  ttfb: "TTFB",
};

/**
 * Server-side backstop for a client that skips or bypasses the shared
 * noise gates that already run in Faro's `beforeSend`
 * (`apps/authoring/src/eventGate.ts#isUnhandledNoise`/`isOfficeScannerRejection`) —
 * re-checked here before an item can mint an `error.uncaught` point or an
 * `fp:` registry entry. Deliberately duplicated, not imported (`apps/authoring`
 * and `workers/o11y` are separate packages with no dependency between them):
 * keep in sync with `eventGate.ts#UNHANDLED_NOISE`/`INJECTED_SCANNER_MESSAGES`
 * by hand. `isForeignUnhandled`/`isEdgelessForeignSessionStart` stay
 * browser-gate-only: both need browser-only context (per-frame URLs,
 * Sentry-only session tags) this ingest path never receives.
 */
const SERVER_SIDE_UNHANDLED_NOISE: readonly RegExp[] = [
  /^ResizeObserver loop/i,
  /^AbortError/i,
  /Failed to fetch/i,
  /Load failed/i,
];
const SERVER_SIDE_INJECTED_SCANNER_MESSAGES: readonly RegExp[] = [
  /Object Not Found Matching Id/i, // Microsoft Outlook/Office safelink scanner
];

/** True for an unhandled exception item whose message/type matches one of
 *  the shared noise gates — mirrors `eventGate.ts`'s own
 *  `mechanism.handled === false` discriminator (an explicit, handled report
 *  that merely quotes this text must never be silently dropped). */
function isServerSideNoiseException(value: string | undefined, type: string | undefined, handled: boolean): boolean {
  if (handled) return false;
  const patterns = [...SERVER_SIDE_UNHANDLED_NOISE, ...SERVER_SIDE_INJECTED_SCANNER_MESSAGES];
  return patterns.some((re) => re.test(value ?? "") || re.test(type ?? ""));
}

export interface ProcessedFaroItem {
  /** Absent for a console-dropped, unrecoverable or oversize item. An
   *  `example.*` event also carries a hash-only `ingestItem` (`record`
   *  absent) so `InboxWriter.ingest`'s dedupe transaction covers it too,
   *  without storing anything (§6). */
  ingestItem?: IngestItem;
  /** When {@link ingestItem} is set, write these only for a hash
   *  `InboxWriter.ingest` reports `"accepted"`, never `"duplicate"` — a
   *  retried batch must not double-count a point. When absent, these have
   *  no hash to gate on and are written unconditionally. */
  aePoints: AePoint[];
  /** Set when this item could not be converted/validated at all — the caller
   *  writes one `invalid_item` `o11y.ingest` point and moves on (never a
   *  500). Unset for a console-drop, an oversize record or an `example.*`
   *  event: those are intentional, not a failure. */
  invalid?: string;
  /** Set when the built record alone (well-formed, otherwise storable)
   *  exceeds `INBOX_RECORD_MAX_BYTES` (ADR §B.2 step 1, "drop records over
   *  256 KB"). Distinct from `invalid` so the caller writes a
   *  `reason: "size"` point, not `reason: "invalid_item"`. */
  oversize?: boolean;
}

function metricValuesFromPayload(values: Record<string, number> | undefined): MetricValues {
  if (!values) return {};
  const out: MetricValues = {};
  for (const key of ["count", "duration_ms", "value", "usd", "tokens_in", "tokens_out", "bytes", "cap"] as const) {
    if (typeof values[key] === "number") out[key] = values[key];
  }
  return out;
}

function browserHotAttrs(resourceAttributes: Record<string, string>) {
  return {
    surface: resourceAttributes[ATTR_HOT_SURFACE] as Surface | undefined,
    tier: resourceAttributes[ATTR_HOT_TIER] as Tier | undefined,
    framework: resourceAttributes[ATTR_HOT_FRAMEWORK],
    ht_major: resourceAttributes[ATTR_HOT_HT_MAJOR] as HtMajor | undefined,
    outcome: resourceAttributes[ATTR_HOT_OUTCOME],
  };
}

function processMeasurement(
  raw: Record<string, unknown>,
  resourceAttributes: Record<string, string>,
  demoId: string | undefined,
  aeOnly: ReturnType<typeof readAeOnlyAttrs>,
  service: ServiceIdentity,
): AePoint[] {
  const type = typeof raw["type"] === "string" ? raw["type"] : "";
  const values = raw["values"] as Record<string, number> | undefined;
  const common = { service_name: service.name, service_version: service.version, environment: service.environment };

  if (type === "web-vitals") {
    const points: AePoint[] = [];
    for (const [key, value] of Object.entries(values ?? {})) {
      const reason = LITE_VITAL_KEYS[key.toLowerCase()];
      if (!reason || typeof value !== "number") continue;
      points.push(
        toAePoint(
          "web_vital",
          { value },
          {
            ...common,
            surface: browserHotAttrs(resourceAttributes).surface,
            framework: browserHotAttrs(resourceAttributes).framework,
            ht_major: browserHotAttrs(resourceAttributes).ht_major,
            reason,
            device: aeOnly.device,
            demo_id: demoId,
          },
        ),
      );
    }
    return points;
  }

  if ((METRICS as Record<string, unknown>)[type] && METRICS[type as MetricName].emittedBy.includes("browser")) {
    return [
      toAePoint(type as MetricName, metricValuesFromPayload(values), {
        ...common,
        ...browserHotAttrs(resourceAttributes),
        ...aeOnly,
      }),
    ];
  }
  return [];
}

function processExampleEvent(
  name: string,
  resourceAttributes: Record<string, string>,
  aeOnly: ReturnType<typeof readAeOnlyAttrs>,
  service: ServiceIdentity,
): AePoint[] {
  if (!(name in METRICS)) return [];
  const common = { service_name: service.name, service_version: service.version, environment: service.environment };
  return [
    toAePoint(name as MetricName, { count: 1 }, { ...common, ...browserHotAttrs(resourceAttributes), ...aeOnly }),
  ];
}

/** Picks the fingerprint a client offered, validated, or falls back to
 *  computing it server-side. `wireFingerprint` (Faro's `payload.fingerprint`,
 *  §7's exact shape) is preferred, since it distinguishes two call sites
 *  reporting the same message; `aeOnlyFingerprint` (`context["hot.fingerprint"]`)
 *  is the next fallback. Neither is trusted verbatim: a value not matching
 *  §7's `<context>:<16 hex>` shape is discarded. `fallbackMessage` is the
 *  last resort (the raw `window.onerror`/`unhandledrejection` path); it must
 *  be the `type: value` head only (`exceptionFingerprintMessage`), never
 *  `record.body`'s stack lines — a minified bundle's chunk hash shifts every
 *  deploy even for an identical error, so hashing the stack would turn a
 *  recurring defect into a fresh `fp:` entry on every release. */
function resolveFingerprint(
  wireFingerprint: string | undefined,
  aeOnlyFingerprint: string | undefined,
  surface: string,
  fallbackMessage: string,
): string {
  if (wireFingerprint !== undefined && isValidFingerprint(wireFingerprint)) return wireFingerprint;
  if (aeOnlyFingerprint !== undefined && isValidFingerprint(aeOnlyFingerprint)) return aeOnlyFingerprint;
  return computeFingerprint(surface, fallbackMessage);
}

/** The `type: value` head of a Faro exception payload, with NO stack —
 *  deliberately mirrors `convert.ts#faroBody`'s own exception-head
 *  construction (duplicated here rather than imported, same tradeoff as
 *  `SERVER_SIDE_UNHANDLED_NOISE` above). `o11y-normalise.test.mjs` pins this
 *  shape directly, so a future drift between the two shows up as a failing
 *  test, not a silent mismatch. */
function exceptionFingerprintMessage(payload: { type?: string; value?: string }): string {
  const value = payload.value ?? "";
  return payload.type ? `${payload.type}: ${value}` : value;
}

/** Inputs that can change this item's output (an AE point, an alert) but
 *  never reach `hashRecord`'s `body`/`attributes` (`hash.ts#PreHashRecord.extra`).
 *  - `type`: `faroBody()`'s measurement case stringifies only `values`, so
 *    two different measurements with the same `values` would hash the same.
 *  - `aeOnly`: `hot.*` AE-only attributes never reach a stored record's
 *    `attributes` (`browser-attrs.ts`), so they'd otherwise be invisible here.
 *  - `sessionId`: a Faro META field, never copied into `context`/`attributes`,
 *    so `faroItemToRecord` never sees it; read from the raw `meta` param. */
function hashExtra(
  payload: Record<string, unknown>,
  aeOnly: ReturnType<typeof readAeOnlyAttrs>,
  meta: unknown,
): Record<string, string> {
  const extra: Record<string, string> = {};
  const type = payload["type"];
  if (typeof type === "string" && type.length > 0) extra["type"] = type;
  for (const [key, value] of Object.entries(aeOnly)) {
    if (typeof value === "string" && value.length > 0) extra[`ae.${key}`] = value;
  }
  const sessionId = (meta as { session?: { id?: unknown } } | null | undefined)?.session?.id;
  if (typeof sessionId === "string" && sessionId.length > 0) extra["session.id"] = sessionId;
  return extra;
}

function processException(
  fallbackMessage: string,
  resourceAttributes: Record<string, string>,
  demoId: string | undefined,
  handled: boolean,
  aeOnly: ReturnType<typeof readAeOnlyAttrs>,
  service: ServiceIdentity,
  wireFingerprint: string | undefined,
): { points: AePoint[]; fingerprint?: string } {
  const surface = (resourceAttributes[ATTR_HOT_SURFACE] as Surface | undefined) ?? "authoring";
  const fp = resolveFingerprint(wireFingerprint, aeOnly.fingerprint, surface, fallbackMessage);
  const common = { service_name: service.name, service_version: service.version, environment: service.environment };
  const point = handled
    ? toAePoint("error.handled", { count: 1 }, { ...common, surface, route_class: aeOnly.route_class, fingerprint: fp })
    : toAePoint("error.uncaught", { count: 1 }, { ...common, surface, fingerprint: fp, demo_id: demoId });
  return { points: [point], fingerprint: feedsNewFingerprintAlert(surface) ? fp : undefined };
}

/** Unpacks a Faro `TransportBody`, scrubs/converts/validates every item,
 *  and returns one {@link ProcessedFaroItem} per item, each with its
 *  `IngestItem.hash` already computed (ADR §B.2 step 2) — the route
 *  handler hashes nothing itself. */
export async function processFaroBody(
  body: unknown,
  env: Env,
  service: ServiceIdentity,
  receivedAtMs: number,
): Promise<ProcessedFaroItem[]> {
  const results: ProcessedFaroItem[] = [];
  if (typeof body !== "object" || body === null) return [{ aePoints: [], invalid: "not an object" }];
  const wire = body as Record<string, unknown>;
  const meta = wire["meta"];
  if (typeof meta !== "object" || meta === null) return [{ aePoints: [], invalid: "missing meta" }];

  if (Array.isArray(wire["traces"]) || (wire["traces"] && typeof wire["traces"] === "object")) {
    results.push({ aePoints: [], invalid: "trace item (not exported)" });
  }

  const jobs: Promise<ProcessedFaroItem>[] = [];
  for (const [bodyKey, kind] of Object.entries(ITEM_KIND_BY_BODY_KEY)) {
    const list = wire[bodyKey];
    if (!Array.isArray(list)) continue;
    for (const rawPayload of list) {
      jobs.push(processOneItem(kind, rawPayload as Record<string, unknown>, meta, env, service, receivedAtMs));
    }
  }
  results.push(...(await Promise.all(jobs)));
  return results;
}

async function processOneItem(
  type: ScrubbableFaroItem["type"],
  payload: Record<string, unknown>,
  meta: unknown,
  env: Env,
  service: ServiceIdentity,
  receivedAtMs: number,
): Promise<ProcessedFaroItem> {
  // An untrusted client can put a `null`/non-object entry inside a Faro
  // batch array (`{"logs":[null]}` is valid JSON); guard against that
  // shape here rather than letting the destructure below throw.
  if (typeof payload !== "object" || payload === null) {
    return { aePoints: [], invalid: "item is not an object" };
  }

  const rawContext = {
    ...((payload["context"] as Record<string, string> | undefined) ?? {}),
    ...((payload["attributes"] as Record<string, string> | undefined) ?? {}),
  };
  const aeOnly = readAeOnlyAttrs(rawContext);
  const handled = rawContext["handled"] === "true";
  // Faro's own `pushError({ fingerprint })` option lands in
  // `payload.fingerprint`, a sibling of `context`/`attributes`, not inside
  // either — `readAeOnlyAttrs` (which only reads `context`) never sees it.
  // Length-capped defensively before the validation regex in
  // `resolveFingerprint` runs against untrusted input.
  const rawWireFingerprint = payload["fingerprint"];
  const wireFingerprint =
    typeof rawWireFingerprint === "string" && rawWireFingerprint.length <= 128 ? rawWireFingerprint : undefined;

  const item: ScrubbableFaroItem = { type, payload: payload as never, meta: meta as never };
  let scrubbed: ScrubbableFaroItem | null;
  try {
    scrubbed = scrubTelemetry(item);
  } catch (err) {
    // `scrubTelemetry` itself can throw on a malformed nested shape; this
    // per-item boundary is the "never a 500" backstop for that.
    return { aePoints: [], invalid: err instanceof Error ? err.message : String(err) };
  }
  if (scrubbed === null) return { aePoints: [] }; // console item, intentionally dropped (§3)

  // Dropped exactly like a console item (see SERVER_SIDE_UNHANDLED_NOISE
  // above): no stored record, no AE point, no fingerprint — the same thing
  // Sentry/Faro's own `beforeSend` returning `null` does browser-side.
  if (
    type === "exception" &&
    isServerSideNoiseException(scrubbed.payload.value, scrubbed.payload.type, handled)
  ) {
    return { aePoints: [] };
  }

  let record;
  try {
    record = faroItemToRecord(scrubbed, { service, receivedAtMs });
  } catch (err) {
    return { aePoints: [], invalid: err instanceof Error ? err.message : String(err) };
  }
  // Snapshot before `withResourceAttrDefaults` fills `hot.outcome = "none"`
  // for the stored record (ADR-0041 §L.15, "every label populated"):
  // `toAePoint` throws on `outcome`/`reason` for a metric whose §5 row has
  // no such slot, so reusing the defaulted bag for AE point attrs would
  // turn a metric like `example.open` into a spurious throw.
  // `clientResourceAttributes` is what `browserHotAttrs()` reads instead.
  const clientResourceAttributes = { ...record.resourceAttributes };
  withResourceAttrDefaults(record.resourceAttributes, env);
  // `stripCodeFrame` (via `scrubText`) and the attribute allowlist need a
  // second pass over fields `faroItemToRecord` itself builds (exception
  // `type`, event `name`, stack-frame `function` text folded into `body`),
  // which the first `scrubTelemetry` call on the raw item never saw. Run it
  // again here on the OTLP-record branch, exactly like `lite.ts`/`otlp.ts`
  // do for their own converted records — it never returns `null` for that
  // branch (only a Faro item can be dropped as a console item).
  record = scrubTelemetry(record)!;
  // `scrubTelemetry` strips query strings only from discrete URL fields,
  // never from an embedded URL inside the built body text; this closes
  // that gap.
  record.body = scrubBodyText(record.body);
  // An allowlisted attribute/resource-attribute value only gets
  // `redactPreviewHosts` inside `scrubTelemetry` — a query string or an
  // embedded user-agent in `context`/a diagnostic tag value would survive
  // otherwise. Same extra pass `body` gets, applied to every attribute
  // value.
  record.attributes = scrubAttributeValues(record.attributes);
  record.resourceAttributes = scrubAttributeValues(record.resourceAttributes) ?? record.resourceAttributes;
  const demoId = record.attributes?.[ATTR_HOT_DEMO_ID];

  // Metric extraction (a crafted `outcome`/`reason`/attribute value throws
  // inside `toAePoint`) is isolated in its own try/catch, deliberately
  // separate from record storage below it — a malformed metric attribute
  // must cost only its own point, never the underlying log record, which is
  // already valid at the OTLP level regardless of what the metric extraction
  // made of it.
  let aePoints: AePoint[] = [];
  let storeRecord = true;
  let itemFingerprint: string | undefined;
  try {
    if (type === "event") {
      const name = typeof scrubbed.payload.name === "string" ? scrubbed.payload.name : "";
      if (name.startsWith("example.")) {
        // Set BEFORE calling the extractor: the catch block below reads
        // `storeRecord` to decide whether a throwing extractor should
        // surface as `invalid` (nothing to salvage) or fall through to
        // still storing the record. Setting the flag AFTER a call that can
        // itself throw would leave it at its default `true` on that path —
        // a crafted `example.*` attribute that made
        // `processExampleEvent`/`toAePoint` throw would then store a record
        // anyway, contradicting §6 ("AE points only, never stored").
        storeRecord = false; // §6: example.* events are AE points only, never stored
        aePoints = processExampleEvent(name, clientResourceAttributes, aeOnly, service);
      }
    } else if (type === "measurement") {
      // A Faro measurement (incl. `web-vitals`, `processMeasurement`'s
      // other branch below) is ~99% of the browser Loki tenant's lines and
      // drained bytes, and no dashboard reads a stored measurement record —
      // the AE point above is the only consumer (ADR §F.1). Reuses the
      // hash-only `ingestItem` path `example.*` events already take above.
      //
      // Set BEFORE calling `processMeasurement`: a crafted
      // `hot.outcome`/`hot.reason` that makes `toAePoint` throw must
      // surface as `invalid`, not fall through and store a record with
      // zero AE points (§6 "none" ruling).
      storeRecord = false;
      aePoints = processMeasurement(payload, clientResourceAttributes, demoId, aeOnly, service);
    } else if (type === "exception") {
      const ex = processException(
        exceptionFingerprintMessage(scrubbed.payload),
        clientResourceAttributes,
        demoId,
        handled,
        aeOnly,
        service,
        wireFingerprint,
      );
      aePoints = ex.points;
      itemFingerprint = ex.fingerprint;
    }
    // "log" and a non-"example." event: inbox record only, no AE point (§6).
  } catch (err) {
    // The point extraction failed; if this item was never going to be
    // stored anyway (an "example.*" event with a bad attribute), there is
    // nothing left to salvage — surface it as invalid. Otherwise fall
    // through and still store the record; the caller sees zero points for
    // this item and can tell from `invalid` that the metric was dropped.
    if (!storeRecord) return { aePoints: [], invalid: err instanceof Error ? err.message : String(err) };
    aePoints = [];
  }

  if (!storeRecord) {
    // An `example.*` event skips row storage (§6: AE points only) but must
    // still go through `InboxWriter.ingest`'s hash/dedupe transaction, so a
    // retried/redelivered batch does not double-count its AE point. Reuses
    // the exact hash shape `hashRecord` computes for a stored record below
    // (same fields, including the raw client `timestamp` — not the clamped
    // one — so two genuine clicks a browser reports with distinct
    // timestamps never collapse into one) purely for dedupe: no `record` is
    // attached, so `InboxWriter.ingest`/`appendRows` skip a `record`-less
    // item entirely — nothing is ever stored for it.
    const hash = await hashRecord({
      body: record.body,
      resourceAttributes: record.resourceAttributes,
      attributes: record.attributes ?? {},
      rawEventTime: scrubbed.payload.timestamp ?? "",
      extra: hashExtra(payload, aeOnly, meta),
    });
    return { aePoints, ingestItem: { hash } };
  }

  // `pack.ts`'s row-chunking (and the contract's own "records over 256 KB
  // are dropped" rule, §8) assumes normalise enforces this on every ingest
  // path, so the Faro path checks it here the same way the OTLP path does.
  if (new TextEncoder().encode(JSON.stringify(record)).length > INBOX_RECORD_MAX_BYTES) {
    return { aePoints, oversize: true };
  }

  const hash = await hashRecord({
    body: record.body,
    resourceAttributes: record.resourceAttributes,
    attributes: record.attributes ?? {},
    rawEventTime: scrubbed.payload.timestamp ?? "",
    extra: hashExtra(payload, aeOnly, meta),
  });
  return { aePoints, ingestItem: { hash, record, fingerprint: itemFingerprint } };
}
