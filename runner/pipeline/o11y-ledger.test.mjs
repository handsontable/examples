// The ledger (workers/o11y/src/inbox/ledger.ts, ADR-0041 §B.3) — pure
// functions over `storage.ts#memoryStorage()`, no DO/R2 needed (T02's own
// pattern for `dedupe.ts`/`registry.ts`/`pack.ts`).
//
// F2 fix round (final review, B-C1/A-I1/B "reopen-window unbounded"): a
// committed key now lives under `done:<key>`, not `key:<key> = "committed"`
// (see ledger.ts's header) — every test below that used to assert
// `"committed"` now asserts the key is GONE from `key:` and present under
// `done:`. New tests: `markKeysProvisional` refusing an over/missing wake
// (B-I1), the interleaving race the fix closes, `reopenWindowExceedsRetention`
// (B-M9) and `pruneLedger` (A-I1). The 10k-key/500-wake bounded-reads scale
// test lives in `o11y-ledger-scale.test.mjs`.
//
// Run: node --experimental-strip-types --test pipeline/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./fixtures/o11y-worker-hooks.mjs", import.meta.url);

const { memoryStorage, putChunked } = await import("../workers/o11y/src/inbox/storage.ts");
const {
  resolveOverWakes,
  computeBacklog,
  nextWrittenKeys,
  markKeysProvisional,
  rejectKey,
  recordPartialReject,
  recentRejectionCount,
  reopenWindow,
  reopenWindowExceedsRetention,
  currentWakeId,
  pruneLedger,
  KEY_RETENTION_MS,
} = await import("../workers/o11y/src/inbox/ledger.ts");
const { wakeStorageKey, inboxKeyStorageKey, doneKeyStorageKey, inboxKey } = await import(
  "@handsontable/demo-runtime/telemetry"
);

function deps({ running = false, markers = new Set() } = {}) {
  return {
    isBoxRunning: async () => running,
    markerExists: async (wakeId) => markers.has(wakeId),
  };
}

// ---- resolveOverWakes -----------------------------------------------------

test("resolveOverWakes leaves a still-running wake's provisional keys untouched", async () => {
  const storage = memoryStorage();
  await storage.put({
    [wakeStorageKey("w1")]: { startedAt: 1, reason: "backlog", over: false },
    [inboxKeyStorageKey("inbox/worker/2026-01-01/00/000000000000.ndjson.gz")]: "provisional:w1",
  });

  const result = await resolveOverWakes(storage, deps({ running: true }));

  assert.deepEqual(result.newlyOver, []);
  assert.equal(await storage.get(inboxKeyStorageKey("inbox/worker/2026-01-01/00/000000000000.ndjson.gz")), "provisional:w1");
  assert.equal(await storage.get(wakeStorageKey("w1")) !== undefined, true, "the still-running wake's entry must survive");
});

test("resolveOverWakes commits a key when the marker is present (clean stop) — moved to done:, wake: deleted", async () => {
  const storage = memoryStorage();
  const key = "inbox/worker/2026-01-01/00/000000000000.ndjson.gz";
  await storage.put({
    [wakeStorageKey("w1")]: { startedAt: 1, reason: "backlog", over: false },
    [inboxKeyStorageKey(key)]: "provisional:w1",
  });

  const result = await resolveOverWakes(storage, deps({ running: false, markers: new Set(["w1"]) }));

  assert.deepEqual(result.newlyOver, ["w1"]);
  assert.equal(result.resolved[0].clean, true);
  assert.equal(await storage.get(inboxKeyStorageKey(key)), undefined, "a committed key must leave key:");
  assert.equal(await storage.get(doneKeyStorageKey(key)), 1, "and appear under done:");
  assert.equal(await storage.get(wakeStorageKey("w1")), undefined, "a fully-resolved wake entry must be deleted");
});

test("resolveOverWakes re-opens a key (back to written) when the marker is absent (unclean stop)", async () => {
  const storage = memoryStorage();
  const key = "inbox/worker/2026-01-01/00/000000000000.ndjson.gz";
  await storage.put({
    [wakeStorageKey("w1")]: { startedAt: 1, reason: "backlog", over: false },
    [inboxKeyStorageKey(key)]: "provisional:w1",
  });

  const result = await resolveOverWakes(storage, deps({ running: false, markers: new Set() }));

  assert.equal(result.resolved[0].clean, false);
  assert.equal(await storage.get(inboxKeyStorageKey(key)), "written");
  assert.equal(await storage.get(doneKeyStorageKey(key)), undefined);
});

test("resolveOverWakes: a newer wake already marked `over: true` by recordWake still gets its keys resolved (shared single-pass scan)", async () => {
  const storage = memoryStorage();
  const key = "inbox/worker/2026-01-01/00/000000000000.ndjson.gz";
  await storage.put({
    [wakeStorageKey("w1")]: { startedAt: 1, reason: "backlog", over: true }, // already over
    [inboxKeyStorageKey(key)]: "provisional:w1", // but its keys were never resolved (crash between the two writes)
  });

  // deps.isBoxRunning is irrelevant here — the wake is already over.
  const result = await resolveOverWakes(storage, deps({ running: true, markers: new Set(["w1"]) }));

  assert.equal(result.resolved.length, 1, "an already-over wake with unresolved keys must still be resolved");
  assert.equal(await storage.get(doneKeyStorageKey(key)), 1);
});

test("resolveOverWakes is idempotent: a second call with nothing left to resolve does not re-emit anything", async () => {
  const storage = memoryStorage();
  const key = "inbox/worker/2026-01-01/00/000000000000.ndjson.gz";
  await storage.put({
    [wakeStorageKey("w1")]: { startedAt: 1, reason: "backlog", over: false },
    [inboxKeyStorageKey(key)]: "provisional:w1",
  });
  const d = deps({ running: false, markers: new Set(["w1"]) });

  const first = await resolveOverWakes(storage, d);
  assert.equal(first.resolved.length, 1);

  const second = await resolveOverWakes(storage, d);
  assert.equal(second.resolved.length, 0, "the wake: entry is gone, so there is nothing left to (re-)resolve");
  assert.equal(second.newlyOver.length, 0);
});

// ---- F2 fix (B-I1): the race markKeysProvisional/resolveOverWakes closes --

test("B-I1: a markKeysProvisional call delivered WHILE isBoxRunning() is pending is still correctly captured (not lost, not committed without the marker)", async () => {
  const storage = memoryStorage();
  await storage.put({ [wakeStorageKey("w1")]: { startedAt: 1, reason: "backlog", over: false } });

  let releaseIsBoxRunning;
  const isBoxRunningPromise = new Promise((resolve) => {
    releaseIsBoxRunning = resolve;
  });

  const resolvePromise = resolveOverWakes(storage, {
    isBoxRunning: () => isBoxRunningPromise,
    markerExists: async () => false, // no marker — an unclean stop
  });

  // Simulate the exact interleaving B-I1 describes: while resolveOverWakes
  // is awaiting isBoxRunning() (an input-gate-opening RPC in production),
  // drainStep's own markKeysProvisional call for the SAME still-not-over
  // wake is delivered and runs.
  const key = "inbox/worker/2026-01-01/00/000000000000.ndjson.gz";
  await markKeysProvisional(storage, "w1", [key]);
  assert.equal(await storage.get(inboxKeyStorageKey(key)), "provisional:w1", "the mark must succeed — the wake is not over yet");

  releaseIsBoxRunning(false); // now the box is observed not running
  const result = await resolvePromise;

  // The key must be re-opened (no marker), never silently dropped and never
  // committed without the marker ever having been consulted (the exact
  // B-I1 data-loss shape: "clean = hasProvisional ? markerExists : true"
  // using a STALE hasProvisional computed before this same await).
  assert.equal(result.resolved[0].clean, false);
  assert.equal(result.resolved[0].keysAffected, 1, "the late-arriving key must be seen, not missed");
  assert.equal(await storage.get(inboxKeyStorageKey(key)), "written");
});

test("B-I1: markKeysProvisional refuses once the wake is over — the key stays untouched for the next wake to pick up", async () => {
  const storage = memoryStorage();
  await storage.put({ [wakeStorageKey("w1")]: { startedAt: 1, reason: "backlog", over: true } });
  const key = "inbox/worker/2026-01-01/00/000000000000.ndjson.gz";

  await markKeysProvisional(storage, "w1", [key]);

  assert.equal(await storage.get(inboxKeyStorageKey(key)), undefined, "an over wake must never accept a new provisional mark");
});

test("B-I1: markKeysProvisional refuses for an unknown/already-deleted wake", async () => {
  const storage = memoryStorage();
  const key = "inbox/worker/2026-01-01/00/000000000000.ndjson.gz";

  await markKeysProvisional(storage, "does-not-exist", [key]);

  assert.equal(await storage.get(inboxKeyStorageKey(key)), undefined);
});

// ---- F3: a zero-ingest wake is a clean stop --------------------------------
//
// T03-D2's other finding: a wake that drains nothing (an empty backlog, or a
// visit wake nobody ever pushed data into) never produces a Loki index
// upload, so shutdown.sh never writes the marker — every such wake was
// counted `unclean`, inflating exit criterion 12's count for a wake that
// lost nothing (nothing was ever provisional). This must not weaken T01's
// C1 guarantee: a wake that DID push data still needs the real marker.

test("F3: a wake with no provisional keys at all resolves clean, with no marker required", async () => {
  const storage = memoryStorage();
  // w1 is over, and never had ANY key marked provisional under it — the
  // exact T03-D2 shape (Loki ingested nothing this wake, so no marker was
  // ever going to exist).
  await storage.put({ [wakeStorageKey("w1")]: { startedAt: 1, reason: "backlog", over: false } });

  const result = await resolveOverWakes(storage, deps({ running: false, markers: new Set() /* no marker */ }));

  assert.equal(result.resolved.length, 1);
  assert.equal(result.resolved[0].clean, true, "zero provisional keys must resolve clean even without a marker");
  assert.equal(result.resolved[0].keysAffected, 0);
});

test("F3: a wake that DID push data still requires the real marker — no weakening of T01's C1 guarantee", async () => {
  const storage = memoryStorage();
  const key = "inbox/worker/2026-01-01/00/000000000000.ndjson.gz";
  await storage.put({
    [wakeStorageKey("w1")]: { startedAt: 1, reason: "backlog", over: false },
    [inboxKeyStorageKey(key)]: "provisional:w1",
  });

  const result = await resolveOverWakes(storage, deps({ running: false, markers: new Set() /* no marker */ }));

  assert.equal(result.resolved[0].clean, false, "a wake with provisional keys and no marker must still resolve unclean");
  assert.equal(await storage.get(inboxKeyStorageKey(key)), "written", "the un-marked data must be re-opened, not silently dropped");
});

// ---- backlog ----------------------------------------------------------

test("computeBacklog counts only `written` keys and reports the oldest R2 `uploaded` time", async () => {
  const storage = memoryStorage();
  const writtenKey = "inbox/worker/2026-01-01/00/000000000000.ndjson.gz";
  const doneKey = "inbox/worker/2026-01-01/00/000000000001.ndjson.gz";
  await storage.put({
    [inboxKeyStorageKey(writtenKey)]: "written",
    [doneKeyStorageKey(doneKey)]: 1, // committed — lives under done:, not key:
  });
  const oldUploaded = new Date(Date.now() - 90 * 60 * 1000);

  const info = await computeBacklog(
    storage,
    async () => [
      { key: writtenKey, size: 1234, uploaded: oldUploaded },
      { key: doneKey, size: 999999, uploaded: new Date() }, // must be ignored
    ],
    false,
  );

  assert.equal(info.writtenCount, 1);
  assert.equal(info.totalBytes, 1234);
  assert.ok(info.oldestWrittenAgeMs >= 89 * 60 * 1000, "age must reflect the real uploaded time, not an hour-bucket guess");
});

test("computeBacklog reports zero backlog when nothing is written", async () => {
  const storage = memoryStorage();
  const info = await computeBacklog(storage, async () => [], true);
  assert.deepEqual(info, { oldestWrittenAgeMs: 0, totalBytes: 0, writtenCount: 0, drainsPaused: true });
});

// ---- nextWrittenKeys / markKeysProvisional / rejectKey ------------------

test("nextWrittenKeys returns only `written` keys, in ascending key order, capped at `limit`", async () => {
  const storage = memoryStorage();
  await storage.put({
    [inboxKeyStorageKey("inbox/worker/2026-01-01/00/000000000002.ndjson.gz")]: "written",
    [inboxKeyStorageKey("inbox/worker/2026-01-01/00/000000000000.ndjson.gz")]: "written",
    [doneKeyStorageKey("inbox/worker/2026-01-01/00/000000000001.ndjson.gz")]: 1,
  });

  const keys = await nextWrittenKeys(storage, 5);
  assert.deepEqual(keys, [
    "inbox/worker/2026-01-01/00/000000000000.ndjson.gz",
    "inbox/worker/2026-01-01/00/000000000002.ndjson.gz",
  ]);

  const capped = await nextWrittenKeys(storage, 1);
  assert.equal(capped.length, 1);
});

test("markKeysProvisional / rejectKey write the exact ledger states ADR §B.3 defines", async () => {
  const storage = memoryStorage();
  const key = "inbox/worker/2026-01-01/00/000000000000.ndjson.gz";
  await storage.put({
    [wakeStorageKey("w1")]: { startedAt: 1, reason: "backlog", over: false },
    [inboxKeyStorageKey(key)]: "written",
  });

  await markKeysProvisional(storage, "w1", [key]);
  assert.equal(await storage.get(inboxKeyStorageKey(key)), "provisional:w1");

  await rejectKey(storage, key, "too_far_behind");
  assert.equal(await storage.get(inboxKeyStorageKey(key)), "rejected:too_far_behind");
});

// ---- reopenWindow -------------------------------------------------------

test("reopenWindow re-opens a `written`-eligible key whose hour overlaps the window, and only that key", async () => {
  const storage = memoryStorage();
  const inWindowKey = inboxKey("worker", new Date(Date.UTC(2026, 0, 1, 10)), 0);
  const outsideKey = inboxKey("worker", new Date(Date.UTC(2026, 0, 1, 20)), 1);
  await storage.put({
    [inboxKeyStorageKey(inWindowKey)]: "rejected:too_far_behind",
    [inboxKeyStorageKey(outsideKey)]: "rejected:too_far_behind",
  });

  const from = Date.UTC(2026, 0, 1, 9, 30);
  const to = Date.UTC(2026, 0, 1, 10, 30);
  const result = await reopenWindow(storage, from, to, null);

  assert.equal(result.reopened, 1);
  assert.equal(await storage.get(inboxKeyStorageKey(inWindowKey)), "written");
  assert.equal(await storage.get(inboxKeyStorageKey(outsideKey)), "rejected:too_far_behind");
});

test("reopenWindow finds a COMMITTED key under done: and moves it back to key: = written", async () => {
  const storage = memoryStorage();
  const key = inboxKey("worker", new Date(Date.UTC(2026, 0, 1, 10)), 0);
  await storage.put({ [doneKeyStorageKey(key)]: 1 });

  const result = await reopenWindow(storage, Date.UTC(2026, 0, 1, 9, 30), Date.UTC(2026, 0, 1, 10, 30), null);

  assert.equal(result.reopened, 1);
  assert.equal(await storage.get(inboxKeyStorageKey(key)), "written");
  assert.equal(await storage.get(doneKeyStorageKey(key)), undefined, "must leave done: once re-opened");
});

test("reopenWindow never touches a key provisional to the CURRENT active wake", async () => {
  const storage = memoryStorage();
  const key = inboxKey("worker", new Date(Date.UTC(2026, 0, 1, 10)), 0);
  await storage.put({ [inboxKeyStorageKey(key)]: "provisional:active-wake" });

  const result = await reopenWindow(storage, Date.UTC(2026, 0, 1, 0), Date.UTC(2026, 0, 2, 0), "active-wake");

  assert.equal(result.reopened, 0);
  assert.equal(await storage.get(inboxKeyStorageKey(key)), "provisional:active-wake");
});

test("B-M9: reopenWindowExceedsRetention refuses a window wider than the 7-day retention", () => {
  assert.equal(reopenWindowExceedsRetention(0, KEY_RETENTION_MS), false);
  assert.equal(reopenWindowExceedsRetention(0, KEY_RETENTION_MS + 1), true);
});

// ---- currentWakeId ------------------------------------------------------

test("currentWakeId returns the one not-over wake, or null", async () => {
  const storage = memoryStorage();
  assert.equal(await currentWakeId(storage), null);

  await storage.put({ [wakeStorageKey("w1")]: { startedAt: 1, reason: "visit", over: false } });
  assert.equal(await currentWakeId(storage), "w1");
});

// ---- pruneLedger (A-I1) --------------------------------------------------

test("pruneLedger deletes only done: entries older than KEY_RETENTION_MS, per tenant, bounded by a range read", async () => {
  const storage = memoryStorage();
  const now = Date.UTC(2026, 5, 20, 0, 0, 0);
  const staleBrowser = inboxKey("browser", new Date(now - KEY_RETENTION_MS - 24 * 60 * 60 * 1000), 0);
  const staleWorker = inboxKey("worker", new Date(now - KEY_RETENTION_MS - 24 * 60 * 60 * 1000), 0);
  const freshBrowser = inboxKey("browser", new Date(now - 60 * 60 * 1000), 0);
  await storage.put({
    [doneKeyStorageKey(staleBrowser)]: 1,
    [doneKeyStorageKey(staleWorker)]: 1,
    [doneKeyStorageKey(freshBrowser)]: 1,
  });

  const result = await pruneLedger(storage, now);

  assert.equal(result.doneDeleted, 2);
  assert.equal(await storage.get(doneKeyStorageKey(staleBrowser)), undefined);
  assert.equal(await storage.get(doneKeyStorageKey(staleWorker)), undefined);
  assert.equal(await storage.get(doneKeyStorageKey(freshBrowser)), 1, "a fresh done: entry must survive");
});

// ---- N2 (merge blocker): a wake with >128 provisional keys ---------------------

test("N2: a wake with 150 provisional keys (over the real DO storage 128-key limit) resolves correctly, all moved to done:", async () => {
  const storage = memoryStorage();
  const wakeId = "big-wake";
  const keyCount = 150;
  const keys = Array.from(
    { length: keyCount },
    (_, i) => `inbox/worker/2026-01-01/00/${String(i).padStart(12, "0")}.ndjson.gz`,
  );
  const writes = { [wakeStorageKey(wakeId)]: { startedAt: 1, reason: "backlog", over: true } };
  for (const k of keys) writes[inboxKeyStorageKey(k)] = `provisional:${wakeId}`;
  await putChunked(storage, writes); // N2: 151 keys, over the harness's own 128-key seed limit

  const result = await resolveOverWakes(storage, deps({ running: false, markers: new Set([wakeId]) }));

  assert.equal(result.resolved.length, 1);
  assert.equal(result.resolved[0].keysAffected, keyCount, "the task's own '>64 provisional keys' scenario must fully finalize, not throw or partially resolve");
  for (const k of keys) {
    assert.equal(await storage.get(inboxKeyStorageKey(k)), undefined, `${k} must leave key:`);
    assert.equal(await storage.get(doneKeyStorageKey(k)), 1, `${k} must appear under done:`);
  }
  assert.equal(await storage.get(wakeStorageKey(wakeId)), undefined, "the wake must be fully resolved");
});

// N2 atomicity trap (advisor review, this fix round): chunking
// `finalizeWakeResolution`'s delete to the real 128-key limit, WITHOUT also
// wrapping the whole function in one `storage.transaction()`, would let a
// crash between chunks orphan whichever provisional keys were in a
// not-yet-run later chunk — their `wake:<id>` entry could already be gone
// (an earlier chunk) while they are still `provisional:<wakeId>`, and
// nothing ever revisits them (`markKeysProvisional` refuses an unknown
// wake). `wakeStorageKey(wakeId)` is pushed onto `toDelete` LAST — this
// proves that ordering: a failure on a LATER delete chunk never removes the
// wake record, so a crash never reaches the "wake is gone but keys are
// still provisional" state, even though this in-memory fake (unlike the
// real DO's transaction) does not roll back the earlier, already-applied
// `put`/`delete` chunks — see this test's own assertions for exactly what
// is and is not proven here.
test("N2 atomicity: if a LATER delete chunk throws, wake: (deleted last) survives and the error propagates", async () => {
  const storage = memoryStorage();
  const wakeId = "big-wake-2";
  const keyCount = 150;
  const keys = Array.from(
    { length: keyCount },
    (_, i) => `inbox/worker/2026-01-01/00/${String(i).padStart(12, "0")}.ndjson.gz`,
  );
  const writes = { [wakeStorageKey(wakeId)]: { startedAt: 1, reason: "backlog", over: true } };
  for (const k of keys) writes[inboxKeyStorageKey(k)] = `provisional:${wakeId}`;
  await putChunked(storage, writes); // N2: 151 keys, over the harness's own 128-key seed limit

  let deleteCalls = 0;
  const originalDelete = storage.delete.bind(storage);
  storage.delete = async (chunk) => {
    deleteCalls++;
    if (deleteCalls === 2) throw new Error("simulated crash mid-chunk");
    return originalDelete(chunk);
  };

  await assert.rejects(() => resolveOverWakes(storage, deps({ running: false, markers: new Set([wakeId]) })));

  assert.ok(deleteCalls >= 2, "sanity: 151 keys (150 + wake:) over the 128-key limit must take more than one delete() call");
  assert.notEqual(
    await storage.get(wakeStorageKey(wakeId)),
    undefined,
    "wake: must survive a failed LATER delete chunk — it is always the last key in the delete list",
  );
});

// N8 (rereview.md §2 Minor, "nearly free" per the advisor review): a stale
// outer snapshot can undo a concurrent manual reopen.
test("N8: finalizeWakeResolution re-reads each key's CURRENT state — a concurrent manual reopen (key moved back to written) is not silently overwritten", async () => {
  const storage = memoryStorage();
  const wakeId = "w-n8";
  const key = "inbox/worker/2026-01-01/00/000000000000.ndjson.gz";
  await storage.put({
    [wakeStorageKey(wakeId)]: { startedAt: 1, reason: "backlog", over: true },
    [inboxKeyStorageKey(key)]: "provisional:" + wakeId,
  });

  // Simulate a manual reopen racing in AFTER resolveOverWakes's own
  // provisionalKeys snapshot was taken but BEFORE finalizeWakeResolution's
  // internal re-read — the key is no longer this wake's provisional key.
  const deps2 = {
    isBoxRunning: async () => false,
    markerExists: async () => {
      await storage.put({ [inboxKeyStorageKey(key)]: "written" }); // the "concurrent reopen"
      return true; // clean
    },
  };

  const result = await resolveOverWakes(storage, deps2);

  assert.equal(result.resolved[0].keysAffected, 0, "the reopened key must not be counted as resolved by this wake");
  assert.equal(
    await storage.get(inboxKeyStorageKey(key)),
    "written",
    "the concurrent reopen's `written` state must survive — not be overwritten by done: or re-written",
  );
});

// ---- rejectedEvent: audit log (row 19 / B-C1/A-I1 remainder) ------------------

test("rejectKey writes both the rejected: key: state AND a rejectedEvent: entry", async () => {
  const storage = memoryStorage();
  const key = "inbox/worker/2026-01-01/00/000000000000.ndjson.gz";
  const nowMs = Date.UTC(2026, 5, 1);

  await rejectKey(storage, key, "too_far_behind", nowMs);

  assert.equal(await storage.get(inboxKeyStorageKey(key)), "rejected:too_far_behind");
  assert.equal(await recentRejectionCount(storage, nowMs - 1), 1, "the event must be visible strictly after (nowMs - 1)");
  assert.equal(await recentRejectionCount(storage, nowMs), 0, "but not strictly after its own timestamp");
});

test("recordPartialReject (row 19) logs a rejectedEvent WITHOUT touching key: state — the key stays whatever it already was", async () => {
  const storage = memoryStorage();
  const key = "inbox/worker/2026-01-01/00/000000000001.ndjson.gz";
  const nowMs = Date.UTC(2026, 5, 1);
  await storage.put({ [inboxKeyStorageKey(key)]: "provisional:w1" });

  await recordPartialReject(storage, key, "too_far_behind", nowMs);

  assert.equal(
    await storage.get(inboxKeyStorageKey(key)),
    "provisional:w1",
    "a partial reject must never change the key's own ledger state (it stays durable/provisional)",
  );
  assert.equal(await recentRejectionCount(storage, nowMs - 1), 1, "the event must still be logged, for the alert");
});

test("recentRejectionCount: rejected-inbox-key's real fix — an OLD rejection outside the window does not count, even though rejectedKeyCount would still see it forever", async () => {
  const storage = memoryStorage();
  const oldMs = Date.UTC(2026, 5, 1);
  const nowMs = oldMs + 2 * 60 * 60 * 1000; // 2h later
  await rejectKey(storage, "inbox/worker/2026-01-01/00/000000000000.ndjson.gz", "x", oldMs);

  assert.equal(await recentRejectionCount(storage, nowMs - 60 * 60 * 1000), 0, "a rejection older than the 1h window must not count as recent");
  assert.equal(await recentRejectionCount(storage, oldMs - 1), 1, "but it is still findable as a raw event, e.g. for audit");
});

test("pruneLedger also prunes stale rejected: key: entries (filtered by value, not a blind range delete) and rejectedEvent: entries", async () => {
  const storage = memoryStorage();
  const now = Date.UTC(2026, 5, 20, 0, 0, 0);
  const staleDate = new Date(now - KEY_RETENTION_MS - 24 * 60 * 60 * 1000);
  const freshDate = new Date(now - 60 * 60 * 1000);
  const staleRejected = inboxKey("worker", staleDate, 0);
  const staleWritten = inboxKey("worker", staleDate, 1); // same stale date range, NOT rejected — must survive
  const freshRejected = inboxKey("worker", freshDate, 0);

  await rejectKey(storage, staleRejected, "old", staleDate.getTime());
  await storage.put({ [inboxKeyStorageKey(staleWritten)]: "written" });
  await rejectKey(storage, freshRejected, "recent", freshDate.getTime());

  const result = await pruneLedger(storage, now);

  assert.equal(result.rejectedDeleted, 1);
  assert.equal(await storage.get(inboxKeyStorageKey(staleRejected)), undefined, "the stale REJECTED key must be pruned");
  assert.equal(
    await storage.get(inboxKeyStorageKey(staleWritten)),
    "written",
    "a stale but NON-rejected key in the same date range must survive — value-filtered, not a blind range delete",
  );
  assert.equal(await storage.get(inboxKeyStorageKey(freshRejected)), "rejected:recent", "a fresh rejected key must survive");
  // The rejectedEvent: audit entries follow the same retention.
  assert.equal(await recentRejectionCount(storage, staleDate.getTime() - 1), 1, "the fresh event must still be findable");
});
