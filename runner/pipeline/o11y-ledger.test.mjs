// The ledger (workers/o11y/src/inbox/ledger.ts, ADR-0041 §B.3) — pure
// functions over `storage.ts#memoryStorage()`, no DO/R2 needed (T02's own
// pattern for `dedupe.ts`/`registry.ts`/`pack.ts`).
//
// Run: node --experimental-strip-types --test pipeline/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./fixtures/o11y-worker-hooks.mjs", import.meta.url);

const { memoryStorage } = await import("../workers/o11y/src/inbox/storage.ts");
const {
  resolveOverWakes,
  computeBacklog,
  nextWrittenKeys,
  markKeysProvisional,
  rejectKey,
  reopenWindow,
  currentWakeId,
} = await import("../workers/o11y/src/inbox/ledger.ts");
const { wakeStorageKey, inboxKeyStorageKey, inboxKey } = await import("@handsontable/demo-runtime/telemetry");

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
});

test("resolveOverWakes commits a key when the marker is present (clean stop)", async () => {
  const storage = memoryStorage();
  const key = "inbox/worker/2026-01-01/00/000000000000.ndjson.gz";
  await storage.put({
    [wakeStorageKey("w1")]: { startedAt: 1, reason: "backlog", over: false },
    [inboxKeyStorageKey(key)]: "provisional:w1",
  });

  const result = await resolveOverWakes(storage, deps({ running: false, markers: new Set(["w1"]) }));

  assert.deepEqual(result.newlyOver, ["w1"]);
  assert.equal(result.resolved[0].clean, true);
  assert.equal(await storage.get(inboxKeyStorageKey(key)), "committed");
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
});

test("resolveOverWakes: a newer wake already marked `over: true` by recordWake still gets its keys resolved", async () => {
  const storage = memoryStorage();
  const key = "inbox/worker/2026-01-01/00/000000000000.ndjson.gz";
  await storage.put({
    [wakeStorageKey("w1")]: { startedAt: 1, reason: "backlog", over: true }, // already over
    [inboxKeyStorageKey(key)]: "provisional:w1", // but its keys were never resolved (crash between the two writes)
  });

  // deps.isBoxRunning is irrelevant here — the wake is already over.
  const result = await resolveOverWakes(storage, deps({ running: true, markers: new Set(["w1"]) }));

  assert.equal(result.resolved.length, 1, "an already-over wake with unresolved keys must still be resolved");
  assert.equal(await storage.get(inboxKeyStorageKey(key)), "committed");
});

// ---- backlog ----------------------------------------------------------

test("computeBacklog counts only `written` keys and reports the oldest R2 `uploaded` time", async () => {
  const storage = memoryStorage();
  const writtenKey = "inbox/worker/2026-01-01/00/000000000000.ndjson.gz";
  const committedKey = "inbox/worker/2026-01-01/00/000000000001.ndjson.gz";
  await storage.put({
    [inboxKeyStorageKey(writtenKey)]: "written",
    [inboxKeyStorageKey(committedKey)]: "committed",
  });
  const oldUploaded = new Date(Date.now() - 90 * 60 * 1000);

  const info = await computeBacklog(
    storage,
    async () => [
      { key: writtenKey, size: 1234, uploaded: oldUploaded },
      { key: committedKey, size: 999999, uploaded: new Date() }, // must be ignored
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
    [inboxKeyStorageKey("inbox/worker/2026-01-01/00/000000000001.ndjson.gz")]: "committed",
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
  await storage.put({ [inboxKeyStorageKey(key)]: "written" });

  await markKeysProvisional(storage, "w1", [key]);
  assert.equal(await storage.get(inboxKeyStorageKey(key)), "provisional:w1");

  await rejectKey(storage, key, "too_far_behind");
  assert.equal(await storage.get(inboxKeyStorageKey(key)), "rejected:too_far_behind");
});

// ---- reopenWindow -------------------------------------------------------

test("reopenWindow re-opens a committed key whose hour overlaps the window, and only that key", async () => {
  const storage = memoryStorage();
  const inWindowKey = inboxKey("worker", new Date(Date.UTC(2026, 0, 1, 10)), 0);
  const outsideKey = inboxKey("worker", new Date(Date.UTC(2026, 0, 1, 20)), 1);
  await storage.put({
    [inboxKeyStorageKey(inWindowKey)]: "committed",
    [inboxKeyStorageKey(outsideKey)]: "committed",
  });

  const from = Date.UTC(2026, 0, 1, 9, 30);
  const to = Date.UTC(2026, 0, 1, 10, 30);
  const result = await reopenWindow(storage, from, to, null);

  assert.equal(result.reopened, 1);
  assert.equal(await storage.get(inboxKeyStorageKey(inWindowKey)), "written");
  assert.equal(await storage.get(inboxKeyStorageKey(outsideKey)), "committed");
});

test("reopenWindow never touches a key provisional to the CURRENT active wake", async () => {
  const storage = memoryStorage();
  const key = inboxKey("worker", new Date(Date.UTC(2026, 0, 1, 10)), 0);
  await storage.put({ [inboxKeyStorageKey(key)]: "provisional:active-wake" });

  const result = await reopenWindow(storage, Date.UTC(2026, 0, 1, 0), Date.UTC(2026, 0, 2, 0), "active-wake");

  assert.equal(result.reopened, 0);
  assert.equal(await storage.get(inboxKeyStorageKey(key)), "provisional:active-wake");
});

// ---- currentWakeId ------------------------------------------------------

test("currentWakeId returns the one not-over wake, or null", async () => {
  const storage = memoryStorage();
  assert.equal(await currentWakeId(storage), null);

  await storage.put({ [wakeStorageKey("w1")]: { startedAt: 1, reason: "visit", over: false } });
  assert.equal(await currentWakeId(storage), "w1");
});
