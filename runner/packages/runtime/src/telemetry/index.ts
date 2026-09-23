// @handsontable/demo-runtime/telemetry — the observability contract
// (docs/observability-contract.md) as one importable module.
//
// Pure: no DOM, no Cloudflare imports (same rule as `monitor.ts`), so the
// authoring app, the API worker, the o11y worker and `pipeline/` tests all
// import the same definitions. `pipeline/telemetry-contract.test.mjs` parses
// the contract doc and fails when this barrel's exports disagree with it —
// edit the doc and the relevant file here together (README "Contract" rule).
//
// One file per concern, re-exported flat here:
//   attrs.ts       — §3 attribute keys, allowed values, Loki labels, `HotAttrs`.
//   metrics.ts      — §4 Analytics Engine layout, §5 metric registry, `toAePoint`.
//   fingerprint.ts  — §7 fingerprint, the Babel-code-frame stripper.
//   scrub.ts        — §3 / ADR §E.4 scrubber, browser and ingest alike.
//   classify.ts     — bot filter, device/browser/OS classifiers (moved from
//                     `workers/api/src/analytics.ts`, T00).
//   inbox.ts        — §8 OTLP `ResourceLogs` builders, NDJSON, inbox keys,
//                     `InboxWriter` storage-key shapes.
//   lite.ts         — §9 lite beacon payload type and validator.
//   sink.ts         — `AeSink`: the real Analytics Engine binding, the local
//                     ClickHouse shim, and an in-memory sink for tests.
//   facade.ts       — §6 browser `Telemetry` interface, `noopTelemetry`,
//                     `recordingTelemetry` (T06 implements the Faro-backed one).
//   convert.ts      — §6/§9 Faro item / beacon → OTLP log record.

export * from "./attrs.js";
export * from "./metrics.js";
export * from "./fingerprint.js";
export * from "./scrub.js";
export * from "./classify.js";
export * from "./inbox.js";
export * from "./lite.js";
export * from "./sink.js";
export * from "./facade.js";
export * from "./convert.js";
