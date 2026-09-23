// The ledger (ADR §B.3, task "Ledger" scope): `written` → `provisional(wakeId)`
// → `committed` | `rejected` transitions, resolved at every cron tick and at
// the start of each wake, plus `backlog()` and the manual `reopen` window.
// Pure functions over `StorageLike` (T02's pattern — see `storage.ts`'s
// header): no direct `DurableObjectStorage`/R2 import, so every rule here is
// unit-testable over `memoryStorage()` without a real DO. `inbox/writer.ts`
// (the real `InboxWriter` DO, T02's file — T03 adds RPC methods to it per
// COMMON.md interface 1's explicit "further methods are added by ... T03
// (ledger/backlog)") wires these against the real storage/R2/GrafanaBox stub.
//
// F2 fix round (final review, B-C1/A-I1/B "reopen-window unbounded", must-fix
// — see .superpowers/sdd/README/final/{A,B}-findings.md): the previous
// version scanned the ENTIRE `key:` prefix once per wake inside a loop over
// every `wake:` entry ever recorded (O(wakes × keys), and both factors grew
// forever — nothing ever deleted a `key:`/`wake:` entry). At 30 days of
// traffic that was measured at ~22-65M storage rows read per call, heading
// toward the DO CPU limit and the platform's rows-read billing. This version:
//   1. Moves `committed` keys OUT of the `key:` prefix entirely, into
//      `done:<key>` (see `doneKeyStorageKey`, packages/runtime) — `key:` then
//      holds only `written`/`provisional:*`/`rejected:*`, the LIVE set every
//      read here needs, never the ever-growing committed history.
//   2. Resolves every already-over wake with ONE shared `key:` scan grouped
//      by wakeId (not one scan per wake) — see `resolveOverWakes` below.
//   3. Closes the B-I1 race directly: for the one wake that becomes `over`
//      DURING this call (the only wake `recordWake`'s invariant allows to be
//      not-over), the write of `over: true` happens BEFORE that wake's
//      provisional keys are (freshly) read — so a `markKeysProvisional` call
//      delivered while `isBoxRunning()`/`markerExists()` is in flight either
//      lands before the fresh read (correctly captured) or after `over` is
//      already true, in which case `markKeysProvisional` itself refuses it
//      (ledger.ts's own `markKeysProvisional`, below). The previous version's
//      bug was using a STALE "does this wake have any provisional keys"
//      boolean (computed before the `isBoxRunning` await) to decide whether
//      the marker even needed checking — a late-arriving key could then be
//      committed without ever consulting the marker.
//   4. Deletes a wake's `wake:<id>` entry once fully resolved, instead of
//      flagging it "resolved" and scanning it forever after — nothing reads
//      an already-resolved wake again, so there is nothing to gain from
//      keeping it, and deleting it is what keeps the top-level `wake:` scan
//      itself bounded to "wakes not yet resolved" rather than all-time.
//   5. `done:`/`hash:` pruning (`pruneLedger`, `dedupe.ts`) always uses a
//      `start`/`end`/`limit`-bounded range read, never a full-prefix scan —
//      see `storage.ts`'s `ListOptions` doc comment.
// See `pipeline/o11y-ledger-scale.test.mjs` for the 10k-key/500-wake bound
// this is measured against, and the `A-findings.md`/`B-findings.md` text
// above for the exact failure scenarios this closes.

import {
  doneKeyStorageKey,
  inboxKeyStorageKey,
  parseInboxKey,
  wakeStorageKey,
  type InboxKeyState,
  type Tenant,
  type WakeState,
} from "@handsontable/demo-runtime/telemetry";
import type { StorageLike } from "./storage.js";

const WAKE_PREFIX = "wake:";
const KEY_PREFIX = "key:";
const DONE_PREFIX = "done:";
const PROVISIONAL_PREFIX = "provisional:";

/** Contract §8: inbox objects live 7 days (R2 lifecycle). A `done:<key>`
 *  entry (a committed key, kept only so a manual reopen can find it) is
 *  worthless once the underlying R2 object is gone, so pruning uses the same
 *  window — see `pruneLedger`. Also the manual-reopen window cap (B-M9): a
 *  window that could never find a live entry past this age is refused
 *  up front by `reopenWindow`/`grafana/reopen.ts`. */
export const KEY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** How many `done:`/`hash:` rows one `pruneLedger`/dedupe-prune call may
 *  delete — bounds the cost of a call that runs after a quiet period has let
 *  a backlog of stale rows build up (T03-D2's own "bounded number of objects
 *  per invocation" principle, applied to storage housekeeping too). */
const PRUNE_BATCH_LIMIT = 500;

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
   *  and "is THAT wake still running" are the same question. This is also an
   *  outbound RPC (a real cross-DO call), which — unlike a plain storage
   *  get/put — briefly opens this DO's input gate, letting another request
   *  (e.g. `drainStep`'s own `markKeysProvisional`) run while it is pending.
   *  `resolveOverWakes` is written to be correct across exactly that
   *  reopening (see this file's header, point 3). */
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
}

export interface ResolveResult {
  /** wakeIds newly marked `over: true` this call (either because a newer
   *  wake already superseded them via `recordWake`, or because this call
   *  observed the box not running). */
  newlyOver: string[];
  /** Every wake this call actually resolved (deleted `wake:<id>` for) —
   *  `keysAffected` can be 0 (an empty-backlog/visit-only wake, F3) — still
   *  included, since the `o11y.wake` clean/unclean point is about the
   *  wake's own outcome, not whether it happened to have keys left. */
  resolved: WakeResolution[];
}

/** Resolves a single wake's provisional keys (already known, from a fresh or
 *  shared read — see call sites) against the marker, moving each to
 *  `done:`/`written` as appropriate and deleting the `wake:<id>` entry.
 *  Re-checks the wake entry still exists immediately before writing (point
 *  4/COMMON's "drainStep every second + cron can call resolveWakes at the
 *  same time" — see this file's header): a concurrent call may already have
 *  resolved (and deleted) this same wake while `markerExists` above was in
 *  flight, and applying this write on top of that would double-count the
 *  `o11y.wake` point `writer.ts` emits per `resolved` entry. */
async function finalizeWakeResolution(
  storage: StorageLike,
  wake: WakeState,
  wakeId: string,
  provisionalStorageKeys: readonly string[],
  clean: boolean,
): Promise<WakeResolution | null> {
  const stillThere = await storage.get<WakeState>(wakeStorageKey(wakeId));
  if (!stillThere) return null; // a concurrent call already resolved this wake

  const writes: Record<string, InboxKeyState> = {};
  const doneWrites: Record<string, 1> = {};
  const toDelete: string[] = [wakeStorageKey(wakeId)];
  for (const storageKey of provisionalStorageKeys) {
    if (clean) {
      // F2 fix: move OUT of `key:` into `done:` on commit, so `key:` never
      // accumulates committed history (see this file's header, point 1).
      toDelete.push(storageKey);
      doneWrites[doneKeyStorageKey(inboxKeyOf(storageKey))] = 1;
    } else {
      writes[storageKey] = "written";
    }
  }
  await storage.put<unknown>({ ...writes, ...doneWrites });
  if (toDelete.length > 0) await storage.delete(toDelete);

  return { wakeId, reason: wake.reason, clean, keysAffected: provisionalStorageKeys.length };
}

/**
 * ADR §B.3: "at each cron tick and at the start of each wake, InboxWriter
 * resolves every wake that still owns provisional keys and is over."
 *
 * A wake is over when a newer wake has started (already reflected as
 * `over: true` by `recordWake`) or when the box is observed not running
 * (this function's own job for the CURRENT wake). A wake still running is
 * left alone entirely.
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

  // ---- Phase 1: wakes already `over` at snapshot time --------------------
  // Their key sets cannot grow any further (`markKeysProvisional` refuses
  // once `over` is true — see below), so one SHARED `key:` scan, grouped by
  // wakeId, safely resolves every one of them: O(wakes-already-over + live
  // keys), never O(wakes × keys).
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
      // F3: zero provisional keys ever recorded for this wake is trivially
      // clean — no marker was ever going to exist (see the F3 tests).
      const clean = provisionalKeys.length > 0 ? await deps.markerExists(wakeId) : true;
      const outcome = await finalizeWakeResolution(storage, wake, wakeId, provisionalKeys, clean);
      if (outcome) resolved.push(outcome);
    }
  }

  // ---- Phase 2: the one wake that may become `over` THIS call ------------
  if (active) {
    const [storageKey, wake] = active;
    const wakeId = wakeIdOf(storageKey);
    const stillRunning = await deps.isBoxRunning(); // input-gate-opening await
    if (!stillRunning) {
      // Durably mark over FIRST — before reading this wake's provisional
      // keys — so any `markKeysProvisional` call delivered while the next
      // await (`markerExists`) is pending either lands before the fresh
      // read just below (correctly captured) or is refused outright
      // (`markKeysProvisional` checks `over` itself). This ordering is the
      // B-I1 fix (see this file's header, point 3).
      await storage.put({ [storageKey]: { ...wake, over: true } satisfies WakeState });
      newlyOver.push(wakeId);

      const freshKeys = await storage.list<InboxKeyState>({ prefix: KEY_PREFIX });
      const provisionalKeys: string[] = [];
      const marker = `${PROVISIONAL_PREFIX}${wakeId}`;
      for (const [sk, state] of freshKeys) if (state === marker) provisionalKeys.push(sk);

      const clean = provisionalKeys.length > 0 ? await deps.markerExists(wakeId) : true;
      const outcome = await finalizeWakeResolution(storage, { ...wake, over: true }, wakeId, provisionalKeys, clean);
      if (outcome) resolved.push(outcome);
    }
  }

  return { newlyOver, resolved };
}

/** A key becomes `provisional(wakeId)` only after all its requests returned
 *  `2xx` (ADR §B.3). F2 fix (B-I1): refuses — inside one storage transaction
 *  — when `wake:<wakeId>` is over OR missing (a wake `resolveOverWakes` has
 *  already deleted, or one that never existed): a key marked provisional
 *  under a wake the ledger has already decided is over/gone would sit there
 *  forever, never resolved by anything, and — if written to storage BEFORE
 *  `resolveOverWakes` observes `over: true` but read by a STALE snapshot
 *  taken before this write — could be committed without ever passing the
 *  marker check (the exact data-loss race B-I1 describes). Read-then-write
 *  inside `storage.transaction()` so the check and the write are atomic with
 *  respect to this DO's own input gate (the same gate `resolveOverWakes`'s
 *  awaits open). */
export async function markKeysProvisional(storage: StorageLike, wakeId: string, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  await storage.transaction(async (txn) => {
    const wake = await txn.get<WakeState>(wakeStorageKey(wakeId));
    if (!wake || wake.over) return; // refuse: unknown or already-over wake
    const writes: Record<string, InboxKeyState> = {};
    for (const key of keys) writes[inboxKeyStorageKey(key)] = `provisional:${wakeId}`;
    await txn.put(writes);
  });
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

// ---- Drain support: ordering, rejection ---------------------------------------

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

/** A `400` (e.g. `too_far_behind`) marks the key `rejected`, logged with
 *  Loki's message (ADR §B.3) — never retried by a later wake. Rejected keys
 *  are rare (a genuine, not-just-stale, Loki-side rejection) and stay under
 *  `key:` indefinitely rather than being moved to `done:`/pruned — unlike
 *  `committed`, this is not the dominant growth path B-C1 measured, and a
 *  rejected key is exactly what an operator diagnosing the
 *  `rejected-inbox-key` alert (ADR §F.3) needs to still be able to find. */
export async function rejectKey(storage: StorageLike, key: string, reason: string): Promise<void> {
  await storage.put({ [inboxKeyStorageKey(key)]: `rejected:${reason}` satisfies InboxKeyState });
}

// ---- Manual reopen (POST /grafana/_o11y/reopen) -------------------------------

export interface ReopenResult {
  reopened: number;
}

/** B-M9: the manual reopen window is capped to {@link KEY_RETENTION_MS} —
 *  nothing past it can possibly still exist (`done:`/`rejected:` entries
 *  past this age are pruned, and Loki's own `reject_old_samples_max_age` is
 *  7d too), so a wider request is refused up front rather than silently
 *  reopening nothing (or, before this fix, scanning unboundedly for
 *  nothing). */
export function reopenWindowExceedsRetention(fromMs: number, toMs: number): boolean {
  return toMs - fromMs > KEY_RETENTION_MS;
}

/**
 * Re-opens every key whose inbox-key hour bucket overlaps `[fromMs, toMs)`:
 * still-live `key:` entries (any state except `provisional:<activeWakeId>` —
 * reopening a key an in-flight drain is actively working is not a "manual
 * re-open," it is corruption of that drain's own bookkeeping) AND `done:`
 * entries (committed keys, F2 fix — these moved out of `key:` per this
 * file's header, so reopen must look in both places or a reopen of anything
 * already committed would silently find nothing). `activeWakeId` is the
 * current not-over wake, if any (`null` when the box is fully stopped). Both
 * scans are bounded by {@link KEY_RETENTION_MS} retention, never all-time
 * history (see `reopenWindowExceedsRetention`, enforced by the caller).
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
  if (reopened > 0) await storage.put(writes);
  if (toDelete.length > 0) await storage.delete(toDelete);
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

// ---- Pruning (F2 fix, A-I1): bounded, retention-based housekeeping ------------

export interface PruneResult {
  doneDeleted: number;
}

/** Deletes `done:<key>` entries whose embedded inbox-key date is older than
 *  {@link KEY_RETENTION_MS} (§8: inbox objects live 7 days — a `done:` entry
 *  for an object R2 has already deleted is worthless). Bounded per call
 *  (`PRUNE_BATCH_LIMIT` rows per tenant) via a `start`/`end` RANGE delete,
 *  never a full-prefix scan: `done:inbox/<tenant>/<date>/...` sorts
 *  chronologically within a tenant by construction (the same property
 *  `nextWrittenKeys` already relies on for `key:`), so `[start, end)` =
 *  `["done:inbox/<tenant>/", "done:inbox/<tenant>/<cutoffDate>/")` names
 *  exactly "every committed key for this tenant strictly older than the
 *  cutoff date," oldest first — the natural rows to delete when the batch
 *  limit means not everything stale fits in one call. Called from
 *  `writer.ts#backlog()` (the ten-minute cron path — see this file's header,
 *  point 5: NOT from the pack alarm, which only fires on ingest and would
 *  starve pruning during a quiet period), wrapped in `try/catch` there so a
 *  pruning failure can never fail the backlog read itself. */
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
      await storage.delete(toDelete);
      doneDeleted += toDelete.length;
    }
  }

  return { doneDeleted };
}

export { wakeStorageKey };
