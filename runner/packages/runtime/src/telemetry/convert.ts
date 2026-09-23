// Observability contract §6, §9 — Faro item → OTLP log record, and lite-beacon
// → OTLP log record. One converter, shared by T02 (Faro `/telemetry/collect`,
// beacon `/telemetry/lite`) and T08 (the beacon sender's own reference for what
// ingest will do with a payload). Runs on an **already-scrubbed** item (T00-D6:
// `scrubTelemetry` first, then convert — scrubbing the richer Faro/beacon shape
// catches fields this module never looks at, such as stack-frame filenames).

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
const STRUCTURED_KEY_SET = new Set<string>(STRUCTURED_METADATA_KEYS);

/**
 * Split a merged, already-allowlisted attribute bag (`scrub.ts`'s output on
 * `payload.context`/`payload.attributes`) into OTLP resource attributes
 * (`hot.surface`, `hot.tier`, … — ADR §B.2 "hoist `hot.*` and `service.*` to
 * resource attributes") and structured metadata (`hot.demo_id`, `session.id`,
 * `cf.ray`, `hot.kind` — never a resource attribute, §3).
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

function faroBody(item: ScrubbableFaroItem): string {
  switch (item.type) {
    case "exception": {
      const value = item.payload.value ?? "";
      return item.payload.type ? `${item.payload.type}: ${value}` : value;
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
