// The drain (ADR §B.3/§A "Drain" scope): pushes one wake's `written` inbox
// objects to Loki, in key order, ≤ 1 MB decompressed per request, with a
// per-record hash set preventing any record being pushed twice in one wake.
// Pure over injected dependencies (`DrainDeps`) — no `@cloudflare/containers`
// or R2 import — so the whole batch/retry/rejection state machine is
// unit-testable under `node --test` (`pipeline/o11y-drain.test.mjs`).
// `box.ts` (T03's wake/stop parts) wires the real dependencies: R2 reads,
// `containerFetch` pushes, `symbolicateResourceLogs`.

import {
  decodeNdjson,
  encodeNdjson,
  LOKI_REQUEST_MAX_BYTES,
  parseInboxKey,
  type OtlpResourceLogs,
  type Tenant,
} from "@handsontable/demo-runtime/telemetry";
import { sha256Hex } from "../gates/util.js";

export interface LokiPushResult {
  status: number;
  message?: string;
}

export interface DrainDeps {
  /** `null` when the object does not exist (defensive — never expected in
   *  normal operation, since drain never deletes inbox objects; only
   *  `InboxWriter`'s pack step deletes the *pending rows* that produced
   *  them). */
  fetchObject(key: string): Promise<Uint8Array | null>;
  /** One push of ≤ {@link LOKI_REQUEST_MAX_BYTES} decompressed, gzipped
   *  NDJSON, `X-Scope-OrgID: <tenant>`. */
  pushToLoki(tenant: Tenant, gzippedNdjson: Uint8Array): Promise<LokiPushResult>;
  /** ADR §C.3 — exception records only; a no-op passthrough for everything
   *  else (`symbolicate.ts#symbolicateResourceLogs` already does this). */
  symbolicate(records: readonly OtlpResourceLogs[]): Promise<OtlpResourceLogs[]>;
}

export interface KeyOutcome {
  key: string;
  tenant: Tenant;
  outcome: "provisional" | "rejected" | "error";
  reason?: string;
  bytesPushed: number;
}

export interface DrainBatchResult {
  outcomes: KeyOutcome[];
  /** `true` when a `429`/`5xx` exhausted its retries — the batch stops
   *  immediately (the remaining keys are left `written` for a later wake to
   *  retry against a possibly-recovered Loki, rather than burning the rest
   *  of this wake's CPU budget hammering a server that is currently
   *  failing every request). */
  stoppedEarly: boolean;
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

/** Chunks `records` into pushes of at most {@link LOKI_REQUEST_MAX_BYTES}
 *  decompressed bytes — the same row-chunking rule `inbox/pack.ts#appendRows`
 *  uses for its own 1 MB row cap, applied here to the drain's own 1 MB
 *  per-request cap (ADR §B.3: "requests of at most 1 MB decompressed"). */
function chunkBySize(records: readonly OtlpResourceLogs[]): OtlpResourceLogs[][] {
  const chunks: OtlpResourceLogs[][] = [];
  let current: OtlpResourceLogs[] = [];
  let currentBytes = 0;
  for (const record of records) {
    const size = new TextEncoder().encode(JSON.stringify(record)).length;
    if (currentBytes + size > LOKI_REQUEST_MAX_BYTES && current.length > 0) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
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
  const ndjson = encodeNdjson(chunk);
  const gz = await gzip(ndjson);
  let result: LokiPushResult = { status: 0 };
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    result = await deps.pushToLoki(tenant, gz);
    if (result.status >= 200 && result.status < 300) return { result, bytesPushed: gz.byteLength };
    if (result.status === 400) return { result, bytesPushed: 0 }; // never retried — a malformed/too-old push
    const delay = RETRY_DELAYS_MS[attempt];
    if (attempt < MAX_RETRIES && delay !== undefined) await sleep(delay);
  }
  return { result, bytesPushed: 0 }; // 429/5xx, retries exhausted
}

/** Drains one key: fetch, decode, symbolicate exceptions, dedupe against
 *  `seenHashes` (mutated in place — shared across the whole wake, per ADR
 *  §B.3's "a per-record hash set guarantees no record is pushed twice"),
 *  push in ≤ 1 MB chunks. A key becomes eligible for `provisional` only
 *  after every one of its chunks returns `2xx` — including the
 *  zero-chunk case (every record in this object was already pushed earlier
 *  in the same wake, e.g. a retried step re-fetching the same key): still
 *  provisional, nothing left to push is not a failure. */
export async function drainKey(key: string, seenHashes: Set<string>, deps: DrainDeps): Promise<KeyOutcome> {
  const parsed = parseInboxKey(key);
  if (!parsed) return { key, tenant: "worker", outcome: "rejected", reason: "unparseable_key", bytesPushed: 0 };
  const { tenant } = parsed;

  const raw = await deps.fetchObject(key);
  if (!raw) return { key, tenant, outcome: "rejected", reason: "object_missing", bytesPushed: 0 };

  let records: OtlpResourceLogs[];
  try {
    records = decodeNdjson(await gunzip(raw));
  } catch {
    return { key, tenant, outcome: "rejected", reason: "undecodable_object", bytesPushed: 0 };
  }

  records = await deps.symbolicate(records);

  const fresh: OtlpResourceLogs[] = [];
  for (const record of records) {
    const hash = await sha256Hex(JSON.stringify(record));
    if (seenHashes.has(hash)) continue;
    seenHashes.add(hash);
    fresh.push(record);
  }

  let bytesPushed = 0;
  for (const chunk of chunkBySize(fresh)) {
    const { result, bytesPushed: chunkBytes } = await pushChunkWithRetry(tenant, chunk, deps);
    bytesPushed += chunkBytes;
    if (result.status === 400) {
      return { key, tenant, outcome: "rejected", reason: result.message ?? "loki_400", bytesPushed };
    }
    if (result.status < 200 || result.status >= 300) {
      return { key, tenant, outcome: "error", reason: result.message ?? `loki_${result.status}`, bytesPushed };
    }
  }

  return { key, tenant, outcome: "provisional", bytesPushed };
}

/** Drains `keys` in order, stopping immediately on the first `error`
 *  outcome (leaves it and everything after it `written`, per
 *  {@link DrainBatchResult.stoppedEarly}'s own doc comment). */
export async function drainBatch(keys: readonly string[], seenHashes: Set<string>, deps: DrainDeps): Promise<DrainBatchResult> {
  const outcomes: KeyOutcome[] = [];
  for (const key of keys) {
    const outcome = await drainKey(key, seenHashes, deps);
    outcomes.push(outcome);
    if (outcome.outcome === "error") return { outcomes, stoppedEarly: true };
  }
  return { outcomes, stoppedEarly: false };
}
