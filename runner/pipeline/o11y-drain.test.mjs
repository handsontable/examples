// The drain batch/retry/rejection state machine (workers/o11y/src/drain/drain.ts,
// ADR-0041 §B.3) — pure over injected `DrainDeps`, no R2/Container needed.
//
// Run: node --experimental-strip-types --test pipeline/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./fixtures/o11y-worker-hooks.mjs", import.meta.url);

const { drainKey, drainBatch } = await import("../workers/o11y/src/drain/drain.ts");
const { encodeNdjson } = await import("@handsontable/demo-runtime/telemetry");

async function gzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Recent by default (the drain-time age filter drops anything older than
 *  ~7 days — see `record(..., "old")` below for the deliberately-stale
 *  case) so every push/retry/reject test here exercises a real push, not a
 *  silently-empty one. */
function record(bodyText, timeUnixNano = String(BigInt(Date.now()) * 1_000_000n)) {
  return {
    resource: { attributes: [{ key: "service.name", value: { stringValue: "demos-api" } }] },
    scopeLogs: [{ logRecords: [{ timeUnixNano, body: { stringValue: bodyText } }] }],
  };
}

/** 8 days behind "now" — past Loki's `reject_old_samples_max_age: 7d`
 *  (containers/o11y/loki/loki-config*.yaml) and past the drain's own
 *  (stricter) drain-time cutoff. */
function oldRecord(bodyText) {
  const eightDaysAgoNs = BigInt(Date.now() - 8 * 24 * 60 * 60 * 1000) * 1_000_000n;
  return record(bodyText, String(eightDaysAgoNs));
}

async function objectBytes(records) {
  return gzip(encodeNdjson(records));
}

function noopSymbolicate(records) {
  return Promise.resolve(records);
}

test("drainKey: all-2xx pushes -> provisional, one push per chunk", async () => {
  const key = "inbox/worker/2026-01-01/00/000000000000.ndjson.gz";
  const bytes = await objectBytes([record("hello")]);
  const pushes = [];
  const deps = {
    fetchObject: async (k) => (k === key ? bytes : null),
    pushToLoki: async (tenant, gz) => {
      pushes.push({ tenant, gz });
      return { status: 204 };
    },
    symbolicate: noopSymbolicate,
  };

  const outcome = await drainKey(key, new Set(), deps);

  assert.equal(outcome.outcome, "provisional");
  assert.equal(outcome.tenant, "worker");
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].tenant, "worker");
});

// Loki's `/otlp/v1/logs` decodes the body as one OTLP/HTTP JSON
// `ExportLogsServiceRequest` (`{"resourceLogs":[...]}`). Sending the
// inbox's own NDJSON (one bare ResourceLogs per line) instead makes Loki
// answer 204 and ingest nothing, so no chunk is flushed, no TSDB table is
// built, no index object is uploaded on SIGTERM, and shutdown.sh correctly
// never writes the clean marker. Reproduced against the real Loki 3.3.2 in
// containers/o11y/compose.yml.
test("drainKey: each push is one OTLP/HTTP JSON ExportLogsServiceRequest holding every record", async () => {
  const key = "inbox/worker/2026-01-01/00/000000000000.ndjson.gz";
  const records = [record("line-a"), record("line-b"), record("line-c")];
  const bytes = await objectBytes(records);
  const bodies = [];
  const deps = {
    fetchObject: async () => bytes,
    pushToLoki: async (_tenant, gz) => {
      const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"));
      bodies.push(await new Response(stream).text());
      return { status: 204 };
    },
    symbolicate: noopSymbolicate,
  };

  const outcome = await drainKey(key, new Set(), deps);

  assert.equal(outcome.outcome, "provisional");
  assert.equal(bodies.length, 1);
  let parsed;
  assert.doesNotThrow(() => {
    parsed = JSON.parse(bodies[0]);
  }, "the decompressed body must be a single JSON document, not NDJSON");
  assert.deepEqual(Object.keys(parsed), ["resourceLogs"]);
  assert.deepEqual(parsed.resourceLogs, records);
});

test("drainKey: a 400 rejects the key with Loki's message, no retry", async () => {
  // An in-window record (the age filter must not remove it) whose 400
  // is forced by the mock — `too_far_behind` is Loki's 60-minute
  // out-of-order window, unrelated to the 7-day age filter, and
  // this test's whole point is that a genuine Loki-side rejection still
  // rejects the key.
  const key = "inbox/browser/2026-01-01/00/000000000000.ndjson.gz";
  const bytes = await objectBytes([record("boom")]);
  let pushCount = 0;
  const deps = {
    fetchObject: async () => bytes,
    pushToLoki: async () => {
      pushCount++;
      return { status: 400, message: "too_far_behind" };
    },
    symbolicate: noopSymbolicate,
  };

  const outcome = await drainKey(key, new Set(), deps);

  assert.equal(outcome.outcome, "rejected");
  assert.equal(outcome.reason, "too_far_behind");
  assert.equal(pushCount, 1, "a 400 must never be retried");
});

// A 400 on one chunk must not make `drainKey` return immediately — any
// later chunk of the same (>1 MB, multi-chunk) object must still be
// attempted, or records that would otherwise push cleanly are silently
// dropped. Two ~700 KB records force `chunkBySize` to split into two
// separate ~1 MB pushes (the drain's own per-request cap, ADR §B.3).
//
// A key with at least one accepted chunk must stay `provisional`, not end
// `rejected` overall — the already-pushed second chunk's durability must
// still pass the §B.3 marker/commit check any wake's clean-stop confirms
// through (an unclean stop right after this push, before Loki's own
// flush, could otherwise lose it with no automatic replay). See
// `drain.ts#drainKey`'s own doc comment for the full reasoning and
// `pipeline/o11y-alerts.test.mjs`/box.ts wiring for how the permanent 400
// stays operator-visible anyway (`recordPartialReject`).
test("a 400 on the FIRST chunk of a multi-chunk key does not skip the remaining chunks — they are still pushed, and the key stays provisional (row 19)", async () => {
  const key = "inbox/worker/2026-01-01/00/000000000000.ndjson.gz";
  const bigBody = "x".repeat(700_000);
  const records = [record(bigBody + "-first"), record(bigBody + "-second")];
  const bytes = await objectBytes(records);
  const pushedBodies = [];
  let pushCount = 0;
  const deps = {
    fetchObject: async () => bytes,
    pushToLoki: async (_tenant, gz) => {
      pushCount++;
      const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"));
      const body = await new Response(stream).text();
      pushedBodies.push(body);
      // Only the FIRST push (the chunk carrying "-first") 400s; every
      // later chunk succeeds.
      if (body.includes("-first")) return { status: 400, message: "too_far_behind" };
      return { status: 204 };
    },
    symbolicate: noopSymbolicate,
  };

  const outcome = await drainKey(key, new Set(), deps);

  assert.equal(pushCount, 2, "both chunks must be attempted — the second must not be skipped because the first 400'd");
  assert.ok(pushedBodies.some((b) => b.includes("-second")), "the second chunk's records must actually reach Loki");
  // Row 19: at least one chunk (the second) landed 2xx, so the key stays
  // `provisional` — its durability follows the normal §B.3 path instead of
  // being unrecoverable except by manual reopen. `reason` still carries the
  // 400 detail so the caller can surface it (`recordPartialReject`).
  assert.equal(outcome.outcome, "provisional", "at least one accepted chunk must keep the key provisional, not rejected (row 19)");
  assert.equal(outcome.reason, "too_far_behind");
  assert.ok(outcome.bytesPushed > 0, "bytes from the successfully-pushed second chunk must still be counted");
});

test("row 19: a key where EVERY chunk 400s still ends rejected (nothing accepted to protect)", async () => {
  const key = "inbox/worker/2026-01-01/00/000000000002.ndjson.gz";
  const bigBody = "x".repeat(700_000);
  const records = [record(bigBody + "-first"), record(bigBody + "-second")];
  const bytes = await objectBytes(records);
  let pushCount = 0;
  const deps = {
    fetchObject: async () => bytes,
    pushToLoki: async () => {
      pushCount++;
      return { status: 400, message: "too_far_behind" };
    },
    symbolicate: noopSymbolicate,
  };

  const outcome = await drainKey(key, new Set(), deps);

  assert.equal(pushCount, 2, "both chunks must still be attempted");
  assert.equal(outcome.outcome, "rejected", "zero accepted chunks means nothing to protect — the key stays rejected");
  assert.equal(outcome.bytesPushed, 0);
});

test("a 400 on a LATER chunk still lets an EARLIER chunk's push stand — no retry of the already-successful one", async () => {
  const key = "inbox/worker/2026-01-01/00/000000000001.ndjson.gz";
  const bigBody = "x".repeat(700_000);
  const records = [record(bigBody + "-first"), record(bigBody + "-second")];
  const bytes = await objectBytes(records);
  let firstPushCount = 0;
  let secondPushCount = 0;
  const deps = {
    fetchObject: async () => bytes,
    pushToLoki: async (_tenant, gz) => {
      const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"));
      const body = await new Response(stream).text();
      if (body.includes("-first")) {
        firstPushCount++;
        return { status: 204 };
      }
      secondPushCount++;
      return { status: 400, message: "too_far_behind" };
    },
    symbolicate: noopSymbolicate,
  };

  const outcome = await drainKey(key, new Set(), deps);

  assert.equal(firstPushCount, 1, "the already-successful first chunk must be pushed exactly once, never retried");
  assert.equal(secondPushCount, 1, "a 400 is still never retried");
  assert.equal(outcome.outcome, "provisional", "the accepted first chunk must keep the key provisional, not rejected (row 19)");
  assert.equal(outcome.reason, "too_far_behind");
});

test("drainKey: a 5xx is retried, and succeeds if a later attempt returns 2xx", async () => {
  const key = "inbox/worker/2026-01-01/00/000000000000.ndjson.gz";
  const bytes = await objectBytes([record("retry-me")]);
  let attempts = 0;
  const deps = {
    fetchObject: async () => bytes,
    pushToLoki: async () => {
      attempts++;
      return attempts < 2 ? { status: 503 } : { status: 204 };
    },
    symbolicate: noopSymbolicate,
  };

  const outcome = await drainKey(key, new Set(), deps);

  assert.equal(outcome.outcome, "provisional");
  assert.ok(attempts >= 2, "must have retried at least once");
});

test("drainKey: a persistently-failing 5xx exhausts retries and reports error, not provisional", async () => {
  const key = "inbox/worker/2026-01-01/00/000000000000.ndjson.gz";
  const bytes = await objectBytes([record("always-fails")]);
  let attempts = 0;
  const deps = {
    fetchObject: async () => bytes,
    pushToLoki: async () => {
      attempts++;
      return { status: 500 };
    },
    symbolicate: noopSymbolicate,
  };

  const outcome = await drainKey(key, new Set(), deps);

  assert.equal(outcome.outcome, "error");
  assert.ok(attempts >= 3, "must have retried more than once before giving up");
});

test("drainKey: a missing R2 object is rejected, not retried forever", async () => {
  const outcome = await drainKey("inbox/worker/2026-01-01/00/000000000000.ndjson.gz", new Set(), {
    fetchObject: async () => null,
    pushToLoki: async () => ({ status: 204 }),
    symbolicate: noopSymbolicate,
  });
  assert.equal(outcome.outcome, "rejected");
  assert.equal(outcome.reason, "object_missing");
});

// ---- drop-old-before-push ---------------------------------------------------
//
// One record older than Loki's own `reject_old_samples_max_age: 7d` gets a
// 400 for the whole push, and `drainKey` maps every 400 to `rejected` —
// losing every good record in that key permanently (a rejected key is
// never retried), unless the old record is dropped before it ever reaches
// Loki. These prove that: the good sibling still gets pushed and the key
// still goes `provisional`, and the drop is counted on the outcome, never
// silent.

test("a record older than the 7-day reject window is dropped before push and counted, not sent to Loki", async () => {
  const key = "inbox/worker/2026-01-01/00/000000000000.ndjson.gz";
  const bytes = await objectBytes([oldRecord("ancient"), record("fresh")]);
  const pushedBodies = [];
  const deps = {
    fetchObject: async () => bytes,
    pushToLoki: async (_tenant, gz) => {
      const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"));
      pushedBodies.push(JSON.parse(await new Response(stream).text()));
      return { status: 204 };
    },
    symbolicate: noopSymbolicate,
  };

  const outcome = await drainKey(key, new Set(), deps);

  assert.equal(outcome.outcome, "provisional", "the good sibling record must still make it — not the whole key rejected");
  assert.equal(outcome.droppedOld, 1, "the old record must be counted as dropped, never silent");
  assert.equal(pushedBodies.length, 1);
  assert.equal(pushedBodies[0].resourceLogs.length, 1, "only the fresh record was actually pushed to Loki");
  assert.match(pushedBodies[0].resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue, /fresh/);
});

test("a key whose every record is too old is provisional with nothing pushed (no whole-key 400, nothing lost silently)", async () => {
  const key = "inbox/worker/2026-01-01/00/000000000000.ndjson.gz";
  const bytes = await objectBytes([oldRecord("a"), oldRecord("b")]);
  let pushCount = 0;
  const deps = {
    fetchObject: async () => bytes,
    pushToLoki: async () => {
      pushCount++;
      return { status: 400, message: "too_far_behind" }; // must never even be called
    },
    symbolicate: noopSymbolicate,
  };

  const outcome = await drainKey(key, new Set(), deps);

  assert.equal(outcome.outcome, "provisional");
  assert.equal(outcome.droppedOld, 2);
  assert.equal(pushCount, 0, "nothing left to push after the filter — Loki must never even see this key");
});

test("a zero/absent timeUnixNano is never treated as an ancient (1970) timestamp and dropped", async () => {
  const key = "inbox/worker/2026-01-01/00/000000000000.ndjson.gz";
  const zeroTimestamp = record("zero", "0");
  const bytes = await objectBytes([zeroTimestamp]);
  let pushed = false;
  const deps = {
    fetchObject: async () => bytes,
    pushToLoki: async () => {
      pushed = true;
      return { status: 204 };
    },
    symbolicate: noopSymbolicate,
  };

  const outcome = await drainKey(key, new Set(), deps);

  assert.equal(outcome.droppedOld, 0);
  assert.ok(pushed, "a record with no real timestamp must still be pushed (Loki falls back to observed time)");
});

test("drainKey: a record already in `seenHashes` is not pushed again (within-call dedupe)", async () => {
  const key = "inbox/worker/2026-01-01/00/000000000000.ndjson.gz";
  const rec = record("dup-me");
  const bytes = await objectBytes([rec, rec]); // same record twice in one object
  const pushedRecords = [];
  const deps = {
    fetchObject: async () => bytes,
    pushToLoki: async (_tenant, gz) => {
      const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"));
      const text = await new Response(stream).text();
      pushedRecords.push(...JSON.parse(text).resourceLogs);
      return { status: 204 };
    },
    symbolicate: noopSymbolicate,
  };

  const seen = new Set();
  await drainKey(key, seen, deps);

  assert.equal(pushedRecords.length, 1, "the duplicate record must be pushed only once");
});

test("drainKey: symbolicate() is applied to the records before they are pushed", async () => {
  const key = "inbox/worker/2026-01-01/00/000000000000.ndjson.gz";
  const bytes = await objectBytes([record("original")]);
  let pushedText = "";
  const deps = {
    fetchObject: async () => bytes,
    pushToLoki: async (_tenant, gz) => {
      const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"));
      pushedText = await new Response(stream).text();
      return { status: 204 };
    },
    symbolicate: async (records) =>
      records.map((r) => ({
        ...r,
        scopeLogs: [{ logRecords: [{ ...r.scopeLogs[0].logRecords[0], body: { stringValue: "resolved" } }] }],
      })),
  };

  await drainKey(key, new Set(), deps);

  assert.match(pushedText, /"resolved"/);
  assert.doesNotMatch(pushedText, /"original"/);
});

// ---- a throw inside symbolicate() must isolate only its key -----------------
//
// A throw from `deps.symbolicate` (e.g. the real `symbolicateResourceLogs`
// hitting a line-0 frame) must not escape `drainKey` uncaught — an
// uncaught throw escapes `drainBatch`'s for-loop too (its early-stop check
// only looks at the `outcome` field of a normally-returned result; an
// exception skips that check completely) and propagates to the caller.
// `box.ts#drainStep`'s own catch would then record the whole wake as
// `outcome: "error"` and leave every key in the batch `written`, including
// the poisoned one — so the identical batch replays on the next wake and
// throws again, forever (`nextWrittenKeys`'s deterministic ascending order
// always re-fetches the same poisoned key first). This isolation makes a
// symbolication throw behave like any other permanent per-key failure
// (`undecodable_object`, `object_missing`): `rejected`, and the batch
// moves on.

test("drainKey isolates a throw from symbolicate() as a rejected outcome, never lets it escape", async () => {
  const key = "inbox/worker/2026-01-01/00/000000000000.ndjson.gz";
  const bytes = await objectBytes([record("poison")]);
  const deps = {
    fetchObject: async () => bytes,
    pushToLoki: async () => {
      throw new Error("pushToLoki must never be reached — symbolicate() threw before any push");
    },
    symbolicate: async () => {
      throw new TypeError("Line must be greater than or equal to 1, got 0");
    },
  };

  const outcome = await drainKey(key, new Set(), deps);

  assert.equal(outcome.outcome, "rejected", "a symbolication throw must isolate to this key, not escape as an exception");
  assert.match(outcome.reason ?? "", /symbolicate_exception/);
  assert.match(outcome.reason ?? "", /Line must be greater/);
});

test("drainBatch with one poison key (symbolicate throws) followed by a good key pushes the good key and rejects only the poison one", async () => {
  const poisonKey = "inbox/worker/2026-01-01/00/000000000000.ndjson.gz";
  const goodKey = "inbox/worker/2026-01-01/00/000000000001.ndjson.gz";
  const objects = {
    [poisonKey]: await objectBytes([record("poison")]),
    [goodKey]: await objectBytes([record("fine")]),
  };
  const pushedBodies = [];
  const deps = {
    fetchObject: async (k) => objects[k] ?? null,
    pushToLoki: async (_tenant, gz) => {
      const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"));
      pushedBodies.push(await new Response(stream).text());
      return { status: 204 };
    },
    // Only the poison key's OWN records throw — a real symbolicator would
    // throw on the poisoned RECORD regardless of which key it came from, so
    // this fake keys off the record content, exactly the same shape
    // `symbolicateResourceLogs` itself would present.
    symbolicate: async (records) => {
      if (records.some((r) => JSON.stringify(r).includes("poison"))) {
        throw new TypeError("Line must be greater than or equal to 1, got 0");
      }
      return records;
    },
  };

  const result = await drainBatch([poisonKey, goodKey], new Set(), deps);

  assert.equal(result.stoppedEarly, false, "a rejected key must not stop the batch — only an 'error' outcome does");
  assert.equal(result.outcomes.length, 2, "both keys must be processed");
  assert.equal(result.outcomes[0].outcome, "rejected");
  assert.equal(result.outcomes[1].outcome, "provisional");
  assert.ok(pushedBodies.some((b) => b.includes("fine")), "the good key's record must actually reach Loki");
  assert.ok(!pushedBodies.some((b) => b.includes("poison")), "the poisoned key's record must never be pushed");
});

test("a transient Loki failure (not a symbolication throw) still does NOT reject — it keeps today's error/retry behaviour", async () => {
  const key = "inbox/worker/2026-01-01/00/000000000000.ndjson.gz";
  const bytes = await objectBytes([record("transient")]);
  let attempts = 0;
  const deps = {
    fetchObject: async () => bytes,
    pushToLoki: async () => {
      attempts++;
      return { status: 503 }; // a real outage — never a throw, never "rejected"
    },
    symbolicate: noopSymbolicate,
  };

  const outcome = await drainKey(key, new Set(), deps);

  assert.equal(outcome.outcome, "error", "a transient push failure must stay 'error' (retried by a later wake), never 'rejected'");
  assert.notEqual(outcome.outcome, "rejected");
  assert.ok(attempts >= 3, "must still have retried, exactly like before this fix");
});

test("drainBatch stops immediately on the first `error` outcome, leaving later keys untouched", async () => {
  const okKey = "inbox/worker/2026-01-01/00/000000000000.ndjson.gz";
  const failKey = "inbox/worker/2026-01-01/00/000000000001.ndjson.gz";
  const neverReachedKey = "inbox/worker/2026-01-01/00/000000000002.ndjson.gz";
  const objects = {
    [okKey]: await objectBytes([record("a")]),
    [failKey]: await objectBytes([record("b")]),
    [neverReachedKey]: await objectBytes([record("c")]),
  };
  let neverReachedFetched = false;
  const deps = {
    fetchObject: async (k) => {
      if (k === neverReachedKey) neverReachedFetched = true;
      return objects[k] ?? null;
    },
    pushToLoki: async (_t, _gz) => (objects[failKey] ? { status: 500 } : { status: 204 }),
    symbolicate: noopSymbolicate,
  };
  // Make the fail key actually fail, the ok key actually succeed.
  deps.pushToLoki = async (_tenant, gz) => {
    const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"));
    const text = await new Response(stream).text();
    return text.includes('"b"') ? { status: 500 } : { status: 204 };
  };

  const result = await drainBatch([okKey, failKey, neverReachedKey], new Set(), deps);

  assert.equal(result.stoppedEarly, true);
  assert.equal(result.outcomes.length, 2, "the batch must stop before reaching the third key");
  assert.equal(result.outcomes[0].outcome, "provisional");
  assert.equal(result.outcomes[1].outcome, "error");
  assert.equal(neverReachedFetched, false);
});

// ---- Loki's active-stream limit ---------------------------------------------

// Loki 3.3.2's own wording for `max_global_streams_per_user` (default 5000).
const STREAM_LIMIT_MESSAGE =
  "Maximum active stream limit exceeded when trying to create stream {hot_outcome=\"o5001\"}, reduce the number of active streams (reduce labels or reduce label values), or contact your Loki administrator to see if the limit can be increased, user: 'browser'";

async function pushedText(gz) {
  const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

test("a stream-limit 429 rejects that key without a retry, and the batch goes on to commit the keys after it", async () => {
  const overKey = "inbox/browser/2026-01-01/00/000000000000.ndjson.gz";
  const laterKey = "inbox/browser/2026-01-01/00/000000000001.ndjson.gz";
  const workerKey = "inbox/worker/2026-01-01/00/000000000000.ndjson.gz";
  const objects = {
    [overKey]: await objectBytes([record("too-many-streams")]),
    [laterKey]: await objectBytes([record("later")]),
    [workerKey]: await objectBytes([record("worker-tenant")]),
  };
  const pushes = [];
  const deps = {
    fetchObject: async (k) => objects[k] ?? null,
    pushToLoki: async (_tenant, gz) => {
      const text = await pushedText(gz);
      pushes.push(text);
      return text.includes("too-many-streams") ? { status: 429, message: STREAM_LIMIT_MESSAGE } : { status: 204 };
    },
    symbolicate: noopSymbolicate,
  };

  const result = await drainBatch([overKey, laterKey, workerKey], new Set(), deps);

  assert.equal(result.stoppedEarly, false, "a stream-limit refusal must not stop the drain");
  assert.deepEqual(
    result.outcomes.map((o) => o.outcome),
    ["rejected", "provisional", "provisional"],
  );
  assert.equal(result.outcomes[0].reason, STREAM_LIMIT_MESSAGE, "the rejection carries Loki's own message for the rejectedEvent");
  assert.equal(pushes.filter((p) => p.includes("too-many-streams")).length, 1, "a stream-limit 429 is never retried");
  assert.ok(pushes.some((p) => p.includes("later")) && pushes.some((p) => p.includes("worker-tenant")));
});

test("a stream-limit 429 on one chunk is a partial reject, never a clean provisional", async () => {
  const key = "inbox/browser/2026-01-01/00/000000000000.ndjson.gz";
  const bigBody = "x".repeat(700_000);
  const bytes = await objectBytes([record(bigBody + "-first"), record(bigBody + "-second")]);
  let secondAttempts = 0;
  const deps = {
    fetchObject: async () => bytes,
    pushToLoki: async (_tenant, gz) => {
      if (!(await pushedText(gz)).includes("-second")) return { status: 204 };
      secondAttempts++;
      // A retry near the limit can answer 204 with the excess streams dropped.
      return secondAttempts === 1 ? { status: 429, message: STREAM_LIMIT_MESSAGE } : { status: 204 };
    },
    symbolicate: noopSymbolicate,
  };

  const outcome = await drainKey(key, new Set(), deps);

  assert.equal(secondAttempts, 1, "the refused chunk must not be retried into a silent 204");
  assert.equal(outcome.outcome, "provisional");
  assert.equal(outcome.reason, STREAM_LIMIT_MESSAGE, "the refused chunk must reach recordPartialReject");
});

/** A Loki-shaped push target with one stream table per tenant: a record's
 *  body names its stream, streams under `limit` are created, and a push
 *  needing one more answers the real stream-limit 429. */
function streamTableLoki(limit) {
  const tables = { browser: new Set(), worker: new Set() };
  return async (tenant, gz) => {
    let refused = false;
    for (const r of JSON.parse(await pushedText(gz)).resourceLogs) {
      const stream = r.scopeLogs[0].logRecords[0].body.stringValue;
      if (tables[tenant].has(stream)) continue;
      if (tables[tenant].size >= limit) refused = true;
      else tables[tenant].add(stream);
    }
    return refused ? { status: 429, message: STREAM_LIMIT_MESSAGE } : { status: 204 };
  };
}

test("after one key fills a tenant's stream table, a later key needing a new stream is deferred, not rejected; other tenants and existing streams still drain", async () => {
  const poison = "inbox/browser/2026-01-01/00/000000000000.ndjson.gz";
  const newStream = "inbox/browser/2026-01-01/00/000000000001.ndjson.gz";
  const oldStream = "inbox/browser/2026-01-01/00/000000000002.ndjson.gz";
  const worker = "inbox/worker/2026-01-01/00/000000000000.ndjson.gz";
  const objects = {
    [poison]: await objectBytes(["s1", "s2", "s3", "s4", "s5"].map((b) => record(b))),
    [newStream]: await objectBytes([record("n1")]),
    [oldStream]: await objectBytes([record("s1")]),
    [worker]: await objectBytes([record("w1")]),
  };
  const streamLimited = new Set();
  const deps = { fetchObject: async (k) => objects[k] ?? null, pushToLoki: streamTableLoki(3), symbolicate: noopSymbolicate };

  const result = await drainBatch([poison, newStream, oldStream, worker], new Set(), deps, streamLimited);

  assert.equal(result.stoppedEarly, false);
  assert.deepEqual(
    result.outcomes.map((o) => o.outcome),
    ["rejected", "deferred", "provisional", "provisional"],
  );
  assert.deepEqual([...streamLimited], ["browser"]);
});

for (const message of ["Ingestion rate limit exceeded for user browser (limit: 4194304 bytes/sec)", "Per stream rate limit exceeded (limit: 3MB/sec) while attempting to ingest for stream '{service_name=\"demos-api\"}'", undefined]) {
  test(`a rate-limit 429 stays transient: retried, then error and stop (${message ? message.slice(0, 24) : "no body"})`, async () => {
    const key = "inbox/worker/2026-01-01/00/000000000000.ndjson.gz";
    const neverReachedKey = "inbox/worker/2026-01-01/00/000000000001.ndjson.gz";
    const bytes = await objectBytes([record("rate-limited")]);
    let attempts = 0;
    let neverReachedFetched = false;
    const deps = {
      fetchObject: async (k) => {
        if (k === neverReachedKey) neverReachedFetched = true;
        return bytes;
      },
      pushToLoki: async () => {
        attempts++;
        return { status: 429, message };
      },
      symbolicate: noopSymbolicate,
    };

    const result = await drainBatch([key, neverReachedKey], new Set(), deps);

    assert.equal(attempts, 4, "one push plus three retries");
    assert.equal(result.outcomes[0].outcome, "error");
    assert.equal(result.stoppedEarly, true);
    assert.equal(neverReachedFetched, false);
  });
}

// ---- an unreadable inbox object ----------------------------------------------

test("a fetchObject throw on key 2 of 3 defers only that key: keys 1 and 3 still push and come back provisional", async () => {
  const keys = [0, 1, 2].map((i) => `inbox/worker/2026-01-01/00/00000000000${i}.ndjson.gz`);
  const objects = { [keys[0]]: await objectBytes([record("first")]), [keys[2]]: await objectBytes([record("third")]) };
  const pushes = [];
  const deps = {
    fetchObject: async (k) => {
      if (k === keys[1]) throw new Error("Too many subrequests.");
      return objects[k] ?? null;
    },
    pushToLoki: async (_tenant, gz) => {
      pushes.push(await pushedText(gz));
      return { status: 204 };
    },
    symbolicate: noopSymbolicate,
  };

  const result = await drainBatch(keys, new Set(), deps);

  assert.equal(result.stoppedEarly, false);
  assert.deepEqual(
    result.outcomes.map((o) => [o.key, o.outcome]),
    [
      [keys[0], "provisional"],
      [keys[1], "deferred"],
      [keys[2], "provisional"],
    ],
  );
  assert.match(result.outcomes[1].reason ?? "", /^fetch_error: Too many subrequests\.$/);
  assert.ok(pushes.some((p) => p.includes("first")) && pushes.some((p) => p.includes("third")));
});
