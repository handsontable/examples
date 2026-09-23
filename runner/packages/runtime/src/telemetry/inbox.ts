// Observability contract §8 — the inbox: OTLP `ResourceLogs` builders, NDJSON
// encode/decode, the `inbox/...` object key and the `InboxWriter` storage-key
// shapes. `InboxWriter` itself (T02) is the only writer; this module is just the
// shapes and pure string/JSON functions it and the drain (T03) share.

export type Tenant = "browser" | "worker";

// ---- OTLP `ResourceLogs`, one log record each -----------------------------------
//
// The OTLP JSON representation (protobuf's `google.protobuf.Struct`-free JSON
// mapping), narrowed to exactly what a normalised record needs: one resource, one
// scope, one log record. Structural, no `@opentelemetry/api` import.

export interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
}

export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

export interface OtlpLogRecord {
  /** Nanoseconds since epoch, as a decimal string (OTLP JSON's `fixed64` mapping
   *  — a plain JS number loses precision past 2^53, so this is always built and
   *  read as a string, never `Number`). */
  timeUnixNano: string;
  observedTimeUnixNano?: string;
  severityText?: string;
  body?: OtlpAnyValue;
  attributes?: OtlpKeyValue[];
}

export interface OtlpScopeLogs {
  logRecords: OtlpLogRecord[];
}

export interface OtlpResourceLogs {
  resource: { attributes: OtlpKeyValue[] };
  scopeLogs: OtlpScopeLogs[];
}

function kv(key: string, value: string): OtlpKeyValue {
  return { key, value: { stringValue: value } };
}

/** What `convert.ts` hands to `buildResourceLogs`: already scrubbed, already
 *  attribute-allowlisted, already timestamp-clamped. */
export interface NormalisedRecord {
  body: string;
  /** Nanoseconds since epoch, decimal string (see `OtlpLogRecord.timeUnixNano`). */
  timeUnixNano: string;
  /** Promoted to OTLP resource attributes — `service.*`, `deployment.*`,
   *  `hot.surface`/`tier`/`framework`/`ht_major`/`outcome` (§3). */
  resourceAttributes: Record<string, string>;
  /** Structured metadata only (§3): `hot.demo_id`, `session.id`, `cf.ray`,
   *  `hot.kind`. Never promoted to a resource attribute. */
  attributes?: Record<string, string>;
  severityText?: string;
}

/** Build one OTLP `ResourceLogs` object wrapping exactly one log record — the
 *  shape one NDJSON line holds (§8: "Each NDJSON line is one OTLP `ResourceLogs`
 *  object"). */
export function buildResourceLogs(record: NormalisedRecord): OtlpResourceLogs {
  const logRecord: OtlpLogRecord = {
    timeUnixNano: record.timeUnixNano,
    body: { stringValue: record.body },
  };
  if (record.severityText !== undefined) logRecord.severityText = record.severityText;
  const attrEntries = Object.entries(record.attributes ?? {});
  if (attrEntries.length > 0) logRecord.attributes = attrEntries.map(([k, v]) => kv(k, v));

  return {
    resource: { attributes: Object.entries(record.resourceAttributes).map(([k, v]) => kv(k, v)) },
    scopeLogs: [{ logRecords: [logRecord] }],
  };
}

// ---- NDJSON ----------------------------------------------------------------

/** One `ResourceLogs` JSON object per line, `\n`-terminated (empty input → `""`,
 *  never a bare newline). */
export function encodeNdjson(records: readonly OtlpResourceLogs[]): string {
  if (records.length === 0) return "";
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

/** Inverse of `encodeNdjson`. Blank lines (a trailing newline, or one a
 *  redelivery introduced) are skipped rather than failing the whole object. */
export function decodeNdjson(text: string): OtlpResourceLogs[] {
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as OtlpResourceLogs);
}

// ---- Inbox object key (§8) ------------------------------------------------------

const SEQ_DIGITS = 12;

/** `inbox/<tenant>/<yyyy-mm-dd>/<hh>/<seq:012d>.ndjson.gz`. `date` is read with
 *  UTC getters — the pack alarm runs in a Worker (UTC), and a local-time build
 *  would put the last hour of a UTC day in tomorrow's prefix. */
export function inboxKey(tenant: Tenant, date: Date, seq: number): string {
  const yyyy = date.getUTCFullYear().toString().padStart(4, "0");
  const mm = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = date.getUTCDate().toString().padStart(2, "0");
  const hh = date.getUTCHours().toString().padStart(2, "0");
  const seqStr = seq.toString().padStart(SEQ_DIGITS, "0");
  return `inbox/${tenant}/${yyyy}-${mm}-${dd}/${hh}/${seqStr}.ndjson.gz`;
}

export interface ParsedInboxKey {
  tenant: Tenant;
  /** `yyyy-mm-dd`, UTC. */
  date: string;
  /** `hh`, UTC, zero-padded. */
  hour: string;
  seq: number;
}

const INBOX_KEY_RE =
  /^inbox\/(browser|worker)\/(\d{4}-\d{2}-\d{2})\/(\d{2})\/(\d{12})\.ndjson\.gz$/;

export function parseInboxKey(key: string): ParsedInboxKey | null {
  const m = INBOX_KEY_RE.exec(key);
  if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined || m[4] === undefined) {
    return null;
  }
  return { tenant: m[1] as Tenant, date: m[2], hour: m[3], seq: Number(m[4]) };
}

/** `state/wakes/<wakeId>/clean` (Loki bucket) — written by the box on a clean
 *  stop, read (existence only) by `InboxWriter` to resolve a wake's provisional
 *  keys (ADR §B.3). */
export function cleanMarkerKey(wakeId: string): string {
  return `state/wakes/${wakeId}/clean`;
}

// ---- `InboxWriter` storage keys and value shapes (§8 table) ---------------------

export const SEQ_STORAGE_KEY = "seq";
export const DRAINS_PAUSED_STORAGE_KEY = "drainsPaused";
export const HEARTBEAT_STORAGE_KEY = "heartbeat";

export function pendingRowStorageKey(n: number): string {
  return `row:${n}`;
}
export function inboxKeyStorageKey(key: string): string {
  return `key:${key}`;
}
/** F2 fix (B-C1/A-I1): a `key:<inbox key>` entry that reaches `committed`
 *  moves OUT of the `key:` prefix entirely into `done:<inbox key>` (see
 *  contract §8) — `key:` then holds only `written`/`provisional:*`/
 *  `rejected:*`, the live set every drain/backlog/resolve read cares about,
 *  never the (unbounded, ever-growing) committed history. `done:` entries
 *  are themselves pruned by retention (`ledger.ts#pruneLedger`) and are
 *  only consulted by a manual reopen of an old window. */
export function doneKeyStorageKey(key: string): string {
  return `done:${key}`;
}
export function hashStorageKey(sha256Hex: string): string {
  return `hash:${sha256Hex}`;
}
export function fingerprintStorageKey(fp: string): string {
  return `fp:${fp}`;
}
export function alertStorageKey(rule: string): string {
  return `alert:${rule}`;
}
export function wakeStorageKey(wakeId: string): string {
  return `wake:${wakeId}`;
}

/** `key:<inbox key>` value (§8 ledger, ADR §B.3). */
export type InboxKeyState = "written" | "committed" | `provisional:${string}` | `rejected:${string}`;

/** `wake:<wakeId>` value. `over` is set once a newer wake starts or the
 *  container is observed not running (ADR §B.3); `InboxWriter.recordWake`
 *  (COMMON.md interface 1) is what marks every earlier wake `over: true`. */
export interface WakeState {
  startedAt: number;
  reason: "backlog" | "visit";
  over: boolean;
}

/** `alert:<rule>` value (ADR §F.3 — notify once on fire, once on resolve). */
export interface AlertState {
  state: "firing" | "resolved";
  since: number;
  lastNotified: number;
}

/** `heartbeat` value — read by the API worker's five-minute cron over the `API`
 *  service binding (ADR §F.3 stale-stack alert). */
export interface Heartbeat {
  lastCron: number;
  lastIngest: number;
}

/** Records over this size are dropped at ingest step 1 (ADR §B.2). */
export const INBOX_RECORD_MAX_BYTES = 256 * 1024;
/** A `row:<n>` storage row holds at most this many bytes of pending records. */
export const INBOX_ROW_MAX_BYTES = 1024 * 1024;
/** A drain request to Loki carries at most this many decompressed bytes (§8). */
export const LOKI_REQUEST_MAX_BYTES = 1024 * 1024;
/** The pack alarm interval (ADR §B.2 step 6). */
export const PACK_ALARM_INTERVAL_MS = 60_000;
/** Pack early once this many bytes are stored, without waiting for the alarm. */
export const PACK_AT_BYTES = 4 * 1024 * 1024;
/** The dedupe hash window (ADR §B.2 step 4). */
export const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
