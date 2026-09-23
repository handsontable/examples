// Observability contract §6, §9 — Faro item → OTLP log record, and lite-beacon
// → OTLP log record. One converter, shared by T02 (Faro `/telemetry/collect`,
// beacon `/telemetry/lite`) and T08 (the beacon sender's own reference for what
// ingest will do with a payload).
//
// T00-D6, revised: the scrub/convert order is **not symmetric between the two
// functions**, because `scrubTelemetry` only accepts the Faro item shape or
// the OTLP record shape — a `LiteBeaconPayload` (§9) is neither, and does not
// typecheck as `scrubTelemetry`'s argument at all (confirmed with a probe,
// `TS2345: LiteErrorPayload is not assignable to Scrubbable`).
//
//   - Faro:   `scrubTelemetry(item)` → `faroItemToRecord(scrubbedItem, …)`
//   - Beacon: `beaconToRecord(payload, …)` → `scrubTelemetry(record)`
//
// `faroItemToRecord` trusts every string field it reads because the item
// already went through `scrubTelemetry` (scrubbing the richer Faro shape
// catches fields this module never looks at, such as stack-frame filenames).
// `beaconToRecord` does **not** get that benefit — §9's beacon fields (`m`,
// `st`) are not scrubbed before conversion, so the *caller* must run
// `scrubTelemetry` on `beaconToRecord`'s return value before packing it into
// the inbox, or a code frame / preview host in `m`/`st` reaches storage
// unscrubbed.

import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_HOT_DEMO_ID,
  ATTR_HOT_FRAMEWORK,
  ATTR_HOT_HT_MAJOR,
  ATTR_HOT_KIND,
  ATTR_HOT_SURFACE,
  ATTR_HOT_TIER,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  DIAGNOSTIC_TAG_KEYS,
  HOT_KINDS,
  RESOURCE_ATTRS,
  STRUCTURED_METADATA_KEYS,
  type Environment,
  type ServiceName,
} from "./attrs.js";
import type { NormalisedRecord } from "./inbox.js";
import type { ScrubbableFaroItem } from "./scrub.js";
import type { LiteBeaconPayload } from "./lite.js";

/** ADR §C.2: browser/beacon item timestamps are clamped to the envelope's
 *  `received_at` ± 5 minutes. */
const CLAMP_WINDOW_MS = 5 * 60 * 1000;

/** Clamp a candidate event-time (ms since epoch) to within `CLAMP_WINDOW_MS` of
 *  `receivedAtMs`; an absent or out-of-window candidate falls back to
 *  `receivedAtMs` itself, so no record ever reaches Loki without a timestamp
 *  (ADR §C.2). Exported for T02's Cloudflare-OTLP-export path too — it clamps
 *  `time_unix_nano`, falling back to `observed_time_unix_nano`, then
 *  `received_at`, the same rule restated at nanosecond precision. */
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
// T02-D (merge fix, see T02's task Outcome): `STRUCTURED_KEY_SET` originally
// covered only §3's four closed-set structured-metadata keys. T06 (fix round
// D1) extended `attrs.ts#ALLOWED_ATTRIBUTE_KEYS` — what `scrub.ts`'s
// `allowlistAttributes` keeps — with `DIAGNOSTIC_TAG_KEYS` (`handled`,
// `context`, `sentry_event_id`, and the `versions-fetch` diagnostic tags),
// but never updated this function to match, even though its own doc comment
// below already claimed to work on "an already-allowlisted attribute bag."
// Without this, `handled`/`sentry_event_id`/etc. would survive `scrubTelemetry`
// only to be silently dropped one step later, here — found while merging T02
// with T06 (the controller's own fix-round instruction), not by T06 itself,
// since T06's own scrub-level tests never exercise `hoistAttributes`.
// Diagnostic tags land in `attributes` (never `resourceAttributes` — none of
// them is a resource attribute, and `DIAGNOSTIC_TAG_KEYS` is disjoint from
// `RESOURCE_ATTR_KEYS`), the same bucket structured metadata already uses.
const STRUCTURED_KEY_SET = new Set<string>([...STRUCTURED_METADATA_KEYS, ...DIAGNOSTIC_TAG_KEYS]);

/**
 * Split a merged, already-allowlisted attribute bag (`scrub.ts`'s output on
 * `payload.context`/`payload.attributes`) into OTLP resource attributes
 * (`hot.surface`, `hot.tier`, … — ADR §B.2 "hoist `hot.*` and `service.*` to
 * resource attributes") and structured metadata (`hot.demo_id`, `session.id`,
 * `cf.ray`, `hot.kind`, and the T06 diagnostic tag keys — never a resource
 * attribute, §3).
 */
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

/** T03 addition (ADR §C.3, symbolication at drain): renders one stack frame
 *  in the standard V8 `    at <fn> (<file>:<line>:<col>)` shape —
 *  `workers/o11y/src/drain/symbolicate.ts` parses this exact text back out.
 *  A frame with no `filename` carries nothing a symbolicator could resolve
 *  or a human could read, so it is skipped rather than rendered as a bare
 *  `at <fn>` line (that would be ambiguous with a genuinely-anonymous,
 *  file-less frame, which does not occur in a browser stack). */
export function formatStackFrame(frame: { filename?: string; function?: string; lineno?: number; colno?: number }): string | null {
  if (!frame.filename) return null;
  const fn = frame.function || "<anonymous>";
  const position =
    typeof frame.lineno === "number" && typeof frame.colno === "number"
      ? `:${frame.lineno}:${frame.colno}`
      : "";
  return `    at ${fn} (${frame.filename}${position})`;
}

/** T03 addition: the pre-T03 version of this function read only
 *  `item.payload.type`/`.value`, silently dropping `item.payload.stacktrace`
 *  — a Faro exception record therefore never carried any frame data past
 *  ingest, and ADR §C.3's drain-time symbolicator (T03) would have had
 *  nothing to resolve for any real exception. Stack frames are appended to
 *  the body as plain text (the same place `beaconBody` below already puts a
 *  beacon error's stack, §9) because `NormalisedRecord`/the OTLP log-record
 *  shape (`inbox.ts`) has no structured per-frame field — `body` is the one
 *  place free text lives. `symbolicate.ts` parses this exact format back out
 *  at drain and rewrites resolved lines in place; frames it cannot resolve
 *  (Babel-chunk, third-party, a missing map) are left exactly as rendered
 *  here, so this function's output must already be a faithful, minified
 *  stack, not a placeholder. */
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

/** Faro item → normalised OTLP log record (§6). `item` must already be scrubbed
 *  (T00-D6) — this function trusts every string field it reads.
 *
 * `hot.kind` is always `item.type` (§3: "the Faro item kind: `exception`,
 * `log`, `event`, `measurement`"), set here rather than trusted from the
 * client — it overwrites anything the caller's own context happened to carry
 * under that key, since `hot.kind`'s contract value set is closed and
 * `item.type` is the one value the ingest route itself controls.
 *
 * Throws if `item.type` is not one of `HOT_KINDS` — most notably `"trace"`,
 * which `TransportItemType` allows but this contract does not (no trace is
 * ever exported, ADR §C.4). `POST /telemetry/collect` accepts a client-built
 * payload, so this is reachable from untrusted input, the same T00-D10 catch
 * obligation `toAePoint` already puts on T02's route handler. */
export function faroItemToRecord(item: ScrubbableFaroItem, options: ConvertOptions): NormalisedRecord {
  if (!(HOT_KINDS as readonly string[]).includes(item.type)) {
    throw new Error(`faroItemToRecord: not a valid hot.kind: ${JSON.stringify(item.type)}`);
  }

  const merged = { ...(item.payload.context ?? {}), ...(item.payload.attributes ?? {}) };
  const { resourceAttributes, attributes } = hoistAttributes(merged);
  attributes[ATTR_HOT_KIND] = item.type;

  return {
    body: faroBody(item),
    timeUnixNano: msToUnixNano(clampTimestampMs(faroTimestampMs(item), options.receivedAtMs)),
    resourceAttributes: { ...serviceResourceAttributes(options.service), ...resourceAttributes },
    attributes,
  };
}

function beaconBody(payload: LiteBeaconPayload): string {
  if (payload.t === "err") {
    return payload.st ? `${payload.n}: ${payload.m}\n${payload.st}` : `${payload.n}: ${payload.m}`;
  }
  return `${payload.n}=${payload.val}`;
}

/** §9's lite beacon → normalised OTLP log record, via "the same converter as
 *  Faro items" (§9) — same clamp, same resource-attribute shape. `hot.tier` is
 *  always `"static"`: the lite beacon only ever fires from `/d` and `/embed`,
 *  never a live editing session. */
export function beaconToRecord(payload: LiteBeaconPayload, options: ConvertOptions): NormalisedRecord {
  const attributes: Record<string, string> = {
    [ATTR_HOT_DEMO_ID]: payload.demo,
    [ATTR_HOT_KIND]: payload.t === "err" ? "exception" : "measurement",
  };

  return {
    body: beaconBody(payload),
    timeUnixNano: msToUnixNano(clampTimestampMs(payload.ts, options.receivedAtMs)),
    resourceAttributes: {
      ...serviceResourceAttributes(options.service),
      [ATTR_HOT_SURFACE]: payload.s,
      [ATTR_HOT_TIER]: "static",
      [ATTR_HOT_FRAMEWORK]: payload.fw,
      [ATTR_HOT_HT_MAJOR]: payload.ht,
    },
    attributes,
  };
}
