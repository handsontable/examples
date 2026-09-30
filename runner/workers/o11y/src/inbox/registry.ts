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

/** Total registry size (entries, not keys). Kept as a counter because a
 *  `fp:` prefix count would be a full scan; the prune lap re-measures it. */
export const FP_COUNT_STORAGE_KEY = "fpCount";
/** Hard ceiling on registry entries. Growth per window is bounded by
 *  `admission.ts#FP_ADMIT_PER_WINDOW`, so storage never exceeds this plus one
 *  window's admissions. */
export const FP_REGISTRY_MAX = 50_000;
/** Bounds one eviction call, like `FP_PRUNE_BATCH_LIMIT`. */
const FP_EVICT_BATCH_LIMIT = 5000;
/** Entries seen so far in the current prune lap; becomes `fpCount` when the
 *  lap completes. Internal housekeeping, like `fpPruneCursor`. */
const FP_LAP_SEEN_STORAGE_KEY = "fpLapSeen";

export async function readFpCount(storage: StorageLike): Promise<number> {
  return (await storage.get<number>(FP_COUNT_STORAGE_KEY)) ?? 0;
}

async function findNewFingerprints(storage: StorageLike, fingerprints: readonly string[]): Promise<string[]> {
  const unique = [...new Set(fingerprints)];
  if (unique.length === 0) return [];
  // A 200-item Faro batch (the ingest cap) can carry up to 200 unique
  // fingerprints — over the real DO storage 128-key limit.
  const existing = await getManyChunked<number>(storage, unique.map(fingerprintStorageKey));
  return unique.filter((fp) => !existing.has(fingerprintStorageKey(fp)));
}

function registryWrites(fresh: readonly string[], nowMs: number): Record<string, number> {
  const writes: Record<string, number> = {};
  for (const fp of fresh) {
    writes[fingerprintStorageKey(fp)] = nowMs;
    writes[fingerprintTimeIndexKey(nowMs, fp)] = nowMs;
  }
  return writes;
}

/** Returns `fp:<fp>` → `nowMs` (plus its `fpts:` time-index twin) for
 *  every fingerprint not already present. Unbudgeted and not counted in
 *  `fpCount`: the ingest path uses {@link admitNewFingerprints}; this is for
 *  seeding a registry in tests. */
export async function newFingerprintWrites(
  storage: StorageLike,
  fingerprints: readonly string[],
  nowMs: number,
): Promise<Record<string, number>> {
  return registryWrites(await findNewFingerprints(storage, fingerprints), nowMs);
}

export interface FingerprintAdmission {
  writes: Record<string, number>;
  admitted: number;
  /** New fingerprints past `budget`, not stored. */
  dropped: number;
}

/** {@link newFingerprintWrites} limited to `budget` new fingerprints, in
 *  arrival order; the rest are counted, not stored. */
export async function admitNewFingerprints(
  storage: StorageLike,
  fingerprints: readonly string[],
  nowMs: number,
  budget: number,
): Promise<FingerprintAdmission> {
  const fresh = await findNewFingerprints(storage, fingerprints);
  const admittedFps = fresh.slice(0, Math.max(0, budget));
  return { writes: registryWrites(admittedFps, nowMs), admitted: admittedFps.length, dropped: fresh.length - admittedFps.length };
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
  const entriesDeleted = toDelete.length / 2;

  // Reached the end of the keyspace (fewer rows than the scan limit came
  // back) — resume from the beginning, so a quiet tail never starves the
  // front.
  const reachedEnd = page.size < FP_PRUNE_SCAN_LIMIT;
  const nextCursor = reachedEnd ? null : lastKey ? `${lastKey}\0` : null;

  // Re-measure the size counter once per full lap: it is only incremented at
  // ingest and decremented here, so this bounds any drift (a restart between
  // a write and its counter, or a registry that predates the counter).
  const lapSeen = ((await storage.get<number>(FP_LAP_SEEN_STORAGE_KEY)) ?? 0) + page.size - entriesDeleted;
  if (reachedEnd) {
    await storage.put({ [FP_COUNT_STORAGE_KEY]: lapSeen, [FP_LAP_SEEN_STORAGE_KEY]: 0 });
  } else {
    const count = entriesDeleted > 0 ? Math.max(0, (await readFpCount(storage)) - entriesDeleted) : null;
    await storage.put({ [FP_LAP_SEEN_STORAGE_KEY]: lapSeen, ...(count === null ? {} : { [FP_COUNT_STORAGE_KEY]: count }) });
  }

  return { fpDeleted: toDelete.length, nextCursor };
}

/** Evicts the oldest registry entries (via the `fpts:` time index) once the
 *  counter exceeds `max`, at most `FP_EVICT_BATCH_LIMIT` per call. A flood
 *  can push real fingerprints out; the cost is a re-alert for one that
 *  reappears, the same trade as the TTL. */
export async function evictOldestFingerprints(storage: StorageLike, max: number = FP_REGISTRY_MAX): Promise<number> {
  const count = await readFpCount(storage);
  const excess = count - max;
  if (excess <= 0) return 0;
  const oldest = await storage.list<number>({
    start: FPTS_PREFIX,
    end: `${FPTS_PREFIX}￿`,
    limit: Math.min(excess, FP_EVICT_BATCH_LIMIT),
  });
  const oldestKeys = [...oldest.keys()];
  const fpKeys = oldestKeys.map((key) => fingerprintStorageKey(fpFromFptsKey(key)));
  // Count only entries whose `fp:` row still exists: an orphaned `fpts:` row
  // is deleted but was never part of the counter.
  const live = await getManyChunked<number>(storage, fpKeys);
  await deleteChunked(storage, [...oldestKeys, ...fpKeys]);
  const evicted = live.size;
  // Eviction removes rows the in-progress prune lap may already have counted,
  // so its running total is stale: restart the lap (the caller resets the
  // cursor) and trust the counter until a fresh lap re-measures it.
  await storage.put({ [FP_COUNT_STORAGE_KEY]: Math.max(0, count - evicted), [FP_LAP_SEEN_STORAGE_KEY]: 0 });
  return evicted;
}
