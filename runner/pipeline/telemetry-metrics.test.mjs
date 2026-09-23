// `toAePoint` (observability contract §4/§5) — the runtime behaviour
// `telemetry-contract.test.mjs` does not cover (that file checks the static
// registry data against the doc; this checks what building a point actually
// does with it): positional slot layout, and the validation that rejects an
// outcome/reason/value not listed for the metric.
//
// Build prerequisite: `pnpm --filter @handsontable/demo-runtime build`.
// Run: node --experimental-strip-types --test pipeline/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { AE_COLUMNS, toAePoint } from "../packages/runtime/dist/telemetry/index.js";

const SERVICE = { service_name: "demos-authoring", service_version: "abc123", environment: "production" };

test("toAePoint writes a fixed-width point (20 blobs, 20 doubles) regardless of how many are used", () => {
  const point = toAePoint("hmr.roundtrip_ms", { duration_ms: 42 }, { ...SERVICE, framework: "react", ht_major: "18" });
  assert.equal(point.blobs.length, 20);
  assert.equal(point.doubles.length, 20);
  assert.equal(point.indexes.length, 1);
  assert.equal(point.indexes[0], "hmr.roundtrip_ms");
});

test("toAePoint places each value at its AE_COLUMNS slot", () => {
  const point = toAePoint(
    "preview.ready_ms",
    { duration_ms: 1234 },
    { ...SERVICE, surface: "authoring", tier: "1", framework: "react", ht_major: "18", outcome: "ready", bucket: "18.1" },
  );
  const blobIndex = (col) => Number(AE_COLUMNS[col].replace("blob", "")) - 1;
  const doubleIndex = (col) => Number(AE_COLUMNS[col].replace("double", "")) - 1;

  assert.equal(point.blobs[blobIndex("service_name")], "demos-authoring");
  assert.equal(point.blobs[blobIndex("surface")], "authoring");
  assert.equal(point.blobs[blobIndex("outcome")], "ready");
  assert.equal(point.blobs[blobIndex("bucket")], "18.1");
  assert.equal(point.doubles[doubleIndex("duration_ms")], 1234);
  // Untouched slots stay at the documented defaults.
  assert.equal(point.blobs[blobIndex("reason")], "");
  assert.equal(point.doubles[doubleIndex("count")], 0);
});

test("toAePoint rejects an outcome not in the metric's allowed set", () => {
  assert.throws(
    () => toAePoint("sandpack.compile_ms", {}, { ...SERVICE, tier: "1", framework: "react", ht_major: "18", outcome: "bogus" }),
    /not an allowed "outcome"/,
  );
});

test("toAePoint rejects an outcome for a metric with no outcome slot", () => {
  assert.throws(
    () => toAePoint("hmr.roundtrip_ms", {}, { ...SERVICE, framework: "react", ht_major: "18", outcome: "ready" }),
    /has no "outcome" slot/,
  );
});

test("toAePoint accepts an open (unenumerated) reason, e.g. import.url's provider-shaped reason", () => {
  const point = toAePoint("import.url", { count: 1 }, { ...SERVICE, provider: "jsfiddle", outcome: "ok", reason: "anything goes here" });
  const blobIndex = (col) => Number(AE_COLUMNS[col].replace("blob", "")) - 1;
  assert.equal(point.blobs[blobIndex("reason")], "anything goes here");
});

test("toAePoint rejects an unknown metric name", () => {
  assert.throws(() => toAePoint("not.a.real.metric", {}, SERVICE), /unknown metric/);
});

test("toAePoint rejects a value outside a repo-wide closed set (surface), for a metric that actually declares surface", () => {
  assert.throws(
    () =>
      toAePoint(
        "preview.ready_ms",
        {},
        { ...SERVICE, surface: "not-a-real-surface", tier: "1", framework: "react", ht_major: "18", outcome: "ready" },
      ),
    /not an allowed "surface"/,
  );
});

test("toAePoint enforces preview.runtime_error's fixed surface value", () => {
  assert.throws(
    () =>
      toAePoint(
        "preview.runtime_error",
        { count: 1 },
        { ...SERVICE, surface: "authoring", tier: "1", framework: "react", ht_major: "18", reason: "uncaught" },
      ),
    /not an allowed "surface"/,
  );
  const point = toAePoint(
    "preview.runtime_error",
    { count: 1 },
    { ...SERVICE, surface: "demo-runtime", tier: "1", framework: "react", ht_major: "18", reason: "uncaught" },
  );
  const blobIndex = (col) => Number(AE_COLUMNS[col].replace("blob", "")) - 1;
  assert.equal(point.blobs[blobIndex("surface")], "demo-runtime");
});
