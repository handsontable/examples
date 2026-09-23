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
  RESOURCE_ATTRS,
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

/** T02-D — real Cloudflare semantic-convention key → this contract's own key
 *  name (see the task Outcome, sandbox probe re-run): captured real
 *  `handsontable-demos-o11y-probe-t02` invocation-log exports carry the ray
 *  id under `cloudflare.ray_id`, not the contract's `cf.ray` — without this
 *  remap, `hoistAttributes` (which only recognises the contract's own key
 *  names) silently drops it, even though `cf.ray` is explicitly named as
 *  structured metadata every record should carry when available (§3). Only
 *  `cloudflare.ray_id` was found to need this in the captured samples;
 *  nothing else Cloudflare's automatic export sends maps onto a contract key
 *  (`url.full`, `user_agent.original`, `geo.*`, `cloudflare.asn` are all
 *  correctly dropped as forbidden, not renamed). Applied before
 *  `hoistAttributes`, so it works whether the source key arrived as a
 *  resource or a record attribute. */
const CLOUDFLARE_KEY_REMAP: Readonly<Record<string, string>> = {
  "cloudflare.ray_id": "cf.ray",
};

function remapCloudflareKeys(attrs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    out[CLOUDFLARE_KEY_REMAP[key] ?? key] = value;
  }
  return out;
}

/** T03B (d): a Worker's own structured `console.log(JSON.stringify({...}))`
 *  line (`workers/api/src/telemetry/lines.ts`'s own shape: `log.kind`,
 *  `cf.ray`, `session.id`, `hot.demo_id`, ...) arrives through Cloudflare's
 *  real OTLP log export as opaque BODY TEXT — confirmed against a real
 *  captured export (this task's sandbox probe, see the Outcome), never
 *  parsed into `attributes`. `attributes` on that record carries only
 *  Cloudflare's own generic wrapper fields (`name: "log"`,
 *  `cloudflare.invocation.sequence.number`), not one of the app's own
 *  fields — without this, `cf.ray`/`session.id`/`hot.demo_id` would never
 *  reach Loki as queryable structured metadata at all, which is exactly
 *  what ADR §E.4's operational-log rule requires for every operational
 *  log line. Parsed here and merged into the SAME attribute bag a true
 *  OTLP attribute would land in — `hoistAttributes`'s existing
 *  allowlist/label/structured-metadata split decides what happens to each
 *  key from there, never a second, parallel allowlist for this shape.
 *  A no-op for anything that is not a JSON object body (a plain
 *  `console.log` string, the auto-generated Cloudflare invocation-log
 *  line, ...) — those keep their pre-existing behaviour, unparsed body
 *  text, unchanged.
 *
 *  Fix round I2: a body-JSON key must never be able to SPOOF a real
 *  resource attribute (`service.name`, `deployment.environment.name`,
 *  `hot.*`, ...) — those are Loki labels/AE index slots, promoted from
 *  the RESOURCE, never from a log record's own content; letting body text
 *  set them would let anything that can reach `/telemetry/v1/logs` (a
 *  Worker's own `console.log`, which is app code, not this pipeline's
 *  own trusted resource metadata) forge which service/environment a line
 *  is attributed to. Every `RESOURCE_ATTRS` key is stripped from this
 *  function's own output — belt AND suspenders alongside the merge-order
 *  fix at the call site below (`toIngestItem`), which additionally gives
 *  the body-JSON bag the LOWEST merge priority so even a future
 *  `RESOURCE_ATTRS` addition this function does not yet know to strip
 *  still cannot win over the real resource attribute. */
const RESOURCE_ATTR_KEY_SET = new Set<string>(RESOURCE_ATTRS.map((a) => a.key));

/** Fix round (B cross-note): the ADR's own platform facts say plainly that
 *  "Tier-2 container stdout lands in the API worker's logs" — the same
 *  Cloudflare export this function parses. A Tier-2 SSR starter's authored
 *  code can `console.log(JSON.stringify({...}))` just as easily as this
 *  worker's own trusted `lines.ts` lines do, and before this fix that
 *  authored JSON's keys were merged into `attributes`/`resourceAttributes`
 *  indistinguishably from a real structured line — a breach of contract
 *  §3's "authored code … console output" rule. `lines.ts` stamps every one
 *  of its own lines with a closed-set `"log.kind"` sentinel
 *  (`"api.request"` | `"error"`); a body missing that exact marker is
 *  authored/unknown output and is left as opaque body text, exactly as it
 *  was before `lines.ts`'s structured shape existed. */
const TRUSTED_BODY_JSON_LOG_KINDS: ReadonlySet<string> = new Set(["api.request", "error"]);

function tryParseJsonBodyAttrs(body: string): Record<string, string> {
  if (!body || body.trimStart()[0] !== "{") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const obj = parsed as Record<string, unknown>;
  if (!TRUSTED_BODY_JSON_LOG_KINDS.has(String(obj["log.kind"]))) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (RESOURCE_ATTR_KEY_SET.has(key)) continue; // never let body content spoof a resource attribute
    if (value === null || value === undefined) continue;
    if (typeof value === "string") out[key] = value;
    else if (typeof value === "number" || typeof value === "boolean") out[key] = String(value);
    // Nested objects/arrays inside the JSON body (none in lines.ts's own
    // shape today) are skipped — attributes are flat strings only, same
    // rule a real OTLP attribute already follows.
  }
  return out;
}

/**
 * Controller handoff (finding C-I2, read half — F3-report.md "Not fixed /
 * handed off", same spec restated in ADR §M): F3 wired the API worker's own
 * `error.handled`/diagnostic reports to carry `hot.fingerprint` on their
 * structured line (`workers/api/src/telemetry/diagnostic.ts`,
 * `lines.ts#logErrorLine`'s `"log.kind": "error"` shape). Nothing on the
 * read side fed it into `InboxWriter`'s exact first-seen registry, so a
 * brand-new server-side failure class notified nobody once `SENTRY_SCOPE`
 * flips to `uncaught` — this closes that gap.
 *
 * Every one of these four conditions must hold, exactly as specced:
 * - the REAL resource `service.name` is `demos-api` — read off
 *   `finalResourceAttrs` (the resource attribute after hoisting/defaults),
 *   never a body-JSON key: `RESOURCE_ATTR_KEY_SET` already strips any
 *   body-supplied `service.name` before it could reach here (the same
 *   anti-spoof guarantee every other resource attribute gets).
 * - the parsed body's own `log.kind` is `"error"` (never `"api.request"`,
 *   which never carries a fingerprint at all).
 * - the value matches the contract's own `<context>:<16 hex>` shape.
 * - the record is not Tier-2 container stdout — guaranteed by construction
 *   here, not a separate check: `tryParseJsonBodyAttrs` (the B cross-note
 *   fix, above) already refuses to parse ANY body whose own `log.kind` is
 *   not one of this worker's trusted shapes, so `bodyJsonAttrs` is already
 *   empty for authored/container output before this function ever runs.
 *
 * Deliberately NOT `hot.surface !== "demo-runtime"` (the browser path's own
 * rule, `feedsNewFingerprintAlert`): a worker-tenant record's `hot.surface`
 * defaults to `"none"` when unset, which would admit any record reaching
 * `/telemetry/v1/logs` — forged or not — under that same test.
 */
const API_FINGERPRINT_LOG_KIND = "error";
const API_FINGERPRINT_PATTERN = /^[a-z0-9-]+:[0-9a-f]{16}$/;

function apiFingerprintFeed(
  bodyJsonAttrs: Record<string, string>,
  finalResourceAttrs: Record<string, string>,
): string | undefined {
  const candidate = bodyJsonAttrs["hot.fingerprint"];
  if (finalResourceAttrs["service.name"] !== "demos-api") return undefined;
  if (bodyJsonAttrs["log.kind"] !== API_FINGERPRINT_LOG_KIND) return undefined;
  if (typeof candidate !== "string" || !API_FINGERPRINT_PATTERN.test(candidate)) return undefined;
  return candidate;
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
  // Fix round I2: `bodyJsonAttrs` merges with the LOWEST priority of the
  // three — a real resource attribute or a real OTLP record attribute
  // must always win over anything inferred from body text, never the
  // other way around (RESOURCE_ATTR_KEY_SET above is the second,
  // independent layer of that same guarantee).
  const bodyJsonAttrs = tryParseJsonBodyAttrs(record.body ?? "");
  const merged = remapCloudflareKeys({ ...bodyJsonAttrs, ...resourceLogs.resourceAttributes, ...record.attributes });
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
  const fingerprint = apiFingerprintFeed(bodyJsonAttrs, finalResourceAttrs);
  return { hash, record: normalised, fingerprint };
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
