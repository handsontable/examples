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

/** Fix round (finding A-I4): a real Faro `TransportBody` batch is bounded
 *  (the SDK's own batch limit is 50 items); nothing enforced any bound
 *  server-side before this, so an unauthenticated client could inflate one
 *  request's Analytics Engine points and DO dedupe-check load arbitrarily —
 *  measured at ~16.7k items in one 1 MB body. Generous headroom over the
 *  SDK's own limit, not a tight fit to it. `handleCollect` (`index.ts`)
 *  rejects the whole request above this, the same way it already rejects
 *  an oversized body — a partially-processed giant batch is not a
 *  meaningfully safer middle ground than rejecting it outright. */
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
 * Controller handoff (defence in depth for finding D-I2's server-side half,
 * F3-report.md "Not fixed / handed off"): F3 applied the shared noise gates
 * to Faro's browser-side `beforeSend`
 * (`apps/authoring/src/eventGate.ts#isUnhandledNoise`/`isOfficeScannerRejection`),
 * which already closes the failure scenario the finding names for a normal
 * client. This is the server-side backstop for a client that skips or
 * bypasses that gate — the same two message/type-shaped rules, re-checked
 * here on the scrubbed item before it can mint an `error.uncaught` point or
 * an `fp:` registry entry.
 *
 * Deliberately duplicated, not imported: `apps/authoring` and `workers/o11y`
 * are separate pnpm workspace packages with no dependency between them (the
 * shared code both surfaces import from is `@handsontable/demo-runtime`,
 * `packages/runtime`, not `apps/authoring/src`), so a cross-package source
 * import would not resolve. Keep these two lists in sync with
 * `eventGate.ts#UNHANDLED_NOISE`/`INJECTED_SCANNER_MESSAGES` by hand.
 *
 * Not reimplemented here: `isForeignUnhandled` (needs the request's own
 * origin plus per-frame URLs, a browser-side concept with no clean
 * server-side analogue once frames are already rendered into `record.body`
 * text) and `isEdgelessForeignSessionStart` (reads Sentry-only session tags
 * this ingest path never receives). Both stay browser-gate-only, same as
 * F3's own scope decision for D-I2.
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
  /** Absent for a console-dropped item, an unrecoverable item (a bad
   *  `item.type`/`toAePoint` input, T00-D10), an oversize record, or an
   *  `example.*` event (AE points only, never stored, §6). */
  ingestItem?: IngestItem;
  /** Fix round (finding A-I4): when {@link ingestItem} is set, the caller
   *  (`index.ts#handleCollect`) must write these points only for a hash
   *  `InboxWriter.ingest` reports as `"accepted"`, never `"duplicate"` — a
   *  retried/redelivered batch must not double-count `error.uncaught`,
   *  `error.handled`, or any browser metric point the way the underlying
   *  log record already avoids double-storage. When {@link ingestItem} is
   *  absent (an `example.*` event, or an item that never reached storage at
   *  all), these points have no hash to gate on and are written
   *  unconditionally, same as before. */
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

/** Fix round (findings A-C2, D-I3): picks the fingerprint a client offered,
 *  validated, or falls back to computing it server-side.
 *
 * - `wireFingerprint` is Faro's own `payload.fingerprint` (the browser
 *   facade's `contractFingerprint(context, message)`, §7's exact shape,
 *   never over the stack) — preferred, since it is the one value that
 *   actually distinguishes two call sites reporting the same message
 *   (D-I3: `computeFingerprint` below only ever sees `hot.surface`, not the
 *   call site).
 * - `aeOnlyFingerprint` (`context["hot.fingerprint"]`) is the fallback a
 *   caller may already be sending; same validation.
 * - Neither trusted verbatim (A-C2): a value that does not match §7's
 *   `<context>:<16 hex>` shape is discarded — an attacker cannot inject
 *   arbitrary text into the exact first-seen registry or, from there, an
 *   unescaped Slack line this way.
 * - `fallbackMessage` (fix round, finding D-I3 remainder, second wave) is
 *   the LAST resort, used only when NEITHER of the above is present — this
 *   is exactly the raw `window.onerror`/`unhandledrejection`/render-crash
 *   path (`ErrorsInstrumentation`, `reportUncaughtError`), since every
 *   explicit, on-purpose `Telemetry.error()` call already sets
 *   `payload.fingerprint` (`apps/authoring/src/telemetry/faro.ts`'s
 *   `buildFacade().error`). It must be the contract-normalised `type: value`
 *   head ONLY (see `exceptionFingerprintMessage` at the call site below) —
 *   never `record.body`, which also carries the rendered stack-frame lines
 *   (`convert.ts#faroBody`'s exception branch). A minified production
 *   bundle's chunk hash and line:col shift on every deploy even when the
 *   thrown error is identical, so hashing the stack churned a genuinely
 *   recurring defect into a fresh `fp:` entry (and Slack "new fingerprint"
 *   post) on every single release — the D-I3 failure this closes.
 */
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
 *  construction (that function is outside this task's file ownership;
 *  duplicated here rather than touched there — see this module's own doc
 *  comment style for the same tradeoff elsewhere, e.g.
 *  `SERVER_SIDE_UNHANDLED_NOISE`'s hand-copy of `eventGate.ts`'s lists).
 *  `pipeline/telemetry-contract.test.mjs`/`o11y-normalise.test.mjs` pin this
 *  shape directly, so a future drift between the two shows up as a failing
 *  test, not a silent mismatch. */
function exceptionFingerprintMessage(payload: { type?: string; value?: string }): string {
  const value = payload.value ?? "";
  return payload.type ? `${payload.type}: ${value}` : value;
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
  // Fix round (finding A-M1): an untrusted client can put a `null`/
  // non-object entry inside a Faro batch array (`{"logs":[null]}` is valid
  // JSON) — the destructure below (`payload["context"]`) threw a
  // `TypeError` on that shape, escaping as an uncaught `500`. Caught as an
  // ordinary invalid item instead, the same as any other malformed one.
  if (typeof payload !== "object" || payload === null) {
    return { aePoints: [], invalid: "item is not an object" };
  }

  const rawContext = {
    ...((payload["context"] as Record<string, string> | undefined) ?? {}),
    ...((payload["attributes"] as Record<string, string> | undefined) ?? {}),
  };
  const aeOnly = readAeOnlyAttrs(rawContext);
  const handled = rawContext["handled"] === "true";
  // Fix round (finding D-I3): Faro's own `pushError({ fingerprint })` option
  // lands in `payload.fingerprint`, a sibling of `context`/`attributes`, not
  // inside either — `readAeOnlyAttrs` (which only reads `context`) never
  // sees it. Read here, validated together with `aeOnly.fingerprint` in
  // `resolveFingerprint` (A-C2). Length-capped defensively before that
  // regex runs against untrusted input.
  const rawWireFingerprint = payload["fingerprint"];
  const wireFingerprint =
    typeof rawWireFingerprint === "string" && rawWireFingerprint.length <= 128 ? rawWireFingerprint : undefined;

  const item: ScrubbableFaroItem = { type, payload: payload as never, meta: meta as never };
  let scrubbed: ScrubbableFaroItem | null;
  try {
    scrubbed = scrubTelemetry(item);
  } catch (err) {
    // Fix round (finding A-M1): `scrubTelemetry` itself can throw on a
    // malformed nested shape (the stacktrace-frame case is now fixed at
    // the root in `scrub.ts`, but this per-item boundary stays as the
    // "never a 500" backstop for whatever shape is discovered next).
    return { aePoints: [], invalid: err instanceof Error ? err.message : String(err) };
  }
  if (scrubbed === null) return { aePoints: [] }; // console item, intentionally dropped (§3)

  // Controller handoff (D-I2 server-side backstop, see SERVER_SIDE_UNHANDLED_NOISE's
  // own doc comment): dropped exactly like a console item — no stored
  // record, no AE point, no fingerprint — the same thing Sentry/Faro's own
  // `beforeSend` returning `null` would have done browser-side.
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
  // Fix round (finding A-M3): the Faro path ran `scrubTelemetry` only on
  // the raw item, never on the assembled OTLP record — `stripCodeFrame`
  // (via `scrubText`) and the attribute allowlist never got a second pass
  // over fields `faroItemToRecord` itself builds (exception `type`, event
  // `name`, stack-frame `function` text folded into `body`). Run it again
  // here, the OTLP-record branch, exactly like `lite.ts`/`otlp.ts` already
  // do for their own converted records — it never returns `null` for that
  // branch (only a Faro item can be dropped as a console item).
  record = scrubTelemetry(record)!;
  // T02-D (see the task Outcome, `text-scrub.ts`): `scrubTelemetry` strips
  // query strings only from discrete URL fields, never from an embedded URL
  // inside the built body text — this task's own extra pass closes that gap.
  record.body = scrubBodyText(record.body);
  // Fix round (finding A-M3, "also"): an allowlisted attribute/resource-
  // attribute value only got `redactPreviewHosts` inside `scrubTelemetry` —
  // a query string or an embedded user-agent in `context`/a diagnostic tag
  // value survived otherwise. Same extra pass `body` gets, applied to every
  // attribute value.
  record.attributes = scrubAttributeValues(record.attributes);
  record.resourceAttributes = scrubAttributeValues(record.resourceAttributes) ?? record.resourceAttributes;
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
