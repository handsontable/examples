// `AeSink` (observability contract §4/§10) — `memorySink`, and
// `clickhouseSink`'s wire format against the real clickhouse-init.sql
// schema, cross-checked against a throwaway ClickHouse container (raw
// epoch-millisecond `timestamp`, not seconds or a string — see `sink.ts`'s
// doc comment). Credential headers and non-2xx rejection are asserted too,
// since a sink that only checks whether `fetch` threw resolves on a `403`.

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

test("clickhouseSink POSTs one JSONEachRow line with the runner_events table's exact column names", async () => {
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
  // Every column the DDL declares is a plain blobN/doubleN key — no
  // friendly name (e.g. "outcome") ever appears as a JSON key.
  assert.equal(row.outcome, undefined);
  assert.equal(row.metric, undefined);
});

test("clickhouseSink sends X-ClickHouse-User/-Key when credentials are given", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true };
  };
  const sink = clickhouseSink("http://localhost:8123", { fetchImpl, user: "default", password: "local-dev-token" });
  const point = toAePoint("chat.edit", { count: 1 }, { service_name: "demos-api", service_version: "x", environment: "production", outcome: "proposed" });
  await sink.writeDataPoint(point);

  assert.equal(calls[0].init.headers["X-ClickHouse-User"], "default");
  assert.equal(calls[0].init.headers["X-ClickHouse-Key"], "local-dev-token");
});

test("clickhouseSink sends no credential headers when none are given", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true };
  };
  const sink = clickhouseSink("http://localhost:8123", { fetchImpl });
  const point = toAePoint("chat.edit", { count: 1 }, { service_name: "demos-api", service_version: "x", environment: "production", outcome: "proposed" });
  await sink.writeDataPoint(point);

  assert.equal(calls[0].init.headers["X-ClickHouse-User"], undefined);
  assert.equal(calls[0].init.headers["X-ClickHouse-Key"], undefined);
});

test("clickhouseSink rejects on a non-2xx response instead of resolving silently (the real bug: an auth failure was swallowed)", async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, text: async () => "Code: 516. DB::Exception: Authentication failed" });
  const sink = clickhouseSink("http://localhost:8123", { fetchImpl });
  const point = toAePoint("chat.edit", { count: 1 }, { service_name: "demos-api", service_version: "x", environment: "production", outcome: "proposed" });
  await assert.rejects(() => sink.writeDataPoint(point), /clickhouseSink: insert failed, 403/);
});
