// ADR §B.2 steps 4–6 + §8 — `InboxWriter` tests: dedupe (24 h window and
// within-batch), the fingerprint first-seen registry, row chunking/numeric
// ordering, pack/commit, a simulated restart between an append and the
// alarm, and `recordWake`'s "mark every earlier wake over" rule. The real
// `InboxWriter` class is constructed over a `Map`-backed
// `DurableObjectStorage` fake (`o11y-harness.mjs`) — not a copy of its
// logic — so a broken implementation, not a broken test double, is what
// fails here.
// Run: node --experimental-strip-types --test pipeline/o11y-inbox.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./fixtures/o11y-worker-hooks.mjs", import.meta.url);

const { makeEnv, makeDurableObjectStorage, makeR2Bucket, ctx } = await import("./fixtures/o11y-harness.mjs");
const { pendingRowsByTenant } = await import("./fixtures/o11y-inbox-helpers.mjs");
const { InboxWriter } = await import("../workers/o11y/src/inbox/writer.ts");
const { checkDuplicates, pruneHashBuckets, capHashWrites, HASH_PRUNE_BATCH_LIMIT } = await import("../workers/o11y/src/inbox/dedupe.ts");
const {
  newFingerprintWrites,
  admitNewFingerprints,
  evictOldestFingerprints,
  pruneFingerprintRegistry,
  readFpCount,
  FP_COUNT_STORAGE_KEY,
  FP_PRUNE_CURSOR_STORAGE_KEY,
} = await import("../workers/o11y/src/inbox/registry.ts");
const {
  ADMISSION_WINDOW_MS,
  FP_ADMIT_PER_WINDOW,
  HASH_ADMIT_PER_WINDOW,
  admissionKey,
  admissionDroppedSince,
  pruneAdmissionWindows,
} = await import("../workers/o11y/src/inbox/admission.ts");
const {
  appendRows,
  packTenant,
  commitPackedObject,
  collectRowBatch,
  ROW_LIST_PAGE_LIMIT,
  PACK_OBJECT_MAX_DECOMPRESSED_BYTES,
} = await import("../workers/o11y/src/inbox/pack.ts");
const { memoryStorage, putChunked } = await import("../workers/o11y/src/inbox/storage.ts");
const { decodeNdjson, buildResourceLogs, AE_COLUMNS } = await import("@handsontable/demo-runtime/telemetry");

function record(body, i = 0) {
  return {
    body,
    timeUnixNano: String(1735689600000000000n + BigInt(i)),
    resourceAttributes: { "service.name": "demos-api", "service.version": "v1", "deployment.environment.name": "production" },
    attributes: {},
  };
}

// ---- dedupe.ts --------------------------------------------------------------
//
// The storage key is day-bucketed (`hash:<yyyymmdd>:<sha256>`, see
// dedupe.ts's own header) so stale buckets can be pruned with a bounded
// range delete — `checkDuplicates`'s behaviour (24h window, within-batch
// collapse) is unchanged, but a test that asserts the exact key string
// must bucket by "today" (UTC) the same way the implementation does.

function todayBucket(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");
}

test("dedupe: a hash seen within the 24h window is a duplicate; an unseen one is not", async () => {
  const storage = memoryStorage();
  const first = await checkDuplicates(storage, ["h1", "h2"], Date.now());
  assert.deepEqual(first.isDuplicate, [false, false]);
  await storage.put(first.writes);

  const second = await checkDuplicates(storage, ["h1", "h3"], Date.now() + 5000);
  assert.deepEqual(second.isDuplicate, [true, false]);
  assert.ok(`hash:${todayBucket()}:h3` in second.writes, "the unseen hash must get a write entry, bucketed by today's UTC date");
});

test("dedupe: a hash repeated within one batch is a duplicate on its second occurrence only", async () => {
  const storage = memoryStorage();
  const result = await checkDuplicates(storage, ["h1", "h1", "h2", "h1"], Date.now());
  // Per occurrence: the first h1 is the copy that gets stored.
  assert.deepEqual(result.isDuplicate, [false, true, false, true]);
  assert.ok(`hash:${todayBucket()}:h1` in result.writes, "the first occurrence marks the hash seen");
});

test("dedupe: a hash outside the 24h window is treated as new again", async () => {
  const storage = memoryStorage();
  const dayAgo = Date.now() - 25 * 60 * 60 * 1000;
  await storage.put({ [`hash:${todayBucket(dayAgo)}:h1`]: dayAgo });
  const result = await checkDuplicates(storage, ["h1"], Date.now());
  assert.deepEqual(result.isDuplicate, [false], "an expired hash must not be treated as a duplicate");
});

test("dedupe: a hash from a DIFFERENT UTC-day bucket, still within 24h, is found via the two-bucket check", async () => {
  const storage = memoryStorage();
  // Force `nowMs` to just after a UTC midnight, so a hash written 1 minute
  // earlier lands in YESTERDAY's bucket while still being well within the
  // 24h window — this is the exact case the two-bucket lookup exists for.
  const midnight = Date.UTC(2026, 5, 15, 0, 0, 0);
  const nowMs = midnight + 60_000;
  const writtenMs = midnight - 60_000;
  await storage.put({ [`hash:${todayBucket(writtenMs)}:hY`]: writtenMs });

  const result = await checkDuplicates(storage, ["hY"], nowMs);

  assert.deepEqual(result.isDuplicate, [true], "a hash from yesterday's UTC bucket, still within 24h, must be found");
});

// Pruning must keep up with the ingest rate. ADR §D's own 10× headroom
// projection is ~6.6M worker records/month, ≈ 220,000/day (before browser
// traffic) — this seeds exactly that many stale `hash:` rows (one day's
// worth, at the 10× projected rate) and asserts `pruneHashBuckets`, called
// once per ten-minute cron tick (144 ticks/day — `writer.ts#backlog()`'s
// own cadence), fully clears them within that many calls. At a 500/tick
// limit this would need 220,000 / 500 = 440 ticks — the test is sized so
// it fails at that limit (440 > 144), not just eventually clearing given
// unlimited ticks.
test("pruneHashBuckets keeps up with the ADR §D 10× projected rate (220k stale rows/day, cleared within 144 ten-minute ticks)", async () => {
  const storage = memoryStorage();
  const DAILY_RATE = 220_000;
  const TICKS_PER_DAY = 144;
  const nowMs = Date.UTC(2026, 5, 20, 0, 0, 0);
  const staleBucket = todayBucket(nowMs - 3 * 24 * 60 * 60 * 1000); // 3 days stale — well past the 2-day keep window

  const writes = {};
  for (let i = 0; i < DAILY_RATE; i++) writes[`hash:${staleBucket}:${i.toString(16).padStart(10, "0")}`] = nowMs - 3 * 24 * 60 * 60 * 1000;
  await putChunked(storage, writes);

  let ticks = 0;
  let deleted = 0;
  let result;
  do {
    result = await pruneHashBuckets(storage, nowMs);
    deleted += result.hashDeleted;
    ticks++;
  } while (result.hashDeleted > 0 && ticks < TICKS_PER_DAY);

  assert.equal(deleted, DAILY_RATE, `only ${deleted} of ${DAILY_RATE} stale rows were pruned within ${TICKS_PER_DAY} ticks`);
  assert.ok(ticks <= TICKS_PER_DAY, `took ${ticks} ticks — must clear a day's projected backlog within one day's own ${TICKS_PER_DAY} ticks`);
});

// ---- registry.ts -----------------------------------------------------------------

test("registry: a fingerprint is written once, on first sight, never overwritten", async () => {
  const storage = memoryStorage();
  const first = await newFingerprintWrites(storage, ["fp:a"], 1000);
  // Also writes the `fpts:` time-index twin
  // (`newFingerprintsSince`'s bounded read) alongside the `fp:` entry —
  // "fp:a" (a fingerprint containing ':') doubles as a colon-safety check.
  assert.deepEqual(first, { "fp:fp:a": 1000, "fpts:000000000001000:fp:a": 1000 });
  await storage.put(first);

  const second = await newFingerprintWrites(storage, ["fp:a"], 2000);
  assert.deepEqual(second, {}, "an already-registered fingerprint must not be rewritten");
});

// ---- pack.ts: row chunking and numeric ordering ---------------------------------

test("pack: rows are read back in numeric row order, not lexicographic", async () => {
  const storage = memoryStorage();
  // 11 tiny records force at least row:0 .. row:10 — enough for lexicographic
  // ("row:10" < "row:2") to diverge from numeric order if the bug is present.
  const records = Array.from({ length: 11 }, (_, i) => record(`r${i}`.repeat(50_000), i));
  let seq = 0;
  for (const r of records) {
    const append = await appendRows(storage, "worker", 1000, [r]);
    await storage.put({ ...append.writes, rowSeq: append.nextRowSeq });
    seq++;
  }
  const byTenant = await pendingRowsByTenant(storage);
  const rows = byTenant.get("worker");
  assert.equal(rows.length, seq);
  const bodiesInOrder = rows.flatMap(([, row]) => row.resourceLogs.map((rl) => rl.scopeLogs[0].logRecords[0].body.stringValue));
  for (let i = 0; i < 11; i++) {
    assert.ok(bodiesInOrder[i].startsWith(`r${i}`), `row ${i} out of order: got ${bodiesInOrder[i].slice(0, 4)}`);
  }
});

test("pack: packTenant + commitPackedObject write one gzipped NDJSON object and delete the rows", async () => {
  const storage = memoryStorage();
  const bucket = makeR2Bucket();
  const append = await appendRows(storage, "browser", 5000, [record("hello"), record("world", 1)]);
  await storage.put({ ...append.writes, rowSeq: append.nextRowSeq });

  const byTenant = await pendingRowsByTenant(storage);
  const packed = await packTenant(storage, bucket, "browser", byTenant.get("browser"));
  assert.ok(packed);
  assert.match(packed.key, /^inbox\/browser\/\d{4}-\d{2}-\d{2}\/\d{2}\/\d{12}\.ndjson\.gz$/);

  await commitPackedObject(storage, packed);

  const remaining = await pendingRowsByTenant(storage);
  assert.equal(remaining.size, 0, "packed rows must be deleted");
  assert.equal(await storage.get("key:" + packed.key), "written");
  assert.equal(await storage.get("seq"), 1);

  const stored = bucket.objects.get(packed.key);
  assert.ok(stored, "the gzipped object must be in R2");
  const text = await new Response(new Blob([stored]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
  const lines = decodeNdjson(text);
  assert.equal(lines.length, 2);
});

// `packTenant` must bound one object's decompressed size — packing every
// pending row for a tenant into one in-memory gzip with no cap could
// exceed the DO's 128 MB memory under a sustained flood. Five ~900 KB rows
// (4.5 MB total, over PACK_OBJECT_MAX_DECOMPRESSED_BYTES's 4 MB) prove a
// single call takes only a prefix and leaves the rest for the caller to
// pack in a follow-up call (`writer.ts#alarm()`'s own loop).
test("pack: packTenant bounds one object's decompressed size, leaving the rest for a follow-up call", async () => {
  const storage = memoryStorage();
  const bucket = makeR2Bucket();
  const bigBody = "x".repeat(900_000);
  for (let i = 0; i < 5; i++) {
    const append = await appendRows(storage, "worker", 1000 + i, [record(bigBody, i)]);
    await storage.put({ ...append.writes, rowSeq: append.nextRowSeq });
  }

  const byTenant = await pendingRowsByTenant(storage);
  const allRows = byTenant.get("worker");
  assert.equal(allRows.length, 5, "sanity: five separate pending rows");

  const first = await packTenant(storage, bucket, "worker", allRows);
  assert.ok(first);
  assert.ok(
    first.consumedRowKeys.length < allRows.length,
    "one call must not consume every pending row once the budget is spent",
  );

  const firstStored = bucket.objects.get(first.key);
  const firstText = await new Response(
    new Blob([firstStored]).stream().pipeThrough(new DecompressionStream("gzip")),
  ).text();
  assert.ok(
    new TextEncoder().encode(firstText).length <= PACK_OBJECT_MAX_DECOMPRESSED_BYTES + 1_000_000,
    "the packed object's decompressed NDJSON must stay near the budget, not grow to the full 4.5 MB pending set",
  );

  await commitPackedObject(storage, first);
  const remaining = await pendingRowsByTenant(storage);
  const stillPending = remaining.get("worker") ?? [];
  assert.ok(stillPending.length > 0, "rows left behind by the first call must still be pending");

  // The caller's own loop (`writer.ts#alarm()`) keeps calling packTenant
  // until nothing remains — proven here directly against pack.ts, without
  // needing the real DO alarm.
  const second = await packTenant(storage, bucket, "worker", stillPending);
  assert.ok(second);
  await commitPackedObject(storage, second);
  const afterSecond = await pendingRowsByTenant(storage);
  assert.equal((afterSecond.get("worker") ?? []).length, 0, "a second call finishes packing the leftover rows");
});

// ---- InboxWriter (real DO class): ingest, restart, recordWake ------------------

test("InboxWriter.ingest: a duplicate delivery, seconds apart, produces one stored copy", async () => {
  const doStorage = makeDurableObjectStorage();
  const { env } = makeEnv(InboxWriter, { doStorage });
  const writer = new InboxWriter({ storage: doStorage }, env);

  const item = { hash: "abc123", record: record("dup") };
  const first = await writer.ingest("worker", Date.now(), [item]);
  assert.equal(first.results[0].outcome, "accepted");

  const second = await writer.ingest("worker", Date.now() + 3000, [item]);
  assert.equal(second.results[0].outcome, "duplicate");

  const byTenant = await pendingRowsByTenant(doStorage);
  const totalRecords = [...(byTenant.get("worker") ?? [])].reduce((n, [, row]) => n + row.resourceLogs.length, 0);
  assert.equal(totalRecords, 1, "exactly one copy must be pending, never two");
});

// Two identical records in one ingest batch must not both be dropped while
// the hash is still marked seen — that would store the record zero times,
// with every later redelivery refused as a duplicate, losing it for good.
test("InboxWriter.ingest: an in-batch repeat stores its first copy once, marks only later copies duplicate", async () => {
  const doStorage = makeDurableObjectStorage();
  const { env } = makeEnv(InboxWriter, { doStorage });
  const writer = new InboxWriter({ storage: doStorage }, env);

  const same = { hash: "same-hash", record: record("same") };
  const other = { hash: "other-hash", record: record("other", 1) };
  const batch = await writer.ingest("worker", Date.now(), [same, { ...same }, other]);
  assert.deepEqual(
    batch.results.map((r) => `${r.hash}=${r.outcome}`),
    ["same-hash=accepted", "same-hash=duplicate", "other-hash=accepted"],
  );

  const byTenant = await pendingRowsByTenant(doStorage);
  const bodies = [...(byTenant.get("worker") ?? [])].flatMap(([, row]) =>
    row.resourceLogs.flatMap((rl) => rl.scopeLogs.flatMap((sl) => sl.logRecords.map((lr) => lr.body.stringValue))),
  );
  assert.deepEqual(bodies.sort(), ["other", "same"], "the repeated record is stored exactly once, not zero times");

  // A later redelivery is a real duplicate of a STORED record now, not the
  // silent drop of a record that was never stored.
  const later = await writer.ingest("worker", Date.now() + 3000, [same]);
  assert.equal(later.results[0].outcome, "duplicate");
});

test("InboxWriter: a simulated restart between an append and the alarm loses nothing", async () => {
  const doStorage = makeDurableObjectStorage();
  const { env } = makeEnv(InboxWriter, { doStorage });
  const writerBeforeRestart = new InboxWriter({ storage: doStorage }, env);

  await writerBeforeRestart.ingest("worker", Date.now(), [{ hash: "restart-1", record: record("before restart") }]);

  // "Restart": a brand-new InboxWriter instance over the *same* backing
  // storage Map — nothing in memory carries over, only what was committed.
  const writerAfterRestart = new InboxWriter({ storage: doStorage }, env);
  await writerAfterRestart.alarm();

  const byTenant = await pendingRowsByTenant(doStorage);
  assert.equal(byTenant.size, 0, "the alarm must have packed the pre-restart row");
  const objectKeys = [...doStorage._data.keys()].filter((k) => k.startsWith("key:"));
  assert.equal(objectKeys.length, 1);
});

test("InboxWriter.recordWake: marks every earlier wake over, starts the new one open", async () => {
  const doStorage = makeDurableObjectStorage();
  const { env } = makeEnv(InboxWriter, { doStorage });
  const writer = new InboxWriter({ storage: doStorage }, env);

  await writer.recordWake("wake-1", "backlog");
  await writer.recordWake("wake-2", "visit");

  const wake1 = await doStorage.get("wake:wake-1");
  const wake2 = await doStorage.get("wake:wake-2");
  assert.equal(wake1.over, true, "the earlier wake must be marked over");
  assert.equal(wake2.over, false, "the new wake starts open");
  assert.equal(wake2.reason, "visit");
});

// `o11y.wake` `duration_ms` must be written, not left at 0.
test("InboxWriter: recordWakeReady's time is the o11y.wake duration_ms on clean and unclean resolution; a never-ready wake writes 0", async () => {
  const doStorage = makeDurableObjectStorage();
  const { env, ae } = makeEnv(InboxWriter, { doStorage });
  const markers = new Set(["state/wakes/w-clean/clean"]);
  env.O11Y_LOKI_STATE = { head: async (key) => (markers.has(key) ? {} : null) };
  env.GRAFANA_BOX = { jurisdiction() { return this; }, getByName: () => ({ isAwake: async () => false }) };
  const pending = [];
  const writer = new InboxWriter({ storage: doStorage, waitUntil: (p) => pending.push(p) }, env);

  // Three wakes, each superseded by the next; each owns one provisional key.
  for (const [i, wakeId] of ["w-clean", "w-unclean", "w-never-ready"].entries()) {
    await writer.recordWake(wakeId, "visit");
    await doStorage.put({ [`key:inbox/worker/2026-01-01/00/00000000000${i}.ndjson.gz`]: `provisional:${wakeId}` });
  }
  await writer.recordWakeReady("w-clean", 31_000);
  await writer.recordWakeReady("w-unclean", 47_000);

  await writer.resolveWakes();
  await Promise.all(pending);

  const slot = (column) => Number(/(\d+)$/.exec(AE_COLUMNS[column])[1]) - 1;
  const wakes = ae.points
    .filter((p) => p.indexes[0] === "o11y.wake")
    .map((p) => ({ outcome: p.blobs[slot("outcome")], count: p.doubles[slot("count")], duration: p.doubles[slot("duration_ms")] }))
    .sort((a, b) => a.duration - b.duration);
  assert.deepEqual(wakes, [
    { outcome: "unclean", count: 1, duration: 0 }, // w-never-ready: deliberately 0
    { outcome: "clean", count: 1, duration: 31_000 },
    { outcome: "unclean", count: 1, duration: 47_000 },
  ]);
});

// ---- the pack alarm's bounded reads -----------------------------------------

/** Builds a `PendingRow` VALUE (not the key — the key's own shape is up to
 *  the caller) holding exactly one log record whose body is `body`. */
function pendingRowValue(body, index, arrivalMs) {
  return { tenant: "worker", arrivalMs, resourceLogs: [buildResourceLogs(record(body, index))] };
}

/** Decodes every packed R2 object, in `inbox/...` key order (the embedded
 *  `<seq:012d>` already sorts packing order correctly), and returns the
 *  `body.stringValue` of every log record across all of them, concatenated
 *  in that order. */
async function decodeAllPackedBodies(r2) {
  const keys = [...r2.objects.keys()].sort();
  const bodies = [];
  for (const key of keys) {
    const bytes = r2.objects.get(key);
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    const text = await new Response(stream).text();
    for (const rl of decodeNdjson(text)) {
      for (const scope of rl.scopeLogs) for (const lr of scope.logRecords) bodies.push(lr.body.stringValue);
    }
  }
  return bodies;
}

test("flood: many MB of pending rows are packed with a bounded read per list() call and per alarm, in order, with no loss", async () => {
  const doStorage = makeDurableObjectStorage();
  const { env, r2 } = makeEnv(InboxWriter, { doStorage });
  const writer = new InboxWriter({ storage: doStorage }, env);

  // Wrap the storage the real DO would hand `alarm()` so every `row:`-prefixed
  // `list()` call's own page size is recorded — this is the exact read that
  // must not regress: a `pendingRowsByTenant`-based alarm made one `list()` call
  // that returned every pending row (here, all 30). A bounded implementation
  // must never return more than `ROW_LIST_PAGE_LIMIT` rows from any single
  // `row:` list() call, regardless of how many MB are pending overall.
  let maxRowListPageSize = 0;
  let rowListCalls = 0;
  const originalList = doStorage.list.bind(doStorage);
  doStorage.list = async (options) => {
    const result = await originalList(options);
    if (options?.prefix === "row:" || options?.start?.startsWith("row:")) {
      rowListCalls++;
      maxRowListPageSize = Math.max(maxRowListPageSize, result.size);
    }
    return result;
  };

  // 30 rows, ~900 KB each (~27 MB total, "many MB" — well over both
  // ROW_LIST_PAGE_LIMIT (8 rows/page) and PACK_OBJECT_MAX_DECOMPRESSED_BYTES
  // (4 MB/object, so ~4-5 rows/object): this backlog needs several pages
  // AND several packed objects, proving the bound holds across both.
  const rowCount = 30;
  const bigBody = "x".repeat(900_000);
  for (let n = 0; n < rowCount; n++) {
    // Padded (current-shape) keys, hand-built here rather than through
    // `pendingRowStorageKey` — this test is about `collectRowBatch`'s own
    // READ bound, not the key-padding invariant (see the numeric-order test
    // below, which writes through the real ingest path instead).
    doStorage._data.set(`row:${n.toString().padStart(12, "0")}`, pendingRowValue(`${bigBody}-${n}`, n, 1_700_000_000_000 + n));
  }
  doStorage._data.set("rowSeq", rowCount);

  let iterations = 0;
  do {
    await writer.alarm();
    iterations++;
  } while ((await doStorage.getAlarm()) !== null && iterations < 200);

  assert.ok(rowListCalls > 0, "sanity: the alarm must have actually listed row: entries");
  assert.ok(
    maxRowListPageSize <= ROW_LIST_PAGE_LIMIT,
    `a single row: list() call returned ${maxRowListPageSize} rows — must never exceed ROW_LIST_PAGE_LIMIT (${ROW_LIST_PAGE_LIMIT}), regardless of the 30-row/~27 MB backlog`,
  );

  const remaining = await pendingRowsByTenant(doStorage);
  assert.equal(remaining.size, 0, "every row must eventually be packed");

  const bodies = await decodeAllPackedBodies(r2);
  assert.equal(bodies.length, rowCount, "no record may be lost");
  const expected = Array.from({ length: rowCount }, (_, n) => `${bigBody}-${n}`);
  assert.deepEqual(bodies, expected, "records must come out in arrival order despite the bounded, paged reads");
});

test("InboxWriter.alarm: rows written through the real ingest path pack in numeric order past a two-digit row count", async () => {
  const doStorage = makeDurableObjectStorage();
  const { env, r2 } = makeEnv(InboxWriter, { doStorage });
  const writer = new InboxWriter({ storage: doStorage }, env);

  // Every key here comes from the real write path (`ingest` -> `appendRows`
  // -> `pendingRowStorageKey`), never hand-built — unlike the two tests
  // above. 12 rows crosses the one-digit/two-digit boundary ("row:...9" vs
  // "row:...10"), exactly where an un-padded key would sort lexicographically
  // out of arrival order.
  const rowCount = 12;
  for (let i = 0; i < rowCount; i++) {
    await writer.ingest("worker", 1000 + i, [{ hash: `h${i}`, record: record(`r${i}`, i) }]);
  }

  let iterations = 0;
  do {
    await writer.alarm();
    iterations++;
  } while ((await doStorage.getAlarm()) !== null && iterations < 200);

  // No re-sort here: `decodeAllPackedBodies` returns bodies in the order the
  // real `collectRowBatch` (native, ascending `storage.list()` order) fed
  // them to `packTenant`, which is what a broken `pendingRowStorageKey`
  // padding would corrupt.
  const bodies = await decodeAllPackedBodies(r2);
  const expected = Array.from({ length: rowCount }, (_, i) => `r${i}`);
  assert.deepEqual(bodies, expected, "rows written through the real ingest path must drain in numeric arrival order, not lexicographic");
});


// ---- global admission caps (DEV-3095) --------------------------------------------
//
// Browser ingest is rate-limited per IP only, so a distributed flood of unique,
// well-formed fingerprints/hashes must hit a GLOBAL cap. Every test below
// fails if that cap is removed (revert-checked).

const WINDOW_BASE = Math.floor(1_700_000_000_000 / ADMISSION_WINDOW_MS) * ADMISSION_WINDOW_MS;

test("admission: hash budget is never above the per-tick prune rate, so a sustained flood cannot outrun the prune", () => {
  assert.ok(HASH_ADMIT_PER_WINDOW <= HASH_PRUNE_BATCH_LIMIT, `${HASH_ADMIT_PER_WINDOW} hashes admitted per 10-min window vs ${HASH_PRUNE_BATCH_LIMIT} pruned per tick`);
});

test("admitNewFingerprints: stores only `budget` NEW fingerprints in arrival order, counts the rest, and already-known ones cost no budget", async () => {
  const storage = memoryStorage();
  await storage.put(await newFingerprintWrites(storage, ["known"], 500));

  const result = await admitNewFingerprints(storage, ["known", "a", "b", "c", "d"], 1000, 2);

  assert.equal(result.admitted, 2);
  assert.equal(result.dropped, 2);
  assert.deepEqual(Object.keys(result.writes).filter((k) => k.startsWith("fp:")).sort(), ["fp:a", "fp:b"]);
  assert.deepEqual(await admitNewFingerprints(storage, ["x"], 1000, 0), { writes: {}, admitted: 0, dropped: 1 });
});

test("capHashWrites: keeps `budget` writes, counts the rest, never goes negative", () => {
  const writes = { "hash:1": 1, "hash:2": 1, "hash:3": 1 };
  assert.deepEqual(capHashWrites(writes, 2), { writes: { "hash:1": 1, "hash:2": 1 }, dropped: 1 });
  assert.deepEqual(capHashWrites(writes, -5), { writes: {}, dropped: 3 });
});

test("flood: unique fingerprints and hashes from many requests in one window store at most the admission budgets and count the overflow", async () => {
  const doStorage = makeDurableObjectStorage();
  const { env } = makeEnv(InboxWriter, { doStorage });
  const writer = env.INBOX_WRITER.jurisdiction("eu").get();

  const REQUESTS = 30; // 30 x 200 = 6,000 unique of each, over both budgets
  const PER_REQUEST = 200;
  for (let r = 0; r < REQUESTS; r++) {
    const items = Array.from({ length: PER_REQUEST }, (_, i) => ({ hash: `flood-h-${r}-${i}`, fingerprint: `flood-fp-${r}-${i}` }));
    await writer.ingest("worker", WINDOW_BASE + 1000 + r, items);
  }

  assert.equal((await doStorage.list({ prefix: "fp:" })).size, FP_ADMIT_PER_WINDOW, "fp: entries capped at the window budget");
  assert.equal((await doStorage.list({ prefix: "fpts:" })).size, FP_ADMIT_PER_WINDOW, "the fpts: twins stay in step");
  assert.equal((await doStorage.list({ prefix: "hash:" })).size, HASH_ADMIT_PER_WINDOW, "hash: entries capped at the window budget");
  assert.equal(await doStorage.get(FP_COUNT_STORAGE_KEY), FP_ADMIT_PER_WINDOW, "the size counter matches what was stored");

  const dropped = await admissionDroppedSince(doStorage, WINDOW_BASE);
  assert.deepEqual(dropped, { fpDropped: REQUESTS * PER_REQUEST - FP_ADMIT_PER_WINDOW, hashDropped: REQUESTS * PER_REQUEST - HASH_ADMIT_PER_WINDOW });
});

test("flood: the next window admits again, so a real new fingerprint after a flood is stored", async () => {
  const doStorage = makeDurableObjectStorage();
  const { env } = makeEnv(InboxWriter, { doStorage });
  const writer = env.INBOX_WRITER.jurisdiction("eu").get();

  const flood = Array.from({ length: FP_ADMIT_PER_WINDOW + 50 }, (_, i) => ({ hash: `h-${i}`, fingerprint: `flood-fp-${i}` }));
  await writer.ingest("worker", WINDOW_BASE + 1000, flood);
  await writer.ingest("worker", WINDOW_BASE + ADMISSION_WINDOW_MS + 1000, [{ hash: "real-h", fingerprint: "real-after-flood" }]);

  assert.notEqual(await doStorage.get("fp:real-after-flood"), undefined);
});

test("flood: an item whose fingerprint is dropped still gets its row stored", async () => {
  const doStorage = makeDurableObjectStorage();
  const { env } = makeEnv(InboxWriter, { doStorage });
  const writer = env.INBOX_WRITER.jurisdiction("eu").get();

  const items = Array.from({ length: FP_ADMIT_PER_WINDOW + 1 }, (_, i) => ({
    hash: `h-${i}`,
    fingerprint: `fp-${i}`,
    record: record(`body ${i}`, i),
  }));
  await writer.ingest("worker", WINDOW_BASE + 1000, items);

  assert.equal(await doStorage.get(`fp:fp-${FP_ADMIT_PER_WINDOW}`), undefined, "the over-budget fingerprint is not registered");
  const stored = [...(await doStorage.list({ prefix: "row:" })).values()].reduce((n, row) => n + row.resourceLogs.length, 0);
  assert.equal(stored, FP_ADMIT_PER_WINDOW + 1, "its record is still stored");
});

test("evictOldestFingerprints: over max, removes the oldest entries and their fpts: twins, and decrements the counter", async () => {
  const storage = memoryStorage();
  for (let i = 0; i < 300; i++) await storage.put(await newFingerprintWrites(storage, [`fp-${String(i).padStart(3, "0")}`], 1000 + i));
  await storage.put({ [FP_COUNT_STORAGE_KEY]: 300 });

  assert.equal(await evictOldestFingerprints(storage, 100), 200);

  assert.equal((await storage.list({ prefix: "fp:" })).size, 100);
  assert.equal((await storage.list({ prefix: "fpts:" })).size, 100);
  assert.equal(await readFpCount(storage), 100);
  assert.equal(await storage.get("fp:fp-000"), undefined, "the oldest is gone");
  assert.notEqual(await storage.get("fp:fp-299"), undefined, "the newest is kept");
  assert.equal(await evictOldestFingerprints(storage, 100), 0, "at the cap, nothing more is evicted");
});

test("evictOldestFingerprints: one call deletes a bounded batch, and successive calls finish the job", async () => {
  const storage = memoryStorage();
  const writes = {};
  for (let i = 0; i < 6000; i++) Object.assign(writes, await newFingerprintWrites(memoryStorage(), [`fp-${String(i).padStart(5, "0")}`], 1000 + i));
  await putChunked(storage, writes);
  await storage.put({ [FP_COUNT_STORAGE_KEY]: 6000 });

  assert.equal(await evictOldestFingerprints(storage, 100), 5000, "one call is bounded");
  assert.equal(await evictOldestFingerprints(storage, 100), 900);
  assert.equal((await storage.list({ prefix: "fp:" })).size, 100);
});

test("registry stays bounded under a sustained flood: admission per window plus eviction per tick never exceeds max + one window", async () => {
  const storage = memoryStorage();
  const MAX = 1000;
  for (let w = 0; w < 30; w++) {
    const now = WINDOW_BASE + w * ADMISSION_WINDOW_MS;
    const flood = Array.from({ length: 400 }, (_, i) => `w${w}-fp-${i}`);
    const admission = await admitNewFingerprints(storage, flood, now, FP_ADMIT_PER_WINDOW);
    await putChunked(storage, { ...admission.writes, [FP_COUNT_STORAGE_KEY]: (await readFpCount(storage)) + admission.admitted });
    assert.ok((await storage.list({ prefix: "fp:" })).size <= MAX + FP_ADMIT_PER_WINDOW, `window ${w}: registry above max + one window`);
    await evictOldestFingerprints(storage, MAX); // the cron tick
    assert.ok((await storage.list({ prefix: "fp:" })).size <= MAX, `window ${w}: still above max after the tick`);
  }
  assert.equal((await storage.list({ prefix: "fp:" })).size, MAX);
  assert.equal((await storage.list({ prefix: "fpts:" })).size, MAX);
});

test("pruneFingerprintRegistry: a finished lap re-measures the size counter (drift, or a registry that predates the counter)", async () => {
  const storage = memoryStorage();
  const writes = {};
  for (let i = 0; i < 150; i++) Object.assign(writes, await newFingerprintWrites(memoryStorage(), [`fp-${i}`], 1000 + i));
  await putChunked(storage, writes); // no fpCount at all, like a registry from before the counter

  await pruneFingerprintRegistry(storage, 2000);

  assert.equal(await readFpCount(storage), 150);
});

test("pruneFingerprintRegistry: TTL deletes lower the size counter", async () => {
  const storage = memoryStorage();
  await putChunked(storage, { ...(await newFingerprintWrites(memoryStorage(), ["old"], 1000)), ...(await newFingerprintWrites(memoryStorage(), ["new"], 9_000_000_000)) });
  await storage.put({ [FP_COUNT_STORAGE_KEY]: 2 });

  await pruneFingerprintRegistry(storage, 9_000_000_000 + 1, 1_000_000);

  assert.equal(await storage.get("fp:old"), undefined);
  assert.equal(await readFpCount(storage), 1);
});

test("pruneAdmissionWindows: drops windows older than an hour, keeps recent ones", async () => {
  const storage = memoryStorage();
  await storage.put({
    [admissionKey(WINDOW_BASE)]: { fp: 1, fpDropped: 0, hash: 1, hashDropped: 0 },
    [admissionKey(WINDOW_BASE + 5 * ADMISSION_WINDOW_MS)]: { fp: 1, fpDropped: 0, hash: 1, hashDropped: 0 },
  });

  await pruneAdmissionWindows(storage, WINDOW_BASE + 8 * ADMISSION_WINDOW_MS);

  assert.equal(await storage.get(admissionKey(WINDOW_BASE)), undefined);
  assert.notEqual(await storage.get(admissionKey(WINDOW_BASE + 5 * ADMISSION_WINDOW_MS)), undefined);
});

test("evictOldestFingerprints: an orphaned fpts: row is deleted but never counted as an evicted entry", async () => {
  const storage = memoryStorage();
  const seeded = await newFingerprintWrites(memoryStorage(), ["a", "b", "c"], 1000);
  delete seeded["fp:a"]; // `a` lost its fp: twin (e.g. TTL-pruned first)
  await putChunked(storage, seeded);
  await storage.put({ [FP_COUNT_STORAGE_KEY]: 2 });

  await evictOldestFingerprints(storage, 0);

  assert.equal((await storage.list({ prefix: "fpts:" })).size, 1, "the orphan is cleaned up along with b; c is beyond the batch");
  assert.equal(await readFpCount(storage), 1, "the counter drops by the 1 real entry evicted (b), not by the 2 rows deleted");
});

test("evictOldestFingerprints: discards the in-progress prune lap's running total, which the eviction just made stale", async () => {
  const storage = memoryStorage();
  await putChunked(storage, await newFingerprintWrites(memoryStorage(), ["a", "b"], 1000));
  await storage.put({ [FP_COUNT_STORAGE_KEY]: 2, fpLapSeen: 4000 });

  await evictOldestFingerprints(storage, 1);

  assert.equal(await storage.get("fpLapSeen"), 0);
});

test("evictOldestFingerprints: deletes every fp: row before any fpts: row, so a failure part-way never strands fp: rows outside the time index", async () => {
  const storage = memoryStorage();
  await putChunked(storage, await newFingerprintWrites(memoryStorage(), ["a", "b", "c"], 1000));
  await storage.put({ [FP_COUNT_STORAGE_KEY]: 3 });
  const deleted = [];
  const spy = { ...storage, delete: async (keys) => { deleted.push(...keys); return storage.delete(keys); } };

  await evictOldestFingerprints(spy, 0);

  const lastFp = deleted.findLastIndex((k) => k.startsWith("fp:"));
  const firstFpts = deleted.findIndex((k) => k.startsWith("fpts:"));
  assert.ok(lastFp >= 0 && firstFpts > lastFp, `fpts: deleted before an fp: row: ${deleted.join(", ")}`);
});

test("evictOldestFingerprints: resets the prune cursor together with the lap total, even when it only removed orphans", async () => {
  const storage = memoryStorage();
  const seeded = await newFingerprintWrites(memoryStorage(), ["orphan"], 1000);
  delete seeded["fp:orphan"];
  await putChunked(storage, seeded);
  // Over the cap on a stale counter, mid-lap: the cursor is mid-keyspace.
  await storage.put({ [FP_COUNT_STORAGE_KEY]: 5, fpLapSeen: 4000, [FP_PRUNE_CURSOR_STORAGE_KEY]: "fp:m\0" });

  await evictOldestFingerprints(storage, 1);

  assert.equal(await storage.get("fpLapSeen"), 0);
  assert.equal(await storage.get(FP_PRUNE_CURSOR_STORAGE_KEY), null, "a lap total of 0 with a mid-keyspace cursor would let the lap finish on the unscanned tail only");
});
