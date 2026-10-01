// The drain (ADR §B.3/§A): pushes one wake's `written` inbox objects to
// Loki, in key order, ≤ 1 MB decompressed per request, with a per-record
// hash set preventing any record being pushed twice. Pure over injected
// dependencies (`DrainDeps`) — unit-testable under `node --test`. `box.ts`
// wires the real dependencies.

import {
  decodeNdjson,
  LOKI_REQUEST_MAX_BYTES,
  parseInboxKey,
  type OtlpResourceLogs,
  type Tenant,
} from "@handsontable/demo-runtime/telemetry";
import { sha256Hex } from "../gates/util.js";
import { TransientSymbolicateError } from "./symbolicate.js";

// ---- Drop records older than Loki's own reject window ----------------------
// `reject_old_samples_max_age: 7d` 400s the WHOLE push if even one record
// is older than 7 days, and any 400 maps to a whole-key `rejected` — a
// stale backlog would otherwise lose good records permanently. Dropping
// too-old records BEFORE the push turns that into a measured, counted loss.
const LOKI_REJECT_OLD_SAMPLES_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Filter stricter than Loki's own cutoff, so a record that passes here at
 *  drain time doesn't age past Loki's own cutoff by the time the push
 *  reaches it (retries, batching, a slow wake). */
const DRAIN_OLD_AGE_MARGIN_MS = 15 * 60 * 1000;
const MAX_RECORD_AGE_MS = LOKI_REJECT_OLD_SAMPLES_MAX_AGE_MS - DRAIN_OLD_AGE_MARGIN_MS;

/** OTLP's "unset" timestamp convention (`"0"`, empty, absent) must never
 *  be read as a real 1970 timestamp and dropped as ancient — only a
 *  genuinely parseable, positive, too-old value counts. */
function isTooOld(timeUnixNano: string | undefined, nowMs: number): boolean {
  if (!timeUnixNano) return false;
  let ns: bigint;
  try {
    ns = BigInt(timeUnixNano);
  } catch {
    return false; // unparseable — not this filter's job to reject it
  }
  if (ns <= 0n) return false;
  const ms = Number(ns / 1_000_000n);
  return nowMs - ms > MAX_RECORD_AGE_MS;
}

/** Drops individual `logRecords` entries older than {@link MAX_RECORD_AGE_MS},
 *  pruning any `scopeLogs`/`resourceLogs` container left empty — never the
 *  whole record for one old line among several (defensive: this codebase's
 *  own inbox always packs one record per `ResourceLogs`, §8, but the OTLP
 *  shape itself allows more). Counted via the returned `droppedOld`, never
 *  silent. */
export function dropOldRecords(
  records: readonly OtlpResourceLogs[],
  nowMs: number,
): { kept: OtlpResourceLogs[]; droppedOld: number } {
  let droppedOld = 0;
  const kept: OtlpResourceLogs[] = [];
  for (const r of records) {
    const scopeLogs = [];
    for (const scope of r.scopeLogs) {
      const logRecords = scope.logRecords.filter((lr) => {
        if (isTooOld(lr.timeUnixNano, nowMs)) {
          droppedOld++;
          return false;
        }
        return true;
      });
      if (logRecords.length > 0) scopeLogs.push({ ...scope, logRecords });
    }
    if (scopeLogs.length > 0) kept.push({ ...r, scopeLogs });
  }
  return { kept, droppedOld };
}

export interface LokiPushResult {
  status: number;
  message?: string;
}

export interface DrainDeps {
  /** `null` when the object does not exist (defensive — drain never
   *  deletes inbox objects; only the pack step deletes the pending rows
   *  that produced them). */
  fetchObject(key: string): Promise<Uint8Array | null>;
  /** One push of ≤ {@link LOKI_REQUEST_MAX_BYTES} decompressed: a gzipped
   *  OTLP/HTTP JSON `ExportLogsServiceRequest` (see {@link encodeLokiPush}),
   *  `X-Scope-OrgID: <tenant>`. */
  pushToLoki(tenant: Tenant, gzippedBody: Uint8Array): Promise<LokiPushResult>;
  /** ADR §C.3 — exception records only; a no-op passthrough for everything
   *  else (`symbolicate.ts#symbolicateResourceLogs` already does this). */
  symbolicate(records: readonly OtlpResourceLogs[], opts: { deferTransient: boolean }): Promise<OtlpResourceLogs[]>;
  /** Injectable clock for {@link dropOldRecords} — defaults to `Date.now`
   *  when omitted, so every existing caller/test is unaffected unless it
   *  deliberately wants a fixed "now". */
  now?(): number;
}

export interface KeyOutcome {
  key: string;
  tenant: Tenant;
  /** `deferred`: left `written` for a later wake, see {@link KeyOutcome.deferral};
   *  unlike `error`, the batch continues. */
  outcome: "provisional" | "rejected" | "error" | "deferred";
  /** Set on `deferred` only: the inbox read threw, a source-map read still
   *  failed after its retries, this key hit Loki's stream limit, or its tenant
   *  already had (so it was not fetched). */
  deferral?: "fetch_error" | "map_fetch_error" | "stream_limit" | "tenant_limited";
  /** Set on `rejected` (why), on `deferred`, and also on `provisional` when
   *  one chunk 2xx'd but another 400'd — the caller should still surface
   *  that via `recordPartialReject`. `undefined` on a fully clean `provisional`. */
  reason?: string;
  bytesPushed: number;
  /** Records dropped by {@link dropOldRecords} before this key's push.
   *  Never folds into `rejected`/`error` — a key with only-too-old records
   *  still ends `provisional`, and `box.ts#drainStep` commits it directly. */
  droppedOld: number;
}

export interface DrainBatchResult {
  outcomes: KeyOutcome[];
  /** `true` when a rate-limit `429`/`5xx` exhausted its retries — the batch stops
   *  immediately, leaving the rest `written` for a later wake rather than
   *  hammering a server that's currently failing every request. */
  stoppedEarly: boolean;
}

/** Loki's per-tenant active-stream limit: the ingester keeps its streams until
 *  it stops, so this 429 lasts the rest of the wake, and a retry can answer 204
 *  with the excess streams dropped. Never retried; the key waits for a new wake. */
const STREAM_LIMIT_RE = /stream limit/i;

function isStreamLimit(result: LokiPushResult): boolean {
  return result.status === 429 && STREAM_LIMIT_RE.test(result.message ?? "");
}

/** How long after its inbox hour a key may keep deferring on a failed map read:
 *  the ledger has no per-key attempt count, and an old `written` key already
 *  wakes the box every cron tick, so past this it pushes with its frames as they are. */
export const MAP_RETRY_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** Age of the inbox hour `parsed` names, from the key alone. */
function inboxKeyAgeMs(parsed: { date: string; hour: string }, nowMs: number): number {
  return nowMs - Date.parse(`${parsed.date}T${parsed.hour}:00:00Z`);
}

const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [250, 750, 2000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

/** The body Loki's `/otlp/v1/logs` actually decodes: ONE OTLP/HTTP JSON
 *  `ExportLogsServiceRequest` — pushing the inbox's own bare NDJSON as-is
 *  makes Loki 3.3.2 answer `204` and ingest nothing. */
function encodeLokiPush(records: readonly OtlpResourceLogs[]): string {
  return JSON.stringify({ resourceLogs: records });
}

/** `{"resourceLogs":[` + `]}` — the envelope bytes {@link encodeLokiPush}
 *  adds around the comma-joined records. */
const PUSH_ENVELOPE_BYTES = encodeLokiPush([]).length;

/** Chunks `records` into pushes of at most {@link LOKI_REQUEST_MAX_BYTES}
 *  decompressed bytes (ADR §B.3: "requests of at most 1 MB decompressed"),
 *  counting the envelope and separating commas. */
function chunkBySize(records: readonly OtlpResourceLogs[]): OtlpResourceLogs[][] {
  const chunks: OtlpResourceLogs[][] = [];
  let current: OtlpResourceLogs[] = [];
  let currentBytes = PUSH_ENVELOPE_BYTES;
  for (const record of records) {
    const size = new TextEncoder().encode(JSON.stringify(record)).length + (current.length > 0 ? 1 : 0);
    if (currentBytes + size > LOKI_REQUEST_MAX_BYTES && current.length > 0) {
      chunks.push(current);
      current = [];
      currentBytes = PUSH_ENVELOPE_BYTES;
    }
    current.push(record);
    currentBytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

async function pushChunkWithRetry(
  tenant: Tenant,
  chunk: readonly OtlpResourceLogs[],
  deps: DrainDeps,
): Promise<{ result: LokiPushResult; bytesPushed: number }> {
  const gz = await gzip(encodeLokiPush(chunk));
  let result: LokiPushResult = { status: 0 };
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    result = await deps.pushToLoki(tenant, gz);
    if (result.status >= 200 && result.status < 300) return { result, bytesPushed: gz.byteLength };
    if (result.status === 400 || isStreamLimit(result)) return { result, bytesPushed: 0 }; // never retried
    const delay = RETRY_DELAYS_MS[attempt];
    if (attempt < MAX_RETRIES && delay !== undefined) await sleep(delay);
  }
  return { result, bytesPushed: 0 }; // rate-limit 429/5xx, retries exhausted
}

/** Drains one key: fetch, decode, symbolicate exceptions, dedupe against
 *  `seenHashes` (shared across the wake, ADR §B.3), push in ≤ 1 MB chunks.
 *  Eligible for `provisional` only after every chunk returns `2xx`,
 *  including the zero-chunk case (nothing left to push is not a failure).
 *  `box.ts#drainStep` commits a zero-`bytesPushed` `provisional` outcome
 *  directly — see {@link KeyOutcome.droppedOld}. */
export async function drainKey(
  key: string,
  seenHashes: Set<string>,
  deps: DrainDeps,
  streamLimited: Set<Tenant> = new Set(),
): Promise<KeyOutcome> {
  const parsed = parseInboxKey(key);
  if (!parsed) return { key, tenant: "worker", outcome: "rejected", reason: "unparseable_key", bytesPushed: 0, droppedOld: 0 };
  const { tenant } = parsed;
  if (streamLimited.has(tenant)) {
    return { key, tenant, outcome: "deferred", deferral: "tenant_limited", reason: "stream_limit", bytesPushed: 0, droppedOld: 0 };
  }

  let raw: Uint8Array | null;
  try {
    raw = await deps.fetchObject(key);
  } catch (err) {
    const reason = `fetch_error: ${err instanceof Error ? err.message : String(err)}`;
    return { key, tenant, outcome: "deferred", deferral: "fetch_error", reason, bytesPushed: 0, droppedOld: 0 };
  }
  if (!raw) return { key, tenant, outcome: "rejected", reason: "object_missing", bytesPushed: 0, droppedOld: 0 };

  let records: OtlpResourceLogs[];
  try {
    records = decodeNdjson(await gunzip(raw));
  } catch {
    return { key, tenant, outcome: "rejected", reason: "undecodable_object", bytesPushed: 0, droppedOld: 0 };
  }

  // Drop records older than Loki's own reject window BEFORE
  // symbolication/push — a stale record must never turn an otherwise-good
  // key into a whole-key `rejected` 400.
  const { kept, droppedOld } = dropOldRecords(records, (deps.now ?? Date.now)());
  records = kept;

  // `symbolicate.ts` throws only `TransientSymbolicateError` (a failed map
  // read, deferred below), but any other throw must isolate only THIS key, not the
  // whole batch — otherwise a poisoned key would leave the whole batch
  // `written` forever, retried and re-thrown every wake. Gets the same
  // `rejected` shape as `undecodable_object` above.
  try {
    const deferTransient = inboxKeyAgeMs(parsed, (deps.now ?? Date.now)()) < MAP_RETRY_MAX_AGE_MS;
    records = await deps.symbolicate(records, { deferTransient });
  } catch (err) {
    if (err instanceof TransientSymbolicateError) {
      return { key, tenant, outcome: "deferred", deferral: "map_fetch_error", reason: `map_fetch_error: ${err.message}`, bytesPushed: 0, droppedOld };
    }
    return {
      key,
      tenant,
      outcome: "rejected",
      reason: `symbolicate_exception: ${err instanceof Error ? err.message : String(err)}`,
      bytesPushed: 0,
      droppedOld,
    };
  }

  const fresh: OtlpResourceLogs[] = [];
  for (const record of records) {
    const hash = await sha256Hex(JSON.stringify(record));
    if (seenHashes.has(hash)) continue;
    seenHashes.add(hash);
    fresh.push(record);
  }

  // A 400 permanently rejects that one chunk (never retried), but every
  // chunk is still attempted — stopping at the first 400 would silently
  // drop later chunks of a >1 MB object that would have pushed cleanly.
  // A key with at least one 2xx chunk still ends `provisional`: its
  // accepted content follows the normal durability path, and a replay
  // deterministically re-derives the same classification (the bad chunk
  // 400s again, harmless; good chunks are redundantly re-confirmed via
  // Loki's own dedup). Only a key with ZERO accepted chunks ends
  // `rejected`. `reason` carries the 400 detail for `recordPartialReject`.
  let bytesPushed = 0;
  let rejectedReason: string | undefined;
  for (const chunk of chunkBySize(fresh)) {
    const { result, bytesPushed: chunkBytes } = await pushChunkWithRetry(tenant, chunk, deps);
    bytesPushed += chunkBytes;
    if (isStreamLimit(result)) {
      // The table may have been filled by earlier keys, so this key is never
      // blamed: it stays `written` (a replay re-pushes chunks that landed) and
      // the tenant is skipped for the rest of the wake.
      streamLimited.add(tenant);
      const reason = result.message ?? "stream_limit";
      return { key, tenant, outcome: "deferred", deferral: "stream_limit", reason, bytesPushed, droppedOld };
    }
    if (result.status === 400) {
      rejectedReason ??= result.message ?? "loki_400";
      continue; // keep pushing the REST of this key's chunks — don't lose them
    }
    if (result.status < 200 || result.status >= 300) {
      // A live outage: stop this key's remaining chunks AND the batch.
      return { key, tenant, outcome: "error", reason: result.message ?? `loki_${result.status}`, bytesPushed, droppedOld };
    }
  }

  if (rejectedReason !== undefined) {
    const acceptedAnyChunk = bytesPushed > 0;
    return {
      key,
      tenant,
      outcome: acceptedAnyChunk ? "provisional" : "rejected",
      reason: rejectedReason,
      bytesPushed,
      droppedOld,
    };
  }
  return { key, tenant, outcome: "provisional", bytesPushed, droppedOld };
}

/** Drains `keys` in order, stopping immediately on the first `error`
 *  outcome (leaves it and everything after it `written`, per
 *  {@link DrainBatchResult.stoppedEarly}'s own doc comment). A `deferred`
 *  key does not stop the batch. `streamLimited` holds the tenants that hit
 *  Loki's stream limit earlier in this wake (their keys are not fetched), and
 *  gains any that hit it now. */
export async function drainBatch(
  keys: readonly string[],
  seenHashes: Set<string>,
  deps: DrainDeps,
  streamLimited: Set<Tenant> = new Set(),
): Promise<DrainBatchResult> {
  const outcomes: KeyOutcome[] = [];
  for (const key of keys) {
    const outcome = await drainKey(key, seenHashes, deps, streamLimited);
    outcomes.push(outcome);
    if (outcome.outcome === "error") return { outcomes, stoppedEarly: true };
  }
  return { outcomes, stoppedEarly: false };
}
