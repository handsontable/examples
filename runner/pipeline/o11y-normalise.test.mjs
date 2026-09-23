// ADR §B.2 step 1–3 (normalise) tests: Faro item processing, OTLP JSON +
// protobuf decode, hashing determinism (exit criterion 4's precondition),
// timestamp rules (exit criterion 3), and the scrub assertions the
// acceptance criteria require "over all fixtures" (no query string, user
// agent, Babel code frame, preview hostname, `url.full`, geo or ASN in any
// stored record).
//
// Run: node --experimental-strip-types --test pipeline/o11y-normalise.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

register("./fixtures/o11y-worker-hooks.mjs", import.meta.url);

const { processFaroBody } = await import("../workers/o11y/src/normalise/faro.ts");
const { decodeOtlpJson, processOtlpBody } = await import("../workers/o11y/src/normalise/otlp.ts");
const { decodeOtlpProtobuf } = await import("../workers/o11y/src/normalise/otlp-protobuf.ts");
const { hashRecord } = await import("../workers/o11y/src/normalise/hash.ts");

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const faroFixture = (name) => JSON.parse(readFileSync(`${FIXTURES}faro/${name}`, "utf8"));
const otlpJsonFixture = (name) => readFileSync(`${FIXTURES}otlp/json/${name}`, "utf8");
const otlpProtobufFixture = (name) => new Uint8Array(readFileSync(`${FIXTURES}otlp/protobuf/${name}`));

const ENV = { O11Y_ENV: "production" };
const SERVICE = { name: "demos-authoring", version: "deadbeef1234", environment: "production" };

/** Every string leaf of a value, concatenated — the acceptance criteria say
 *  "assert over all fixtures," so these helpers grep the *whole* serialised
 *  record rather than checking a few named fields, matching the review
 *  advice given before implementation ("grep the whole serialised stored
 *  line"). */
function allText(value) {
  return JSON.stringify(value);
}

// ---- Faro --------------------------------------------------------------------

test("Faro exception with a code frame: scrubbed, fingerprinted, hot.kind=exception", async () => {
  const body = faroFixture("exception-code-frame.json");
  const [item] = await processFaroBody(body, ENV, SERVICE, Date.now());
  assert.equal(item.invalid, undefined);
  assert.ok(item.ingestItem, "an exception must always be stored");

  const text = allText(item.ingestItem.record);
  assert.doesNotMatch(text, /\?t=1700000000/, "no query string survives");
  assert.doesNotMatch(text, /8787-abc123-tok3n/, "no preview hostname survives");
  assert.doesNotMatch(text, /> 2 \|/, "no Babel code-frame gutter line survives");
  assert.doesNotMatch(text, /\^\s*"/, "no code-frame caret line survives");

  assert.equal(item.ingestItem.record.attributes["hot.kind"], "exception");
  assert.equal(item.aePoints.length, 1);
  assert.equal(item.aePoints[0].indexes[0], "error.uncaught"); // handled: "false" in the fixture
  assert.ok(item.ingestItem.fingerprint, "authoring surface must feed the new-fingerprint alert");
});

test("Faro measurement: one browser metric point, stored record", async () => {
  const body = faroFixture("measurement.json");
  const [item] = await processFaroBody(body, ENV, SERVICE, Date.now());
  assert.ok(item.ingestItem);
  assert.equal(item.aePoints.length, 1);
  assert.equal(item.aePoints[0].indexes[0], "preview.ready_ms");
});

test("Faro web-vitals: LCP/INP/CLS become points, FCP is not a contract reason", async () => {
  const body = faroFixture("web-vitals.json");
  const [item] = await processFaroBody(body, ENV, SERVICE, Date.now());
  assert.ok(item.ingestItem, "a web-vitals measurement is still stored (§6 table)");
  const reasons = item.aePoints.map((p) => p.indexes[0]);
  assert.deepEqual(reasons, ["web_vital", "web_vital", "web_vital"]);
});

test("Faro example.open: one Analytics Engine point, no stored record", async () => {
  const body = faroFixture("example-open.json");
  const [item] = await processFaroBody(body, ENV, SERVICE, Date.now());
  assert.equal(item.ingestItem, undefined, "example.* events are never stored (§6)");
  assert.equal(item.aePoints.length, 1);
  assert.equal(item.aePoints[0].indexes[0], "example.open");
});

test("Faro log: stored record, no Analytics Engine point", async () => {
  const body = faroFixture("log.json");
  const [item] = await processFaroBody(body, ENV, SERVICE, Date.now());
  assert.ok(item.ingestItem);
  assert.equal(item.aePoints.length, 0);
});

test("hash: identical Faro item redelivered seconds apart hashes identically", async () => {
  const body = faroFixture("log.json");
  const [a] = await processFaroBody(body, ENV, SERVICE, Date.now());
  const [b] = await processFaroBody(body, ENV, SERVICE, Date.now() + 4000);
  assert.equal(a.ingestItem.hash, b.ingestItem.hash);
});

test("hash: a Faro item with no timestamp at all still hashes identically across redelivery", async () => {
  const body = faroFixture("log.json");
  delete body.logs[0].timestamp;
  const [a] = await processFaroBody(body, ENV, SERVICE, Date.now());
  const [b] = await processFaroBody(body, ENV, SERVICE, Date.now() + 9000);
  assert.equal(a.ingestItem.hash, b.ingestItem.hash, "a zero-timestamp record's clamp fallback must not leak into the hash");
});

// ---- OTLP: JSON vs protobuf agree -----------------------------------------------

test("OTLP JSON and protobuf decoders agree on the same fixture content", () => {
  const fromJson = decodeOtlpJson(otlpJsonFixture("basic.json"));
  const fromProtobuf = decodeOtlpProtobuf(otlpProtobufFixture("basic.bin"));
  assert.equal(fromJson[0].resourceAttributes["service.name"], fromProtobuf[0].resourceAttributes["service.name"]);
  assert.equal(fromJson[0].logRecords[0].body.startsWith("api.request"), true);
  assert.equal(fromProtobuf[0].logRecords[0].body.startsWith("api.request"), true);
  assert.equal(fromJson[0].logRecords[0].timeUnixNano, fromProtobuf[0].logRecords[0].timeUnixNano);
});

test("OTLP: a zero time_unix_nano gets the received_at fallback (exit criterion 3)", async () => {
  const receivedAtMs = Date.now();
  const result = await processOtlpBody(
    new TextEncoder().encode(otlpJsonFixture("zero-timestamp.json")),
    "application/json",
    ENV,
    receivedAtMs,
  );
  assert.equal(result.items.length, 1);
  const nano = BigInt(result.items[0].record.timeUnixNano);
  const expected = BigInt(receivedAtMs) * 1_000_000n;
  assert.equal(nano, expected);
});

test("OTLP: a real time_unix_nano is never clamped, even far from receivedAtMs", async () => {
  const receivedAtMs = Date.now();
  const result = await processOtlpBody(
    new TextEncoder().encode(otlpJsonFixture("basic.json")),
    "application/json",
    ENV,
    receivedAtMs,
  );
  // basic.json's time_unix_nano is a fixed 2025-01-01 timestamp, far outside
  // any 5-minute clamp window around "now" — it must survive unchanged.
  assert.equal(result.items[0].record.timeUnixNano, "1735689600000000000");
});

test("hash: the same OTLP export body delivered twice, seconds apart, hashes identically", async () => {
  const bytes = new TextEncoder().encode(otlpJsonFixture("zero-timestamp.json"));
  const first = await processOtlpBody(bytes, "application/json", ENV, Date.now());
  const second = await processOtlpBody(bytes, "application/json", ENV, Date.now() + 5000);
  assert.equal(first.items[0].hash, second.items[0].hash);
});

test("OTLP: forbidden attributes and body text are scrubbed over the whole record", async () => {
  const result = await processOtlpBody(
    new TextEncoder().encode(otlpJsonFixture("forbidden-attrs.json")),
    "application/json",
    ENV,
    Date.now(),
  );
  assert.equal(result.items.length, 1);
  const text = allText(result.items[0].record);
  assert.doesNotMatch(text, /url\.full/i);
  assert.doesNotMatch(text, /geo\./i);
  assert.doesNotMatch(text, /asn\./i);
  assert.doesNotMatch(text, /token=secret123/, "no query string survives, including inside body text");
  assert.doesNotMatch(text, /Mozilla\//, "no user-agent string survives");
  assert.doesNotMatch(text, /8787-abc123-tok3n/, "no preview hostname survives");
});

test("every stored record carries the contract's eight resource attributes", async () => {
  const result = await processOtlpBody(
    new TextEncoder().encode(otlpJsonFixture("basic.json")),
    "application/json",
    ENV,
    Date.now(),
  );
  const attrs = result.items[0].record.resourceAttributes;
  for (const key of [
    "service.name",
    "service.version",
    "deployment.environment.name",
    "hot.surface",
    "hot.tier",
    "hot.framework",
    "hot.ht_major",
    "hot.outcome",
  ]) {
    assert.ok(key in attrs, `missing resource attribute ${key}`);
  }
});

test("records over 256 KB are dropped, not stored", async () => {
  const huge = "x".repeat(300_000);
  const body = JSON.stringify({
    resourceLogs: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "demos-api" } }] },
        scopeLogs: [{ logRecords: [{ timeUnixNano: "1735689600000000000", body: { stringValue: huge } }] }],
      },
    ],
  });
  const result = await processOtlpBody(new TextEncoder().encode(body), "application/json", ENV, Date.now());
  assert.equal(result.items.length, 0);
  assert.equal(result.droppedOversize, 1);
});
