// `InboxWriter` — the one owner of the inbox lifecycle (ADR §B.2). A thin
// RPC shell: every real decision lives in the pure, storage-agnostic
// modules next to this file (`dedupe.ts`, `registry.ts`, `pack.ts`) so
// they are unit-testable over `storage.ts#memoryStorage()` without a real
// DO.

import { DurableObject } from "cloudflare:workers";
import {
  DRAINS_PAUSED_STORAGE_KEY,
  HEARTBEAT_STORAGE_KEY,
  PACK_ALARM_INTERVAL_MS,
  PACK_AT_BYTES,
  toAePoint,
  wakeStorageKey,
  type AlertState,
  type Heartbeat,
  type NormalisedRecord,
  type Tenant,
  type WakeState,
} from "@handsontable/demo-runtime/telemetry";
import type { Env, IngestItem, InboxWriterApi, IngestResult } from "../env.js";
import {
  admissionDroppedSince,
  admissionKey,
  FP_ADMIT_PER_WINDOW,
  HASH_ADMIT_PER_WINDOW,
  pruneAdmissionWindows,
  readAdmissionWindow,
} from "./admission.js";
import { capHashWrites, checkDuplicates } from "./dedupe.js";
import {
  admitNewFingerprints,
  evictOldestFingerprints,
  FP_COUNT_STORAGE_KEY,
  FP_PRUNE_CURSOR_STORAGE_KEY,
  readFpCount,
} from "./registry.js";
import { o11ySelfIdentity } from "../normalise/respond.js";
import { writePointFromDo } from "../normalise/points.js";
// Aliased to `ledger*`: every one of these names also names a class method
// below with the identical signature; aliasing removes any doubt about
// which one a reader means, even though the bare import always wins in JS.
import {
  commitKeys as ledgerCommitKeys,
  computeBacklog as ledgerComputeBacklog,
  currentWakeId as ledgerCurrentWakeId,
  markKeysProvisional as ledgerMarkKeysProvisional,
  nextWrittenKeys as ledgerNextWrittenKeys,
  pruneLedger,
  recentRejectionCount as ledgerRecentRejectionCount,
  recordPartialReject as ledgerRecordPartialReject,
  recordWakeReady as ledgerRecordWakeReady,
  rejectKey as ledgerRejectKey,
  reopenWindow as ledgerReopenWindow,
  reopenWindowExceedsRetention,
  resolveOverWakes,
  takeReopenedFlag as ledgerTakeReopenedFlag,
  type InboxObjectInfo,
} from "./ledger.js";
import { appendRows, collectRowBatch, commitPackedObject, packTenant, ROW_SEQ_STORAGE_KEY } from "./pack.js";
import { putChunked } from "./storage.js";
import { pruneHashBuckets } from "./dedupe.js";
import { pruneFingerprintRegistry } from "./registry.js";
import type { StorageLike } from "./storage.js";
import {
  backlogOldestAgeMs,
  newFingerprintsAfterKey,
  readAlertMeta,
  readAlertState,
  readDrainsPaused,
  readHeartbeat,
  rejectedKeyCount,
  writeAlertMeta,
  writeAlertState,
  writeCronHeartbeat,
  writeDrainsPaused,
} from "../alerts/inbox-state.js";
import { getGrafanaBoxStub } from "../box.js";
import { markerExists } from "./marker.js";

/** Paginates `O11Y_INBOX.list()` under `inbox/` into the shape `ledger.ts`
 *  needs — cheaper than a `.head()` per key, which would cost one
 *  subrequest per backlog key on every cron tick. */
async function listInboxObjects(bucket: R2Bucket): Promise<InboxObjectInfo[]> {
  const out: InboxObjectInfo[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await bucket.list({ prefix: "inbox/", cursor, limit: 1000 });
    for (const obj of page.objects) out.push({ key: obj.key, size: obj.size, uploaded: obj.uploaded });
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  return out;
}

/** `this.ctx.storage` adapted to {@link StorageLike}. Also used,
 *  recursively, to adapt a real `transaction()` call's own `txn` — a
 *  `DurableObjectTransaction` has `get`/`getMany`/`put`/`delete`/`list` but
 *  not `transaction`/`getAlarm`/`setAlarm`; every call site in this file
 *  only uses the shared subset on a nested `StorageLike`. */
function adaptStorage(storage: DurableObjectStorage): StorageLike {
  return {
    get: <T>(key: string) => storage.get<T>(key),
    getMany: <T>(keys: string[]) => storage.get<T>(keys),
    put: (entries) => storage.put(entries),
    delete: (keys) => storage.delete(keys),
    list: (options) => storage.list(options),
    transaction: (closure) => storage.transaction((txn) => closure(adaptStorage(txn as unknown as DurableObjectStorage))),
    getAlarm: () => storage.getAlarm(),
    setAlarm: (t) => storage.setAlarm(t),
  };
}

export class InboxWriter extends DurableObject<Env> implements InboxWriterApi {
  async recordWake(wakeId: string, reason: "backlog" | "visit"): Promise<void> {
    const storage = adaptStorage(this.ctx.storage);
    await storage.transaction(async (txn) => {
      const existingWakes = await txn.list<WakeState>({ prefix: "wake:" });
      const writes: Record<string, WakeState> = {};
      for (const [key, wake] of existingWakes) {
        if (!wake.over) writes[key] = { ...wake, over: true };
      }
      writes[wakeStorageKey(wakeId)] = { startedAt: Date.now(), reason, over: false };
      await txn.put(writes);
    });
  }

  async recordWakeReady(wakeId: string, readyMs: number): Promise<void> {
    await ledgerRecordWakeReady(adaptStorage(this.ctx.storage), wakeId, readyMs);
  }

  async ingest(tenant: Tenant, arrivalMs: number, items: IngestItem[]): Promise<IngestResult> {
    const storage = adaptStorage(this.ctx.storage);

    const result = await storage.transaction(async (txn) => {
      const hashes = items.map((i) => i.hash);
      const dedupe = await checkDuplicates(txn, hashes, arrivalMs);
      const window = await readAdmissionWindow(txn, arrivalMs);
      const hashAdmission = capHashWrites(dedupe.writes, HASH_ADMIT_PER_WINDOW - window.hash);
      // Filter by OCCURRENCE (index), never by hash — the first copy of an
      // in-batch repeat is the one stored, later copies are duplicates. See
      // `DedupeResult.isDuplicate`.
      const accepted = items.filter((_, idx) => !dedupe.isDuplicate[idx]);

      // A `record`-less item still goes through the dedupe/fingerprint
      // bookkeeping above but must never produce a `row:` entry (§6: AE
      // points only, never stored).
      const append = await appendRows(
        txn,
        tenant,
        arrivalMs,
        accepted.map((i) => i.record).filter((r): r is NormalisedRecord => r !== undefined),
      );

      const fingerprints = accepted.map((i) => i.fingerprint).filter((fp): fp is string => Boolean(fp));
      const fpAdmission = await admitNewFingerprints(txn, fingerprints, arrivalMs, FP_ADMIT_PER_WINDOW - window.fp);
      const hasCounts = fpAdmission.admitted + fpAdmission.dropped + Object.keys(hashAdmission.writes).length + hashAdmission.dropped > 0;
      // Counters ride the same transaction as the writes they count.
      const counters: Record<string, unknown> = {};
      if (hasCounts) {
        counters[admissionKey(arrivalMs)] = {
          fp: window.fp + fpAdmission.admitted,
          fpDropped: window.fpDropped + fpAdmission.dropped,
          hash: window.hash + Object.keys(hashAdmission.writes).length,
          hashDropped: window.hashDropped + hashAdmission.dropped,
        };
      }
      if (fpAdmission.admitted > 0) counters[FP_COUNT_STORAGE_KEY] = (await readFpCount(txn)) + fpAdmission.admitted;

      const heartbeat = (await txn.get<Heartbeat>(HEARTBEAT_STORAGE_KEY)) ?? { lastCron: 0, lastIngest: 0 };

      // A 200-item Faro batch (the per-request cap) can produce up to 200
      // dedupe writes + 200*2 fp writes (fp:/fpts: pairs) entries in one
      // call — well over the real DO storage 128-key put() limit.
      await putChunked<unknown>(txn, {
        ...hashAdmission.writes,
        ...append.writes,
        [ROW_SEQ_STORAGE_KEY]: append.nextRowSeq,
        ...fpAdmission.writes,
        ...counters,
        [HEARTBEAT_STORAGE_KEY]: { ...heartbeat, lastIngest: arrivalMs } satisfies Heartbeat,
      });

      return {
        results: items.map((i, idx) => ({
          hash: i.hash,
          outcome: (dedupe.isDuplicate[idx] ? "duplicate" : "accepted") as "duplicate" | "accepted",
        })),
        bytesAdded: append.bytesAdded,
      };
    });

    // Alarm scheduling is outside the transaction — `getAlarm`/`setAlarm`
    // are not part of `DurableObjectTransaction`'s surface.
    await this.schedulePackAlarm(storage, result.bytesAdded);

    return { results: result.results };
  }

  // ---- Ledger, backlog, drain support -------------------------------------

  async resolveWakes(): Promise<void> {
    const storage = adaptStorage(this.ctx.storage);
    const { resolved } = await resolveOverWakes(storage, {
      isBoxRunning: () => getGrafanaBoxStub(this.env).isAwake(),
      markerExists: (wakeId) => markerExists(this.env, wakeId),
    });
    // Contract §5's `o11y.wake` point — written here since only the
    // ledger learns whether a wake's stop was clean. `recordWakeReady`
    // carries the wake-to-ready time here on both the clean and unclean
    // path; a wake whose box never became ready writes 0 deliberately.
    for (const w of resolved) {
      writePointFromDo(
        this.env,
        this.ctx,
        toAePoint(
          "o11y.wake",
          { count: 1, duration_ms: w.readyMs ?? 0 },
          { ...o11ySelfIdentity(this.env), reason: w.reason, outcome: w.clean ? "clean" : "unclean" },
        ),
      );
    }
  }

  async backlog(): Promise<{ oldestWrittenAgeMs: number; totalBytes: number; writtenCount: number; drainsPaused: boolean }> {
    await this.resolveWakes();
    const storage = adaptStorage(this.ctx.storage);
    // Housekeeping runs from the cron path, never the pack alarm (which
    // only fires on ingest and would starve pruning during a quiet
    // period) — see `pruneStorage`.
    await this.pruneStorage(storage);
    const drainsPaused = (await storage.get<boolean>(DRAINS_PAUSED_STORAGE_KEY)) ?? false;
    return ledgerComputeBacklog(storage, () => listInboxObjects(this.env.O11Y_INBOX), drainsPaused);
  }

  /** Bounded housekeeping for the three storage prefixes that would
   *  otherwise never be deleted. Each sweep is independently try/caught. */
  private async pruneStorage(storage: StorageLike): Promise<void> {
    const nowMs = Date.now();
    try {
      await pruneLedger(storage, nowMs);
    } catch (err) {
      console.error(JSON.stringify({ event: "o11y.prune.error", target: "ledger", message: String(err) }));
    }
    try {
      await pruneHashBuckets(storage, nowMs);
    } catch (err) {
      console.error(JSON.stringify({ event: "o11y.prune.error", target: "hash", message: String(err) }));
    }
    try {
      await pruneAdmissionWindows(storage, nowMs);
    } catch (err) {
      console.error(JSON.stringify({ event: "o11y.prune.error", target: "admission", message: String(err) }));
    }
    try {
      const cursor = (await storage.get<string | null>(FP_PRUNE_CURSOR_STORAGE_KEY)) ?? null;
      const result = await pruneFingerprintRegistry(storage, nowMs, undefined, cursor);
      await storage.put({ [FP_PRUNE_CURSOR_STORAGE_KEY]: result.nextCursor });
    } catch (err) {
      console.error(JSON.stringify({ event: "o11y.prune.error", target: "fingerprint", message: String(err) }));
    }
    try {
      await evictOldestFingerprints(storage);
    } catch (err) {
      console.error(JSON.stringify({ event: "o11y.prune.error", target: "fingerprint-evict", message: String(err) }));
    }
  }

  async nextWrittenKeys(limit: number, excludeTenants: Tenant[] = []): Promise<string[]> {
    return ledgerNextWrittenKeys(adaptStorage(this.ctx.storage), limit, excludeTenants);
  }

  // Lets `box.ts#drainStepBody` know whether the batch it just pushed
  // replayed any reopened keys, so its `o11y.drain` point can emit
  // `reason: "reopen"`.
  async takeReopenedFlag(inboxKeys: string[]): Promise<boolean> {
    return ledgerTakeReopenedFlag(adaptStorage(this.ctx.storage), inboxKeys);
  }

  async markKeysProvisional(wakeId: string, keys: string[]): Promise<void> {
    await ledgerMarkKeysProvisional(adaptStorage(this.ctx.storage), wakeId, keys);
  }

  /** See `ledger.ts#commitKeys` — a zero-bytes-pushed key commits directly,
   *  no wake/marker involved. */
  async commitKeys(keys: string[]): Promise<void> {
    await ledgerCommitKeys(adaptStorage(this.ctx.storage), keys);
  }

  async rejectKey(key: string, reason: string): Promise<void> {
    await ledgerRejectKey(adaptStorage(this.ctx.storage), key, reason);
  }

  /** Logs a rejection EVENT for a key whose ledger state stays
   *  `provisional`/`done:` — see `ledger.ts#recordPartialReject`. */
  async recordPartialReject(key: string, reason: string): Promise<void> {
    await ledgerRecordPartialReject(adaptStorage(this.ctx.storage), key, reason);
  }

  /** Count of `rejectedEvent:` entries newer than `sinceMs` — the
   *  rejected-key alert resolves once rejections stop. */
  async recentRejectionCount(sinceMs: number): Promise<number> {
    return ledgerRecentRejectionCount(adaptStorage(this.ctx.storage), sinceMs);
  }

  /** A window wider than {@link KEY_RETENTION_MS} is refused outright —
   *  nothing that old can still exist, so a wider request would otherwise
   *  scan for nothing while paying the full read cost. */
  async reopenWindow(fromMs: number, toMs: number): Promise<{ reopened: number }> {
    if (reopenWindowExceedsRetention(fromMs, toMs)) {
      throw new Error("reopenWindow: window exceeds the 7-day retention cap");
    }
    const storage = adaptStorage(this.ctx.storage);
    const active = await ledgerCurrentWakeId(storage);
    return ledgerReopenWindow(storage, fromMs, toMs, active);
  }

  async currentWakeId(): Promise<string | null> {
    return ledgerCurrentWakeId(adaptStorage(this.ctx.storage));
  }

  /** ADR §B.2 step 6: pack on a 60 s alarm, or immediately once a single
   *  ingest call crosses `PACK_AT_BYTES` — an approximation of "4 MB
   *  stored" as "4 MB in one request," not a running total; the 60 s alarm
   *  always catches the remainder. Never moves an alarm earlier than one
   *  already scheduled. */
  private async schedulePackAlarm(storage: StorageLike, bytesAdded: number): Promise<void> {
    const existing = await storage.getAlarm();
    if (bytesAdded >= PACK_AT_BYTES) {
      await storage.setAlarm(Date.now());
      return;
    }
    if (existing === null) {
      await storage.setAlarm(Date.now() + PACK_ALARM_INTERVAL_MS);
    }
  }

  /** ADR §B.2 step 6: gzipped NDJSON objects per tenant, committed
   *  atomically per object (`pack.ts#commitPackedObject`). Reads are
   *  bounded — `collectRowBatch` pages `row:` in small chunks up to one
   *  packed object's byte budget — and looped until nothing remains or
   *  `MAX_OBJECTS_PER_ALARM` objects have packed, rescheduling immediately
   *  when objects remain, so a sustained flood cannot grow past the DO's
   *  memory limit within one invocation. */
  async alarm(): Promise<void> {
    const MAX_OBJECTS_PER_ALARM = 25;
    const storage = adaptStorage(this.ctx.storage);

    let packedCount = 0;
    let more = false;
    for (;;) {
      if (packedCount >= MAX_OBJECTS_PER_ALARM) {
        more = true;
        break;
      }
      const batch = await collectRowBatch(storage); // bounded — see this method's own doc comment
      if (batch.length === 0) break;

      const byTenant = new Map<Tenant, [string, (typeof batch)[number][1]][]>();
      for (const entry of batch) {
        const list = byTenant.get(entry[1].tenant) ?? [];
        list.push(entry);
        byTenant.set(entry[1].tenant, list);
      }

      let packedAny = false;
      for (const [tenant, rows] of byTenant) {
        if (packedCount >= MAX_OBJECTS_PER_ALARM) {
          more = true;
          break;
        }
        const packed = await packTenant(storage, this.env.O11Y_INBOX, tenant, rows);
        if (!packed) continue;
        await commitPackedObject(storage, packed);
        packedCount++;
        packedAny = true;
      }
      if (more) break;
      if (!packedAny) break; // safety valve: nothing consumable in this batch
    }
    if (more) await storage.setAlarm(Date.now());
  }

  // ---- Alerts, watchdog, the o11y spend cap -------------------------------
  // Thin RPC shells only — every real rule lives in `alerts/inbox-state.ts`.

  async heartbeat(): Promise<Heartbeat> {
    return readHeartbeat(adaptStorage(this.ctx.storage));
  }

  async stampCronHeartbeat(nowMs: number): Promise<void> {
    await writeCronHeartbeat(adaptStorage(this.ctx.storage), nowMs);
  }

  async backlogOldestAgeMs(): Promise<number | null> {
    return backlogOldestAgeMs(adaptStorage(this.ctx.storage));
  }

  async rejectedKeyCount(): Promise<number> {
    return rejectedKeyCount(adaptStorage(this.ctx.storage));
  }

  async newFingerprintsAfterKey(
    afterKey: string | null,
    fallbackSinceMs: number,
  ): Promise<{ entries: { key: string; name: string; firstSeenMs: number }[]; truncated: boolean }> {
    return newFingerprintsAfterKey(adaptStorage(this.ctx.storage), afterKey, fallbackSinceMs);
  }

  async admissionDroppedSince(sinceMs: number): Promise<{ fpDropped: number; hashDropped: number }> {
    return admissionDroppedSince(adaptStorage(this.ctx.storage), sinceMs);
  }

  async alertState(rule: string): Promise<AlertState | undefined> {
    return readAlertState(adaptStorage(this.ctx.storage), rule);
  }

  async setAlertState(rule: string, state: AlertState): Promise<void> {
    await writeAlertState(adaptStorage(this.ctx.storage), rule, state);
  }

  async getAlertMeta(key: string): Promise<string | undefined> {
    return readAlertMeta(adaptStorage(this.ctx.storage), key);
  }

  async setAlertMeta(key: string, value: string): Promise<void> {
    await writeAlertMeta(adaptStorage(this.ctx.storage), key, value);
  }

  async drainsPaused(): Promise<boolean> {
    return readDrainsPaused(adaptStorage(this.ctx.storage));
  }

  async setDrainsPaused(paused: boolean): Promise<void> {
    await writeDrainsPaused(adaptStorage(this.ctx.storage), paused);
  }
}
