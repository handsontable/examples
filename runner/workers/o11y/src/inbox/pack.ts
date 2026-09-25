// ADR §B.2 steps 5–6: append accepted records into ≤ 1 MB storage rows (the
// arrival time on the row, never in the record — §8), then pack one gzipped
// NDJSON object per tenant, `<seq>` persisted in the same transaction that
// records the object's `key:<key> = written` and deletes the packed rows.

import {
  buildResourceLogs,
  encodeNdjson,
  inboxKey,
  inboxKeyStorageKey,
  INBOX_ROW_MAX_BYTES,
  pendingRowStorageKey,
  ROW_SEQ_DIGITS,
  SEQ_STORAGE_KEY,
  type NormalisedRecord,
  type OtlpResourceLogs,
  type Tenant,
} from "@handsontable/demo-runtime/telemetry";
import { deleteChunked, putChunked, type StorageLike } from "./storage.js";

export interface PendingRow {
  tenant: Tenant;
  /** ADR §8: "the arrival time itself never becomes part of a stored
   *  record" — it lives here, on the row, set once when the row is written. */
  arrivalMs: number;
  resourceLogs: OtlpResourceLogs[];
}

const ROW_PREFIX = "row:";
/** Not a contract-named key (§8's table only fixes `row:<n>`'s *value*
 *  shape, not how `<n>` is generated) — an `InboxWriter`-internal monotonic
 *  counter, separate from the pack `seq` (§8), so row numbering survives a
 *  restart the same way `seq` does. */
const ROW_SEQ_STORAGE_KEY = "rowSeq";

function rowNumber(key: string): number {
  return Number(key.slice(ROW_PREFIX.length));
}

export interface AppendResult {
  writes: Record<string, PendingRow>;
  nextRowSeq: number;
  bytesAdded: number;
}

/** Chunks `records` into rows of at most {@link INBOX_ROW_MAX_BYTES} (a
 *  single oversized record is impossible here — `normalise/` already drops
 *  anything over `INBOX_RECORD_MAX_BYTES`, well under the row cap) and
 *  returns the `row:<n>` entries to write, reading/advancing `rowSeq` from
 *  `storage` first. Pure: does not write — the caller commits these
 *  alongside the dedupe/fingerprint/heartbeat writes in one transaction. */
export async function appendRows(
  storage: StorageLike,
  tenant: Tenant,
  arrivalMs: number,
  records: readonly NormalisedRecord[],
): Promise<AppendResult> {
  let rowSeq = (await storage.get<number>(ROW_SEQ_STORAGE_KEY)) ?? 0;
  const writes: Record<string, PendingRow> = {};
  let bytesAdded = 0;

  let current: OtlpResourceLogs[] = [];
  let currentBytes = 0;
  const flush = () => {
    if (current.length === 0) return;
    writes[pendingRowStorageKey(rowSeq)] = { tenant, arrivalMs, resourceLogs: current };
    rowSeq += 1;
    bytesAdded += currentBytes;
    current = [];
    currentBytes = 0;
  };

  for (const record of records) {
    const resourceLogs = buildResourceLogs(record);
    const size = new TextEncoder().encode(JSON.stringify(resourceLogs)).length;
    if (currentBytes + size > INBOX_ROW_MAX_BYTES && current.length > 0) flush();
    current.push(resourceLogs);
    currentBytes += size;
  }
  flush();

  return { writes, nextRowSeq: rowSeq, bytesAdded };
}

export { ROW_SEQ_STORAGE_KEY };

/** All pending rows, grouped by tenant, in row-insertion order (numeric sort
 *  in memory, so this is correct regardless of whether any un-migrated
 *  legacy (un-padded) `row:<n>` keys remain — see `migrateLegacyRows`).
 *
 *  UNBOUNDED — loads every pending row into memory, exactly the shape A-I2
 *  fixed the pack alarm away from. Kept only for tests/diagnostics that
 *  work over a small, known row count; production code (`writer.ts#alarm()`)
 *  must use {@link collectRowBatch} instead, never this. */
export async function pendingRowsByTenant(storage: StorageLike): Promise<Map<Tenant, [string, PendingRow][]>> {
  const rows = await storage.list<PendingRow>({ prefix: ROW_PREFIX });
  const sorted = [...rows.entries()].sort(([a], [b]) => rowNumber(a) - rowNumber(b));
  const byTenant = new Map<Tenant, [string, PendingRow][]>();
  for (const entry of sorted) {
    const list = byTenant.get(entry[1].tenant) ?? [];
    list.push(entry);
    byTenant.set(entry[1].tenant, list);
  }
  return byTenant;
}

async function gzip(text: string): Promise<Uint8Array> {
  // Fully read the compressed stream before returning — a `put` against a
  // still-draining `CompressionStream` output is the documented trap
  // (task file "Traps": "`CompressionStream` output must be fully read
  // before `put`").
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

export interface PackedObject {
  key: string;
  bytes: number;
  consumedRowKeys: string[];
}

/** Fix round (finding A-I2): ADR §B.2 step 6's "or at 4 MB stored" was never
 *  a real bound on the packed OBJECT itself — `packTenant` used to gzip
 *  every pending row for a tenant in one pass, with no upper bound. A
 *  sustained ingest flood (a legitimate burst, or an attacker at the rate
 *  limit) fills 60 s of rows before the alarm fires; at ~100 MB/min for one
 *  IP, a few more colos or IPs push the alarm's `list()` + in-memory gzip
 *  past the DO's 128 MB memory, which throws — and since nothing was ever
 *  packed, every later alarm retries against an ever-larger pending set,
 *  silent data loss for the whole pipeline. Bounded here, decompressed, to
 *  this constant; the caller (`writer.ts#alarm()`) loops over the leftover
 *  rows this call did not take. */
export const PACK_OBJECT_MAX_DECOMPRESSED_BYTES = 4 * 1024 * 1024;

/** Packs pending rows for `tenant`, in order, up to
 *  {@link PACK_OBJECT_MAX_DECOMPRESSED_BYTES} decompressed, into one gzipped
 *  NDJSON R2 object, keyed by the **first** packed row's arrival time (T02-D,
 *  see the task Outcome: not `Date.now()` — a crash between the R2 `put`
 *  below and the ledger transaction that follows it, on retry, packs the
 *  same still-pending rows again and must land on the identical key, not a
 *  later-dated one, or the retry produces two divergent objects instead of
 *  one overwrite). Returns `null` when there is nothing pending for this
 *  tenant. `consumedRowKeys` may be a strict prefix of `rows` (fix round
 *  A-I2) — the caller loops until it is empty. Writes to R2 directly (not
 *  part of any DO transaction — R2 isn't transactional with DO storage); the
 *  caller commits `seq`/`key:<key>`/row deletion in one storage transaction
 *  immediately after, per ADR §B.2 step 6. */
export async function packTenant(
  storage: StorageLike,
  bucket: R2Bucket,
  tenant: Tenant,
  rows: [string, PendingRow][],
): Promise<PackedObject | null> {
  const first = rows[0];
  if (!first) return null;

  // Take rows in order (already arrival-ordered by `pendingRowsByTenant`)
  // until the byte budget is spent. Each row is already ≤ `INBOX_ROW_MAX_BYTES`
  // (~1 MB), so per-row granularity keeps this loop cheap and the resulting
  // object comfortably under the budget rather than exactly at it. Always
  // takes at least one row, even if that single row alone is over budget —
  // an ever-growing pending set with zero progress is worse than one
  // slightly-oversized object.
  let budget = 0;
  let cut = rows.length;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) break;
    const rowBytes = new TextEncoder().encode(encodeNdjson(row[1].resourceLogs)).length;
    if (i > 0 && budget + rowBytes > PACK_OBJECT_MAX_DECOMPRESSED_BYTES) {
      cut = i;
      break;
    }
    budget += rowBytes;
  }
  const taken = rows.slice(0, cut);

  const allLogs = taken.flatMap(([, row]) => row.resourceLogs);
  const ndjson = encodeNdjson(allLogs);
  const gz = await gzip(ndjson);

  const seq = (await storage.get<number>(SEQ_STORAGE_KEY)) ?? 0;
  // `taken[0]` is always `first` (the loop above always takes at least the
  // row at index 0) — `?? first` only satisfies the type checker's
  // (correct, in general) indexed-access uncertainty, not a real fallback.
  const firstArrival = new Date((taken[0] ?? first)[1].arrivalMs);
  const key = inboxKey(tenant, firstArrival, seq);

  await bucket.put(key, gz);

  return { key, bytes: gz.byteLength, consumedRowKeys: taken.map(([k]) => k) };
}

/** Commits a {@link PackedObject}: `seq += 1`, `key:<key> = "written"`, the
 *  consumed rows deleted — one atomic write (ADR §B.2 step 6: "`<seq>` is …
 *  incremented in the same transaction that records the key"). */
export async function commitPackedObject(storage: StorageLike, packed: PackedObject): Promise<void> {
  await storage.transaction(async (txn) => {
    const seq = (await txn.get<number>(SEQ_STORAGE_KEY)) ?? 0;
    await txn.put({
      [SEQ_STORAGE_KEY]: seq + 1,
      [inboxKeyStorageKey(packed.key)]: "written",
    });
    // N2: many small rows can pack more than 128 into one object.
    await deleteChunked(txn, packed.consumedRowKeys);
  });
}

// ---- A-I2: bounded reads for the pack alarm --------------------------------------
//
// `row:<n>` is zero-padded as of this fix (`pendingRowStorageKey`, the
// shared package) — native ascending `storage.list()` order then equals
// arrival order, so a small, bounded page is enough to read rows in the
// right order without sorting anything in memory. Two helpers:
//   - `migrateLegacyRows`: a bounded, self-terminating sweep that rewrites
//     any un-padded `row:<n>` key (written before this fix deployed) into
//     the new padded shape, oldest first.
//   - `collectRowBatch`: bounded pages, accumulated up to one packed
//     object's own byte budget, for the alarm's normal packing loop.
// `writer.ts#alarm()` always finishes migrating (a call that migrates zero
// rows) before ever calling `collectRowBatch` — a newer (larger, padded)
// row must never be packed ahead of an older (un-migrated, legacy) one.

/** A legacy (pre-fix) row key: `row:` followed by a bare decimal with no
 *  leading zero (`n.toString()`, the old `pendingRowStorageKey`). Excludes
 *  every possible NEW padded key by construction: a padded key is always
 *  exactly {@link ROW_SEQ_DIGITS} digits wide and, for any `n` that could
 *  realistically occur (far below `10 ** (ROW_SEQ_DIGITS - 1)`), starts
 *  with `0` — which `n.toString()` never produces except for the bare
 *  string `"0"` itself (handled separately, see `migrateLegacyRows`). */
const LEGACY_ROW_RE = /^row:[1-9]\d*$/;
/** How many legacy rows one `migrateLegacyRows` call may rewrite — well
 *  under the real DO storage 128-key limit (`storage.ts`), since the call
 *  does one `put` and one `delete`, each sized to this many keys. */
export const LEGACY_MIGRATE_BATCH_LIMIT = 64;

/** Bounded, oldest-first page of un-migrated legacy row keys. `start`/`end`
 *  (never combined with `prefix` — `storage.ts`'s own caveat) restrict the
 *  scan to the lexicographic band `row:1` .. `row:~` (`~` sorts after every
 *  digit), which holds every legacy key with `n >= 1` and NO padded key
 *  (padded keys start with `0` for any realistic `n` — see `LEGACY_ROW_RE`).
 *  `row:0` (legacy `n === 0`) sorts BEFORE that whole band, so it needs its
 *  own one-key check. */
async function legacyRowPage(storage: StorageLike, limit: number): Promise<[string, PendingRow][]> {
  const zeroKey = `${ROW_PREFIX}0`;
  const zero = await storage.get<PendingRow>(zeroKey);
  const rest = await storage.list<PendingRow>({
    start: `${ROW_PREFIX}1`,
    end: `${ROW_PREFIX}~`,
    limit: zero !== undefined ? limit - 1 : limit,
  });
  const entries: [string, PendingRow][] = [];
  if (zero !== undefined) entries.push([zeroKey, zero]);
  for (const entry of rest) if (LEGACY_ROW_RE.test(entry[0])) entries.push(entry);
  return entries;
}

/** Rewrites up to {@link LEGACY_MIGRATE_BATCH_LIMIT} legacy (un-padded)
 *  `row:<n>` rows into the new padded shape, in one transaction (same
 *  value, only the key changes — never touches `rowSeq`/`seq`, which are
 *  unaffected by the key's own text width). Returns how many were migrated;
 *  the caller (`writer.ts#alarm()`) keeps calling this — never packing in
 *  between — until it returns 0, guaranteeing every legacy row is packed
 *  strictly before any row appended after this fix deployed. Self-limiting:
 *  legacy rows only ever shrink (nothing writes new ones — `appendRows`
 *  always uses the current, padded `pendingRowStorageKey`), so this
 *  eventually always reaches 0 and never runs again after that. */
export async function migrateLegacyRows(storage: StorageLike, limit: number = LEGACY_MIGRATE_BATCH_LIMIT): Promise<number> {
  const legacy = await legacyRowPage(storage, limit);
  if (legacy.length === 0) return 0;
  await storage.transaction(async (txn) => {
    const writes: Record<string, PendingRow> = {};
    const toDelete: string[] = [];
    for (const [key, row] of legacy) {
      writes[pendingRowStorageKey(rowNumber(key))] = row;
      toDelete.push(key);
    }
    await putChunked(txn, writes);
    await deleteChunked(txn, toDelete);
  });
  return legacy.length;
}

/** How many rows one `list()` page fetches while accumulating a batch — a
 *  small constant (not {@link PACK_OBJECT_MAX_DECOMPRESSED_BYTES}-sized)
 *  so a single call's OWN memory footprint stays small even before the
 *  accumulated-bytes check below can stop it (rows are ≤ `INBOX_ROW_MAX_BYTES`
 *  each, so one page is ≤ ~8 MB). */
export const ROW_LIST_PAGE_LIMIT = 8;
/** Target bytes to accumulate per `collectRowBatch` call — matches
 *  {@link PACK_OBJECT_MAX_DECOMPRESSED_BYTES} so one batch is normally
 *  enough to fill one packed object per tenant present in it, without the
 *  page-boundary fragmentation a much-smaller per-page limit would cause
 *  (advisor review, this fix round: a naive re-list-from-the-front-after-
 *  every-object loop re-reads rows it isn't about to use, amplifying DO row
 *  reads well past what packing this many bytes actually needs). */
const ROW_BATCH_TARGET_BYTES = PACK_OBJECT_MAX_DECOMPRESSED_BYTES;

function rowByteSize(row: PendingRow): number {
  return new TextEncoder().encode(encodeNdjson(row.resourceLogs)).length;
}

/** Bounded, arrival-ordered batch of pending rows (ANY tenant mixed in —
 *  the caller groups by tenant): pages through `row:` in small chunks
 *  ({@link ROW_LIST_PAGE_LIMIT} at a time — bounds ONE `list()` call's
 *  memory) via an exclusive `start` cursor, accumulating until
 *  {@link ROW_BATCH_TARGET_BYTES} is reached or no more rows exist. Always
 *  takes at least one row (a single oversized row must still make
 *  progress, matching `packTenant`'s own rule). Requires every `row:` key
 *  in storage to already be in the padded shape — the caller
 *  (`writer.ts#alarm()`) only calls this after `migrateLegacyRows` reports
 *  0 remaining, so native ascending `list()` order is arrival order (see
 *  this section's header). */
export async function collectRowBatch(storage: StorageLike): Promise<[string, PendingRow][]> {
  const rows: [string, PendingRow][] = [];
  let bytes = 0;
  let start: string | undefined;
  for (;;) {
    const page = await storage.list<PendingRow>({ prefix: ROW_PREFIX, start, limit: ROW_LIST_PAGE_LIMIT });
    if (page.size === 0) break;
    let lastKey: string | undefined;
    let hitBudget = false;
    for (const [key, row] of page) {
      lastKey = key;
      const size = rowByteSize(row);
      if (rows.length > 0 && bytes + size > ROW_BATCH_TARGET_BYTES) {
        hitBudget = true;
        break;
      }
      rows.push([key, row]);
      bytes += size;
    }
    if (hitBudget) break;
    if (page.size < ROW_LIST_PAGE_LIMIT) break; // nothing pending beyond this page
    start = `${lastKey}\0`; // exclusive: the next page starts strictly after lastKey
  }
  return rows;
}
