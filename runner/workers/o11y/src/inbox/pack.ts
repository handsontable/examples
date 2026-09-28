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
  SEQ_STORAGE_KEY,
  type NormalisedRecord,
  type OtlpResourceLogs,
  type Tenant,
} from "@handsontable/demo-runtime/telemetry";
import { deleteChunked, type StorageLike } from "./storage.js";

export interface PendingRow {
  tenant: Tenant;
  /** ADR §8: "the arrival time itself never becomes part of a stored
   *  record" — it lives here, on the row, set once when the row is written. */
  arrivalMs: number;
  resourceLogs: OtlpResourceLogs[];
}

const ROW_PREFIX = "row:";
/** Not a contract-named key — an `InboxWriter`-internal monotonic counter,
 *  separate from the pack `seq` (§8), so row numbering survives a restart
 *  the same way `seq` does. */
const ROW_SEQ_STORAGE_KEY = "rowSeq";

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

async function gzip(text: string): Promise<Uint8Array> {
  // Fully read the compressed stream before returning — a `put` against a
  // still-draining `CompressionStream` output is a documented trap.
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

export interface PackedObject {
  key: string;
  bytes: number;
  consumedRowKeys: string[];
}

/** ADR §B.2 step 6's "or at 4 MB stored" bounds the packed OBJECT itself:
 *  without it, a sustained ingest flood (~100 MB/min for one IP) could
 *  push the alarm's in-memory gzip past the DO's 128 MB memory before
 *  anything is packed, causing every later alarm to retry against an
 *  ever-larger pending set. The caller (`writer.ts#alarm()`) loops over
 *  leftover rows. */
export const PACK_OBJECT_MAX_DECOMPRESSED_BYTES = 4 * 1024 * 1024;

/** Packs pending rows for `tenant`, up to
 *  {@link PACK_OBJECT_MAX_DECOMPRESSED_BYTES} decompressed, into one
 *  gzipped NDJSON R2 object, keyed by the **first** packed row's arrival
 *  time — not `Date.now()`, so a retry after a crash lands on the
 *  identical key instead of producing a divergent object. `null` when
 *  nothing is pending. Writes to R2 directly (not transactional with DO
 *  storage); the caller commits `seq`/`key:<key>`/row deletion right
 *  after, per ADR §B.2 step 6. */
export async function packTenant(
  storage: StorageLike,
  bucket: R2Bucket,
  tenant: Tenant,
  rows: [string, PendingRow][],
): Promise<PackedObject | null> {
  const first = rows[0];
  if (!first) return null;

  // Take rows in order until the byte budget is spent; always takes at
  // least one row, even if it alone is over budget — a stuck pending set
  // is worse than one oversized object.
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
    // Many small rows can pack more than 128 into one object.
    await deleteChunked(txn, packed.consumedRowKeys);
  });
}

// ---- Bounded reads for the pack alarm --------------------------------------
// `row:<n>` is zero-padded, so native ascending `list()` order equals
// arrival order — a small, bounded page is enough to read in order.

/** How many rows one `list()` page fetches while accumulating a batch —
 *  small so a single call's OWN memory footprint stays bounded (rows are
 *  ≤ `INBOX_ROW_MAX_BYTES`, so one page is ≤ ~8 MB). */
export const ROW_LIST_PAGE_LIMIT = 8;
/** Target bytes per `collectRowBatch` call — matches
 *  {@link PACK_OBJECT_MAX_DECOMPRESSED_BYTES} so one batch is normally
 *  enough to fill one packed object, without page-boundary fragmentation. */
const ROW_BATCH_TARGET_BYTES = PACK_OBJECT_MAX_DECOMPRESSED_BYTES;

function rowByteSize(row: PendingRow): number {
  return new TextEncoder().encode(encodeNdjson(row.resourceLogs)).length;
}

/** Bounded, arrival-ordered batch of pending rows (any tenant mixed in —
 *  the caller groups by tenant): pages through `row:` in small chunks
 *  ({@link ROW_LIST_PAGE_LIMIT}) via an exclusive `start` cursor,
 *  accumulating until {@link ROW_BATCH_TARGET_BYTES} or nothing remains.
 *  Always takes at least one row, matching `packTenant`'s own rule. */
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
