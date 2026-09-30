// ADR §B.2 step 4: "Deduplicate in `InboxWriter`: each hash is checked
// against a 24-hour set in DO storage." Pure over {@link StorageLike},
// unit-testable without a real DO. `hash:<sha256>` as a flat, permanent
// set heads toward the 10 GB SQLite-DO limit within days under sustained
// traffic; keys are day-bucketed instead (`hash:<yyyymmdd>:<sha256>`), and
// `pruneHashBuckets` sweeps stale buckets with a bounded range read.

import { DEDUPE_WINDOW_MS } from "@handsontable/demo-runtime/telemetry";
import { deleteChunked, getManyChunked, type StorageLike } from "./storage.js";

const HASH_PREFIX = "hash:";
const DAY_MS = 24 * 60 * 60 * 1000;
/** How many stale `hash:` rows one `pruneHashBuckets` call may delete —
 *  bounds the cost of a call after a quiet period let a backlog build up.
 *  Against a 10-minute cron, 500/tick tops out at 72,000/day, below ADR
 *  §D's 10× headroom projection of ~220,000/day. 5,000/tick gives
 *  720,000/day, over 3× that headroom. */
export const HASH_PRUNE_BATCH_LIMIT = 5000;

/** `yyyymmdd`, UTC — sorts lexicographically in chronological order, which
 *  is what makes `pruneHashBuckets`'s range delete correct without
 *  inspecting each row's value. */
function dayBucket(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");
}

function bucketedHashKey(bucket: string, sha256Hex: string): string {
  return `${HASH_PREFIX}${bucket}:${sha256Hex}`;
}

export interface DedupeResult {
  /** One entry per input hash, index-aligned with `hashes`: `true` when
   *  THAT occurrence is a duplicate — already seen, or a later copy of a
   *  hash earlier in this same batch. The first in-batch occurrence of an
   *  unseen hash is `false`: it is the copy that gets stored. Per
   *  occurrence, not per hash: a plain `Set` of duplicate hashes would
   *  drop the first copy of an in-batch repeat along with the later ones,
   *  losing the record for good. */
  isDuplicate: readonly boolean[];
  /** `hash:<yyyymmdd>:<sha256>` entries to write for every non-duplicate
   *  hash — the caller commits these in the same transaction as the
   *  rows/fingerprints. */
  writes: Readonly<Record<string, number>>;
}

/** Checks `hashes` (in order — a within-batch repeat keeps only its first
 *  occurrence as non-duplicate) against storage's 24 h dedupe window. The
 *  24h window can only ever straddle two calendar-day buckets, so
 *  checking exactly those two per unique hash is correct and bounded.
 *  Read-only: a caller that decides not to commit never leaves a hash
 *  marked seen for a record that was never stored. */
export async function checkDuplicates(
  storage: StorageLike,
  hashes: readonly string[],
  nowMs: number,
): Promise<DedupeResult> {
  const uniqueHashes = [...new Set(hashes)];
  const today = dayBucket(nowMs);
  const yesterday = dayBucket(nowMs - DAY_MS);

  // `today`/`yesterday` are UTC calendar days (no DST discontinuity), so
  // they are always exactly one day apart and never equal — both are always
  // worth a lookup.
  const lookupKeys: string[] = [];
  for (const hash of uniqueHashes) {
    lookupKeys.push(bucketedHashKey(today, hash));
    lookupKeys.push(bucketedHashKey(yesterday, hash));
  }
  // A batch of 65+ unique records (still under the 200-item ingest cap)
  // already needs 130+ lookup keys here (2 buckets each) — over the real
  // DO storage limit (`storage.ts#DO_STORAGE_MAX_KEYS_PER_CALL`).
  const existing = await getManyChunked<number>(storage, lookupKeys);

  const isDuplicate: boolean[] = [];
  const writes: Record<string, number> = {};
  const acceptedThisBatch = new Set<string>();

  for (const hash of hashes) {
    if (acceptedThisBatch.has(hash)) {
      isDuplicate.push(true);
      continue;
    }
    const firstSeen = existing.get(bucketedHashKey(today, hash)) ?? existing.get(bucketedHashKey(yesterday, hash));
    const withinWindow = firstSeen !== undefined && nowMs - firstSeen < DEDUPE_WINDOW_MS;
    if (withinWindow) {
      isDuplicate.push(true);
    } else {
      writes[bucketedHashKey(today, hash)] = nowMs;
      acceptedThisBatch.add(hash);
      isDuplicate.push(false);
    }
  }

  return { isDuplicate, writes };
}

export interface HashPruneResult {
  hashDeleted: number;
}

/** Deletes `hash:` rows whose bucket is strictly older than `keepDays`
 *  full days ago (default 2 — today+yesterday are the only buckets
 *  `checkDuplicates` reads). Bounded per call via a `start`/`end` range
 *  read, never a full-prefix scan; a backlog clears incrementally across
 *  successive calls, oldest rows first. Called from `writer.ts#backlog()`,
 *  wrapped in `try/catch` there. */
export async function pruneHashBuckets(storage: StorageLike, nowMs: number, keepDays = 2): Promise<HashPruneResult> {
  const cutoffBucket = dayBucket(nowMs - keepDays * DAY_MS);
  const stale = await storage.list<number>({
    start: HASH_PREFIX,
    end: `${HASH_PREFIX}${cutoffBucket}:`,
    limit: HASH_PRUNE_BATCH_LIMIT,
  });
  const toDelete = [...stale.keys()];
  if (toDelete.length > 0) await deleteChunked(storage, toDelete);
  return { hashDeleted: toDelete.length };
}

/** Trims `writes` to `budget` new `hash:` entries. A dropped hash is simply
 *  not registered: its record is still stored, and a redelivery inside the
 *  24 h window can then be stored a second time (fail-open). */
export function capHashWrites(
  writes: Readonly<Record<string, number>>,
  budget: number,
): { writes: Record<string, number>; dropped: number } {
  const entries = Object.entries(writes);
  const kept = entries.slice(0, Math.max(0, budget));
  return { writes: Object.fromEntries(kept), dropped: entries.length - kept.length };
}
