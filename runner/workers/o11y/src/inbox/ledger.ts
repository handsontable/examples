// The ledger (ADR §B.3, task "Ledger" scope): `written` → `provisional(wakeId)`
// → `committed` | `rejected` transitions, resolved at every cron tick and at
// the start of each wake, plus `backlog()` and the manual `reopen` window.
// Pure functions over `StorageLike` (T02's pattern — see `storage.ts`'s
// header): no direct `DurableObjectStorage`/R2 import, so every rule here is
// unit-testable over `memoryStorage()` without a real DO. `inbox/writer.ts`
// (the real `InboxWriter` DO, T02's file — T03 adds RPC methods to it per
// COMMON.md interface 1's explicit "further methods are added by ... T03
// (ledger/backlog)") wires these against the real storage/R2/GrafanaBox stub.

import {
  inboxKeyStorageKey,
  parseInboxKey,
  wakeStorageKey,
  type InboxKeyState,
  type WakeState,
} from "@handsontable/demo-runtime/telemetry";
import type { StorageLike } from "./storage.js";

const WAKE_PREFIX = "wake:";
const KEY_PREFIX = "key:";

function wakeIdOf(storageKey: string): string {
  return storageKey.slice(WAKE_PREFIX.length);
}
function inboxKeyOf(storageKey: string): string {
  return storageKey.slice(KEY_PREFIX.length);
}

export interface LedgerDeps {
  /** Best-available "is the box still running the wake the ledger thinks is
   *  current" signal (`GrafanaBox.isAwake()`, box.ts, T03 — see that file's
   *  doc comment on why this is `getState()`-backed, not the container's
   *  live flag directly, and the delta this is recorded under). Called with
   *  no wakeId: the invariant `recordWake` maintains (COMMON.md interface 1
   *  — every earlier wake marked `over: true` before a new one starts) means
   *  at most one wake is ever not-over at a time, so "is the box running"
   *  and "is THAT wake still running" are the same question. */
  isBoxRunning(): Promise<boolean>;
  /** `state/wakes/<wakeId>/clean` exists in the Loki bucket (ADR §A/§B.3). */
  markerExists(wakeId: string): Promise<boolean>;
}

export interface WakeResolution {
  wakeId: string;
  reason: WakeState["reason"];
  clean: boolean;
  keysAffected: number;
}

export interface ResolveResult {
  /** wakeIds newly marked `over: true` this call (either because a newer
   *  wake already superseded them via `recordWake`, or because this call
   *  observed the box not running). */
  newlyOver: string[];
  /** Every wake whose marker was checked this call — a superset of
   *  `newlyOver` when an earlier call already marked a wake over but a
   *  crash before its keys were resolved left it pending (the defensive
   *  branch below). `keysAffected` can be 0 (an already-clean-drained wake
   *  with nothing left provisional) — still included, since the o11y.wake
   *  clean/unclean point (box.ts's `writer.ts#resolveWakes`) is about the
   *  wake's own outcome, not whether it happened to have keys left. */
  resolved: WakeResolution[];
}

/**
 * ADR §B.3: "at each cron tick and at the start of each wake, InboxWriter
 * resolves every wake that still owns provisional keys and is over."
 *
 * A wake is over when a newer wake has started (already reflected as
 * `over: true` by `recordWake` — nothing further to do here beyond noticing
 * it still has unresolved provisional keys) or when the box is observed not
 * running (this function's own job: mark it over, then resolve). A wake
 * still running is left alone entirely — its provisional keys are not even
 * inspected, so a box kept awake by a Grafana visitor never touches its own
 * in-flight drain's keys (task acceptance criterion).
 */
export async function resolveOverWakes(storage: StorageLike, deps: LedgerDeps): Promise<ResolveResult> {
  const wakes = await storage.list<WakeState>({ prefix: WAKE_PREFIX });
  const newlyOver: string[] = [];
  const resolved: WakeResolution[] = [];

  for (const [storageKey, wake] of wakes) {
    const wakeId = wakeIdOf(storageKey);
    const hasProvisional = await hasUnresolvedProvisionalKeys(storage, wakeId);

    if (!wake.over) {
      const stillRunning = await deps.isBoxRunning();
      if (stillRunning) continue; // leave alone — this is the active wake
      // Mark over first (a separate write from the key resolution below —
      // deliberately not one transaction: if the process is interrupted
      // between the two, the wake is left `over: true` with unresolved
      // keys, which the branch below catches on the very next call, rather
      // than a half-applied transaction leaving ambiguous state).
      await storage.put({ [storageKey]: { ...wake, over: true } satisfies WakeState });
      newlyOver.push(wakeId);
    } else if (!hasProvisional) {
      // Already over and nothing left to resolve — the common case for
      // every wake this function has already fully processed in a prior
      // call. Skip the (otherwise harmless but pointless) marker re-check.
      continue;
    }

    // F3: a wake that never pushed anything durable — no key was EVER
    // marked `provisional` under this wakeId — is trivially clean. Loki
    // only writes `state/wakes/<wakeId>/clean` after confirming a NEW
    // index upload (shutdown.sh), and a Loki process that ingested zero
    // lines this wake never produces one — requiring the marker here would
    // count every empty backlog/visit wake as "unclean" and inflate exit
    // criterion 12's count for a wake that lost nothing (there was nothing
    // provisional to lose). A wake that DID push something (`hasProvisional`)
    // still needs the real marker — T01's C1 guarantee (a new
    // uploader-named index object) is unchanged for that case.
    const clean = hasProvisional ? await deps.markerExists(wakeId) : true;
    const affected = await resolveProvisionalKeysForWake(storage, wakeId, clean);
    resolved.push({ wakeId, reason: wake.reason, clean, keysAffected: affected });
  }

  return { newlyOver, resolved };
}

async function hasUnresolvedProvisionalKeys(storage: StorageLike, wakeId: string): Promise<boolean> {
  const keys = await storage.list<InboxKeyState>({ prefix: KEY_PREFIX });
  const marker = `provisional:${wakeId}`;
  for (const state of keys.values()) {
    if (state === marker) return true;
  }
  return false;
}

async function resolveProvisionalKeysForWake(storage: StorageLike, wakeId: string, clean: boolean): Promise<number> {
  const keys = await storage.list<InboxKeyState>({ prefix: KEY_PREFIX });
  const marker = `provisional:${wakeId}`;
  const writes: Record<string, InboxKeyState> = {};
  for (const [storageKey, state] of keys) {
    if (state === marker) writes[storageKey] = clean ? "committed" : "written";
  }
  const count = Object.keys(writes).length;
  if (count > 0) await storage.put(writes);
  return count;
}

// ---- backlog() ---------------------------------------------------------------

export interface InboxObjectInfo {
  key: string;
  size: number;
  /** R2's own `uploaded` timestamp — the exact object age, not an estimate
   *  derived from the key's own hour-bucket prefix (which would only be
   *  accurate to the hour and, worse, systematically UNDERSTATES age by up
   *  to 59 minutes if read as "now - the hour boundary", wrongly wakes the
   *  box early, and inflates the wake count exit criterion 7's cost model
   *  is measured against — an R2 `list()` already returns `uploaded` per
   *  object at no extra request cost, so there is no reason to approximate). */
  uploaded: Date;
}

export interface BacklogInfo {
  /** 0 when there is no backlog (nothing `written`). */
  oldestWrittenAgeMs: number;
  totalBytes: number;
  writtenCount: number;
  drainsPaused: boolean;
}

/**
 * `backlog()` "over `written` keys only, computed after that resolution"
 * (ADR §B.3) — callers must run {@link resolveOverWakes} first in the same
 * call (`InboxWriter.backlog()`, writer.ts, does this).
 */
export async function computeBacklog(
  storage: StorageLike,
  listInboxObjects: () => Promise<InboxObjectInfo[]>,
  drainsPaused: boolean,
): Promise<BacklogInfo> {
  const keys = await storage.list<InboxKeyState>({ prefix: KEY_PREFIX });
  const written = new Set<string>();
  for (const [storageKey, state] of keys) {
    if (state === "written") written.add(inboxKeyOf(storageKey));
  }
  if (written.size === 0) {
    return { oldestWrittenAgeMs: 0, totalBytes: 0, writtenCount: 0, drainsPaused };
  }

  const objects = await listInboxObjects();
  let totalBytes = 0;
  let oldestUploadedMs: number | null = null;
  for (const obj of objects) {
    if (!written.has(obj.key)) continue;
    totalBytes += obj.size;
    const t = obj.uploaded.getTime();
    if (oldestUploadedMs === null || t < oldestUploadedMs) oldestUploadedMs = t;
  }

  return {
    oldestWrittenAgeMs: oldestUploadedMs === null ? 0 : Math.max(0, Date.now() - oldestUploadedMs),
    totalBytes,
    writtenCount: written.size,
    drainsPaused,
  };
}

// ---- Drain support: ordering, provisional marking, rejection -----------------

/**
 * `written` keys, in key order (ascending string sort). The inbox key format
 * (`inbox/<tenant>/<yyyy-mm-dd>/<hh>/<seq:012d>.ndjson.gz`) sorts
 * chronologically within a tenant by construction, so this single sort
 * already satisfies "re-opened keys first, then new `written` keys, in key
 * order" (ADR §B.3/task Scope) without tracking "was this key re-opened"
 * separately: a re-opened key is, by definition, older than any key from the
 * current wake, so it already sorts first. Cross-tenant interleaving is
 * irrelevant — Loki isolates ingester state per `X-Scope-OrgID` tenant, so
 * ordering only has to hold within one tenant's own keys, which it does. */
export async function nextWrittenKeys(storage: StorageLike, limit: number): Promise<string[]> {
  const keys = await storage.list<InboxKeyState>({ prefix: KEY_PREFIX });
  const written: string[] = [];
  for (const [storageKey, state] of keys) {
    if (state === "written") written.push(inboxKeyOf(storageKey));
  }
  written.sort();
  return written.slice(0, limit);
}

/** A key becomes `provisional(wakeId)` only after all its requests returned
 *  `2xx` (ADR §B.3) — called once per successfully-pushed key. */
export async function markKeysProvisional(storage: StorageLike, wakeId: string, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  const writes: Record<string, InboxKeyState> = {};
  for (const key of keys) writes[inboxKeyStorageKey(key)] = `provisional:${wakeId}`;
  await storage.put(writes);
}

/** A `400` (e.g. `too_far_behind`) marks the key `rejected`, logged with
 *  Loki's message (ADR §B.3) — never retried by a later wake. */
export async function rejectKey(storage: StorageLike, key: string, reason: string): Promise<void> {
  await storage.put({ [inboxKeyStorageKey(key)]: `rejected:${reason}` satisfies InboxKeyState });
}

// ---- Manual reopen (POST /grafana/_o11y/reopen) -------------------------------

export interface ReopenResult {
  reopened: number;
}

/**
 * Re-opens every key (any state) whose inbox-key hour bucket overlaps
 * `[fromMs, toMs)`, except a key `provisional:<activeWakeId>` — reopening a
 * key an in-flight drain is actively working is not a "manual re-open," it
 * is corruption of that drain's own bookkeeping. `activeWakeId` is the
 * current not-over wake, if any (`null` when the box is fully stopped).
 */
export async function reopenWindow(
  storage: StorageLike,
  fromMs: number,
  toMs: number,
  activeWakeId: string | null,
): Promise<ReopenResult> {
  const keys = await storage.list<InboxKeyState>({ prefix: KEY_PREFIX });
  const protectedState = activeWakeId ? `provisional:${activeWakeId}` : null;
  const writes: Record<string, InboxKeyState> = {};

  for (const [storageKey, state] of keys) {
    if (state === "written") continue; // already open
    if (protectedState && state === protectedState) continue; // in-flight — protected

    const inboxKey = inboxKeyOf(storageKey);
    const parsed = parseInboxKey(inboxKey);
    if (!parsed) continue;

    const hourStart = Date.UTC(
      Number(parsed.date.slice(0, 4)),
      Number(parsed.date.slice(5, 7)) - 1,
      Number(parsed.date.slice(8, 10)),
      Number(parsed.hour),
    );
    const hourEnd = hourStart + 60 * 60 * 1000;
    if (hourEnd <= fromMs || hourStart >= toMs) continue; // no overlap

    writes[storageKey] = "written";
  }

  const reopened = Object.keys(writes).length;
  if (reopened > 0) await storage.put(writes);
  return { reopened };
}

/** The current not-over wake's id, or `null` (fully stopped). Used by the
 *  reopen route to protect an in-flight drain (see {@link reopenWindow}) and
 *  by drain/wake orchestration to know "which wakeId am I." */
export async function currentWakeId(storage: StorageLike): Promise<string | null> {
  const wakes = await storage.list<WakeState>({ prefix: WAKE_PREFIX });
  for (const [storageKey, wake] of wakes) {
    if (!wake.over) return wakeIdOf(storageKey);
  }
  return null;
}

export { wakeStorageKey };
