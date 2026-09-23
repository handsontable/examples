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
  HEARTBEAT_STORAGE_KEY,
  PACK_ALARM_INTERVAL_MS,
  PACK_AT_BYTES,
  wakeStorageKey,
  type AlertState,
  type Heartbeat,
  type Tenant,
  type WakeState,
} from "@handsontable/demo-runtime/telemetry";
import type { Env, IngestItem, InboxWriterApi, IngestResult } from "../env.js";
import { checkDuplicates } from "./dedupe.js";
import { newFingerprintWrites } from "./registry.js";
import { appendRows, commitPackedObject, packTenant, pendingRowsByTenant, ROW_SEQ_STORAGE_KEY } from "./pack.js";
import type { StorageLike } from "./storage.js";
import {
  backlogOldestAgeMs,
  newFingerprintsSince,
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
      const accepted = items.filter((i) => !dedupe.duplicates.has(i.hash));

      const append = await appendRows(
        txn,
        tenant,
        arrivalMs,
        accepted.map((i) => i.record),
      );

      const fingerprints = accepted.map((i) => i.fingerprint).filter((fp): fp is string => Boolean(fp));
      const fpWrites = await newFingerprintWrites(txn, fingerprints, arrivalMs);

      const heartbeat = (await txn.get<Heartbeat>(HEARTBEAT_STORAGE_KEY)) ?? { lastCron: 0, lastIngest: 0 };

      await txn.put<unknown>({
        ...dedupe.writes,
        ...append.writes,
        [ROW_SEQ_STORAGE_KEY]: append.nextRowSeq,
        ...fpWrites,
        [HEARTBEAT_STORAGE_KEY]: { ...heartbeat, lastIngest: arrivalMs } satisfies Heartbeat,
      });

      return {
        results: items.map((i) => ({
          hash: i.hash,
          outcome: (dedupe.duplicates.has(i.hash) ? "duplicate" : "accepted") as "duplicate" | "accepted",
        })),
        bytesAdded: append.bytesAdded,
      };
    });

    // Alarm scheduling is outside the transaction — `getAlarm`/`setAlarm`
    // are not part of `DurableObjectTransaction`'s surface.
    await this.schedulePackAlarm(storage, result.bytesAdded);

    return { results: result.results };
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

  /** ADR §B.2 step 6: one gzipped NDJSON object per tenant, packed from
   *  every pending row, `seq`/`key:<key>`/row-deletion committed atomically
   *  per object (`pack.ts#commitPackedObject`). */
  async alarm(): Promise<void> {
    const storage = adaptStorage(this.ctx.storage);
    const byTenant = await pendingRowsByTenant(storage);
    for (const [tenant, rows] of byTenant) {
      const packed = await packTenant(storage, this.env.O11Y_INBOX, tenant, rows);
      if (packed) await commitPackedObject(storage, packed);
    }
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

  async newFingerprintsSince(sinceMs: number): Promise<string[]> {
    return newFingerprintsSince(adaptStorage(this.ctx.storage), sinceMs);
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
