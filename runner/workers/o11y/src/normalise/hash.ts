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
