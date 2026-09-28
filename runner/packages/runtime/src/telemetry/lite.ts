// Observability contract §9 — the lite beacon payload sent by the ES5 reporter's
// standalone mode (ADR §C.5) from `/d` and `/embed`, `navigator.sendBeacon`,
// `application/json`, at most 2 KB.

import {
  HT_MAJORS,
  DEVICE_CLASSES,
  isValidOpenAttrValue,
  type DeviceClass,
  type Framework,
  type HtMajor,
} from "./attrs.js";

export const LITE_SURFACES = ["embed", "d"] as const;
export type LiteSurface = (typeof LITE_SURFACES)[number];

export const LITE_VITAL_NAMES = ["LCP", "INP", "CLS", "TTFB"] as const;
export type LiteVitalName = (typeof LITE_VITAL_NAMES)[number];

/** Matches `MONITOR_MESSAGE_MAX` (`monitor.ts`) — restated here to avoid a
 *  `monitor.ts` import cycle. */
export const LITE_MESSAGE_MAX = 500;
/** Matches `MONITOR_STACK_MAX`. */
export const LITE_STACK_MAX = 2000;

/**
 * Total payload cap (§9: "at most 2 KB"), in bytes of the serialized JSON —
 * "2 KB" means 2048 bytes, not decimal 2000. `LITE_MESSAGE_MAX` (500) +
 * `LITE_STACK_MAX` (2000) already exceed this on their own (per-field
 * ceilings, not a promise both fit together); `isValidLitePayload` enforces
 * this total.
 *
 * Measured (`pipeline/telemetry-lite.test.mjs`): `st` alone at
 * `LITE_STACK_MAX` already runs ~2150 bytes — over budget by itself.
 * Producing a payload that fits is the sender's job: truncate `st` before
 * `m`, and re-validate with `isValidLitePayload` after truncating.
 */
export const LITE_PAYLOAD_MAX_BYTES = 2048;

interface LiteBase {
  v: 1;
  s: LiteSurface;
  demo: string;
  ht: HtMajor;
  fw: Framework;
  dev: DeviceClass;
  /** Epoch ms. Clamped to receive time ± 5 minutes at ingest (§9), same rule as
   *  every other record's timestamp (ADR §C.2). */
  ts: number;
  /** Per-beacon random id: `Math.random().toString(36).slice(2,10)` from
   *  the reporter, 0-8 lowercase base-36 characters — `Math.random()` landing
   *  on exactly `0` yields `""`, which is a valid id, not a missing one. Used
   *  only to keep two byte-identical beacons (same demo/error/millisecond,
   *  e.g. two parallel page loads, or several throws in one synchronous pass)
   *  from being deduped as a single record — see `workers/o11y/src/lite.ts`'s
   *  `hashRecord` call. Absent entirely for a beacon sent by an old, cached
   *  reporter still on a page; that must hash exactly as before this field
   *  existed. */
  id?: string;
}

export interface LiteErrorPayload extends LiteBase {
  t: "err";
  /** Error name/type (e.g. `TypeError`). */
  n: string;
  /** Normalised message, ≤ `LITE_MESSAGE_MAX` chars. */
  m: string;
  /** Stack, ≤ `LITE_STACK_MAX` chars. */
  st?: string;
  val: null;
}

export interface LiteVitalPayload extends LiteBase {
  t: "vital";
  n: LiteVitalName;
  m?: string;
  st?: string;
  val: number;
}

export type LiteBeaconPayload = LiteErrorPayload | LiteVitalPayload;

function isDeviceClass(v: unknown): v is DeviceClass {
  return typeof v === "string" && (DEVICE_CLASSES as readonly string[]).includes(v);
}
function isHtMajor(v: unknown): v is HtMajor {
  return typeof v === "string" && (HT_MAJORS as readonly string[]).includes(v);
}
function isLiteSurface(v: unknown): v is LiteSurface {
  return v === "embed" || v === "d";
}

/**
 * Validates shape, field caps, and — decisively — the total serialized size.
 * Used both by the sender, to decide whether a built payload may be
 * sent at all, and at ingest, on untrusted input: a client-crafted beacon is
 * otherwise indistinguishable from a real one, so every bound here is re-checked
 * server-side, exactly like `sanitizeMonitorPayload` for the demo-runtime relay.
 */
export function isValidLitePayload(data: unknown): data is LiteBeaconPayload {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;

  if (d["v"] !== 1) return false;
  if (!isLiteSurface(d["s"])) return false;
  if (typeof d["demo"] !== "string" || d["demo"].length === 0) return false;
  if (!isHtMajor(d["ht"])) return false;
  // Bounded, not just "non-empty string" — an unbounded `fw` lets a client
  // hoist a multi-kilobyte value into the `hot.framework` Loki label. Same
  // bounded charset every other §3 `hot.*` open-set value uses
  // (`convert.ts#sanitizeResourceAttributes`).
  if (typeof d["fw"] !== "string" || !isValidOpenAttrValue(d["fw"])) return false;
  if (!isDeviceClass(d["dev"])) return false;
  if (typeof d["ts"] !== "number" || !Number.isFinite(d["ts"])) return false;
  if (d["m"] !== undefined && (typeof d["m"] !== "string" || d["m"].length > LITE_MESSAGE_MAX)) return false;
  if (d["st"] !== undefined && (typeof d["st"] !== "string" || d["st"].length > LITE_STACK_MAX)) return false;
  // `id` is absent for an old/cached reporter — accepted, not required.
  // `{0,16}` deliberately allows the empty string: the reporter's
  // `Math.random().toString(36).slice(2,10)` can legitimately produce `""`
  // when `Math.random()` returns exactly 0, and that must not reject the
  // whole beacon.
  if (d["id"] !== undefined && (typeof d["id"] !== "string" || !/^[0-9a-z]{0,16}$/.test(d["id"]))) return false;

  if (d["t"] === "err") {
    if (typeof d["n"] !== "string" || d["n"].length === 0) return false;
    if (typeof d["m"] !== "string") return false;
    if (d["val"] !== null) return false;
  } else if (d["t"] === "vital") {
    if (!(LITE_VITAL_NAMES as readonly string[]).includes(d["n"] as string)) return false;
    if (typeof d["val"] !== "number" || !Number.isFinite(d["val"])) return false;
  } else {
    return false;
  }

  const bytes = new TextEncoder().encode(JSON.stringify(data)).length;
  return bytes <= LITE_PAYLOAD_MAX_BYTES;
}
