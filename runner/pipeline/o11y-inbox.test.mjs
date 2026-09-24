// ADR §B.2 steps 4–6 + §8 — `InboxWriter` tests: dedupe (24 h window and
// within-batch), the fingerprint first-seen registry, row chunking/numeric
// ordering, pack/commit, a simulated restart between an append and the
// alarm, and `recordWake`'s "mark every earlier wake over" rule. The real
// `InboxWriter` class is constructed over a `Map`-backed
// `DurableObjectStorage` fake (`o11y-harness.mjs`) — not a copy of its
// logic — so a broken implementation, not a broken test double, is what
// fails here (TESTING.md: "don't mock the unit under test").
//
// Run: node --experimental-strip-types --test pipeline/o11y-inbox.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./fixtures/o11y-worker-hooks.mjs", import.meta.url);

const { makeEnv, makeDurableObjectStorage, makeR2Bucket, ctx } = await import("./fixtures/o11y-harness.mjs");
const { InboxWriter } = await import("../workers/o11y/src/inbox/writer.ts");
const { checkDuplicates, pruneHashBuckets } = await import("../workers/o11y/src/inbox/dedupe.ts");
const { newFingerprintWrites } = await import("../workers/o11y/src/inbox/registry.ts");
const {
  appendRows,
  pendingRowsByTenant,
  packTenant,
  commitPackedObject,
  collectRowBatch,
  migrateLegacyRows,
  LEGACY_MIGRATE_BATCH_LIMIT,
  ROW_LIST_PAGE_LIMIT,
  PACK_OBJECT_MAX_DECOMPRESSED_BYTES,
} = await import("../workers/o11y/src/inbox/pack.ts");
const { memoryStorage, putChunked } = await import("../workers/o11y/src/inbox/storage.ts");
const { decodeNdjson, buildResourceLogs } = await import("@handsontable/demo-runtime/telemetry");

function record(body, i = 0) {
  return {
    body,
    timeUnixNano: String(1735689600000000000n + BigInt(i)),
    resourceAttributes: { "service.name": "demos-api", "service.version": "v1", "deployment.environment.name": "production" },
    attributes: {},
  };
}

// ---- dedupe.ts -----------------------------------------------------------------
//
// F2 fix (final review, A-I1 "hash: entries are never deleted"): the storage
// key is now day-bucketed (`hash:<yyyymmdd>:<sha256>`, see dedupe.ts's own
// header) so stale buckets can be pruned with a bounded range delete —
// `checkDuplicates`'s BEHAVIOUR (24h window, within-batch collapse) is
// unchanged, but a test that asserted the exact key string must bucket by
// "today" (UTC) the same way the implementation does.

function todayBucket(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");
}

test("dedupe: a hash seen within the 24h window is a duplicate; an unseen one is not", async () => {
  const storage = memoryStorage();
  const first = await checkDuplicates(storage, ["h1", "h2"], Date.now());
  assert.deepEqual([...first.duplicates], []);
  await storage.put(first.writes);

  const second = await checkDuplicates(storage, ["h1", "h3"], Date.now() + 5000);
  assert.deepEqual([...second.duplicates], ["h1"]);
  assert.ok(`hash:${todayBucket()}:h3` in second.writes, "the unseen hash must get a write entry, bucketed by today's UTC date");
});

test("dedupe: a hash repeated within one batch is a duplicate on its second occurrence", async () => {
  const storage = memoryStorage();
  const result = await checkDuplicates(storage, ["h1", "h1", "h2"], Date.now());
  assert.deepEqual([...result.duplicates], ["h1"]);
});

test("dedupe: a hash outside the 24h window is treated as new again", async () => {
  const storage = memoryStorage();
  const dayAgo = Date.now() - 25 * 60 * 60 * 1000;
  await storage.put({ [`hash:${todayBucket(dayAgo)}:h1`]: dayAgo });
  const result = await checkDuplicates(storage, ["h1"], Date.now());
  assert.deepEqual([...result.duplicates], [], "an expired hash must not be treated as a duplicate");
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

  assert.deepEqual([...result.duplicates], ["hY"], "a hash from yesterday's UTC bucket, still within 24h, must be found");
});

// B-C1/A-I1 remainder (final review, rereview.md row 13): "the prune ceiling
// (500 hash rows per tick, which falls behind at about 3× traffic). Make
// pruning keep up with the ingest rate." ADR §D's own 10× headroom
// projection is ~6.6M worker records/month, ≈ 220,000/day (before browser
// traffic) — this seeds exactly that many stale `hash:` rows (one day's
// worth, at the 10× projected rate) and asserts `pruneHashBuckets`, called
// once per ten-minute cron tick (144 ticks/day — `writer.ts#backlog()`'s
// own cadence), fully clears them within that many calls. At the OLD
// 500/tick limit this would need 220,000 / 500 = 440 ticks — the test is
// specifically sized so it FAILS at that old limit (440 > 144), not just
// "eventually clears given unlimited ticks."
test("B-C1/A-I1 remainder: pruneHashBuckets keeps up with the ADR §D 10× projected rate (220k stale rows/day, cleared within 144 ten-minute ticks)", async () => {
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
  // B-C1/A-I1 remainder: also writes the `fpts:` time-index twin
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

// Fix round (finding A-I2): `packTenant` must bound one object's
// DECOMPRESSED size — the previous version packed every pending row for a
// tenant into one in-memory gzip with no cap at all, which could exceed
// the DO's 128 MB memory under a sustained flood. Five ~900 KB rows (4.5 MB
// total, over PACK_OBJECT_MAX_DECOMPRESSED_BYTES's 4 MB) prove a single
// call takes only a PREFIX and leaves the rest for the caller to pack in a
// follow-up call (`writer.ts#alarm()`'s own loop).
test("pack: packTenant bounds one object's decompressed size, leaving the rest for a follow-up call (finding A-I2)", async () => {
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

// ---- A-I2 (rereview.md, merge blocker): the pack alarm's bounded reads ----------

/** Builds a `PendingRow` VALUE (not the key — the key's own shape is up to
 *  the caller) holding exactly one log record whose body is `body`. */
function pendingRowValue(body, index, arrivalMs) {
  return { tenant: "worker", arrivalMs, resourceLogs: [buildResourceLogs(record(body, index))] };
}

/** Seeds `row:<n>` directly into the harness's raw backing `Map`, in the
 *  OLD, un-padded shape (`row:${n}`, exactly what `pendingRowStorageKey`
 *  produced before this fix) — simulating rows written by a pre-fix
 *  deploy, still pending when this fix's code starts running. */
function seedLegacyRows(doStorage, ns, arrivalBaseMs) {
  for (const n of ns) doStorage._data.set(`row:${n}`, pendingRowValue(`r${n}`, n, arrivalBaseMs + n));
  const maxN = Math.max(...ns);
  doStorage._data.set("rowSeq", maxN + 1);
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

test("A-I2: legacy (un-padded) row keys migrate to completion, across several alarm calls, before any packing — packed records come out in NUMERIC arrival order across digit boundaries", async () => {
  const doStorage = makeDurableObjectStorage();
  const { env, r2 } = makeEnv(InboxWriter, { doStorage });
  const writer = new InboxWriter({ storage: doStorage }, env);

  // Digit-boundary values (0, 1, 2, 8, 9, 10, 11, 98, 99, 100, 101, ...) are
  // exactly where "row:10" sorting BEFORE "row:2" (the un-padded shape's
  // bug) would diverge from arrival order. More than
  // LEGACY_MIGRATE_BATCH_LIMIT (64) rows so migration must span more than
  // one alarm() call — proving it does NOT try to migrate everything in one
  // shot (which would defeat A-I2's own point).
  const ns = Array.from({ length: 70 }, (_, i) => i); // 0..69
  seedLegacyRows(doStorage, ns, 1_700_000_000_000);
  assert.ok(70 > LEGACY_MIGRATE_BATCH_LIMIT, "sanity: this test's row count must exceed one migration batch");

  // Run the real alarm repeatedly, exactly as the platform's own scheduler
  // would (an alarm that reschedules itself runs again) — bounded to 200
  // iterations so a bug that never converges fails the test instead of
  // hanging it.
  let iterations = 0;
  do {
    await writer.alarm();
    iterations++;
  } while ((await doStorage.getAlarm()) !== null && iterations < 200);
  assert.ok(
    iterations >= 2,
    `70 legacy rows over a ${LEGACY_MIGRATE_BATCH_LIMIT}-row migrate batch must take more than one alarm call (took ${iterations})`,
  );

  const remaining = await pendingRowsByTenant(doStorage);
  assert.equal(remaining.size, 0, "every row must have been packed");

  const bodies = await decodeAllPackedBodies(r2);
  assert.equal(bodies.length, 70, "no record may be lost");
  const expected = ns.map((n) => `r${n}`);
  assert.deepEqual(bodies, expected, "records must come out in NUMERIC arrival order, not the legacy format's lexicographic order");
});

test("A-I2 flood: many MB of pending rows are packed with a bounded read per list() call and per alarm, in order, with no loss", async () => {
  const doStorage = makeDurableObjectStorage();
  const { env, r2 } = makeEnv(InboxWriter, { doStorage });
  const writer = new InboxWriter({ storage: doStorage }, env);

  // Wrap the storage the real DO would hand `alarm()` so every `row:`-prefixed
  // `list()` call's own PAGE SIZE is recorded — this is the exact read A-I2
  // fixed: the old `pendingRowsByTenant`-based alarm made ONE `list()` call
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
    // Padded (current-shape) keys — this test is about the READ bound, not
    // the legacy migration path (that's the test above).
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
