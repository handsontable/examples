// ADR §B.2 step 1 (Cloudflare export half): "decode Cloudflare's export
// (protobuf or JSON, whichever spike (b) observes); keep only allowlisted
// attributes; hoist `hot.*` and `service.*` to resource attributes; run the
// server-side scrubber (§E.4)." Plus §C.2's OTLP timestamp rule.
//
// T02-D — no clamping for OTLP (see the task Outcome): `convert.ts`'s
// `clampTimestampMs` is documented there as usable for "T02's
// Cloudflare-OTLP-export path too," but ADR §C.2 only clamps **browser and
// beacon** item timestamps — an OTLP record keeps its real `time_unix_nano`,
// falling back to `observed_time_unix_nano`, then `received_at`, with no
// window check at all (a replayed sandbox-probe fixture days later must
// still pass exit criterion 3). This module never calls `clampTimestampMs`
// for that reason, and keeps every timestamp as the decimal-nanosecond
// string OTLP itself uses — never round-tripped through a `number` of
// milliseconds, which would lose precision past 2^53 nanoseconds (about 104
// days) even before considering the clamp question.

import {
  hoistAttributes,
  INBOX_RECORD_MAX_BYTES,
  msToUnixNano,
  scrubTelemetry,
  type NormalisedRecord,
  type ScrubbableOtlpRecord,
} from "@handsontable/demo-runtime/telemetry";
import type { Env, IngestItem } from "../env.js";
import { hashRecord } from "./hash.js";
import { decodeOtlpProtobuf, type DecodedLogRecord, type DecodedResourceLogs } from "./otlp-protobuf.js";
import { withResourceAttrDefaults } from "./points.js";
import { scrubBodyText } from "./text-scrub.js";

// ---- OTLP JSON decode -----------------------------------------------------

interface OtlpAnyValueJson {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
  bytesValue?: string;
}
interface OtlpKeyValueJson {
  key: string;
  value?: OtlpAnyValueJson;
}
function anyValueJsonToString(v: OtlpAnyValueJson | undefined): string {
  if (!v) return "";
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.boolValue !== undefined) return String(v.boolValue);
  if (v.intValue !== undefined) return String(v.intValue);
  if (v.doubleValue !== undefined) return String(v.doubleValue);
  if (v.bytesValue !== undefined) return v.bytesValue;
  return "";
}
function attrsJsonToRecord(attrs: OtlpKeyValueJson[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of attrs ?? []) out[kv.key] = anyValueJsonToString(kv.value);
  return out;
}

/** Decodes the OTLP JSON `ExportLogsServiceRequest` shape into the same flat
 *  {@link DecodedResourceLogs} list the protobuf decoder produces. Throws on
 *  a body that is not that shape at all (not JSON, or missing
 *  `resourceLogs`) — the caller turns that into a `400`. */
export function decodeOtlpJson(text: string): DecodedResourceLogs[] {
  const parsed = JSON.parse(text) as { resourceLogs?: unknown };
  if (!Array.isArray(parsed.resourceLogs)) throw new Error("otlp json: missing resourceLogs");
  return parsed.resourceLogs.map((rl) => {
    const r = rl as {
      resource?: { attributes?: OtlpKeyValueJson[] };
      scopeLogs?: Array<{ logRecords?: unknown[] }>;
    };
    const resourceAttributes = attrsJsonToRecord(r.resource?.attributes);
    const logRecords: DecodedLogRecord[] = [];
    for (const scope of r.scopeLogs ?? []) {
      for (const lr of scope.logRecords ?? []) {
        const rec = lr as {
          timeUnixNano?: string | number;
          observedTimeUnixNano?: string | number;
          severityText?: string;
          body?: OtlpAnyValueJson;
          attributes?: OtlpKeyValueJson[];
        };
        logRecords.push({
          timeUnixNano: rec.timeUnixNano !== undefined ? String(rec.timeUnixNano) : undefined,
          observedTimeUnixNano: rec.observedTimeUnixNano !== undefined ? String(rec.observedTimeUnixNano) : undefined,
          severityText: rec.severityText,
          body: anyValueJsonToString(rec.body),
          attributes: attrsJsonToRecord(rec.attributes),
        });
      }
    }
    return { resourceAttributes, logRecords };
  });
}

// ---- Shared decode → NormalisedRecord pipeline -----------------------------

/** `"0"`, `""` and `undefined` are all "no real value" for the OTLP
 *  timestamp fallback chain (§C.2) — Cloudflare's export, like any OTLP
 *  exporter, may send an explicit `"0"` rather than omitting the field. */
function isRealTimestamp(v: string | undefined): v is string {
  return v !== undefined && v !== "" && v !== "0";
}

export interface OtlpProcessResult {
  items: IngestItem[];
  /** Records decoded but dropped (over the 256 KB cap) — accounted as
   *  `dropped`/`reason=size` by the caller, not `invalid_item`: these are
   *  well-formed, just too large. */
  droppedOversize: number;
}

async function toIngestItem(
  resourceLogs: DecodedResourceLogs,
  record: DecodedLogRecord,
  env: Env,
  receivedAtMs: number,
): Promise<IngestItem | "oversize"> {
  const merged = { ...resourceLogs.resourceAttributes, ...record.attributes };
  const { resourceAttributes, attributes } = hoistAttributes(merged);

  const scrubbable: ScrubbableOtlpRecord = { body: record.body, attributes, resourceAttributes };
  const scrubbed = scrubTelemetry(scrubbable) as ScrubbableOtlpRecord;

  const finalResourceAttrs = withResourceAttrDefaults(scrubbed.resourceAttributes ?? {}, env);

  const rawEventTime = isRealTimestamp(record.timeUnixNano)
    ? record.timeUnixNano
    : isRealTimestamp(record.observedTimeUnixNano)
      ? record.observedTimeUnixNano
      : undefined;
  const timeUnixNano = rawEventTime ?? msToUnixNano(receivedAtMs);

  const normalised: NormalisedRecord = {
    body: scrubBodyText(scrubbed.body ?? ""),
    timeUnixNano,
    resourceAttributes: finalResourceAttrs,
    attributes: scrubbed.attributes,
    severityText: record.severityText,
  };

  if (new TextEncoder().encode(JSON.stringify(normalised)).length > INBOX_RECORD_MAX_BYTES) return "oversize";

  const hash = await hashRecord({
    body: normalised.body,
    resourceAttributes: normalised.resourceAttributes,
    attributes: normalised.attributes ?? {},
    rawEventTime: rawEventTime ?? "",
  });
  return { hash, record: normalised };
}

/** Decodes and processes an already-size-capped OTLP export body (JSON or
 *  protobuf, by `contentType`) into ready-to-store {@link IngestItem}s. Never
 *  clamps a timestamp (see the file header); always fills the §3 resource
 *  attribute defaults (`withResourceAttrDefaults`). Throws only on a body
 *  that cannot be decoded at all (malformed JSON/protobuf) — the caller
 *  turns that into a `400`, never a `500`. */
export async function processOtlpBody(
  bytes: Uint8Array,
  contentType: string,
  env: Env,
  receivedAtMs: number,
): Promise<OtlpProcessResult> {
  const isProtobuf = contentType.toLowerCase().includes("protobuf");
  const decoded = isProtobuf
    ? decodeOtlpProtobuf(bytes)
    : decodeOtlpJson(new TextDecoder().decode(bytes));

  const items: IngestItem[] = [];
  let droppedOversize = 0;
  for (const resourceLogs of decoded) {
    for (const record of resourceLogs.logRecords) {
      const result = await toIngestItem(resourceLogs, record, env, receivedAtMs);
      if (result === "oversize") droppedOversize++;
      else items.push(result);
    }
  }
  return { items, droppedOversize };
}
