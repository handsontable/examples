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
  LOKI_REQUEST_MAX_BYTES,
  parseInboxKey,
  type OtlpResourceLogs,
  type Tenant,
} from "@handsontable/demo-runtime/telemetry";
import { sha256Hex } from "../gates/util.js";

// ---- F1: drop records older than Loki's own reject window -----------------
//
// `reject_old_samples_max_age: 7d` (containers/o11y/loki/loki-config*.yaml)
// 400s the WHOLE push if even one record in it is older than 7 days — and
// `drainKey` (below) maps any 400 to the whole key `rejected`, which is
// correct for a genuinely malformed push but wrong here: a backlog that
// went stale (e.g. `drainsPaused` for over a week) can carry a handful of
// too-old records mixed with otherwise-good ones, and the 400 would lose
// the good records too, permanently (a `rejected` key is never retried).
// Dropping the too-old records BEFORE the push — never silently, always
// counted — keeps the good records flowing and turns the loss the ADR
// already accepts (§G) into a measured number instead of an opaque
// `rejected` key.
const LOKI_REJECT_OLD_SAMPLES_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Filter stricter than Loki's own cutoff by this much, so a record that
 *  passes our filter at drain time does not go on to age past Loki's own
 *  cutoff by the time the push actually reaches it (retries, batching, a
 *  slow wake) and 400 the batch anyway. */
const DRAIN_OLD_AGE_MARGIN_MS = 15 * 60 * 1000;
const MAX_RECORD_AGE_MS = LOKI_REJECT_OLD_SAMPLES_MAX_AGE_MS - DRAIN_OLD_AGE_MARGIN_MS;

/** `timeUnixNano` is OTLP's own "unset" convention for "no client timestamp"
 *  (§8/contract: Loki then falls back to its own observed-at time) — `"0"`,
 *  empty, or absent must never be read as a real 1970 timestamp and dropped
 *  as ancient. Only a genuinely parseable, positive, too-old value counts. */
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
 *  silent (task F1: "that loss must be counted, never silent"). */
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
  /** `null` when the object does not exist (defensive — never expected in
   *  normal operation, since drain never deletes inbox objects; only
   *  `InboxWriter`'s pack step deletes the *pending rows* that produced
   *  them). */
  fetchObject(key: string): Promise<Uint8Array | null>;
  /** One push of ≤ {@link LOKI_REQUEST_MAX_BYTES} decompressed: a gzipped
   *  OTLP/HTTP JSON `ExportLogsServiceRequest` (see {@link encodeLokiPush}),
   *  `X-Scope-OrgID: <tenant>`. */
  pushToLoki(tenant: Tenant, gzippedBody: Uint8Array): Promise<LokiPushResult>;
  /** ADR §C.3 — exception records only; a no-op passthrough for everything
   *  else (`symbolicate.ts#symbolicateResourceLogs` already does this). */
  symbolicate(records: readonly OtlpResourceLogs[]): Promise<OtlpResourceLogs[]>;
  /** Injectable clock for {@link dropOldRecords} (F1) — defaults to
   *  `Date.now` when omitted, so every existing caller/test is unaffected
   *  unless it deliberately wants a fixed "now". */
  now?(): number;
}

export interface KeyOutcome {
  key: string;
  tenant: Tenant;
  outcome: "provisional" | "rejected" | "error";
  /** Set on `rejected` (why), and — row 19 fix — also on `provisional` when
   *  at least one chunk 2xx'd but another permanently 400'd: the caller
   *  (`box.ts#drainStep`) should still surface this via
   *  `InboxWriterApi#recordPartialReject` even though the key itself is
   *  durable. `undefined` on a fully clean `provisional`. */
  reason?: string;
  bytesPushed: number;
  /** F1: records dropped by {@link dropOldRecords} before this key's push —
   *  0 when nothing was too old. Never folds into `rejected`/`error`: a
   *  key with only-too-old records still ends `provisional` here (nothing
   *  left to push is not a failure, matching the existing all-duplicates
   *  case) — this `outcome` field itself is unchanged by minor triage item
   *  3. What changed is downstream, in `box.ts#drainStep`: a `provisional`
   *  outcome with `bytesPushed === 0` (this all-dropped/all-duplicate case)
   *  is now routed to `InboxWriterApi#commitKeys` instead of
   *  `#markKeysProvisional`, committing it directly rather than entering
   *  `provisional:<wakeId>` — see `ledger.ts#commitKeys`'s own doc comment
   *  for why (the endless re-wake loop a zero-byte key stuck waiting on a
   *  marker that will never exist used to cause). */
  droppedOld: number;
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

/** The body Loki's `/otlp/v1/logs` actually decodes: ONE OTLP/HTTP JSON
 *  `ExportLogsServiceRequest`. The inbox stores NDJSON (one bare
 *  ResourceLogs per line), and pushing that as-is is the T03-D2 bug: Loki
 *  3.3.2 answers `204` to it and ingests nothing — no stream, no chunk, no
 *  TSDB table, so nothing is uploaded on SIGTERM and shutdown.sh (correctly)
 *  never writes the clean marker. */
function encodeLokiPush(records: readonly OtlpResourceLogs[]): string {
  return JSON.stringify({ resourceLogs: records });
}

/** `{"resourceLogs":[` + `]}` — the envelope bytes {@link encodeLokiPush}
 *  adds around the comma-joined records. */
const PUSH_ENVELOPE_BYTES = encodeLokiPush([]).length;

/** Chunks `records` into pushes of at most {@link LOKI_REQUEST_MAX_BYTES}
 *  decompressed bytes — the same row-chunking rule `inbox/pack.ts#appendRows`
 *  uses for its own 1 MB row cap, applied here to the drain's own 1 MB
 *  per-request cap (ADR §B.3: "requests of at most 1 MB decompressed"),
 *  counting the {@link encodeLokiPush} envelope and the separating commas. */
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
 *  in the same wake, e.g. a retried step re-fetching the same key, OR every
 *  record was too old / already deduped, `bytesPushed` staying 0 either
 *  way): still provisional, nothing left to push is not a failure. Minor
 *  triage item 3: `box.ts#drainStep` treats the `bytesPushed === 0` case of
 *  THIS `provisional` outcome specially (commits it directly rather than
 *  marking it `provisional:<wakeId>`) — see {@link KeyOutcome.droppedOld}'s
 *  own doc comment. Nothing about that reclassification changes what this
 *  function itself returns. */
export async function drainKey(key: string, seenHashes: Set<string>, deps: DrainDeps): Promise<KeyOutcome> {
  const parsed = parseInboxKey(key);
  if (!parsed) return { key, tenant: "worker", outcome: "rejected", reason: "unparseable_key", bytesPushed: 0, droppedOld: 0 };
  const { tenant } = parsed;

  const raw = await deps.fetchObject(key);
  if (!raw) return { key, tenant, outcome: "rejected", reason: "object_missing", bytesPushed: 0, droppedOld: 0 };

  let records: OtlpResourceLogs[];
  try {
    records = decodeNdjson(await gunzip(raw));
  } catch {
    return { key, tenant, outcome: "rejected", reason: "undecodable_object", bytesPushed: 0, droppedOld: 0 };
  }

  // F1: drop records older than Loki's own `reject_old_samples_max_age`
  // BEFORE symbolication/push — a stale record must never turn an
  // otherwise-good key into a whole-key `rejected` 400 (see this file's
  // header comment on `dropOldRecords`).
  const { kept, droppedOld } = dropOldRecords(records, (deps.now ?? Date.now)());
  records = kept;

  // Z-B-C1 defense in depth: `symbolicate.ts#symbolicateResourceLogs` is
  // now written to never throw (it isolates a per-frame and a per-record
  // failure internally), but this is the THIRD, independent layer — a
  // throw here must isolate only THIS key, not the whole batch. Before
  // this fix, an uncaught throw here escaped `drainKey`, then `drainBatch`
  // (whose loop only guards against an `"error"` *outcome*, never an
  // exception), then `box.ts#drainStep`'s own catch, which recorded the
  // whole wake as `outcome: "error"` and left every key in this batch
  // `written` — including the one that poisoned it, so the NEXT wake
  // fetched the identical batch (`nextWrittenKeys`'s deterministic
  // ascending order) and threw again, forever. A non-transient failure
  // here (a decode/parse throw, not a Loki/R2 outage — those never throw;
  // they return a `LokiPushResult`/`null` the rest of this function already
  // handles) means this ONE key's symbolication is unrecoverable, so it is
  // classified exactly like `undecodable_object` above: `rejected`, with
  // the same `InboxWriterApi#rejectKey` metric/alert path
  // (`box.ts#drainStep`) — never retried automatically, but no longer able
  // to block every key after it. `drainBatch`'s loop only stops on an
  // `"error"` outcome, so the next key in this batch (and every later one)
  // still drains in the same call.
  try {
    records = await deps.symbolicate(records);
  } catch (err) {
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

  // F2 fix (final review, B cross-note "a drain 400 skips the key's
  // remaining chunks, and Loki accepts part of a 400 — don't lose valid
  // records"): a 400 is a PERMANENT rejection of that one chunk (a 400 is
  // never retried, above), but it says nothing about the chunks after it —
  // the previous version `return`ed immediately on the first 400, so any
  // later chunk of the SAME key (a >1 MB object splits into several) was
  // never even attempted, silently dropping records that would otherwise
  // have pushed cleanly. Every chunk is now always attempted; a 400 is
  // remembered (the first one, for `reason`) but does not stop the loop. A
  // genuine outage (429/5xx exhausted) still stops immediately and reports
  // `error` — unlike a 400, an outage is evidence the REST of this key's
  // chunks would fail too, and `error` already tells `drainBatch` to leave
  // the rest of the WHOLE BATCH `written` for a later wake, which is the
  // correct behaviour for a transient failure (a 400 is not transient).
  //
  // Chosen semantics for the "some chunks 2xx, one chunk 400" case — G1 fix
  // round, rereview.md row 19, replacing F2's original choice (a key with
  // any 400 ended `rejected` outright): F2's comment here claimed the
  // already-pushed chunks "ARE durably in Loki … regardless," but `rejected`
  // NEVER becomes `provisional`, so those chunks never pass the §B.3
  // marker/commit check any wake's clean-stop confirms durability through —
  // an unclean stop right after this push, before Loki's own local WAL/TSDB
  // flush, could lose them with no automatic replay (a `rejected` key is
  // never retried by a later wake, only by a manual reopen). That was the
  // actual gap: not the claim itself, but that NOTHING was verifying it.
  //
  // Fixed by tracking whether ANY chunk landed 2xx (`acceptedAnyChunk`,
  // via `bytesPushed`): if so, the key still ends `provisional` — its
  // accepted content follows the exact same §B.3 durability path as a
  // fully-clean key (an unclean stop reverts it to `written` for automatic
  // replay; a clean stop's marker confirms it and moves it to `done:`).
  // Only a key with ZERO accepted chunks (every chunk 400'd) still ends
  // `rejected` — there is nothing to protect, so the existing "never
  // auto-retried, `POST /grafana/_o11y/reopen` is the manual escape hatch"
  // behaviour is unchanged for that case.
  //
  // This does NOT invent per-chunk ledger state (`key:` stays one state per
  // key, as F2's original comment already argued) and does NOT change what
  // gets pushed: a replay (automatic, after an unclean stop, OR a manual
  // reopen of an already-`done:` key) re-attempts every chunk of this key
  // again, deterministically re-deriving the SAME classification — the
  // permanently-bad chunk 400s again (harmless: `pushChunkWithRetry` never
  // retries a 400, so this costs one request, not a loop) while the good
  // chunk(s) are safely, redundantly re-confirmed (Loki's own partial-
  // accept behaviour plus query-time dedup already make a duplicate push
  // harmless, per ADR §B.3's "what an unclean stop costs"). `reason` still
  // carries the 400 detail on the `provisional` outcome so the caller
  // (`box.ts#drainStep`) can log/alert on the permanent loss even though
  // the key itself is not `rejected` — see `InboxWriterApi#recordPartialReject`.
  let bytesPushed = 0;
  let rejectedReason: string | undefined;
  for (const chunk of chunkBySize(fresh)) {
    const { result, bytesPushed: chunkBytes } = await pushChunkWithRetry(tenant, chunk, deps);
    bytesPushed += chunkBytes;
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
