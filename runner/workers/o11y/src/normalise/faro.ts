// ADR §B.2 step 1 (Faro half) + §6's item → Analytics Engine / inbox table.
// T00-D6's order for Faro: `scrubTelemetry(item)` → `faroItemToRecord(scrubbedItem, …)`.
//
// T02-D — unpacking the wire body (see the task Outcome): `@grafana/faro-web-sdk`'s
// real transport posts a `TransportBody` — one shared `meta` plus separate
// arrays (`exceptions`, `logs`, `measurements`, `events`, `traces`) — not an
// array of self-contained items the way `ScrubbableFaroItem` (and this
// contract's item-shaped functions) assume. This module is what reconstructs
// `{type, payload, meta}` items from that body before anything else runs.
// `traces` is never unpacked (ADR §C.4: no trace is ever exported) — any
// item under that key is counted as a dropped, invalid item, not silently
// ignored.

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
import { scrubBodyText } from "./text-scrub.js";

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

export interface ProcessedFaroItem {
  /** Absent for a console-dropped item, an unrecoverable item (a bad
   *  `item.type`/`toAePoint` input, T00-D10), an oversize record, or an
   *  `example.*` event (AE points only, never stored, §6). */
  ingestItem?: IngestItem;
  aePoints: AePoint[];
  /** Set when this item could not be converted/validated at all — the caller
   *  writes one `invalid_item` `o11y.ingest` point and moves on (never a
   *  500). Unset for a console-drop, an oversize record or an `example.*`
   *  event: those are intentional, not a failure. */
  invalid?: string;
  /** Set when the built record alone (well-formed, otherwise storable)
   *  exceeds `INBOX_RECORD_MAX_BYTES` (ADR §B.2 step 1, "drop records over
   *  256 KB") — fix round I2: the OTLP path already had this check
   *  (`otlp.ts`'s `droppedOversize`); the Faro path did not, even though
   *  `pack.ts`'s row-chunking assumes normalise already enforces the cap.
   *  Distinct from `invalid` so the caller writes a `reason: "size"` point
   *  (I3), not `reason: "invalid_item"`. */
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

function processException(
  bodyText: string,
  resourceAttributes: Record<string, string>,
  demoId: string | undefined,
  handled: boolean,
  aeOnly: ReturnType<typeof readAeOnlyAttrs>,
  service: ServiceIdentity,
): { points: AePoint[]; fingerprint?: string } {
  const surface = (resourceAttributes[ATTR_HOT_SURFACE] as Surface | undefined) ?? "authoring";
  const fp = aeOnly.fingerprint ?? computeFingerprint(surface, bodyText);
  const common = { service_name: service.name, service_version: service.version, environment: service.environment };
  const point = handled
    ? toAePoint("error.handled", { count: 1 }, { ...common, surface, route_class: aeOnly.route_class, fingerprint: fp })
    : toAePoint("error.uncaught", { count: 1 }, { ...common, surface, fingerprint: fp, demo_id: demoId });
  return { points: [point], fingerprint: feedsNewFingerprintAlert(surface) ? fp : undefined };
}

/** Unpacks a Faro `TransportBody`, scrubs/converts/validates every item
 *  (T00-D6, T00-D10), and returns one {@link ProcessedFaroItem} per item,
 *  each with its `IngestItem.hash` already computed (ADR §B.2 step 2) — the
 *  route handler hashes nothing itself. */
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
  const rawContext = {
    ...((payload["context"] as Record<string, string> | undefined) ?? {}),
    ...((payload["attributes"] as Record<string, string> | undefined) ?? {}),
  };
  const aeOnly = readAeOnlyAttrs(rawContext);
  const handled = rawContext["handled"] === "true";

  const item: ScrubbableFaroItem = { type, payload: payload as never, meta: meta as never };
  const scrubbed = scrubTelemetry(item);
  if (scrubbed === null) return { aePoints: [] }; // console item, intentionally dropped (§3)

  let record;
  try {
    record = faroItemToRecord(scrubbed, { service, receivedAtMs });
  } catch (err) {
    return { aePoints: [], invalid: err instanceof Error ? err.message : String(err) };
  }
  // T02-D — snapshot *before* filling §3 resource-attribute defaults (see
  // the task Outcome): `toAePoint` throws when `outcome`/`reason` is set for
  // a metric whose §5 row has no such slot (a caller-bug guard). Once
  // `withResourceAttrDefaults` fills `hot.outcome = "none"` for the *stored*
  // record (needed for exit criterion 15's "every label populated"), reusing
  // that same defaulted bag for AE point attrs would set `outcome: "none"`
  // on every metric — including ones like `example.open` that carry no
  // outcome slot at all — turning a metric with no client-supplied outcome
  // into a spurious throw. `clientResourceAttributes` is what every
  // `browserHotAttrs()` call below reads instead; only the record that gets
  // stored sees the defaulted bag.
  const clientResourceAttributes = { ...record.resourceAttributes };
  withResourceAttrDefaults(record.resourceAttributes, env);
  // T02-D (see the task Outcome, `text-scrub.ts`): `scrubTelemetry` strips
  // query strings only from discrete URL fields, never from an embedded URL
  // inside the built body text — this task's own extra pass closes that gap.
  record.body = scrubBodyText(record.body);
  const demoId = record.attributes?.[ATTR_HOT_DEMO_ID];

  // Metric extraction (T00-D10: a crafted `outcome`/`reason`/attribute value
  // throws inside `toAePoint`) is isolated in its own try/catch, deliberately
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
        aePoints = processExampleEvent(name, clientResourceAttributes, aeOnly, service);
        storeRecord = false; // §6: example.* events are AE points only, never stored
      }
    } else if (type === "measurement") {
      aePoints = processMeasurement(payload, clientResourceAttributes, demoId, aeOnly, service);
    } else if (type === "exception") {
      const ex = processException(record.body, clientResourceAttributes, demoId, handled, aeOnly, service);
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

  if (!storeRecord) return { aePoints };

  // I2 (fix round, see the task Outcome): the OTLP path already dropped
  // records over `INBOX_RECORD_MAX_BYTES` before this fix; the Faro path
  // did not, even though `pack.ts`'s row-chunking (and the contract's own
  // "records over 256 KB are dropped" rule, §8) assumes normalise already
  // enforces this everywhere, not just on one ingest path.
  if (new TextEncoder().encode(JSON.stringify(record)).length > INBOX_RECORD_MAX_BYTES) {
    return { aePoints, oversize: true };
  }

  const hash = await hashRecord({
    body: record.body,
    resourceAttributes: record.resourceAttributes,
    attributes: record.attributes ?? {},
    rawEventTime: scrubbed.payload.timestamp ?? "",
  });
  return { aePoints, ingestItem: { hash, record, fingerprint: itemFingerprint } };
}
