// B-C1 (must-fix, final review): "Add a scale test with 10k keys × 500
// wakes that asserts a bounded number of reads per call." The finding's own
// failure estimate: the OLD `resolveOverWakes` did one full `key:` scan
// PER WAKE inside a loop over every `wake:` entry ever recorded — O(wakes ×
// keys) — "~22-65M storage rows read per call" at 30 days of traffic.
//
// This wraps a real `memoryStorage()` to COUNT every row a `list`/`get`/
// `getMany` call actually yields/looks up (not the number of calls — the
// billing/CPU concern is rows read, not round-trips — see the advisor
// review this fix round recorded). It then proves the fix is linear in
// (wakes + keys), never their product, and that once wakes are resolved
// (and committed keys pruned, per the B-C1/A-I1 fix's `done:` split —
// ledger.ts's header), a STEADY-STATE call reads a small, bounded number of
// rows regardless of how much history has accumulated.
//
// Run: node --experimental-strip-types --test pipeline/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./fixtures/o11y-worker-hooks.mjs", import.meta.url);

const { memoryStorage, putChunked } = await import("../workers/o11y/src/inbox/storage.ts");
const { resolveOverWakes, computeBacklog, nextWrittenKeys, pruneLedger } = await import(
  "../workers/o11y/src/inbox/ledger.ts"
);
const { wakeStorageKey, inboxKeyStorageKey, doneKeyStorageKey, inboxKey } = await import(
  "@handsontable/demo-runtime/telemetry"
);

/** Wraps a real `memoryStorage()` so every row a `list`/`get`/`getMany` call
 *  actually returns/looks up is tallied into `rowReads` — reset with
 *  `resetRowReads()` between calls under test. `put`/`delete` aren't
 *  counted: this test is about READ amplification (the billing/CPU concern
 *  B-C1 describes), not write cost. */
function countingStorage() {
  const inner = memoryStorage();
  let rowReads = 0;
  return {
    async get(key) {
      rowReads += 1; // a single-key get is always exactly one row lookup
      return inner.get(key);
    },
    async getMany(keys) {
      rowReads += keys.length;
      return inner.getMany(keys);
    },
    put: (entries) => inner.put(entries),
    delete: (keys) => inner.delete(keys),
    async list(options) {
      const result = await inner.list(options);
      rowReads += result.size;
      return result;
    },
    transaction: (closure) => inner.transaction(closure),
    getAlarm: () => inner.getAlarm(),
    setAlarm: (t) => inner.setAlarm(t),
    resetRowReads() {
      rowReads = 0;
    },
    get rowReads() {
      return rowReads;
    },
  };
}

const WAKE_COUNT = 500;
const KEYS_PER_WAKE = 20; // 500 * 20 = 10,000 keys, matching the finding's own "10k keys" scale
const TOTAL_KEYS = WAKE_COUNT * KEYS_PER_WAKE;

/** Seeds `WAKE_COUNT` already-`over` wakes, each with `KEYS_PER_WAKE`
 *  `provisional:<wakeId>` keys — the exact shape B-C1 measured its O(W×K)
 *  estimate against (every wake still holding unresolved provisional keys
 *  at once). Real day-spread timestamps so `pruneLedger`'s later date-range
 *  reads are exercised meaningfully too. */
async function seedScale(storage) {
  const writes = {};
  const baseMs = Date.UTC(2026, 5, 1, 0, 0, 0);
  for (let w = 0; w < WAKE_COUNT; w++) {
    const wakeId = `w${w}`;
    writes[wakeStorageKey(wakeId)] = { startedAt: baseMs, reason: "backlog", over: true };
    for (let k = 0; k < KEYS_PER_WAKE; k++) {
      const seq = w * KEYS_PER_WAKE + k;
      const hour = seq % 24;
      const day = 1 + Math.floor(seq / (24 * 40)); // spread across a few June days
      const key = inboxKey("worker", new Date(Date.UTC(2026, 5, day, hour)), seq);
      writes[inboxKeyStorageKey(key)] = `provisional:${wakeId}`;
    }
  }
  // F2/G1 fix round (N2): a real SQLite-backed DO storage `put()` caps at
  // 128 key-value pairs per call — this fixture seeds 10,500+ at once, so
  // it must chunk like any other production multi-key write (never loosen
  // `memoryStorage()`'s own enforcement of that limit to make a TEST fit).
  await putChunked(storage, writes);
}

test(`scale: resolveOverWakes over ${WAKE_COUNT} wakes × ${KEYS_PER_WAKE} keys (${TOTAL_KEYS} total) reads a number of rows LINEAR in (wakes+keys), never their product`, async () => {
  const storage = countingStorage();
  await seedScale(storage);

  storage.resetRowReads();
  const result = await resolveOverWakes(storage, {
    isBoxRunning: async () => false,
    markerExists: async () => true, // every wake resolves clean
  });

  assert.equal(result.resolved.length, WAKE_COUNT, "every wake must actually be resolved");
  const totalKeysAffected = result.resolved.reduce((sum, r) => sum + r.keysAffected, 0);
  assert.equal(totalKeysAffected, TOTAL_KEYS);

  // The OLD O(wakes × keys) design would read ~WAKE_COUNT * TOTAL_KEYS =
  // 500 * 10,000 = 5,000,000 rows for this exact shape (the finding's own
  // "~22-65M" estimate, scaled to this test's smaller fixture) — the
  // single-pass fix reads `wake:` once (WAKE_COUNT rows) and `key:` once
  // (TOTAL_KEYS rows), a small constant multiple of (wakes + keys), never
  // their product. Generous bound (3x) to allow for the fixed handful of
  // additional targeted reads (existence re-checks before each wake's
  // final write) without being so loose it stops meaning anything.
  const bound = 3 * (WAKE_COUNT + TOTAL_KEYS);
  assert.ok(
    storage.rowReads <= bound,
    `resolveOverWakes read ${storage.rowReads} rows for ${WAKE_COUNT} wakes × ${TOTAL_KEYS} keys — expected <= ${bound} (linear), the O(wakes×keys) shape this fixes would read ~${WAKE_COUNT * TOTAL_KEYS}`,
  );
});

test("scale: once wakes are resolved (and committed keys pruned to done:), a STEADY-STATE resolveWakes/backlog/nextWrittenKeys call reads a small, bounded number of rows — independent of the 10k-key history", async () => {
  const storage = countingStorage();
  await seedScale(storage);

  // Resolve everything once (as the previous test does), which — per this
  // fix's design — moves every committed key OUT of `key:` into `done:`
  // and deletes every `wake:` entry. What's left in `key:`/`wake:` after
  // this is empty; a FEW new `written` keys are added on top (a handful of
  // fresh, still-open inbox objects, exactly what a real backlog/drain
  // loop actually has to read on every call in steady state).
  await resolveOverWakes(storage, { isBoxRunning: async () => false, markerExists: async () => true });

  const freshWrites = {};
  for (let i = 0; i < 5; i++) {
    freshWrites[inboxKeyStorageKey(inboxKey("worker", new Date(Date.UTC(2026, 5, 20, i)), 9000 + i))] = "written";
  }
  await storage.put(freshWrites);

  storage.resetRowReads();
  await resolveOverWakes(storage, { isBoxRunning: async () => false, markerExists: async () => true });
  const resolveReads = storage.rowReads;

  storage.resetRowReads();
  await computeBacklog(storage, async () => [], false);
  const backlogReads = storage.rowReads;

  storage.resetRowReads();
  await nextWrittenKeys(storage, 10);
  const nextWrittenReads = storage.rowReads;

  // Bounded by a small constant, NOT by the 10,000 keys / 500 wakes that
  // existed in this DO's history — that is the literal "never scan
  // committed history" requirement. 50 is generous headroom over the ~5-10
  // rows each call actually touches (the wake:/key: prefixes are empty or
  // near-empty at this point) while still catching a regression back to a
  // full-history scan (which would read >= 10,000).
  const bound = 50;
  assert.ok(resolveReads <= bound, `steady-state resolveOverWakes read ${resolveReads} rows, expected <= ${bound}`);
  assert.ok(backlogReads <= bound, `steady-state computeBacklog read ${backlogReads} rows, expected <= ${bound}`);
  assert.ok(nextWrittenReads <= bound, `steady-state nextWrittenKeys read ${nextWrittenReads} rows, expected <= ${bound}`);
});

test("scale: pruneLedger deletes done: history in bounded batches, never in one unbounded scan of the whole prefix", async () => {
  const storage = countingStorage();
  // 10k committed keys, all already stale (8 days old — past the 7-day
  // retention), spread across a tenant.
  const writes = {};
  for (let i = 0; i < 10_000; i++) {
    const hour = i % 24;
    const day = 1 + (Math.floor(i / 24) % 28);
    const key = inboxKey("worker", new Date(Date.UTC(2026, 0, day, hour)), i);
    writes[doneKeyStorageKey(key)] = 1;
  }
  await putChunked(storage, writes); // N2: chunk the 10k-pair seed write, see seedScale's own note

  storage.resetRowReads();
  const nowMs = Date.UTC(2026, 5, 1); // well past every seeded done: entry's retention
  const result = await pruneLedger(storage, nowMs);

  // The batch limit (ledger.ts's own PRUNE_BATCH_LIMIT) bounds how much ONE
  // call can read/delete — it must NOT have scanned all 10,000 rows in one
  // pass (that would be exactly the unbounded full-prefix scan this fixes).
  assert.ok(result.doneDeleted > 0, "at least some stale done: entries must be deleted");
  assert.ok(
    result.doneDeleted < 10_000,
    "one call must not delete the entire 10k-row history in a single unbounded pass — it must be batch-bounded",
  );
  assert.ok(
    storage.rowReads < 10_000,
    `pruneLedger read ${storage.rowReads} rows for a 10k-row done: prefix — expected a bounded batch read, not a full scan`,
  );
});
