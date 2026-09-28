// ADR §B.2 step 1 (Cloudflare export half): decode Cloudflare's export
// (protobuf or JSON); keep only allowlisted attributes; hoist `hot.*` and
// `service.*` to resource attributes; run the server-side scrubber (§E.4).
// Plus §C.2's OTLP timestamp rule: ADR §C.2 only clamps **browser and
// beacon** item timestamps, never OTLP — an OTLP record keeps its real
// `time_unix_nano`, falling back to `observed_time_unix_nano`, then
// `received_at` (a replayed sandbox-probe fixture days later must still
// pass exit criterion 3, ADR-0041 §L.3). Every timestamp stays the
// decimal-nanosecond string OTLP itself uses — never round-tripped through
// a `number` of milliseconds, which would lose precision past 2^53
// nanoseconds (about 104 days).

import {
  ATTR_SERVICE_NAME,
  hoistAttributes,
  INBOX_RECORD_MAX_BYTES,
  isValidFingerprint,
  msToUnixNano,
  RESOURCE_ATTRS,
  scrubTelemetry,
  SERVICE_NAMES,
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

/** Real Cloudflare invocation-log exports carry the ray id under
 *  `cloudflare.ray_id`, not the contract's `cf.ray` — without this remap,
 *  `hoistAttributes` (which only recognises the contract's own key names)
 *  silently drops it, even though `cf.ray` is named as structured metadata
 *  every record should carry (§3). Applied before `hoistAttributes`, so it
 *  works whether the source key arrived as a resource or record attribute. */
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

/** Cloudflare's real OTLP export stamps the resource `service.name` with
 *  the deployed Worker's own SCRIPT name (`handsontable-demos-api`), never
 *  the contract's short name (§3's closed `SERVICE_NAMES` set). Left
 *  unmapped, `apiFingerprintFeed` below (which checks
 *  `finalResourceAttrs["service.name"] === "demos-api"` exactly) could
 *  never match a real record. Strips the shared `handsontable-` prefix
 *  before `hoistAttributes`, strictly after the `bodyJsonAttrs` spread, so
 *  a body-JSON key can never win this remap either. */
const CLOUDFLARE_SCRIPT_NAME_PREFIX = "handsontable-";
const CONTRACT_SERVICE_NAMES: ReadonlySet<string> = new Set(SERVICE_NAMES);

function remapCloudflareServiceName(attrs: Record<string, string>): Record<string, string> {
  const raw = attrs[ATTR_SERVICE_NAME];
  if (typeof raw !== "string" || !raw.startsWith(CLOUDFLARE_SCRIPT_NAME_PREFIX)) return attrs;
  const stripped = raw.slice(CLOUDFLARE_SCRIPT_NAME_PREFIX.length);
  if (!CONTRACT_SERVICE_NAMES.has(stripped)) return attrs;
  return { ...attrs, [ATTR_SERVICE_NAME]: stripped };
}

/** A Worker's own structured `console.log(JSON.stringify({...}))` line
 *  (`lines.ts`'s shape) arrives through Cloudflare's OTLP export as opaque
 *  BODY TEXT — without this, those fields never reach Loki as structured
 *  metadata (ADR §E.4). Parsed here and merged into the same attribute bag
 *  a true OTLP attribute lands in. A body-JSON key must never SPOOF a real
 *  resource attribute: every `RESOURCE_ATTRS` key is stripped from this
 *  function's output, and the call site (`toIngestItem`) additionally
 *  gives the body-JSON bag the LOWEST merge priority. */
const RESOURCE_ATTR_KEY_SET = new Set<string>(RESOURCE_ATTRS.map((a) => a.key));

/** ADR §A: "Tier-2 container stdout lands in the API worker's logs" — the
 *  same export this function parses. `lines.ts` stamps every one of its
 *  own lines with a closed-set `"log.kind"` sentinel; a body missing that
 *  exact marker stays opaque body text (contract §3's "authored code …
 *  console output" rule).
 *
 *  Known gap (ADR §M): the sentinel is body text, not cryptographically
 *  bound to `lines.ts` — authored stdout that prints the same shape is
 *  indistinguishable here if it ever reaches this Worker's own
 *  `console.log` (unconfirmed on a real account). Accepted: a forged line
 *  can only mint an `fp:` entry and a notify-only Slack line — never
 *  Sentry, PII or code execution. */
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
 * Feeds the API worker's own `error.handled`/diagnostic reports into
 * `InboxWriter`'s first-seen registry, so a server-side failure class
 * notifies too once `SENTRY_SCOPE` flips to `uncaught`.
 *
 * All four conditions must hold: the REAL resource `service.name` is
 * `demos-api` (never a body-JSON key); `log.kind` is `"error"`; the value
 * matches contract §7's shape via the same validator the browser path
 * uses; and the record is not Tier-2 container stdout, by construction —
 * not fully guaranteed (see the known-gap doc above). Deliberately NOT
 * `hot.surface !== "demo-runtime"`: that defaults to `"none"` for a
 * worker-tenant record, which would admit anything under the same test.
 */
const API_FINGERPRINT_LOG_KIND = "error";

function apiFingerprintFeed(
  bodyJsonAttrs: Record<string, string>,
  finalResourceAttrs: Record<string, string>,
): string | undefined {
  const candidate = bodyJsonAttrs["hot.fingerprint"];
  if (finalResourceAttrs[ATTR_SERVICE_NAME] !== "demos-api") return undefined;
  if (bodyJsonAttrs["log.kind"] !== API_FINGERPRINT_LOG_KIND) return undefined;
  if (typeof candidate !== "string" || !isValidFingerprint(candidate)) return undefined;
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
  // `bodyJsonAttrs` merges with the LOWEST priority of the three — a real
  // resource or OTLP record attribute must always win over anything
  // inferred from body text (RESOURCE_ATTR_KEY_SET above is the second,
  // independent layer of that same guarantee).
  const bodyJsonAttrs = tryParseJsonBodyAttrs(record.body ?? "");
  const merged = remapCloudflareServiceName(
    remapCloudflareKeys({ ...bodyJsonAttrs, ...resourceLogs.resourceAttributes, ...record.attributes }),
  );
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
