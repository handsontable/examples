// `InboxWriter` — the one owner of the inbox lifecycle (ADR §B.2). Real
// implementation (T02); was a do-nothing T00 scaffold stub (see the header
// this file replaces, preserved in git history).
//
// A thin RPC shell: every real decision lives in the pure, storage-agnostic
// modules next to this file (`dedupe.ts`, `registry.ts`, `pack.ts`) so they
// are unit-testable over `storage.ts#memoryStorage()` without a real DO
// (TESTING.md's "in-memory fakes for worker bindings" — see
// `pipeline/o11y-inbox.test.mjs`).

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
import { checkDuplicates } from "./dedupe.js";
import { newFingerprintWrites } from "./registry.js";
import { o11ySelfIdentity } from "../normalise/respond.js";
import { writePointFromDo } from "../normalise/points.js";
// Aliased to `ledger*` (not, e.g., a bare `nextWrittenKeys`): every one of
// these names also names a class method below with the identical public
// signature (the thin-shell pattern this file's header describes). A bare
// import name and a same-named class method do not actually collide in JS
// (a class method is reachable only via `this.method`, never as a bare
// identifier inside another method's body — the bare name always resolves
// to this module's top-level import), but aliasing removes any doubt for a
// reader, rather than relying on that scoping rule holding.
import {
  commitKeys as ledgerCommitKeys,
  computeBacklog as ledgerComputeBacklog,
  currentWakeId as ledgerCurrentWakeId,
  markKeysProvisional as ledgerMarkKeysProvisional,
  nextWrittenKeys as ledgerNextWrittenKeys,
  pruneLedger,
  recentRejectionCount as ledgerRecentRejectionCount,
  recordPartialReject as ledgerRecordPartialReject,
  rejectKey as ledgerRejectKey,
  reopenWindow as ledgerReopenWindow,
  reopenWindowExceedsRetention,
  resolveOverWakes,
  takeReopenedFlag as ledgerTakeReopenedFlag,
  type InboxObjectInfo,
} from "./ledger.js";
import { appendRows, collectRowBatch, commitPackedObject, migrateLegacyRows, packTenant, ROW_SEQ_STORAGE_KEY } from "./pack.js";
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

const CLEAN_MARKER_PREFIX = "state/wakes/";
/** Where `pruneStorage` persists `pruneFingerprintRegistry`'s resume cursor
 *  between cron ticks — not a contract-named key (internal housekeeping
 *  state only, like `pack.ts`'s own `rowSeq`). */
const FP_PRUNE_CURSOR_STORAGE_KEY = "fpPruneCursor";

/** Paginates `O11Y_INBOX.list()` under `inbox/` into the shape `ledger.ts`
 *  needs — R2 `list()` returns up to 1000 objects per page and, per key,
 *  `.size`/`.uploaded` at no extra request cost (T03-D, see the task
 *  Outcome: chosen over a `.head()` per key, which would cost one
 *  subrequest per backlog key on every cron tick). */
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

/** `this.ctx.storage` (a real `DurableObjectStorage`) adapted to
 *  {@link StorageLike} — see `storage.ts`'s header for why `get`/`getMany`
 *  are split rather than mirrored as one overloaded method.
 *
 *  Also used, recursively, to adapt the `txn` a real `transaction()` call
 *  hands its closure — a `DurableObjectTransaction` has `get`/`getMany`
 *  (via the same overloaded `get`)/`put`/`delete`/`list`, but **not**
 *  `transaction`/`getAlarm`/`setAlarm`. Every call site in this file only
 *  ever uses `get`/`getMany`/`put`/`delete`/`list` on a *nested* (already
 *  inside a `transaction()` callback) `StorageLike` — calling the other
 *  three on one would throw at runtime, since the underlying object
 *  genuinely has no such method; nothing here does. */
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

  async ingest(tenant: Tenant, arrivalMs: number, items: IngestItem[]): Promise<IngestResult> {
    const storage = adaptStorage(this.ctx.storage);

    const result = await storage.transaction(async (txn) => {
      const hashes = items.map((i) => i.hash);
      const dedupe = await checkDuplicates(txn, hashes, arrivalMs);
      // F5-batch fix: filter by OCCURRENCE (index), never by hash — the
      // first copy of an in-batch repeat is the one stored, later copies
      // are duplicates. See `DedupeResult.isDuplicate`.
      const accepted = items.filter((_, idx) => !dedupe.isDuplicate[idx]);

      // A-I4 remainder (closed, second wave): a `record`-less item (an
      // `example.*` Faro event, `normalise/faro.ts`) still goes through the
      // dedupe/fingerprint bookkeeping above — the whole point is giving it
      // the same hash/dedupe transaction every other item gets — but must
      // never produce a `row:` entry (§6: AE points only, never stored).
      const append = await appendRows(
        txn,
        tenant,
        arrivalMs,
        accepted.map((i) => i.record).filter((r): r is NormalisedRecord => r !== undefined),
      );

      const fingerprints = accepted.map((i) => i.fingerprint).filter((fp): fp is string => Boolean(fp));
      const fpWrites = await newFingerprintWrites(txn, fingerprints, arrivalMs);

      const heartbeat = (await txn.get<Heartbeat>(HEARTBEAT_STORAGE_KEY)) ?? { lastCron: 0, lastIngest: 0 };

      // N2: a 200-item Faro batch (A-I4's own per-request cap) can produce
      // up to 200 dedupe.writes + 200*2 fpWrites (fp:/fpts: pairs) entries
      // in one call — well over the real DO storage 128-key put() limit.
      await putChunked<unknown>(txn, {
        ...dedupe.writes,
        ...append.writes,
        [ROW_SEQ_STORAGE_KEY]: append.nextRowSeq,
        ...fpWrites,
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

  // ---- T03 additions (ledger, backlog, drain support) --------------------

  async resolveWakes(): Promise<void> {
    const storage = adaptStorage(this.ctx.storage);
    const { resolved } = await resolveOverWakes(storage, {
      isBoxRunning: () => getGrafanaBoxStub(this.env).isAwake(),
      markerExists: async (wakeId) => {
        const head = await this.env.O11Y_LOKI_STATE.head(`${CLEAN_MARKER_PREFIX}${wakeId}/clean`);
        return head !== null;
      },
    });
    // ADR §5's `o11y.wake` "outcome: clean, unclean" — written here, at
    // resolution time, because only the ledger (not `box.ts`, which writes
    // its own `o11y.wake` at wake-start with `duration_ms` instead) ever
    // learns whether a wake's stop was clean.
    for (const w of resolved) {
      writePointFromDo(
        this.env,
        this.ctx,
        toAePoint(
          "o11y.wake",
          { count: 1 },
          { ...o11ySelfIdentity(this.env), reason: w.reason, outcome: w.clean ? "clean" : "unclean" },
        ),
      );
    }
  }

  async backlog(): Promise<{ oldestWrittenAgeMs: number; totalBytes: number; writtenCount: number; drainsPaused: boolean }> {
    await this.resolveWakes();
    const storage = adaptStorage(this.ctx.storage);
    // F2 fix (A-I1): housekeeping runs from the cron path (`backlog()`),
    // never the pack alarm (which only fires on ingest and would starve
    // pruning during a quiet period — see `ledger.ts#pruneLedger`'s doc
    // comment). Each call is individually bounded (a `start`/`end` range
    // read, never a full-prefix scan) and wrapped so a housekeeping failure
    // can never fail the backlog read itself, which the cron/drain loop
    // depends on.
    await this.pruneStorage(storage);
    const drainsPaused = (await storage.get<boolean>(DRAINS_PAUSED_STORAGE_KEY)) ?? false;
    return ledgerComputeBacklog(storage, () => listInboxObjects(this.env.O11Y_INBOX), drainsPaused);
  }

  /** A-I1: bounded housekeeping for the three storage prefixes the final
   *  review flagged as never-deleted (`key:`/`done:`, `hash:`, `fp:`). Each
   *  sweep is independently try/caught — one failing must never prevent the
   *  others from running, or prevent `backlog()` from answering. */
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
      const cursor = (await storage.get<string | null>(FP_PRUNE_CURSOR_STORAGE_KEY)) ?? null;
      const result = await pruneFingerprintRegistry(storage, nowMs, undefined, cursor);
      await storage.put({ [FP_PRUNE_CURSOR_STORAGE_KEY]: result.nextCursor });
    } catch (err) {
      console.error(JSON.stringify({ event: "o11y.prune.error", target: "fingerprint", message: String(err) }));
    }
  }

  async nextWrittenKeys(limit: number): Promise<string[]> {
    return ledgerNextWrittenKeys(adaptStorage(this.ctx.storage), limit);
  }

  // Fix round (finding B-M5): lets `box.ts#drainStepBody` know whether the
  // batch it just pushed replayed any reopened keys, so its `o11y.drain`
  // point can emit `reason: "reopen"` — see `ledger.ts#takeReopenedFlag`'s
  // own doc comment.
  async takeReopenedFlag(inboxKeys: string[]): Promise<boolean> {
    return ledgerTakeReopenedFlag(adaptStorage(this.ctx.storage), inboxKeys);
  }

  async markKeysProvisional(wakeId: string, keys: string[]): Promise<void> {
    await ledgerMarkKeysProvisional(adaptStorage(this.ctx.storage), wakeId, keys);
  }

  /** B-M4 fix (minor triage item 3): see `ledger.ts#commitKeys`'s own doc
   *  comment — a zero-bytes-pushed key commits directly, no wake/marker
   *  involved. */
  async commitKeys(keys: string[]): Promise<void> {
    await ledgerCommitKeys(adaptStorage(this.ctx.storage), keys);
  }

  async rejectKey(key: string, reason: string): Promise<void> {
    await ledgerRejectKey(adaptStorage(this.ctx.storage), key, reason);
  }

  /** Row 19 (drain partial-400 durability): logs a rejection EVENT for a
   *  key whose ledger state stays `provisional`/`done:` (its accepted
   *  chunks are durable, per §B.3) — see `ledger.ts#recordPartialReject`'s
   *  own doc comment. */
  async recordPartialReject(key: string, reason: string): Promise<void> {
    await ledgerRecordPartialReject(adaptStorage(this.ctx.storage), key, reason);
  }

  /** B-C1/A-I1 remainder: count of `rejectedEvent:` entries newer than
   *  `sinceMs` — `alerts/rules.ts#rejectedKeyRule` reads this instead of
   *  the never-pruned `rejectedKeyCount()` total, so the alert can resolve
   *  once rejections stop, not fire forever after the first one. */
  async recentRejectionCount(sinceMs: number): Promise<number> {
    return ledgerRecentRejectionCount(adaptStorage(this.ctx.storage), sinceMs);
  }

  /** B-M9: a window wider than {@link KEY_RETENTION_MS} is refused outright
   *  (defense in depth alongside `grafana/reopen.ts`'s own check — see that
   *  file's doc comment): nothing that old can exist any more (`done:`
   *  entries and Loki's own `reject_old_samples_max_age` are both 7d), so a
   *  wider request would otherwise scan for nothing while still paying the
   *  full `done:`/`key:` read cost. */
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
   *  ingest call alone crosses `PACK_AT_BYTES` (T02-D, see the task
   *  Outcome: this approximates the contract's "4 MB stored" as "4 MB in one
   *  request," not a running total across many small requests — the 60 s
   *  alarm always catches the remainder regardless, so nothing is lost,
   *  only possibly packed a little later than a true running counter
   *  would). Never moves an alarm *earlier* than one already scheduled for
   *  "now." */
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

  /** ADR §B.2 step 6: gzipped NDJSON objects per tenant, `seq`/`key:<key>`/
   *  row-deletion committed atomically per object (`pack.ts#commitPackedObject`).
   *
   *  Fix round (finding R-A-I2, rereview.md "the pack alarm lists EVERY
   *  pending row, with full content, into memory before the cap" — the F1
   *  fix round only bounded the OBJECT's size, not this read): the old
   *  `pendingRowsByTenant(storage)` call above loaded every pending row
   *  across BOTH tenants into memory in one `list()`, unbounded by design —
   *  a sustained ingest flood fills the pending set faster than 60 s alarms
   *  can drain it, and this read grows right along with it, eventually
   *  exceeding the DO's 128 MB memory and retrying forever against an
   *  ever-larger set (pipeline's own flood test proves the old function's
   *  read size instead).
   *
   *  Two bounded steps, in order:
   *  1. `migrateLegacyRows` — rewrites any un-padded `row:<n>` key (written
   *     before this fix deployed) into the new zero-padded shape, a small
   *     batch at a time. Runs to COMPLETION (this alarm invocation reschedules
   *     and returns without packing anything while any remain) before any
   *     packing — a row written before the fix must never be packed AFTER
   *     one written after it, which native key order alone cannot guarantee
   *     while both shapes coexist (see `pack.ts`'s "bounded reads" header).
   *  2. `collectRowBatch` — pages `row:` in small chunks, accumulated up to
   *     one packed object's own byte budget, then packed/committed per
   *     tenant present in that bounded batch. Looped until nothing remains
   *     or `MAX_OBJECTS_PER_ALARM` objects have been packed this invocation
   *     (a large backlog is packed over several alarm invocations, not one
   *     unbounded loop competing with the Worker's own CPU limit),
   *     rescheduling immediately (`setAlarm(Date.now())`) when objects
   *     remain. */
  async alarm(): Promise<void> {
    const MAX_OBJECTS_PER_ALARM = 25;
    const storage = adaptStorage(this.ctx.storage);

    const migrated = await migrateLegacyRows(storage);
    if (migrated > 0) {
      await storage.setAlarm(Date.now());
      return;
    }

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

  // ---- T04 additions: alerts, watchdog, the o11y spend cap ---------------
  // Thin RPC shells only — every real rule lives in `alerts/inbox-state.ts`
  // (pure over `StorageLike`, same split `dedupe.ts`/`registry.ts`/`pack.ts`
  // already use), so it is unit-testable without a real Durable Object.

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
