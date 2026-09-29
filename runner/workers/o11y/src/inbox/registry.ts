// ADR §F.3 / contract §7, §8: the exact first-seen registry for error
// fingerprints — `fp:<fingerprint>` is written once, on first sight, and
// never overwritten. `pruneFingerprintRegistry` is a bounded,
// cursor-paginated TTL sweep (never a full-prefix scan) called from
// `writer.ts#backlog()` alongside `ledger.ts#pruneLedger`. A TTL, not an
// LRU: the alert lookback only ever looks back to the last notified time.

import { fingerprintStorageKey, fingerprintTimeIndexKey, FPTS_TIMESTAMP_DIGITS } from "@handsontable/demo-runtime/telemetry";
import { deleteChunked, getManyChunked, type StorageLike } from "./storage.js";

const FP_PREFIX = "fp:";
const FPTS_PREFIX = "fpts:";
/** `fpts:` + the zero-padded ms + the separating `:` — everything after
 *  this offset in an `fpts:` key is the fingerprint verbatim (safe even
 *  when the fingerprint itself contains `:`). */
const FPTS_FP_OFFSET = FPTS_PREFIX.length + FPTS_TIMESTAMP_DIGITS + 1;
/** Default TTL: long enough that a re-alert after pruning is rare and
 *  acceptable, while bounding registry growth to a multiple of daily
 *  fingerprint volume rather than all-time history. */
export const FP_DEFAULT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** Bounds one prune call's cost — see `dedupe.ts#HASH_PRUNE_BATCH_LIMIT`
 *  for the throughput arithmetic. */
const FP_PRUNE_BATCH_LIMIT = 5000;
/** How many rows one prune call inspects (not necessarily deletes) — larger
 *  than the delete limit since most inspected rows, in steady state, are
 *  not stale. Bounds the call even when nothing is stale yet. */
const FP_PRUNE_SCAN_LIMIT = 20000;

/** Returns `fp:<fp>` → `nowMs` (plus its `fpts:` time-index twin) for
 *  every fingerprint not already present — commit these in the same
 *  transaction as the dedupe/row writes. */
export async function newFingerprintWrites(
  storage: StorageLike,
  fingerprints: readonly string[],
  nowMs: number,
): Promise<Record<string, number>> {
  const unique = [...new Set(fingerprints)];
  if (unique.length === 0) return {};
  // A 200-item Faro batch (the ingest cap) can carry up to 200 unique
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
  /** A stored cursor makes forward progress across the whole keyspace over
   *  successive calls (fingerprints don't embed a date, unlike `hash:`).
   *  `null` once a full lap completes with nothing left. */
  nextCursor: string | null;
}

/** Bounded TTL sweep: reads at most `FP_PRUNE_SCAN_LIMIT` rows starting
 *  after `cursor` (wrapping to the beginning once the end of the keyspace is
 *  reached), deletes at most `FP_PRUNE_BATCH_LIMIT` of the ones older than
 *  `ttlMs`, and returns where the next call should resume. Never a
 *  `list({prefix: "fp:"})` with no bound. */
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

  // Reached the end of the keyspace (fewer rows than the scan limit came
  // back) — resume from the beginning, so a quiet tail never starves the
  // front.
  const reachedEnd = page.size < FP_PRUNE_SCAN_LIMIT;
  const nextCursor = reachedEnd ? null : lastKey ? `${lastKey}\0` : null;

  return { fpDeleted: toDelete.length, nextCursor };
}
