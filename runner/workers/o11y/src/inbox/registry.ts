// ADR §F.3 / contract §7, §8: "The exact first-seen registry for error
// fingerprints (§F.3) is updated at [dedupe] step" — `fp:<fingerprint>` is
// written once, on first sight, and never overwritten; `feedsNewFingerprintAlert`
// (surface = `demo-runtime`) has already filtered which fingerprints even
// reach here (`normalise/faro.ts` only sets `IngestItem.fingerprint` when it
// should feed the alert).
//
// F2 fix (final review, A-I1 "fp: is never deleted"): `newFingerprintWrites`
// is unchanged — the key SHAPE (`fp:<fingerprint>`) stays exactly what
// `alerts/inbox-state.ts#newFingerprintsSince` already reads, so no other
// file needs to change. `pruneFingerprintRegistry` is new: a bounded,
// cursor-paginated TTL sweep (never a full-prefix scan) that deletes entries
// older than `ttlMs`, called from `writer.ts#backlog()` alongside
// `ledger.ts#pruneLedger`/`dedupe.ts#pruneHashBuckets`. A TTL, not an LRU
// (per the finding's own suggested fix: "cap it, e.g. with LRU or a TTL
// longer than the alert lookback") — the alert lookback
// (`alerts/rules.ts`'s new-fingerprint rule) only ever looks back to the
// last notified time, which is far shorter than any reasonable TTL here.

import { fingerprintStorageKey, fingerprintTimeIndexKey, FPTS_TIMESTAMP_DIGITS } from "@handsontable/demo-runtime/telemetry";
import { deleteChunked, getManyChunked, putChunked, type StorageLike } from "./storage.js";

const FP_PREFIX = "fp:";
const FPTS_PREFIX = "fpts:";
/** `fpts:` + the zero-padded ms + the separating `:` — everything after
 *  this offset in an `fpts:` key is the fingerprint verbatim (safe even
 *  when the fingerprint itself contains `:`). */
const FPTS_FP_OFFSET = FPTS_PREFIX.length + FPTS_TIMESTAMP_DIGITS + 1;
/** Default TTL: long enough that "the same fingerprint returns after being
 *  pruned and alerts again" is a rare, acceptable event (a genuinely
 *  recurring bug re-alerting after 90 days of silence is arguably correct
 *  behaviour, not a false positive), while still bounding registry growth
 *  to a fixed multiple of typical daily fingerprint volume rather than
 *  all-time history. */
export const FP_DEFAULT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** Bounds one prune call's cost — see `dedupe.ts#HASH_PRUNE_BATCH_LIMIT`'s
 *  doc comment for the throughput arithmetic (same 10-minute cron cadence,
 *  same ADR §D 10× headroom target). */
const FP_PRUNE_BATCH_LIMIT = 5000;
/** How many rows one prune call inspects (not necessarily deletes) before
 *  giving up for this call — larger than the delete batch limit because most
 *  inspected rows, in steady state, are NOT stale (only a small fraction of
 *  the registry ages out on any given sweep). Bounds the call even when
 *  nothing is stale yet. Raised alongside `FP_PRUNE_BATCH_LIMIT` so the scan
 *  window can actually contain enough stale rows to hit the new delete cap. */
const FP_PRUNE_SCAN_LIMIT = 20000;

/** Returns `fp:<fp>` → `nowMs` (plus its `fpts:<nowMs>:<fp>` time-index
 *  twin, see that key builder's doc comment) for every fingerprint in
 *  `fingerprints` not already present in storage — commit these in the same
 *  transaction as the dedupe/row writes. A fingerprint present more than
 *  once in one batch is written once (the registry only cares about
 *  first-seen, not a count). */
export async function newFingerprintWrites(
  storage: StorageLike,
  fingerprints: readonly string[],
  nowMs: number,
): Promise<Record<string, number>> {
  const unique = [...new Set(fingerprints)];
  if (unique.length === 0) return {};
  // N2: a 200-item Faro batch (A-I4's own cap) can carry up to 200 unique
  // fingerprints — over the real DO storage 128-key limit.
  const existing = await getManyChunked<number>(storage, unique.map(fingerprintStorageKey));
  const writes: Record<string, number> = {};
  for (const fp of unique) {
    const key = fingerprintStorageKey(fp);
    if (!existing.has(key)) {
      writes[key] = nowMs;
      writes[fingerprintTimeIndexKey(nowMs, fp)] = nowMs;
    }
  }
  return writes;
}

/** `fpts:` prefix and per-key parsing, exported for `alerts/inbox-state.ts#newFingerprintsSince`
 *  (its own bounded, time-ordered read of this index — kept here so the
 *  `fpts:` key shape has exactly one owner). */
export { FPTS_PREFIX };
export function fpFromFptsKey(key: string): string {
  return key.slice(FPTS_FP_OFFSET);
}

export interface FingerprintPruneResult {
  fpDeleted: number;
  /** A stored cursor is used to make forward progress across the whole
   *  keyspace over successive calls, rather than always re-inspecting the
   *  same lexicographically-first rows (fingerprints don't embed a date, so
   *  — unlike `hash:`/`done:` — there is no cheap range that names "the old
   *  ones" directly; this cursor is what keeps each call's SCAN bounded
   *  while still eventually covering every row). `null` once a full lap
   *  completed with nothing left after the cursor (the caller may choose to
   *  keep it `null`, restarting the lap next time). */
  nextCursor: string | null;
}

/** Bounded TTL sweep: reads at most `FP_PRUNE_SCAN_LIMIT` rows starting
 *  after `cursor` (wrapping to the beginning once the end of the keyspace is
 *  reached), deletes at most `FP_PRUNE_BATCH_LIMIT` of the ones older than
 *  `ttlMs`, and returns where the next call should resume. Never a
 *  `list({prefix: "fp:"})` with no bound — the one thing A-I1 flags this
 *  prefix for. */
export async function pruneFingerprintRegistry(
  storage: StorageLike,
  nowMs: number,
  ttlMs: number = FP_DEFAULT_TTL_MS,
  cursor: string | null = null,
): Promise<FingerprintPruneResult> {
  const end = `${FP_PREFIX}￿`; // exclusive upper bound past every possible fp: key
  const start = cursor ?? FP_PREFIX;
  const page = await storage.list<number>({ start, end, limit: FP_PRUNE_SCAN_LIMIT });

  const toDelete: string[] = [];
  let lastKey: string | undefined;
  for (const [key, firstSeenMs] of page) {
    lastKey = key;
    if (toDelete.length < FP_PRUNE_BATCH_LIMIT && typeof firstSeenMs === "number" && nowMs - firstSeenMs > ttlMs) {
      toDelete.push(key);
      // Delete the `fpts:` time-index twin alongside its `fp:` entry — the
      // exact firstSeenMs is right here as this row's own value, so the
      // twin's key is reconstructible without a second read.
      toDelete.push(fingerprintTimeIndexKey(firstSeenMs, key.slice(FP_PREFIX.length)));
    }
  }
  if (toDelete.length > 0) await deleteChunked(storage, toDelete);

  // Reached the end of the keyspace this call (fewer rows than the scan
  // limit came back) — resume from the beginning next time, so a quiet tail
  // never starves the front of the keyspace and the sweep keeps laps
  // running indefinitely. Otherwise resume just past the last key seen.
  const reachedEnd = page.size < FP_PRUNE_SCAN_LIMIT;
  const nextCursor = reachedEnd ? null : lastKey ? `${lastKey}\0` : null;

  return { fpDeleted: toDelete.length, nextCursor };
}
