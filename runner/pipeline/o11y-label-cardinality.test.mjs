// Contract §3: `hot.framework` and `hot.outcome` are Loki labels, so every
// ingest path must map a client-sent value into a known set. Each distinct value
// is a Loki stream, and one inbox object with more than 5000 streams (Loki's
// default per-tenant limit) is refused on every drain.
// Build prerequisite: `pnpm --filter @handsontable/demo-runtime build`.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./fixtures/o11y-worker-hooks.mjs", import.meta.url);

const { processFaroBody, MAX_FARO_ITEMS_PER_BODY } = await import("../workers/o11y/src/normalise/faro.ts");
const { processOtlpBody } = await import("../workers/o11y/src/normalise/otlp.ts");
const { beaconToRecord, KNOWN_FRAMEWORKS, RECORD_OUTCOMES, AE_COLUMNS } = await import(
  "../packages/runtime/dist/telemetry/index.js"
);

const ENV = { O11Y_ENV: "production" };
const SERVICE = { name: "demos-authoring", version: "deadbeef1234", environment: "production" };
const DISTINCT = 6000;

/** One packed inbox object's worth of Faro logs (30 bodies of 200 items, one
 *  60 s pack window from a single IP), each item with its own attribute value. */
async function storedFaroLogs(attrKey) {
  const records = [];
  for (let start = 0; start < DISTINCT; start += MAX_FARO_ITEMS_PER_BODY) {
    const logs = [];
    for (let n = start; n < start + MAX_FARO_ITEMS_PER_BODY; n++) {
      logs.push({ message: `m${n}`, timestamp: new Date().toISOString(), context: { [attrKey]: `v${n}` } });
    }
    const body = { meta: { app: { name: "demos-authoring", version: "deadbeef1234" } }, logs };
    for (const item of await processFaroBody(body, ENV, SERVICE, Date.now())) {
      if (item.ingestItem?.record) records.push(item.ingestItem.record);
    }
  }
  return records;
}

function distinct(records, key) {
  return new Set(records.map((r) => r.resourceAttributes[key]));
}

test(`Faro: ${DISTINCT} distinct hot.outcome values on logs store at most |record outcomes|+1 label values`, async () => {
  const records = await storedFaroLogs("hot.outcome");
  assert.equal(records.length, DISTINCT, "every log is still stored");
  const values = distinct(records, "hot.outcome");
  assert.ok(values.size <= RECORD_OUTCOMES.length + 1, `got ${values.size} distinct values`);
  assert.deepEqual([...values], ["other"]);
});

test(`Faro: ${DISTINCT} distinct hot.framework values store at most |known frameworks|+1 label values`, async () => {
  const records = await storedFaroLogs("hot.framework");
  assert.equal(records.length, DISTINCT);
  const values = distinct(records, "hot.framework");
  assert.ok(values.size <= KNOWN_FRAMEWORKS.length + 1, `got ${values.size} distinct values`);
  assert.deepEqual([...values], ["other"]);
});

test("Faro: a real framework and outcome pass through unchanged", async () => {
  const now = new Date().toISOString();
  const body = {
    meta: { app: { name: "demos-authoring", version: "deadbeef1234" } },
    logs: [{ message: "hello", timestamp: now, context: { "hot.framework": "react", "hot.outcome": "none" } }],
    events: [{ name: "session.start", timestamp: now, attributes: { "hot.framework": "next.js", "hot.outcome": "ready" } }],
    measurements: [
      { type: "preview.ready_ms", values: { duration_ms: 812 }, timestamp: now, context: { "hot.framework": "vue", "hot.outcome": "timeout" } },
    ],
  };
  const [log, measurement, event] = await processFaroBody(body, ENV, SERVICE, Date.now());

  assert.equal(log.ingestItem.record.resourceAttributes["hot.framework"], "react");
  assert.equal(log.ingestItem.record.resourceAttributes["hot.outcome"], "none");
  // An event named after a metric keeps an outcome from that metric's set.
  assert.equal(event.ingestItem.record.resourceAttributes["hot.framework"], "next.js");
  assert.equal(event.ingestItem.record.resourceAttributes["hot.outcome"], "ready");
  // A measurement is AE-only; its point keeps the real outcome and framework.
  assert.equal(measurement.invalid, undefined);
  const [point] = measurement.aePoints;
  const blob = (column) => point.blobs[Number(AE_COLUMNS[column].slice(4)) - 1];
  assert.equal(blob("outcome"), "timeout");
  assert.equal(blob("framework"), "vue");
});

test("Faro: an outcome from another metric's set is still \"other\" on a log", async () => {
  const body = {
    meta: { app: { name: "demos-authoring", version: "deadbeef1234" } },
    logs: [{ message: "hello", timestamp: new Date().toISOString(), context: { "hot.outcome": "ready" } }],
  };
  const [log] = await processFaroBody(body, ENV, SERVICE, Date.now());
  assert.equal(log.ingestItem.record.resourceAttributes["hot.outcome"], "other");
});

test(`lite beacon: ${DISTINCT} distinct fw values store at most |known frameworks|+1 label values; a real one is kept`, () => {
  const values = new Set();
  for (let n = 0; n < DISTINCT; n++) {
    const record = beaconToRecord(
      { v: 1, t: "err", s: "embed", demo: "abc123", ht: "18", fw: `fw${n}`, n: "TypeError", m: "x", val: null, dev: "desktop", ts: Date.now() },
      { service: SERVICE, receivedAtMs: Date.now() },
    );
    values.add(record.resourceAttributes["hot.framework"]);
  }
  assert.ok(values.size <= KNOWN_FRAMEWORKS.length + 1, `got ${values.size} distinct values`);
  assert.deepEqual([...values], ["other"]);

  const real = beaconToRecord(
    { v: 1, t: "err", s: "embed", demo: "abc123", ht: "18", fw: "angular", n: "TypeError", m: "x", val: null, dev: "desktop", ts: Date.now() },
    { service: SERVICE, receivedAtMs: Date.now() },
  );
  assert.equal(real.resourceAttributes["hot.framework"], "angular");
});

test(`OTLP export: ${DISTINCT} distinct hot.outcome/hot.framework record attributes stay bounded; real values are kept`, async () => {
  const str = (stringValue) => ({ stringValue });
  const logRecords = [];
  for (let n = 0; n < DISTINCT; n++) {
    logRecords.push({
      timeUnixNano: String(1_700_000_000_000_000_000n + BigInt(n)),
      body: str(`line ${n}`),
      attributes: [
        { key: "hot.outcome", value: str(`o${n}`) },
        { key: "hot.framework", value: str(`f${n}`) },
      ],
    });
  }
  logRecords.push({
    timeUnixNano: "1700000000000000000",
    body: str("real"),
    attributes: [
      { key: "hot.outcome", value: str("none") },
      { key: "hot.framework", value: str("remix") },
    ],
  });
  const body = JSON.stringify({
    resourceLogs: [
      { resource: { attributes: [{ key: "service.name", value: str("handsontable-demos-api") }] }, scopeLogs: [{ logRecords }] },
    ],
  });
  const { items } = await processOtlpBody(new TextEncoder().encode(body), "application/json", ENV, Date.now());
  assert.equal(items.length, DISTINCT + 1);
  const records = items.map((i) => i.record);
  const outcomes = distinct(records, "hot.outcome");
  const frameworks = distinct(records, "hot.framework");
  assert.ok(outcomes.size <= RECORD_OUTCOMES.length + 1, `got ${outcomes.size} distinct outcomes`);
  assert.ok(frameworks.size <= KNOWN_FRAMEWORKS.length + 1, `got ${frameworks.size} distinct frameworks`);
  const real = records.at(-1);
  assert.equal(real.resourceAttributes["hot.outcome"], "none");
  assert.equal(real.resourceAttributes["hot.framework"], "remix");
});
