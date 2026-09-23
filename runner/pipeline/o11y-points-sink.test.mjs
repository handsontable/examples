// T11 regression test — found live while running this task's own required
// local walkthrough (not by reading source): `normalise/points.ts#aeSink`'s
// local-mode branch hardcoded `http://localhost:8123` unconditionally,
// never reading `env.RUNNER_EVENTS_CLICKHOUSE_URL` — the same var
// `alerts/ae-query.ts#runAnalyticsEngineSqlApi` already reads (with the same
// fallback) for the QUERY side. A local ClickHouse on any port other than
// 8123 (every o11y task's own port block puts it elsewhere, e.g. T11's
// 5212) silently received zero browser-metric AE points, while alert
// queries against the configured URL read an empty table — a real,
// blocking-for-verification asymmetry, not a hypothetical. See T11's report
// for the live symptom (ClickHouse held only `api.request` points from the
// API worker, never a browser-origin point from the o11y worker, until this
// fix).
//
// Run: node --experimental-strip-types --test pipeline/o11y-points-sink.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./fixtures/o11y-worker-hooks.mjs", import.meta.url);

const { aeSink } = await import("../workers/o11y/src/normalise/points.ts");

const POINT = { indexes: ["t"], blobs: ["a"], doubles: [1] };

test("aeSink (local mode) writes to env.RUNNER_EVENTS_CLICKHOUSE_URL, not a hardcoded port", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    return new Response("", { status: 200 });
  };
  try {
    const env = {
      O11Y_ENV: "local",
      AE_SQL_TOKEN: "local-dev-token",
      RUNNER_EVENTS_CLICKHOUSE_URL: "http://localhost:5212",
    };
    await aeSink(env).writeDataPoint(POINT);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^http:\/\/localhost:5212\//, `expected the configured URL, got: ${calls[0]}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("aeSink (local mode) falls back to :8123 when RUNNER_EVENTS_CLICKHOUSE_URL is unset", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response("", { status: 200 });
  };
  try {
    const env = { O11Y_ENV: "local", AE_SQL_TOKEN: "local-dev-token" };
    await aeSink(env).writeDataPoint(POINT);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^http:\/\/localhost:8123\//);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
