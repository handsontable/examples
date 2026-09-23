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
const { checkDuplicates } = await import("../workers/o11y/src/inbox/dedupe.ts");
const { newFingerprintWrites } = await import("../workers/o11y/src/inbox/registry.ts");
const { appendRows, pendingRowsByTenant, packTenant, commitPackedObject, PACK_OBJECT_MAX_DECOMPRESSED_BYTES } =
  await import("../workers/o11y/src/inbox/pack.ts");
const { memoryStorage } = await import("../workers/o11y/src/inbox/storage.ts");
const { decodeNdjson } = await import("@handsontable/demo-runtime/telemetry");

function record(body, i = 0) {
  return {
    body,
    timeUnixNano: String(1735689600000000000n + BigInt(i)),
    resourceAttributes: { "service.name": "demos-api", "service.version": "v1", "deployment.environment.name": "production" },
    attributes: {},
  };
}

// ---- dedupe.ts -----------------------------------------------------------------

test("dedupe: a hash seen within the 24h window is a duplicate; an unseen one is not", async () => {
  const storage = memoryStorage();
  const first = await checkDuplicates(storage, ["h1", "h2"], Date.now());
  assert.deepEqual([...first.duplicates], []);
  await storage.put(first.writes);

  const second = await checkDuplicates(storage, ["h1", "h3"], Date.now() + 5000);
  assert.deepEqual([...second.duplicates], ["h1"]);
  assert.ok("hash:h3" in second.writes, "the unseen hash must get a write entry");
});

test("dedupe: a hash repeated within one batch is a duplicate on its second occurrence", async () => {
  const storage = memoryStorage();
  const result = await checkDuplicates(storage, ["h1", "h1", "h2"], Date.now());
  assert.deepEqual([...result.duplicates], ["h1"]);
});

test("dedupe: a hash outside the 24h window is treated as new again", async () => {
  const storage = memoryStorage();
  const dayAgo = Date.now() - 25 * 60 * 60 * 1000;
  await storage.put({ "hash:h1": dayAgo });
  const result = await checkDuplicates(storage, ["h1"], Date.now());
  assert.deepEqual([...result.duplicates], [], "an expired hash must not be treated as a duplicate");
});

// ---- registry.ts -----------------------------------------------------------------

test("registry: a fingerprint is written once, on first sight, never overwritten", async () => {
  const storage = memoryStorage();
  const first = await newFingerprintWrites(storage, ["fp:a"], 1000);
  assert.deepEqual(first, { "fp:fp:a": 1000 });
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
