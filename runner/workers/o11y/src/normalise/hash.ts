// ADR §B.2 step 2: "Hash each record (SHA-256) at this point, before any
// arrival-time value exists, so a redelivered body hashes identically."
//
// T02-D — what exactly gets hashed (see the task Outcome): a `NormalisedRecord`
// (`@handsontable/demo-runtime/telemetry`) already carries its *final*,
// clamped `timeUnixNano` — hashing that would break exit criterion 4 for the
// zero-timestamp case, since `InboxWriter.arrivalMs` differs "seconds apart"
// between the two deliveries and the clamp falls back to it. What must be
// identical across a redelivery is the **content**: `body`,
// `resourceAttributes`, `attributes`, and the record's own *raw*, un-clamped
// source timestamp (Faro's `payload.timestamp` string, or OTLP's raw
// `time_unix_nano`/`observed_time_unix_nano` before the received_at
// fallback) — genuinely part of the original body, unlike the arrival time,
// so it stays in the hash to keep two real events with identical text but
// different real timestamps distinct.

import { sha256Hex } from "../gates/util.js";

export interface PreHashRecord {
  body: string;
  resourceAttributes: Record<string, string>;
  attributes?: Record<string, string>;
  /** The record's own raw source timestamp, exactly as received (before any
   *  clamp/fallback) — `""` when the source carried none at all, which is
   *  itself a stable, redelivery-identical value. */
  rawEventTime: string;
  /** QA follow-up ("Faro dedupe hash inputs"): additional content that
   *  distinguishes two otherwise-identical records but is not itself part of
   *  `body`/`attributes` — e.g. `normalise/faro.ts` uses this for the raw
   *  Faro `payload.type` (a measurement's own metric name, which
   *  `faroBody()`'s measurement case never puts in `body`, only `values`),
   *  the AE-only `hot.*` attributes (`browser-attrs.ts#readAeOnlyAttrs` —
   *  never part of a stored record's `attributes`, since they are not on
   *  `attrs.ts#ALLOWED_ATTRIBUTE_KEYS`), and the Faro session id
   *  (`meta.session.id`, a batch-level field `faroItemToRecord` never reads
   *  at all). Left `undefined` (not merely an empty object — see
   *  {@link hashRecord}'s own doc comment) by every OTHER caller of
   *  `hashRecord`, so their hash output is unchanged — W1's timestamp work
   *  and F5's in-batch dedupe both depend on hashing staying stable for an
   *  identical redelivery. */
  extra?: Record<string, string>;
}

/** Deterministic JSON: object keys sorted recursively, so two structurally
 *  equal objects with differently-ordered keys hash identically (the two
 *  attribute bags are built from `Object.entries`/`for..of` over payloads
 *  whose own key order is not guaranteed to match across a redelivery). */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 hex over the stable-stringified {@link PreHashRecord}. */
export async function hashRecord(record: PreHashRecord): Promise<string> {
  return sha256Hex(stableStringify(record));
}
