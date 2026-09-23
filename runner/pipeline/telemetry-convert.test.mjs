// Observability contract §6 (Faro item → OTLP log record) and §9 (beacon → OTLP
// log record).
//
// Build prerequisite: `pnpm --filter @handsontable/demo-runtime build`.
// Run: node --experimental-strip-types --test pipeline/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  beaconToRecord,
  clampTimestampMs,
  faroItemToRecord,
  hoistAttributes,
  msToUnixNano,
} from "../packages/runtime/dist/telemetry/index.js";

const SERVICE = { name: "demos-authoring", version: "abc123def456", environment: "production" };
const RECEIVED_AT_MS = Date.UTC(2026, 8, 23, 12, 0, 0); // fixed, so "twice" never races a clock

test("clampTimestampMs keeps a candidate inside the 5-minute window", () => {
  const candidate = RECEIVED_AT_MS - 60_000; // 1 minute earlier
  assert.equal(clampTimestampMs(candidate, RECEIVED_AT_MS), candidate);
});

test("clampTimestampMs falls back outside the 5-minute window", () => {
  const tooOld = RECEIVED_AT_MS - 6 * 60_000;
  assert.equal(clampTimestampMs(tooOld, RECEIVED_AT_MS), RECEIVED_AT_MS);
});

test("clampTimestampMs falls back when the candidate is absent", () => {
  assert.equal(clampTimestampMs(undefined, RECEIVED_AT_MS), RECEIVED_AT_MS);
});

test("msToUnixNano converts exactly, at ordinary timestamp magnitudes", () => {
  const ms = 1_695_463_200_123;
  assert.equal(msToUnixNano(ms), "1695463200123000000");
});

test("msToUnixNano stays an exact integer string even where `ms * 1e6` as a plain double would not", () => {
  // `ms` alone is a safe integer (well under 2^53); `ms * 1e6` computed in
  // double precision overflows the mantissa and prints in exponential
  // notation ("8e+21", `String(8_000_000_000_000_000 * 1e6)`) — a value OTLP's
  // JSON `fixed64` mapping cannot parse back as a timestamp. BigInt keeps it
  // exact. Not a realistic wall-clock date, but a real boundary the function
  // must not get wrong.
  const ms = 8_000_000_000_000_000;
  assert.equal(msToUnixNano(ms), "8000000000000000000000");
});

test("hoistAttributes splits a merged bag into resource attrs vs structured metadata, dropping anything else", () => {
  const { resourceAttributes, attributes } = hoistAttributes({
    "hot.surface": "authoring",
    "hot.ht_major": "18",
    "hot.demo_id": "r-react-18-0-0",
    "session.id": "plid-1",
    "not.a.contract.key": "should be dropped",
  });
  assert.deepEqual(resourceAttributes, { "hot.surface": "authoring", "hot.ht_major": "18" });
  assert.deepEqual(attributes, { "hot.demo_id": "r-react-18-0-0", "session.id": "plid-1" });
});

function faroLogItem(overrides = {}) {
  return {
    type: "log",
    payload: {
      message: "session started",
      timestamp: new Date(RECEIVED_AT_MS - 1000).toISOString(),
      context: {
        "hot.surface": "authoring",
        "hot.tier": "1",
        "hot.framework": "react",
        "hot.ht_major": "18",
        "hot.demo_id": "r-react-18-0-0",
        "session.id": "plid-abc",
      },
      ...overrides.payload,
    },
    meta: {},
    ...overrides,
  };
}

test("faroItemToRecord hoists hot.* to resourceAttributes and adds the service.* resource attrs", () => {
  const record = faroItemToRecord(faroLogItem(), { service: SERVICE, receivedAtMs: RECEIVED_AT_MS });
  assert.equal(record.resourceAttributes["service.name"], "demos-authoring");
  assert.equal(record.resourceAttributes["service.version"], "abc123def456");
  assert.equal(record.resourceAttributes["deployment.environment.name"], "production");
  assert.equal(record.resourceAttributes["hot.surface"], "authoring");
  assert.equal(record.resourceAttributes["hot.tier"], "1");
  assert.equal(record.resourceAttributes["hot.framework"], "react");
  assert.equal(record.resourceAttributes["hot.ht_major"], "18");
  // Structured metadata never lands as a resource attribute.
  assert.equal(record.resourceAttributes["hot.demo_id"], undefined);
  assert.equal(record.resourceAttributes["session.id"], undefined);
  assert.deepEqual(record.attributes, { "hot.demo_id": "r-react-18-0-0", "session.id": "plid-abc" });
});

test("faroItemToRecord clamps the event timestamp to the receive window", () => {
  const farInPast = faroLogItem({ payload: { timestamp: new Date(RECEIVED_AT_MS - 3_600_000).toISOString() } });
  const record = faroItemToRecord(farInPast, { service: SERVICE, receivedAtMs: RECEIVED_AT_MS });
  assert.equal(record.timeUnixNano, msToUnixNano(RECEIVED_AT_MS));
});

test("faroItemToRecord body: exception carries its type, log carries its message", () => {
  const exceptionItem = {
    type: "exception",
    payload: { type: "TypeError", value: "x is not a function", timestamp: new Date(RECEIVED_AT_MS).toISOString() },
    meta: {},
  };
  const record = faroItemToRecord(exceptionItem, { service: SERVICE, receivedAtMs: RECEIVED_AT_MS });
  assert.equal(record.body, "TypeError: x is not a function");

  const logRecord = faroItemToRecord(faroLogItem(), { service: SERVICE, receivedAtMs: RECEIVED_AT_MS });
  assert.equal(logRecord.body, "session started");
});

test("faroItemToRecord is byte-identical converting the same item twice", () => {
  const item = faroLogItem();
  const a = faroItemToRecord(item, { service: SERVICE, receivedAtMs: RECEIVED_AT_MS });
  const b = faroItemToRecord(item, { service: SERVICE, receivedAtMs: RECEIVED_AT_MS });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

function litePayload(overrides = {}) {
  return {
    v: 1,
    t: "err",
    s: "embed",
    demo: "r-react-18-0-0",
    ht: "18",
    fw: "react",
    n: "TypeError",
    m: "x is not a function",
    val: null,
    dev: "desktop",
    ts: RECEIVED_AT_MS - 500,
    ...overrides,
  };
}

test("beaconToRecord hoists s/ht/fw to resourceAttributes, hot.tier is always static", () => {
  const record = beaconToRecord(litePayload(), { service: { ...SERVICE, name: "demos-embed" }, receivedAtMs: RECEIVED_AT_MS });
  assert.equal(record.resourceAttributes["hot.surface"], "embed");
  assert.equal(record.resourceAttributes["hot.tier"], "static");
  assert.equal(record.resourceAttributes["hot.framework"], "react");
  assert.equal(record.resourceAttributes["hot.ht_major"], "18");
  assert.equal(record.resourceAttributes["service.name"], "demos-embed");
  assert.deepEqual(record.attributes, { "hot.demo_id": "r-react-18-0-0", "hot.kind": "exception" });
});

test("beaconToRecord clamps its own ts the same way", () => {
  const stale = litePayload({ ts: RECEIVED_AT_MS - 3_600_000 });
  const record = beaconToRecord(stale, { service: SERVICE, receivedAtMs: RECEIVED_AT_MS });
  assert.equal(record.timeUnixNano, msToUnixNano(RECEIVED_AT_MS));
});

test("beaconToRecord is byte-identical converting the same payload twice", () => {
  const payload = litePayload();
  const a = beaconToRecord(payload, { service: SERVICE, receivedAtMs: RECEIVED_AT_MS });
  const b = beaconToRecord(payload, { service: SERVICE, receivedAtMs: RECEIVED_AT_MS });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("beaconToRecord marks a vital beacon's hot.kind as measurement, not exception", () => {
  const vital = litePayload({ t: "vital", n: "LCP", m: undefined, val: 2200 });
  const record = beaconToRecord(vital, { service: SERVICE, receivedAtMs: RECEIVED_AT_MS });
  assert.equal(record.attributes["hot.kind"], "measurement");
  assert.equal(record.body, "LCP=2200");
});
