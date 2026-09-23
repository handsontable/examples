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

function record(bodyText, timeUnixNano = "1000000000") {
  return {
    resource: { attributes: [{ key: "service.name", value: { stringValue: "demos-api" } }] },
    scopeLogs: [{ logRecords: [{ timeUnixNano, body: { stringValue: bodyText } }] }],
  };
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

test("drainKey: a 400 rejects the key with Loki's message, no retry", async () => {
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
      pushedRecords.push(...text.trim().split("\n"));
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
