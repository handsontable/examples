// Observability contract §8 — `inboxKey`/`parseInboxKey` (UTC, not local time),
// NDJSON encode/decode round-trip, and `buildResourceLogs`'s shape.
//
// Build prerequisite: `pnpm --filter @handsontable/demo-runtime build`.
// Run: node --experimental-strip-types --test pipeline/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildResourceLogs,
  cleanMarkerKey,
  decodeNdjson,
  encodeNdjson,
  inboxKey,
  parseInboxKey,
} from "../packages/runtime/dist/telemetry/index.js";

test("inboxKey builds the exact §8 shape", () => {
  const date = new Date(Date.UTC(2026, 8, 23, 14, 5, 0));
  assert.equal(inboxKey("browser", date, 7), "inbox/browser/2026-09-23/14/000000000007.ndjson.gz");
});

test("inboxKey uses UTC, not local time — this machine's zone (CEST, UTC+2) would put 23:30 UTC in tomorrow's local date", () => {
  // 2026-09-23T23:30:00Z is 2026-09-24, 01:30 in CEST (UTC+2).
  const date = new Date(Date.UTC(2026, 8, 23, 23, 30, 0));
  const key = inboxKey("worker", date, 1);
  assert.equal(key, "inbox/worker/2026-09-23/23/000000000001.ndjson.gz");
});

test("inboxKey pads the sequence to 12 digits", () => {
  const date = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
  assert.equal(inboxKey("browser", date, 42), "inbox/browser/2026-01-01/00/000000000042.ndjson.gz");
});

test("parseInboxKey is the exact inverse of inboxKey", () => {
  const date = new Date(Date.UTC(2026, 8, 23, 14, 5, 0));
  const key = inboxKey("browser", date, 7);
  assert.deepEqual(parseInboxKey(key), { tenant: "browser", date: "2026-09-23", hour: "14", seq: 7 });
});

test("parseInboxKey rejects a key that does not match the shape", () => {
  assert.equal(parseInboxKey("inbox/browser/2026-09-23/14/7.ndjson.gz"), null); // seq not 12 digits
  assert.equal(parseInboxKey("inbox/other-tenant/2026-09-23/14/000000000007.ndjson.gz"), null);
  assert.equal(parseInboxKey("not a key at all"), null);
});

test("cleanMarkerKey builds the §8 state path", () => {
  assert.equal(cleanMarkerKey("wake-abc123"), "state/wakes/wake-abc123/clean");
});

test("encodeNdjson / decodeNdjson round-trip exactly", () => {
  const records = [
    buildResourceLogs({
      body: "hello",
      timeUnixNano: "1695463200000000000",
      resourceAttributes: { "service.name": "demos-o11y" },
    }),
    buildResourceLogs({
      body: "world",
      timeUnixNano: "1695463201000000000",
      resourceAttributes: { "service.name": "demos-o11y" },
      attributes: { "hot.demo_id": "r-react-18-0-0" },
    }),
  ];
  const encoded = encodeNdjson(records);
  assert.equal(encoded.split("\n").filter(Boolean).length, 2);
  assert.deepEqual(decodeNdjson(encoded), records);
});

test("encodeNdjson of an empty array is an empty string, not a bare newline", () => {
  assert.equal(encodeNdjson([]), "");
});

test("decodeNdjson skips blank lines", () => {
  const one = buildResourceLogs({ body: "x", timeUnixNano: "1", resourceAttributes: {} });
  const withBlankLines = `\n${JSON.stringify(one)}\n\n`;
  assert.deepEqual(decodeNdjson(withBlankLines), [one]);
});

test("buildResourceLogs wraps exactly one log record, resource attrs first", () => {
  const rl = buildResourceLogs({
    body: "boom",
    timeUnixNano: "1695463200000000000",
    resourceAttributes: { "service.name": "demos-o11y", "hot.surface": "o11y" },
    attributes: { "cf.ray": "abc123" },
    severityText: "ERROR",
  });
  assert.equal(rl.scopeLogs.length, 1);
  assert.equal(rl.scopeLogs[0].logRecords.length, 1);
  const record = rl.scopeLogs[0].logRecords[0];
  assert.equal(record.body.stringValue, "boom");
  assert.equal(record.timeUnixNano, "1695463200000000000");
  assert.equal(record.severityText, "ERROR");
  assert.deepEqual(record.attributes, [{ key: "cf.ray", value: { stringValue: "abc123" } }]);
  assert.deepEqual(rl.resource.attributes, [
    { key: "service.name", value: { stringValue: "demos-o11y" } },
    { key: "hot.surface", value: { stringValue: "o11y" } },
  ]);
});

test("buildResourceLogs omits `attributes` entirely when there are none (not an empty array)", () => {
  const rl = buildResourceLogs({ body: "x", timeUnixNano: "1", resourceAttributes: {} });
  assert.equal(rl.scopeLogs[0].logRecords[0].attributes, undefined);
});
