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
import type { StorageLike } from "./storage.js";

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

/** All pending rows, grouped by tenant, in row-insertion order (numeric, not
 *  lexicographic — `row:10` must sort after `row:2`, which `storage.list()`'s
 *  string ordering gets wrong). */
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

/** Packs every pending row for `tenant` into one gzipped NDJSON R2 object,
 *  keyed by the **first** packed row's arrival time (T02-D, see the task
 *  Outcome: not `Date.now()` — a crash between the R2 `put` below and the
 *  ledger transaction that follows it, on retry, packs the same still-
 *  pending rows again and must land on the identical key, not a
 *  later-dated one, or the retry produces two divergent objects instead of
 *  one overwrite). Returns `null` when there is nothing pending for this
 *  tenant. Writes to R2 directly (not part of any DO transaction — R2 isn't
 *  transactional with DO storage); the caller commits `seq`/`key:<key>` /row
 *  deletion in one storage transaction immediately after, per ADR §B.2 step
 *  6. */
export async function packTenant(
  storage: StorageLike,
  bucket: R2Bucket,
  tenant: Tenant,
  rows: [string, PendingRow][],
): Promise<PackedObject | null> {
  const first = rows[0];
  if (!first) return null;

  const allLogs = rows.flatMap(([, row]) => row.resourceLogs);
  const ndjson = encodeNdjson(allLogs);
  const gz = await gzip(ndjson);

  const seq = (await storage.get<number>(SEQ_STORAGE_KEY)) ?? 0;
  const firstArrival = new Date(first[1].arrivalMs);
  const key = inboxKey(tenant, firstArrival, seq);

  await bucket.put(key, gz);

  return { key, bytes: gz.byteLength, consumedRowKeys: rows.map(([k]) => k) };
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
    await txn.delete(packed.consumedRowKeys);
  });
}
