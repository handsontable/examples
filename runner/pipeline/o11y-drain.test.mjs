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

/** Recent by default (F1's drain-time age filter drops anything older than
 *  ~7 days — see `record(..., "old")` below for the deliberately-stale
 *  case) so every pre-existing push/retry/reject test here still exercises
 *  a real push, not a silently-empty one. */
function record(bodyText, timeUnixNano = String(BigInt(Date.now()) * 1_000_000n)) {
  return {
    resource: { attributes: [{ key: "service.name", value: { stringValue: "demos-api" } }] },
    scopeLogs: [{ logRecords: [{ timeUnixNano, body: { stringValue: bodyText } }] }],
  };
}

/** 8 days behind "now" — past Loki's `reject_old_samples_max_age: 7d`
 *  (containers/o11y/loki/loki-config*.yaml) and past F1's own (stricter)
 *  drain-time cutoff. */
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

// T03-D2: Loki's `/otlp/v1/logs` decodes the body as ONE OTLP/HTTP JSON
// `ExportLogsServiceRequest` (`{"resourceLogs":[...]}`). The drain used to
// send the inbox's own NDJSON (one bare ResourceLogs per line) instead;
// Loki answered 204 and ingested nothing, so no chunk was flushed, no TSDB
// table was built, no index object was uploaded on SIGTERM and shutdown.sh
// (correctly) never wrote the clean marker. Reproduced against the real
// Loki 3.3.2 in containers/o11y/compose.yml (see the T03-D2 report).
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
  // An IN-WINDOW record (F1's own age filter must not remove it) whose 400
  // is forced by the mock — `too_far_behind` is Loki's 60-minute
  // out-of-order window (T03-D1), unrelated to F1's 7-day age filter, and
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

// ---- F1: drop-old-before-push --------------------------------------------
//
// T03-D2's other finding: one record older than Loki's own
// `reject_old_samples_max_age: 7d` gets a 400 for the WHOLE push, and
// `drainKey` maps every 400 to `rejected` — losing every good record in
// that key, permanently (a rejected key is never retried). These prove the
// fix: the old record never reaches Loki at all, the good sibling still
// gets pushed and the key still goes `provisional`, and the drop is
// counted on the outcome, never silent.

test("F1: a record older than the 7-day reject window is dropped before push and counted, not sent to Loki", async () => {
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

test("F1: a key whose every record is too old is provisional with nothing pushed (no whole-key 400, nothing lost silently)", async () => {
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

test("F1: a zero/absent timeUnixNano is never treated as an ancient (1970) timestamp and dropped", async () => {
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
