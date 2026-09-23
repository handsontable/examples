// ADR §B.2 step 4: "Deduplicate in `InboxWriter`: each hash is checked
// against a 24-hour set in DO storage; a record already seen is dropped."
// Pure over a {@link StorageLike}, so it is unit-testable without a real DO
// (`pipeline/o11y-inbox.test.mjs`) and reusable from the real `InboxWriter`.
//
// F2 fix (final review, A-I1 "hash: entries are never deleted, so DO storage
// and per-tick scan cost grow without bound"): `hash:<sha256>` used to be a
// flat, permanent set — one entry per accepted record, forever (§B-findings:
// "about 16.7k permanent hash: keys" per 1 MB collect body, heading toward
// the 10 GB SQLite-DO limit within days under sustained/attacker traffic).
// Keys are now day-bucketed (`hash:<yyyymmdd>:<sha256>`), and
// `pruneHashBuckets` deletes stale buckets with a bounded `start`/`end`
// range read (never a full-prefix scan — see `storage.ts`'s `ListOptions`
// doc comment), called from `writer.ts#backlog()` alongside
// `ledger.ts#pruneLedger`. `checkDuplicates`'s signature and behaviour
// (24h window, same-batch repeats collapse to their first occurrence) are
// UNCHANGED — this is purely a storage-layout fix.

import { DEDUPE_WINDOW_MS } from "@handsontable/demo-runtime/telemetry";
import type { StorageLike } from "./storage.js";

const HASH_PREFIX = "hash:";
const DAY_MS = 24 * 60 * 60 * 1000;
/** How many stale `hash:` rows one `pruneHashBuckets` call may delete —
 *  bounds the cost of a call after a quiet period let a backlog of stale
 *  buckets build up (same principle as `ledger.ts`'s `PRUNE_BATCH_LIMIT`). */
const HASH_PRUNE_BATCH_LIMIT = 500;

/** `yyyymmdd`, UTC — chosen so the bucket sorts lexicographically in
 *  chronological order (a plain string comparison on this component alone
 *  already orders correctly), which is what makes `pruneHashBuckets`'s
 *  `start`/`end` range delete correct without inspecting each row's value. */
function dayBucket(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");
}

function bucketedHashKey(bucket: string, sha256Hex: string): string {
  return `${HASH_PREFIX}${bucket}:${sha256Hex}`;
}

export interface DedupeResult {
  /** Hashes that are duplicates — already seen within the 24 h window, or
   *  repeated within this same batch (a request that includes the same
   *  record twice, e.g. a client-side retry folded into one POST). */
  duplicates: ReadonlySet<string>;
  /** `hash:<yyyymmdd>:<sha256>` entries to write for every non-duplicate
   *  hash — the caller commits these in the same transaction as the
   *  rows/fingerprints (ADR §B.2: "the same transaction as
   *  `key:<key> = written`"). */
  writes: Readonly<Record<string, number>>;
}

/** Checks `hashes` (in order — a within-batch repeat keeps only its first
 *  occurrence as non-duplicate) against storage's 24 h dedupe window. Since
 *  the 24h window can only ever straddle AT MOST two calendar-day buckets
 *  (today's, which is by construction < 24h old, and yesterday's, which
 *  covers the remainder — see the proof in this file's git history /
 *  F2-report.md), checking exactly those two buckets per unique hash is
 *  correct and bounded (a fixed ×2 factor on `getMany`'s key list, never a
 *  `list()` over accumulated history). Read-only: does **not** write
 *  anything itself, so a caller that decides not to commit (an error later
 *  in the same request) never leaves a hash marked seen for a record that
 *  was never actually stored. */
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
  const existing = await storage.getMany<number>(lookupKeys);

  const duplicates = new Set<string>();
  const writes: Record<string, number> = {};
  const acceptedThisBatch = new Set<string>();

  for (const hash of hashes) {
    if (acceptedThisBatch.has(hash)) {
      duplicates.add(hash);
      continue;
    }
    const firstSeen = existing.get(bucketedHashKey(today, hash)) ?? existing.get(bucketedHashKey(yesterday, hash));
    const withinWindow = firstSeen !== undefined && nowMs - firstSeen < DEDUPE_WINDOW_MS;
    if (withinWindow) {
      duplicates.add(hash);
    } else {
      writes[bucketedHashKey(today, hash)] = nowMs;
      acceptedThisBatch.add(hash);
    }
  }

  return { duplicates, writes };
}

export interface HashPruneResult {
  hashDeleted: number;
}

/** Deletes `hash:` rows whose bucket is strictly older than `keepDays` full
 *  days ago (default 2 — today + yesterday are the only buckets
 *  `checkDuplicates` ever reads, so anything older is dead weight). Bounded
 *  per call via a `start`/`end` range read (`HASH_PRUNE_BATCH_LIMIT` rows),
 *  never a full-prefix scan of all-time hash history — a backlog built up
 *  over a quiet period is cleared incrementally across successive calls
 *  (each call reads from `"hash:"` up to the cutoff, so it always makes
 *  forward progress on the OLDEST rows first, regardless of how many stale
 *  buckets have accumulated). Called from `writer.ts#backlog()` (the cron
 *  path), wrapped in `try/catch` there. */
export async function pruneHashBuckets(storage: StorageLike, nowMs: number, keepDays = 2): Promise<HashPruneResult> {
  const cutoffBucket = dayBucket(nowMs - keepDays * DAY_MS);
  const stale = await storage.list<number>({
    start: HASH_PREFIX,
    end: `${HASH_PREFIX}${cutoffBucket}:`,
    limit: HASH_PRUNE_BATCH_LIMIT,
  });
  const toDelete = [...stale.keys()];
  if (toDelete.length > 0) await storage.delete(toDelete);
  return { hashDeleted: toDelete.length };
}
