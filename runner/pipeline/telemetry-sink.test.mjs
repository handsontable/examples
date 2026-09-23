// `AeSink` (observability contract §4/§10) — `memorySink`, and `clickhouseSink`'s
// wire format against T01's actual `containers/o11y/local/clickhouse-init.sql`
// schema (confirmed column-for-column: index1, blob1-20 String, double1-20
// Float64, timestamp DateTime64(3), _sample_interval). The `timestamp` shape
// (raw epoch-millisecond integer) was cross-checked against a real, throwaway
// `clickhouse/clickhouse-server:24.10-alpine` container running T01's exact
// DDL — see `sink.ts`'s doc comment for the measured reasoning (a bare
// Unix-seconds integer and a formatted string were both measured wrong).
//
// Build prerequisite: `pnpm --filter @handsontable/demo-runtime build`.
// Run: node --experimental-strip-types --test pipeline/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { clickhouseSink, clickhouseTimestamp, memorySink, toAePoint } from "../packages/runtime/dist/telemetry/index.js";

test("memorySink collects every point written, in order", () => {
  const sink = memorySink();
  const a = toAePoint("chat.edit", { count: 1 }, { service_name: "demos-api", service_version: "x", environment: "production", outcome: "proposed" });
  const b = toAePoint("chat.edit", { count: 1 }, { service_name: "demos-api", service_version: "x", environment: "production", outcome: "applied" });
  sink.writeDataPoint(a);
  sink.writeDataPoint(b);
  assert.equal(sink.points.length, 2);
  assert.deepEqual(sink.points, [a, b]);
});

test("clickhouseTimestamp is a raw epoch-millisecond integer, not a formatted string", () => {
  const date = new Date(Date.UTC(2026, 8, 23, 12, 0, 0, 123));
  assert.equal(clickhouseTimestamp(date), 1790164800123);
  assert.equal(typeof clickhouseTimestamp(date), "number");
});

test("clickhouseSink POSTs one JSONEachRow line with T01's exact column names", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true };
  };
  const sink = clickhouseSink("http://localhost:8123", { fetchImpl });
  const point = toAePoint(
    "api.request",
    { count: 3, duration_ms: 42 },
    { service_name: "demos-api", service_version: "x", environment: "production", route_class: "api/versions", outcome: "2xx" },
  );
  await sink.writeDataPoint(point);

  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin, "http://localhost:8123");
  assert.match(url.searchParams.get("query"), /INSERT INTO runner_events FORMAT JSONEachRow/);

  const row = JSON.parse(calls[0].init.body.trim());
  assert.equal(typeof row.timestamp, "number");
  assert.ok(row.timestamp > 1_700_000_000_000, `timestamp looks like epoch ms: ${row.timestamp}`);
  assert.equal(row._sample_interval, 1);
  assert.equal(row.index1, "api.request");
  assert.equal(row.blob1, "demos-api");
  assert.equal(row.blob8, "2xx");
  assert.equal(row.blob10, "api/versions");
  assert.equal(row.double1, 3);
  assert.equal(row.double2, 42);
  // Every column T01's DDL declares is a plain blobN/doubleN key — no
  // friendly name (e.g. "outcome") ever appears as a JSON key.
  assert.equal(row.outcome, undefined);
  assert.equal(row.metric, undefined);
});
