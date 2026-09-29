// Observability contract §6, §9 — Faro item → OTLP log record, and lite-beacon
// → OTLP log record. One converter for both.
//
// Scrub/convert order is NOT symmetric: `scrubTelemetry` accepts the Faro
// item shape or the OTLP record shape, never `LiteBeaconPayload` (§9).
//   - Faro:   `scrubTelemetry(item)` → `faroItemToRecord(scrubbedItem, …)`
//   - Beacon: `beaconToRecord(payload, …)` → `scrubTelemetry(record)`
// `beaconToRecord`'s caller MUST run `scrubTelemetry` on its return value
// before storage, or an unscrubbed code frame / preview host in `m`/`st`
// reaches the inbox.

import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_HOT_DEMO_ID,
  ATTR_HOT_FRAMEWORK,
  ATTR_HOT_HT_MAJOR,
  ATTR_HOT_KIND,
  ATTR_HOT_OUTCOME,
  ATTR_HOT_SURFACE,
  ATTR_HOT_TIER,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  DIAGNOSTIC_TAG_KEYS,
  ENVIRONMENTS,
  HOT_KINDS,
  HT_MAJORS,
  KNOWN_FRAMEWORKS,
  OTHER_ATTR_VALUE,
  RECORD_OUTCOMES,
  RESOURCE_ATTRS,
  STRUCTURED_METADATA_KEYS,
  SURFACES,
  TIERS,
  type Environment,
  type ServiceName,
} from "./attrs.js";
import { METRICS } from "./metrics.js";
import type { NormalisedRecord } from "./inbox.js";
import type { ScrubbableFaroItem } from "./scrub.js";
import type { LiteBeaconPayload } from "./lite.js";

/** ADR §C.2: browser/beacon item timestamps are clamped to the envelope's
 *  `received_at` ± 5 minutes. */
const CLAMP_WINDOW_MS = 5 * 60 * 1000;

/** Clamps a candidate event-time (ms since epoch) to within
 *  `CLAMP_WINDOW_MS` of `receivedAtMs`; an absent or out-of-window candidate
 *  falls back to `receivedAtMs`, so no record ever reaches Loki without a
 *  timestamp (ADR §C.2). Also used by `normalise/otlp.ts`'s export path, at
 *  nanosecond precision. */
export function clampTimestampMs(candidateMs: number | undefined, receivedAtMs: number): number {
  if (candidateMs === undefined || !Number.isFinite(candidateMs)) return receivedAtMs;
  return Math.abs(candidateMs - receivedAtMs) <= CLAMP_WINDOW_MS ? candidateMs : receivedAtMs;
}

/** ms since epoch → OTLP `timeUnixNano` (decimal-string nanoseconds). Built with
 *  `BigInt`, never `ms * 1e6` — that exceeds `Number.MAX_SAFE_INTEGER` and
 *  silently loses precision. */
export function msToUnixNano(ms: number): string {
  return (BigInt(Math.round(ms)) * 1_000_000n).toString();
}

const RESOURCE_ATTR_KEYS = new Set(RESOURCE_ATTRS.map((a) => a.key));
// `STRUCTURED_KEY_SET`: §3's structured-metadata keys plus
// `DIAGNOSTIC_TAG_KEYS` — everything `scrub.ts#allowlistAttributes` keeps
// that isn't a resource attribute; lands in `attributes`, never
// `resourceAttributes`.
const STRUCTURED_KEY_SET = new Set<string>([...STRUCTURED_METADATA_KEYS, ...DIAGNOSTIC_TAG_KEYS]);

/** Split a merged, already-allowlisted attribute bag into OTLP resource
 *  attributes (`hot.surface`, `hot.tier`, … — ADR §B.2) and structured
 *  metadata (`hot.demo_id`, `session.id`, `cf.ray`, `hot.kind`, and the
 *  diagnostic tag keys — never a resource attribute, §3). */
export function hoistAttributes(
  merged: Record<string, string> | undefined,
): { resourceAttributes: Record<string, string>; attributes: Record<string, string> } {
  const resourceAttributes: Record<string, string> = {};
  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged ?? {})) {
    if (RESOURCE_ATTR_KEYS.has(key)) resourceAttributes[key] = value;
    else if (STRUCTURED_KEY_SET.has(key)) attributes[key] = value;
  }
  return { resourceAttributes, attributes };
}

export interface ServiceIdentity {
  name: ServiceName;
  version: string;
  environment: Environment;
}

export interface ConvertOptions {
  service: ServiceIdentity;
  /** The envelope's arrival time, ms since epoch — the clamp anchor (§C.2). */
  receivedAtMs: number;
}

function serviceResourceAttributes(service: ServiceIdentity): Record<string, string> {
  return {
    [ATTR_SERVICE_NAME]: service.name,
    [ATTR_SERVICE_VERSION]: service.version,
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: service.environment,
  };
}

/** Closed-set resource attributes, checked at record level. A failing value is
 *  dropped, and `normalise/points.ts#withResourceAttrDefaults` fills its default. */
const CLOSED_SET_BY_KEY: Readonly<Record<string, readonly string[]>> = {
  [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: ENVIRONMENTS,
  [ATTR_HOT_SURFACE]: SURFACES,
  [ATTR_HOT_TIER]: TIERS,
  [ATTR_HOT_HT_MAJOR]: HT_MAJORS,
};

/** The `hot.outcome` values `metric`'s §5 row allows, or {@link RECORD_OUTCOMES}
 *  for a record no outcome-carrying metric describes. */
function outcomeSetFor(metric: string | undefined): readonly string[] {
  if (metric === undefined || !Object.prototype.hasOwnProperty.call(METRICS, metric)) return RECORD_OUTCOMES;
  return METRICS[metric as keyof typeof METRICS].values?.["outcome"] ?? RECORD_OUTCOMES;
}

/**
 * Record-level enforcement of §3's value rules on every Loki-label attribute.
 * A closed-set value outside its enum is dropped. `hot.framework` and
 * `hot.outcome` outside their known sets (`KNOWN_FRAMEWORKS`; `metric`'s
 * outcomes) become `"other"`, so the label set stays bounded however many
 * distinct values a client sends. `metric` is the item's metric name, if any.
 */
export function sanitizeResourceAttributes(
  resourceAttributes: Record<string, string>,
  metric?: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(resourceAttributes)) {
    const closedSet = CLOSED_SET_BY_KEY[key];
    if (closedSet) {
      if (closedSet.includes(value)) out[key] = value;
      continue;
    }
    if (key === ATTR_HOT_FRAMEWORK) {
      out[key] = (KNOWN_FRAMEWORKS as readonly string[]).includes(value) ? value : OTHER_ATTR_VALUE;
      continue;
    }
    if (key === ATTR_HOT_OUTCOME) {
      out[key] = outcomeSetFor(metric).includes(value) ? value : OTHER_ATTR_VALUE;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** ADR §C.3, symbolication at drain: renders one stack frame
 *  in the standard V8 `    at <fn> (<file>:<line>:<col>)` shape —
 *  `workers/o11y/src/drain/symbolicate.ts` parses this exact text back out.
 *  A frame with no `filename` carries nothing a symbolicator could resolve
 *  or a human could read, so it is skipped rather than rendered as a bare
 *  `at <fn>` line (that would be ambiguous with a genuinely-anonymous,
 *  file-less frame, which does not occur in a browser stack). */
export function formatStackFrame(frame: { filename?: string; function?: string; lineno?: number; colno?: number }): string | null {
  if (!frame.filename) return null;
  const fn = frame.function || "<anonymous>";
  // A `lineno < 1` (or non-finite) is not a real source position:
  // `@jridgewell/trace-mapping#originalPositionFor` throws on it.
  // `symbolicate.ts#resolveBody` guards this too; dropping only the position
  // suffix keeps the existing "unresolvable, rendered as-is" shape.
  const position =
    typeof frame.lineno === "number" &&
    typeof frame.colno === "number" &&
    Number.isFinite(frame.lineno) &&
    Number.isFinite(frame.colno) &&
    frame.lineno >= 1
      ? `:${frame.lineno}:${frame.colno}`
      : "";
  return `    at ${fn} (${frame.filename}${position})`;
}

/** Stack frames are appended to the body as plain text (`body` is the one
 *  free-text field `NormalisedRecord` has). `symbolicate.ts` parses this
 *  exact format back out at drain and rewrites resolved lines in place, so
 *  this function's output must already be a faithful, minified stack. */
function faroBody(item: ScrubbableFaroItem): string {
  switch (item.type) {
    case "exception": {
      const value = item.payload.value ?? "";
      const head = item.payload.type ? `${item.payload.type}: ${value}` : value;
      const frameLines = (item.payload.stacktrace?.frames ?? [])
        .map(formatStackFrame)
        .filter((line): line is string => line !== null);
      return frameLines.length > 0 ? `${head}\n${frameLines.join("\n")}` : head;
    }
    case "log":
      return item.payload.message ?? "";
    case "event":
      return item.payload.name ?? "";
    case "measurement":
      return JSON.stringify(item.payload.values ?? {});
    default:
      return item.payload.message ?? item.payload.value ?? "";
  }
}

function faroTimestampMs(item: ScrubbableFaroItem): number | undefined {
  const ts = item.payload.timestamp;
  if (typeof ts !== "string") return undefined;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Faro item → normalised OTLP log record (§6). `item` must already be
 *  scrubbed. `hot.kind` is always `item.type`, overwriting anything the
 *  client's own context carried under that key. Throws if `item.type` is
 *  not one of `HOT_KINDS` (e.g. `"trace"`, never exported, ADR §C.4) —
 *  reachable from untrusted input via `POST /telemetry/collect`. */
export function faroItemToRecord(item: ScrubbableFaroItem, options: ConvertOptions): NormalisedRecord {
  if (!(HOT_KINDS as readonly string[]).includes(item.type)) {
    throw new Error(`faroItemToRecord: not a valid hot.kind: ${JSON.stringify(item.type)}`);
  }

  const merged = { ...(item.payload.context ?? {}), ...(item.payload.attributes ?? {}) };
  const { resourceAttributes, attributes } = hoistAttributes(merged);
  attributes[ATTR_HOT_KIND] = item.type;
  // Only a measurement carries a metric outcome, and it becomes an AE point, never
  // a stored record. A stored record's `hot.outcome` is always the `none`
  // default, which keeps the browser tenant's label tuples under the box's Loki
  // stream limit (contract §3).
  if (item.type !== "measurement") delete resourceAttributes[ATTR_HOT_OUTCOME];
  const metric = item.type === "measurement" ? item.payload.type : undefined;

  return {
    body: faroBody(item),
    timeUnixNano: msToUnixNano(clampTimestampMs(faroTimestampMs(item), options.receivedAtMs)),
    // `serviceResourceAttributes` spreads LAST: a client-hoisted value under
    // `service.name`/`service.version`/`deployment.environment.name` must
    // never win over the route's own identity. `sanitizeResourceAttributes`
    // closes the matching hole for the remaining `hot.*` keys.
    resourceAttributes: {
      ...sanitizeResourceAttributes(resourceAttributes, metric),
      ...serviceResourceAttributes(options.service),
    },
    attributes,
  };
}

function beaconBody(payload: LiteBeaconPayload): string {
  if (payload.t === "err") {
    return payload.st ? `${payload.n}: ${payload.m}\n${payload.st}` : `${payload.n}: ${payload.m}`;
  }
  return `${payload.n}=${payload.val}`;
}

/** §9's lite beacon → normalised OTLP log record, through its own converter next to
 *  `faroItemToRecord`, with the same clamp and resource-attribute shape. `hot.tier` is
 *  always `"static"`: the lite beacon only ever fires from `/d` and `/embed`,
 *  never a live editing session. */
export function beaconToRecord(payload: LiteBeaconPayload, options: ConvertOptions): NormalisedRecord {
  const attributes: Record<string, string> = {
    [ATTR_HOT_DEMO_ID]: payload.demo,
    [ATTR_HOT_KIND]: payload.t === "err" ? "exception" : "measurement",
  };

  // `s`/`ht` are already closed-set-checked by `isValidLitePayload`; `fw` is
  // client-supplied free text, so it (and the whole bag, defensively) go
  // through the same record-level check `faroItemToRecord` uses.
  const rawResourceAttributes: Record<string, string> = {
    [ATTR_HOT_SURFACE]: payload.s,
    [ATTR_HOT_TIER]: "static",
    [ATTR_HOT_FRAMEWORK]: payload.fw,
    [ATTR_HOT_HT_MAJOR]: payload.ht,
  };

  return {
    body: beaconBody(payload),
    timeUnixNano: msToUnixNano(clampTimestampMs(payload.ts, options.receivedAtMs)),
    resourceAttributes: {
      ...sanitizeResourceAttributes(rawResourceAttributes),
      ...serviceResourceAttributes(options.service),
    },
    attributes,
  };
}
