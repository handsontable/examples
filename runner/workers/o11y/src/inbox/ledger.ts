// The ledger (ADR §B.3): `written` → `provisional(wakeId)` → `committed` |
// `rejected` transitions, resolved at every cron tick and at the start of
// each wake, plus `backlog()` and the manual `reopen` window. Pure over
// `StorageLike` (unit-testable via `memoryStorage()`, no real DO needed).
// Bounded throughout: `key:`/`wake:` scans and `done:`/`hash:` pruning stay
// O(live rows), not O(all-time history) — see `pipeline/o11y-ledger-scale.test.mjs`.

import {
  doneKeyStorageKey,
  inboxKeyStorageKey,
  parseInboxKey,
  wakeStorageKey,
  type InboxKeyState,
  type Tenant,
  type WakeState,
} from "@handsontable/demo-runtime/telemetry";
import { deleteChunked, getManyChunked, putChunked, type StorageLike } from "./storage.js";

const WAKE_PREFIX = "wake:";
const KEY_PREFIX = "key:";
const DONE_PREFIX = "done:";
const PROVISIONAL_PREFIX = "provisional:";
// `nextWrittenKeys`'s sort order alone gives reopened keys drain priority,
// so `reopenWindow` also drops a one-shot `reopenmark:` per key it moves to
// `written`, consumed by `takeReopenedFlag` so the drain's `o11y.drain`
// point can report `reason: "reopen"`.
const REOPEN_MARK_PREFIX = "reopenmark:";
function reopenMarkStorageKey(inboxKey: string): string {
  return `${REOPEN_MARK_PREFIX}${inboxKey}`;
}

/** Contract §8: inbox objects live 7 days (R2 lifecycle) — `done:<key>`
 *  pruning and the manual-reopen window cap both use this same window. */
export const KEY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** How many `done:` rows one `pruneLedger` call may delete. Raised from 500
 *  — a 10-min cron at 500/tick tops out at 72,000/day, below ADR §D's 10×
 *  headroom projection of ~220,000/day. */
const PRUNE_BATCH_LIMIT = 5000;

function wakeIdOf(storageKey: string): string {
  return storageKey.slice(WAKE_PREFIX.length);
}
function inboxKeyOf(storageKey: string): string {
  return storageKey.slice(KEY_PREFIX.length);
}

export interface LedgerDeps {
  /** Best-available "is the box still running the wake the ledger thinks
   *  is current" signal (`GrafanaBox.isAwake()`), backed by `getState()`
   *  rather than the container's live flag. Called with no wakeId: at most
   *  one wake is ever not-over at a time. An outbound RPC briefly opens
   *  this DO's input gate; `resolveOverWakes` is written to be correct
   *  across that reopening. */
  isBoxRunning(): Promise<boolean>;
  /** `state/wakes/<wakeId>/clean` exists in the Loki bucket (ADR §A/§B.3).
   *  Also a real R2 `head()` call — same input-gate note as
   *  {@link isBoxRunning} applies. */
  markerExists(wakeId: string): Promise<boolean>;
}

export interface WakeResolution {
  wakeId: string;
  reason: WakeState["reason"];
  clean: boolean;
  keysAffected: number;
  /** The wake's `readyMs` as stored at resolution time (read inside the
   *  resolving transaction, so the freshest value) — `undefined` when the
   *  box never became ready during this wake. */
  readyMs?: number;
}

export interface ResolveResult {
  /** wakeIds newly marked `over: true` this call (either because a newer
   *  wake already superseded them via `recordWake`, or because this call
   *  observed the box not running). */
  newlyOver: string[];
  /** Every wake this call actually resolved (deleted `wake:<id>` for) —
   *  `keysAffected` can be 0 and still counts, since the `o11y.wake` point
   *  is about the wake's outcome, not whether it had keys left. */
  resolved: WakeResolution[];
}

/** Resolves a single wake's provisional keys against the marker, moving
 *  each to `done:`/`written` as appropriate and deleting `wake:<id>` — all
 *  inside one `storage.transaction()`, so a crash mid-way leaves the
 *  pre-transaction state rather than an orphaned partial write (chunked
 *  put/delete would otherwise leave keys stuck in `provisional:<wakeId>`
 *  forever). Re-reads each key's CURRENT state inside the transaction,
 *  rather than trusting a possibly-stale caller snapshot — a concurrent
 *  manual reopen can move a key back to `written` between the read and
 *  this point, and that must not be silently undone. */
async function finalizeWakeResolution(
  storage: StorageLike,
  wake: WakeState,
  wakeId: string,
  provisionalStorageKeys: readonly string[],
  clean: boolean,
): Promise<WakeResolution | null> {
  return storage.transaction(async (txn) => {
    const stillThere = await txn.get<WakeState>(wakeStorageKey(wakeId));
    if (!stillThere) return null; // a concurrent call already resolved this wake

    const marker = `${PROVISIONAL_PREFIX}${wakeId}`;
    const currentStates =
      provisionalStorageKeys.length > 0 ? await getManyChunked<InboxKeyState>(txn, provisionalStorageKeys) : new Map();

    const writes: Record<string, InboxKeyState> = {};
    const doneWrites: Record<string, 1> = {};
    const toDelete: string[] = [];
    let keysAffected = 0;
    for (const storageKey of provisionalStorageKeys) {
      if (currentStates.get(storageKey) !== marker) continue; // no longer this wake's — a concurrent reopen won
      keysAffected++;
      if (clean) {
        // Move OUT of `key:` into `done:` on commit, so `key:` never
        // accumulates committed history (see this file's header, point 1).
        toDelete.push(storageKey);
        doneWrites[doneKeyStorageKey(inboxKeyOf(storageKey))] = 1;
      } else {
        writes[storageKey] = "written";
      }
    }
    toDelete.push(wakeStorageKey(wakeId)); // deleted last — see this function's own doc comment

    await putChunked<unknown>(txn, { ...writes, ...doneWrites });
    await deleteChunked(txn, toDelete);

    return { wakeId, reason: wake.reason, clean, keysAffected, readyMs: stillThere.readyMs };
  });
}

/**
 * ADR §B.3: "at each cron tick and at the start of each wake, InboxWriter
 * resolves every wake that still owns provisional keys and is over." A
 * wake is over when a newer wake started, or the box is observed not
 * running (this call's own job for the CURRENT wake).
 */
export async function resolveOverWakes(storage: StorageLike, deps: LedgerDeps): Promise<ResolveResult> {
  const wakes = await storage.list<WakeState>({ prefix: WAKE_PREFIX });
  const newlyOver: string[] = [];
  const resolved: WakeResolution[] = [];

  const alreadyOver: [string, WakeState][] = [];
  let active: [string, WakeState] | null = null;
  for (const [storageKey, wake] of wakes) {
    if (wake.over) alreadyOver.push([wakeIdOf(storageKey), wake]);
    else active = [storageKey, wake]; // at most one, by construction (recordWake's invariant)
  }

  // Wakes already `over`: their key sets cannot grow further
  // (`markKeysProvisional` refuses once `over` is true), so one SHARED
  // `key:` scan grouped by wakeId resolves all of them: O(wakes+keys).
  if (alreadyOver.length > 0) {
    const keys = await storage.list<InboxKeyState>({ prefix: KEY_PREFIX });
    const byWake = new Map<string, string[]>();
    for (const [storageKey, state] of keys) {
      if (typeof state !== "string" || !state.startsWith(PROVISIONAL_PREFIX)) continue;
      const owner = state.slice(PROVISIONAL_PREFIX.length);
      const list = byWake.get(owner);
      if (list) list.push(storageKey);
      else byWake.set(owner, [storageKey]);
    }
    for (const [wakeId, wake] of alreadyOver) {
      const provisionalKeys = byWake.get(wakeId) ?? [];
      // Zero provisional keys ever recorded for this wake is trivially
      // clean — no marker was ever going to exist.
      const clean = provisionalKeys.length > 0 ? await deps.markerExists(wakeId) : true;
      const outcome = await finalizeWakeResolution(storage, wake, wakeId, provisionalKeys, clean);
      if (outcome) resolved.push(outcome);
    }
  }

  // The one wake that may become `over` THIS call.
  if (active) {
    const [storageKey, wake] = active;
    const wakeId = wakeIdOf(storageKey);
    const stillRunning = await deps.isBoxRunning(); // input-gate-opening await
    if (!stillRunning) {
      // Mark over FIRST, before reading provisional keys, so a concurrent
      // `markKeysProvisional` either lands before the fresh read or is
      // refused (it checks `over` itself). Re-read `wake` here too — a
      // `recordWakeReady` landed during `isBoxRunning()` must not be
      // overwritten by the stale snapshot.
      const fresh = (await storage.get<WakeState>(storageKey)) ?? wake;
      await storage.put({ [storageKey]: { ...fresh, over: true } satisfies WakeState });
      newlyOver.push(wakeId);

      const freshKeys = await storage.list<InboxKeyState>({ prefix: KEY_PREFIX });
      const provisionalKeys: string[] = [];
      const marker = `${PROVISIONAL_PREFIX}${wakeId}`;
      for (const [sk, state] of freshKeys) if (state === marker) provisionalKeys.push(sk);

      const clean = provisionalKeys.length > 0 ? await deps.markerExists(wakeId) : true;
      const outcome = await finalizeWakeResolution(storage, { ...fresh, over: true }, wakeId, provisionalKeys, clean);
      if (outcome) resolved.push(outcome);
    }
  }

  return { newlyOver, resolved };
}

/** A key becomes `provisional(wakeId)` only after all its requests
 *  returned `2xx` (ADR §B.3). Refuses — inside one transaction — when
 *  `wake:<wakeId>` is over or missing: a key marked provisional under a
 *  gone wake would sit there forever, and a stale-snapshot race could
 *  commit it without ever passing the marker check. Read-then-write inside
 *  `storage.transaction()` makes the check and the write atomic. */
export async function markKeysProvisional(storage: StorageLike, wakeId: string, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  await storage.transaction(async (txn) => {
    const wake = await txn.get<WakeState>(wakeStorageKey(wakeId));
    if (!wake || wake.over) return; // refuse: unknown or already-over wake
    const writes: Record<string, InboxKeyState> = {};
    for (const key of keys) writes[inboxKeyStorageKey(key)] = `provisional:${wakeId}`;
    // A drain batch can carry more than 128 keys (DRAIN_BATCH_SIZE, box.ts).
    await putChunked(txn, writes);
  });
}

/** A key whose drain pushed ZERO bytes (already deduped/too old) has
 *  nothing an unclean stop could lose, so it skips the wake-marker
 *  durability check entirely. Routing it through `markKeysProvisional`
 *  instead would leave a wake with only zero-byte keys looking unclean
 *  forever (no Loki marker was ever written for it), re-waking and
 *  re-draining the same empty keys on a loop. This commits straight
 *  `written` → `done:`, safe since nothing durable rides on it. */
export async function commitKeys(storage: StorageLike, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  await storage.transaction(async (txn) => {
    const doneWrites: Record<string, 1> = {};
    for (const key of keys) doneWrites[doneKeyStorageKey(key)] = 1;
    await putChunked<unknown>(txn, doneWrites);
    // Chunked to the real 128-key DO limit, same as `finalizeWakeResolution`.
    await deleteChunked(
      txn,
      keys.map((key) => inboxKeyStorageKey(key)),
    );
  });
}

// ---- backlog() ---------------------------------------------------------------

export interface InboxObjectInfo {
  key: string;
  size: number;
  /** R2's own `uploaded` timestamp — exact, unlike deriving age from the
   *  key's hour bucket (which understates age by up to 59 minutes and
   *  wakes the box early). No extra request cost from `list()`. */
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

// ---- Drain support: ordering, rejection ---------------------------------------

/**
 * `written` keys, in key order. The inbox key format sorts chronologically
 * within a tenant by construction, so this satisfies "re-opened keys
 * first" without a separate flag — a re-opened key is always older than
 * any key from the current wake. `excludeTenants` (tenants the drain found
 * stream-limited this wake) and `excludeKeys` (keys the drain deferred this
 * wake) are skipped before the limit applies, so the batch fills with the
 * keys that can still make progress.
 */
export async function nextWrittenKeys(
  storage: StorageLike,
  limit: number,
  excludeTenants: readonly string[] = [],
  excludeKeys: readonly string[] = [],
): Promise<string[]> {
  const keys = await storage.list<InboxKeyState>({ prefix: KEY_PREFIX });
  const excludedPrefixes = excludeTenants.map((t) => `inbox/${t}/`);
  const excludedKeys = new Set(excludeKeys);
  const written: string[] = [];
  for (const [storageKey, state] of keys) {
    if (state !== "written") continue;
    const inboxKey = inboxKeyOf(storageKey);
    if (excludedKeys.has(inboxKey)) continue;
    if (excludedPrefixes.some((prefix) => inboxKey.startsWith(prefix))) continue;
    written.push(inboxKey);
  }
  written.sort();
  return written.slice(0, limit);
}

// ---- rejectedEvent: audit log ----------------------------------------------
// `rejected:` `key:` entries are never pruned, so a plain count-based rule
// would fire forever; this chronological, independently-prunable log gives
// the alert a REJECTION TIME to fire-once/resolve-once on instead.
const REJECTED_EVENT_PREFIX = "rejectedEvent:";
const REJECTED_EVENT_TIMESTAMP_DIGITS = 15;
/** Same window contract §8 already uses for `done:`/`hash:`/reopen (the
 *  underlying inbox object's own 7-day retention) — past this, nothing
 *  about the rejection is diagnosable any more anyway. */
const REJECTED_EVENT_RETENTION_MS = KEY_RETENTION_MS;

function rejectedEventStorageKey(ms: number, inboxKeyStr: string): string {
  return `${REJECTED_EVENT_PREFIX}${Math.max(0, Math.trunc(ms)).toString().padStart(REJECTED_EVENT_TIMESTAMP_DIGITS, "0")}:${inboxKeyStr}`;
}

/** A `400` marks the key `rejected`, logged with Loki's message (ADR
 *  §B.3) — never retried by a later wake. Stays under `key:` past
 *  retention only via `pruneLedger`'s value-filtered sweep (not `done:`'s
 *  blind range delete), since an operator diagnosing the alert needs to
 *  still find it. Also logs a `rejectedEvent:` entry so the alert can
 *  tell "rejected, ever" from "rejected, recently." */
export async function rejectKey(storage: StorageLike, key: string, reason: string, nowMs = Date.now()): Promise<void> {
  await storage.put({
    [inboxKeyStorageKey(key)]: `rejected:${reason}` satisfies InboxKeyState,
    [rejectedEventStorageKey(nowMs, key)]: reason,
  });
}

/** A key with at least one 2xx chunk AND one permanently-400'd chunk
 *  stays `provisional` (its accepted content is durable — see
 *  `drain.ts#drainKey`), so it never becomes `rejected:<reason>`. Logs the
 *  SAME `rejectedEvent:` entry `rejectKey` would, so the loss is still
 *  operator-visible even though the key itself durably resolves. */
export async function recordPartialReject(storage: StorageLike, key: string, reason: string, nowMs = Date.now()): Promise<void> {
  await storage.put({ [rejectedEventStorageKey(nowMs, key)]: reason });
}

/** Count of `rejectedEvent:` entries strictly newer than `sinceMs` — bounded
 *  `start`/`end` range read (chronologically keyed by construction, same
 *  pattern as `fpts:`), never a full-prefix scan. */
export async function recentRejectionCount(storage: StorageLike, sinceMs: number): Promise<number> {
  const start = rejectedEventStorageKey(sinceMs + 1, "");
  const end = `${REJECTED_EVENT_PREFIX}￿`;
  const page = await storage.list<unknown>({ start, end, limit: PRUNE_BATCH_LIMIT });
  return page.size;
}

// ---- Manual reopen (POST /grafana/_o11y/reopen) -------------------------------

export interface ReopenResult {
  reopened: number;
}

/** The manual reopen window is capped to {@link KEY_RETENTION_MS} —
 *  nothing past it can still exist, so a wider request is refused up
 *  front rather than silently reopening nothing. */
export function reopenWindowExceedsRetention(fromMs: number, toMs: number): boolean {
  return toMs - fromMs > KEY_RETENTION_MS;
}

/**
 * Re-opens every key whose inbox-key hour bucket overlaps `[fromMs, toMs)`:
 * live `key:` entries (except the active wake's own in-flight
 * `provisional:` keys) AND `done:` entries (committed keys live there, not
 * under `key:`). Both scans are bounded by {@link KEY_RETENTION_MS},
 * enforced by the caller via `reopenWindowExceedsRetention`.
 */
export async function reopenWindow(
  storage: StorageLike,
  fromMs: number,
  toMs: number,
  activeWakeId: string | null,
): Promise<ReopenResult> {
  const overlaps = (inboxKey: string): boolean => {
    const parsed = parseInboxKey(inboxKey);
    if (!parsed) return false;
    const hourStart = Date.UTC(
      Number(parsed.date.slice(0, 4)),
      Number(parsed.date.slice(5, 7)) - 1,
      Number(parsed.date.slice(8, 10)),
      Number(parsed.hour),
    );
    const hourEnd = hourStart + 60 * 60 * 1000;
    return !(hourEnd <= fromMs || hourStart >= toMs);
  };

  const writes: Record<string, InboxKeyState> = {};
  const toDelete: string[] = [];

  const keys = await storage.list<InboxKeyState>({ prefix: KEY_PREFIX });
  const protectedState = activeWakeId ? `${PROVISIONAL_PREFIX}${activeWakeId}` : null;
  for (const [storageKey, state] of keys) {
    if (state === "written") continue; // already open
    if (protectedState && state === protectedState) continue; // in-flight — protected
    if (!overlaps(inboxKeyOf(storageKey))) continue;
    writes[storageKey] = "written";
  }

  const done = await storage.list<1>({ prefix: DONE_PREFIX });
  for (const [storageKey] of done) {
    const inboxKeyStr = storageKey.slice(DONE_PREFIX.length);
    if (!overlaps(inboxKeyStr)) continue;
    writes[inboxKeyStorageKey(inboxKeyStr)] = "written";
    toDelete.push(storageKey);
  }

  const reopened = Object.keys(writes).length;
  // One transient `reopenmark:` per key this call moves to `written`, in
  // the SAME transaction as the `written` write itself — see this file's
  // `REOPEN_MARK_PREFIX` doc comment.
  const marks: Record<string, 1> = {};
  for (const storageKey of Object.keys(writes)) {
    marks[reopenMarkStorageKey(inboxKeyOf(storageKey))] = 1;
  }
  // Wrapped in one transaction so a crash mid-chunk never leaves a `done:`
  // entry deleted without its `key:<key> = written` twin written, or the
  // reverse — same atomicity approach as `finalizeWakeResolution`.
  await storage.transaction(async (txn) => {
    if (reopened > 0) {
      await putChunked(txn, writes);
      await putChunked(txn, marks);
    }
    if (toDelete.length > 0) await deleteChunked(txn, toDelete);
  });
  return { reopened };
}

/**
 * Consumes (reads AND clears) the reopen markers `reopenWindow` left for
 * `inboxKeys`, one-shot, and reports whether ANY were found. Called once
 * per drain batch so its `o11y.drain` point can emit `reason: "reopen"`.
 */
export async function takeReopenedFlag(storage: StorageLike, inboxKeys: readonly string[]): Promise<boolean> {
  if (inboxKeys.length === 0) return false;
  const markKeys = inboxKeys.map(reopenMarkStorageKey);
  const found = await getManyChunked(storage, markKeys);
  if (found.size === 0) return false;
  await deleteChunked(storage, [...found.keys()]);
  return true;
}

/** Records a wake's wake-to-ready time on `wake:<wakeId>`, once — first
 *  call wins, and an already-resolved wake is left alone. */
export async function recordWakeReady(storage: StorageLike, wakeId: string, readyMs: number): Promise<void> {
  await storage.transaction(async (txn) => {
    const key = wakeStorageKey(wakeId);
    const wake = await txn.get<WakeState>(key);
    if (!wake || wake.readyMs !== undefined) return;
    await txn.put({ [key]: { ...wake, readyMs } satisfies WakeState });
  });
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

// ---- Pruning: bounded, retention-based housekeeping ------------------------

export interface PruneResult {
  doneDeleted: number;
  /** Stale `key:<k> = rejected:<reason>` entries deleted this call — see
   *  `pruneLedger`'s own doc comment. */
  rejectedDeleted: number;
}

/** Deletes `done:<key>` entries older than {@link KEY_RETENTION_MS} — a
 *  `done:` entry for an object R2 has already deleted is worthless.
 *  Bounded per call via a `start`/`end` range delete: `done:inbox/<tenant>/`
 *  sorts chronologically, so `[start, cutoffDate)` names exactly the
 *  oldest stale rows. Called from `writer.ts#backlog()`, wrapped in
 *  `try/catch` there so a pruning failure never fails the backlog read. */
export async function pruneLedger(storage: StorageLike, nowMs: number): Promise<PruneResult> {
  const cutoff = new Date(nowMs - KEY_RETENTION_MS);
  const cutoffDate = cutoff.toISOString().slice(0, 10); // yyyy-mm-dd, UTC

  let doneDeleted = 0;
  for (const tenant of ["browser", "worker"] satisfies Tenant[]) {
    const stale = await storage.list<1>({
      start: `${DONE_PREFIX}inbox/${tenant}/`,
      end: `${DONE_PREFIX}inbox/${tenant}/${cutoffDate}/`,
      limit: PRUNE_BATCH_LIMIT,
    });
    const toDelete = [...stale.keys()];
    if (toDelete.length > 0) {
      await deleteChunked(storage, toDelete);
      doneDeleted += toDelete.length;
    }
  }

  // `rejected:<reason>` entries need pruning too, but `key:inbox/<tenant>/`
  // mixes live and rejected entries chronologically, so this range read
  // must filter by VALUE, not blind-delete. A batch whose oldest rows are
  // all non-rejected makes no progress this tick; it converges over later
  // ticks.
  let rejectedDeleted = 0;
  for (const tenant of ["browser", "worker"] satisfies Tenant[]) {
    const stale = await storage.list<InboxKeyState>({
      start: `${KEY_PREFIX}inbox/${tenant}/`,
      end: `${KEY_PREFIX}inbox/${tenant}/${cutoffDate}/`,
      limit: PRUNE_BATCH_LIMIT,
    });
    const toDelete: string[] = [];
    for (const [key, state] of stale) {
      if (typeof state === "string" && state.startsWith("rejected:")) toDelete.push(key);
    }
    if (toDelete.length > 0) {
      await deleteChunked(storage, toDelete);
      rejectedDeleted += toDelete.length;
    }
  }

  // The `rejectedEvent:` audit log is itself chronologically keyed, so a
  // plain bounded range delete (no value filtering) prunes it too.
  const rejectedEventStale = await storage.list<unknown>({
    start: REJECTED_EVENT_PREFIX,
    end: rejectedEventStorageKey(nowMs - REJECTED_EVENT_RETENTION_MS, ""),
    limit: PRUNE_BATCH_LIMIT,
  });
  const rejectedEventToDelete = [...rejectedEventStale.keys()];
  if (rejectedEventToDelete.length > 0) await deleteChunked(storage, rejectedEventToDelete);

  return { doneDeleted, rejectedDeleted };
}

export { wakeStorageKey };
