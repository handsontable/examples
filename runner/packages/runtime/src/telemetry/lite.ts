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

/** Matches `MONITOR_MESSAGE_MAX` (`monitor.ts`) — the same cap, restated here
 *  because this module must stay free of a `monitor.ts` import cycle risk (the
 *  reporter's standalone mode is the one place both this shape and `monitor.ts`'s
 *  caps are relevant at once; T08 wires them together). */
export const LITE_MESSAGE_MAX = 500;
/** Matches `MONITOR_STACK_MAX`. */
export const LITE_STACK_MAX = 2000;

/**
 * Total payload cap (§9: "at most 2 KB"), in bytes of the serialized JSON body
 * `sendBeacon` transmits — not characters, since UTF-8 can run more than one
 * byte per character (T00-D5: "2 KB" reads as 2048 bytes, the binary meaning,
 * not a decimal 2000).
 *
 * `LITE_MESSAGE_MAX` (500) plus `LITE_STACK_MAX` (2000) already exceeds this on
 * their own — those are *per-field* ceilings from `monitor.ts`'s existing caps,
 * not a promise that a maxed-out message and a maxed-out stack always fit
 * together. This total is the one `isValidLitePayload` actually enforces
 * (T00-D5): a payload can satisfy both field caps and still be rejected here.
 *
 * Measured (`pipeline/telemetry-lite.test.mjs`): even `st` alone at
 * `LITE_STACK_MAX`, with every other field minimal, already runs ~2150 bytes
 * — over budget by itself. `LITE_STACK_MAX` is a defensive upper bound that
 * this cap makes effectively unreachable in practice, not a size T08's sender
 * should aim to fill. Producing a payload that actually fits is the sender's
 * job (T08): truncate `st` well below its own field cap (a few hundred chars
 * is plenty for a first frame) before `m`, since the message is the part an
 * operator reads first, and re-validate with `isValidLitePayload` after
 * truncating rather than trusting the field caps alone.
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
 * Validates shape, field caps, and — decisively — the total serialized size
 * (T00-D5). Used both by the sender, to decide whether a built payload may be
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
  // Fix round (finding A-C1): `fw` was only checked for "non-empty string",
  // with no upper bound — a client could hoist a multi-kilobyte value into
  // the `hot.framework` Loki label. Same bounded charset every other §3
  // `hot.*` open-set value now uses (`convert.ts#sanitizeResourceAttributes`).
  if (typeof d["fw"] !== "string" || !isValidOpenAttrValue(d["fw"])) return false;
  if (!isDeviceClass(d["dev"])) return false;
  if (typeof d["ts"] !== "number" || !Number.isFinite(d["ts"])) return false;
  if (d["m"] !== undefined && (typeof d["m"] !== "string" || d["m"].length > LITE_MESSAGE_MAX)) return false;
  if (d["st"] !== undefined && (typeof d["st"] !== "string" || d["st"].length > LITE_STACK_MAX)) return false;

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
