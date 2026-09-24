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
// F2 fix round (final review, B-C1/A-I1/B "reopen-window unbounded", must-fix):
// the previous
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
import { deleteChunked, getManyChunked, putChunked, type StorageLike } from "./storage.js";

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

/** How many `done:` rows one `pruneLedger` call may delete — bounds the cost
 *  of a call that runs after a quiet period has let a backlog of stale rows
 *  build up (T03-D2's own "bounded number of objects per invocation"
 *  principle, applied to storage housekeeping too).
 *
 *  B-C1/A-I1 remainder (final review, rereview.md row 13): raised from 500
 *  — see `dedupe.ts#HASH_PRUNE_BATCH_LIMIT`'s doc comment for the same
 *  throughput arithmetic (500/tick tops out at 72,000/day against a 10-min
 *  cron; ADR §D's own 10× headroom projects ~220,000 worker records/day).
 *  Each `delete()` call is still chunked to the real 128-key DO limit
 *  (`deleteChunked`), independently of this list-side batch size. */
const PRUNE_BATCH_LIMIT = 5000;

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
 *
 *  N2/N8 fix (final review, rereview.md "atomicity trap" + row-count minor
 *  N8): the previous version did a `get` (existence re-check), a `put` and
 *  a `delete` as three SEPARATE, non-transactional `storage` calls — a
 *  crash between them could already leave `wake:<id>` deleted with some of
 *  its provisional keys never resolved (orphaned in `provisional:<wakeId>`
 *  forever: `markKeysProvisional` refuses an unknown wake, so nothing ever
 *  revisits them). Chunking the put/delete to the real DO 128-key limit
 *  (N2) would make this markedly WORSE — a crash between chunk 1 and chunk
 *  2 orphans exactly the keys in the chunks that never ran. The whole
 *  function now runs inside one `storage.transaction()`: every chunked
 *  put/delete inside it commits or rolls back together, so a crash mid-way
 *  leaves the PRE-transaction state, not a partial one. `wake:<id>` is
 *  still deleted last (defense in depth, cheap, no reason not to) even
 *  though the transaction's own atomicity no longer depends on the order.
 *
 *  N8 (rereview.md §2 Minor): re-reads each key's CURRENT state inside this
 *  same transaction, rather than trusting the caller's (possibly stale,
 *  snapshot-at-some-earlier-point) `provisionalStorageKeys` list blindly —
 *  a concurrent manual reopen (`reopenWindow`, below) can move a key OUT of
 *  `provisional:<wakeId>` (back to `written`) between that snapshot and
 *  this point; applying the snapshot's decision on top of that would
 *  silently undo the reopen. A key whose current state no longer matches
 *  `provisional:<wakeId>` is skipped, not resolved. */
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
      if (currentStates.get(storageKey) !== marker) continue; // N8: no longer this wake's — a concurrent reopen won
      keysAffected++;
      if (clean) {
        // F2 fix: move OUT of `key:` into `done:` on commit, so `key:` never
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

    return { wakeId, reason: wake.reason, clean, keysAffected };
  });
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
    // N2: a drain batch can carry more than 128 keys (DRAIN_BATCH_SIZE, box.ts).
    await putChunked(txn, writes);
  });
}

/** B-M4 fix (minor triage item 3): a key whose drain pushed ZERO bytes to
 *  Loki (every record was already deduped or too old — `drain.ts#drainKey`'s
 *  zero-chunk `provisional` case) has nothing that could be lost by an
 *  unclean stop, so it never needs the wake-marker durability check
 *  `provisional:<wakeId>` → {@link finalizeWakeResolution} exists for.
 *  Routing it through `markKeysProvisional` instead was the actual bug: a
 *  wake whose ONLY provisional keys are all zero-byte never gets a Loki
 *  index/marker written for it (nothing was ever pushed), so
 *  `resolveOverWakes` reads that wake as unclean and bounces every one of
 *  those keys back to `written` — which re-adds them to the backlog, wakes
 *  the box again ~10 minutes later, drains them again (still zero bytes),
 *  and repeats forever. This moves such a key straight `written` → `done:`,
 *  exactly like a normal key's CLEAN commit path
 *  ({@link finalizeWakeResolution}'s `clean` branch), skipping the
 *  provisional/marker step entirely — safe because there is nothing durable
 *  riding on it. */
export async function commitKeys(storage: StorageLike, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  await storage.transaction(async (txn) => {
    const doneWrites: Record<string, 1> = {};
    for (const key of keys) doneWrites[doneKeyStorageKey(key)] = 1;
    await putChunked<unknown>(txn, doneWrites);
    // N2: chunked to the real 128-key DO limit, same as `finalizeWakeResolution`.
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

// ---- rejectedEvent: audit log (row 19 / B-C1/A-I1 remainder) ------------------
//
// `rejectedKeyRule` used to fire on `rejectedKeyCount() > 0` and never
// resolve — `rejected:<reason>` `key:` entries are never pruned (rare,
// operator-diagnosable, by design — see `rejectKey`'s own doc comment), so
// once ANY key was ever rejected, the alert fired forever (rereview.md's
// "resolve the rejected-inbox-key rule: fire once per new rejection,
// resolve when none are recent"). Fixing this needs a REJECTION TIME, which
// `rejected:<reason>` never carried — this chronological, independently
// prunable event log provides it without changing `key:`'s own value shape
// at all (no compat/migration burden on the ledger's live state). Also used
// by `recordPartialReject` (drain partial-400 durability fix, row 19,
// below): a key that stays `provisional`/resolves to `done:` (its accepted
// chunks ARE durable) can still log a rejection event for a permanently
// dropped chunk, without the ledger conflating "durable" and "rejected."
const REJECTED_EVENT_PREFIX = "rejectedEvent:";
const REJECTED_EVENT_TIMESTAMP_DIGITS = 15;
/** Same window contract §8 already uses for `done:`/`hash:`/reopen (the
 *  underlying inbox object's own 7-day retention) — past this, nothing
 *  about the rejection is diagnosable any more anyway. */
const REJECTED_EVENT_RETENTION_MS = KEY_RETENTION_MS;

function rejectedEventStorageKey(ms: number, inboxKeyStr: string): string {
  return `${REJECTED_EVENT_PREFIX}${Math.max(0, Math.trunc(ms)).toString().padStart(REJECTED_EVENT_TIMESTAMP_DIGITS, "0")}:${inboxKeyStr}`;
}

/** A `400` (e.g. `too_far_behind`) marks the key `rejected`, logged with
 *  Loki's message (ADR §B.3) — never retried by a later wake. Rejected keys
 *  are rare (a genuine, not-just-stale, Loki-side rejection) and stay under
 *  `key:` past retention only via `pruneLedger`'s value-filtered sweep
 *  (B-C1/A-I1 remainder — see that function) rather than `done:`'s blind
 *  range delete: unlike `committed`, this is not the dominant growth path
 *  B-C1 measured, and a rejected key is exactly what an operator diagnosing
 *  the `rejected-inbox-key` alert (ADR §F.3) needs to still be able to
 *  find, for as long as its underlying object could still exist. Also logs
 *  a `rejectedEvent:` entry — see this section's header — so the alert can
 *  tell "rejected, ever" from "rejected, recently." */
export async function rejectKey(storage: StorageLike, key: string, reason: string, nowMs = Date.now()): Promise<void> {
  await storage.put({
    [inboxKeyStorageKey(key)]: `rejected:${reason}` satisfies InboxKeyState,
    [rejectedEventStorageKey(nowMs, key)]: reason,
  });
}

/** Row 19 (drain partial-400 durability): a key with at least one 2xx chunk
 *  AND at least one permanently-400'd chunk stays `provisional` (its
 *  accepted content follows the normal §B.3 marker/commit path — see
 *  `drain.ts#drainKey`'s own doc comment for why), so it never becomes
 *  `key:<key> = rejected:<reason>` and `rejectedKeyCount`/`pruneLedger`'s
 *  value-filtered sweep never sees it. This still logs the SAME
 *  `rejectedEvent:` entry `rejectKey` would, so the alert stays accurate —
 *  a permanently-dropped chunk is real operator-visible information even
 *  though the key itself durably resolves. */
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
  // N2: both a large reopen window and the real DO 128-key limit mean this
  // must chunk; wrapped in one transaction (rather than two independent
  // top-level calls) so a crash mid-chunk never leaves a `done:` entry
  // deleted without its `key:<key> = written` twin ever having been
  // written (or the reverse) — the same atomicity-trap fix as
  // `finalizeWakeResolution`, above.
  await storage.transaction(async (txn) => {
    if (reopened > 0) await putChunked(txn, writes);
    if (toDelete.length > 0) await deleteChunked(txn, toDelete);
  });
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
  /** Stale `key:<k> = rejected:<reason>` entries deleted this call
   *  (B-C1/A-I1 remainder — see `pruneLedger`'s own doc comment). */
  rejectedDeleted: number;
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
      await deleteChunked(storage, toDelete); // N2
      doneDeleted += toDelete.length;
    }
  }

  // B-C1/A-I1 remainder (rereview.md G1 section: "prune rejected: key
  // entries after their inbox object's retention"): `rejected:<reason>`
  // entries were never pruned at all (`rejectKey`'s own doc comment
  // originally argued this — an operator diagnosing the alert needs to
  // still find them — but nothing past the object's own 7-day retention is
  // still diagnosable: the R2 object is already gone). `key:inbox/<tenant>/`
  // mixes live `written`/`provisional:*` entries in with `rejected:*` ones
  // chronologically, so — unlike `done:`, which is exclusively committed
  // history — this range read must filter by VALUE, not just blind-delete
  // the range. Accepted, documented trade-off: a batch whose oldest rows
  // are all non-rejected makes no delete progress this tick (the read is
  // still bounded; it just doesn't always convert to a deletion), and
  // converges over later ticks once older rejected rows are reached.
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

  // C-I1/rereview row 13 (fire-once/resolve-when-none-recent): the
  // `rejectedEvent:` audit log (`rejectKey`/`recordPartialReject`, see
  // those functions' doc comments) is itself chronologically keyed, so a
  // plain bounded range delete (no value filtering needed) prunes it past
  // the same retention.
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
