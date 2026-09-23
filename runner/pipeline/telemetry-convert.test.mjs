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
  isValidOpenAttrValue,
  msToUnixNano,
  sanitizeResourceAttributes,
  scrubTelemetry,
} from "../packages/runtime/dist/telemetry/index.js";

const SERVICE = { name: "demos-authoring", version: "abc123def456", environment: "production" };
const RECEIVED_AT_MS = Date.UTC(2026, 8, 23, 12, 0, 0); // fixed, so "twice" never races a clock
const PREVIEW_HOST = "3000-sbx7f2a-tok9xQ.demos.handsontable.com";

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

test("hoistAttributes also keeps T06's diagnostic tag keys as structured metadata (merge fix, T02+T06)", () => {
  // `scrub.ts#allowlistAttributes` (via `attrs.ts#ALLOWED_ATTRIBUTE_KEYS`) has
  // allowed `handled`/`context`/`sentry_event_id`/the `versions-fetch` tags
  // through since T06's fix round D1, but `hoistAttributes` — the very next
  // step in both the Faro and OTLP ingest paths — had its own narrower key
  // set and silently dropped them again. Found merging T02 with T06.
  const { resourceAttributes, attributes } = hoistAttributes({
    "hot.surface": "authoring",
    handled: "true",
    context: "tier1-compiler-asset",
    sentry_event_id: "abc123def456",
    versions_fetch_outcome: "ok",
    "not.a.contract.key": "still dropped",
  });
  assert.deepEqual(resourceAttributes, { "hot.surface": "authoring" });
  assert.deepEqual(attributes, {
    handled: "true",
    context: "tier1-compiler-asset",
    sentry_event_id: "abc123def456",
    versions_fetch_outcome: "ok",
  });
});

// ---- Fix round (finding A-C1): label/service forgery on the ingest path ----

test("sanitizeResourceAttributes drops an out-of-enum closed-set value, keeps a valid one", () => {
  const out = sanitizeResourceAttributes({
    "hot.surface": "o11y",
    "hot.tier": "zzz", // not in TIERS
    "hot.ht_major": "18",
  });
  assert.deepEqual(out, { "hot.surface": "o11y", "hot.ht_major": "18" });
});

test("sanitizeResourceAttributes drops an over-length/bad-charset open-set value (hot.framework, hot.outcome)", () => {
  const tooLong = "F".repeat(3000);
  const out = sanitizeResourceAttributes({ "hot.framework": tooLong, "hot.outcome": "attacker-<script>" });
  assert.deepEqual(out, {});
});

test("isValidOpenAttrValue accepts real framework/outcome shapes, rejects the forged ones from the A-C1 probe", () => {
  assert.equal(isValidOpenAttrValue("react"), true);
  assert.equal(isValidOpenAttrValue("react-18"), true);
  assert.equal(isValidOpenAttrValue("none"), true);
  assert.equal(isValidOpenAttrValue("F".repeat(3000)), false);
  assert.equal(isValidOpenAttrValue(""), false);
});

test("faroItemToRecord: the route's service identity always wins over a client-hoisted service.*/environment — spoof probe from finding A-C1", () => {
  // The exact probe from the finding: a single item whose own `context`
  // tries to override `service.name` and `deployment.environment.name`.
  const spoofed = faroLogItem({
    payload: {
      context: {
        "service.name": "demos-api",
        "deployment.environment.name": "local",
        "hot.surface": "o11y",
        "hot.tier": "zzz",
        "hot.framework": "F".repeat(3000),
        "hot.outcome": "<script>document.cookie</script>",
      },
    },
  });
  const record = faroItemToRecord(spoofed, { service: SERVICE, receivedAtMs: RECEIVED_AT_MS });
  // The route's own identity, never the client's.
  assert.equal(record.resourceAttributes["service.name"], "demos-authoring");
  assert.equal(record.resourceAttributes["deployment.environment.name"], "production");
  // Out-of-enum / over-length hot.* values are dropped, not stored verbatim.
  assert.equal(record.resourceAttributes["hot.tier"], undefined);
  assert.equal(record.resourceAttributes["hot.framework"], undefined);
  assert.equal(record.resourceAttributes["hot.outcome"], undefined);
  // A legitimate closed-set value survives untouched.
  assert.equal(record.resourceAttributes["hot.surface"], "o11y");
});

test("beaconToRecord: an over-length hot.framework (fw) is dropped, not stored verbatim — same A-C1 probe, lite path", () => {
  const record = beaconToRecord(
    {
      v: 1,
      s: "embed",
      demo: "r-react-18-0-0",
      ht: "18",
      fw: "F".repeat(3000),
      n: "TypeError",
      m: "x",
      val: null,
      dev: "desktop",
      ts: RECEIVED_AT_MS,
    },
    { service: SERVICE, receivedAtMs: RECEIVED_AT_MS },
  );
  assert.equal(record.resourceAttributes["hot.framework"], undefined);
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
  assert.deepEqual(record.attributes, {
    "hot.demo_id": "r-react-18-0-0",
    "session.id": "plid-abc",
    "hot.kind": "log",
  });
});

test("faroItemToRecord always sets hot.kind from item.type (§3's closed set), overwriting a client-sent value", () => {
  const item = faroLogItem({ payload: { context: { "hot.kind": "not-a-real-kind" } } });
  const record = faroItemToRecord(item, { service: SERVICE, receivedAtMs: RECEIVED_AT_MS });
  assert.equal(record.attributes["hot.kind"], "log");
});

test("faroItemToRecord throws on an item.type outside §3's closed set, e.g. 'trace' (Faro's own enum allows it; the contract does not)", () => {
  const traceItem = { type: "trace", payload: {}, meta: {} };
  assert.throws(() => faroItemToRecord(traceItem, { service: SERVICE, receivedAtMs: RECEIVED_AT_MS }), /not a valid hot\.kind/);
  assert.throws(
    () => faroItemToRecord({ ...faroLogItem(), type: "not-a-real-kind" }, { service: SERVICE, receivedAtMs: RECEIVED_AT_MS }),
    /not a valid hot\.kind/,
  );
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

// ---- T00-D6, revised: a beacon does not typecheck as scrubTelemetry's
// argument at all (it is neither Faro- nor OTLP-shaped) — convert, THEN
// scrub, the opposite order from a Faro item.

test("beaconToRecord -> scrubTelemetry cleans a code frame in m and a preview host in st", () => {
  const dirty = litePayload({
    m: "unknown: Unexpected token (1:10)\n\n> 1 | const x = ;\n    |           ^",
    st: `at https://${PREVIEW_HOST}/src/main.js`,
  });
  const record = beaconToRecord(dirty, { service: SERVICE, receivedAtMs: RECEIVED_AT_MS });
  const scrubbed = scrubTelemetry(record);
  assert.equal(scrubbed.body, "TypeError: unknown: Unexpected token (1:10)\nat https://<preview>/src/main.js");
});

test("scrubTelemetry is a no-op on an already-clean faroItemToRecord output (idempotent at the boundary)", () => {
  const record = faroItemToRecord(faroLogItem(), { service: SERVICE, receivedAtMs: RECEIVED_AT_MS });
  assert.deepEqual(scrubTelemetry(record), record);
});
