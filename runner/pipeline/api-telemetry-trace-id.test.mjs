import test from "node:test";
import assert from "node:assert/strict";
import { traceIdOf } from "../workers/api/src/telemetry/trace-id.ts";

// `Span.spanContext()` (workerd v1.20261009.1+) returns an all-zero context for
// a span that is not traced, which at 1% sampling is most requests. Only a real
// id may reach the request line.

const REAL = "4bf92f3577b34da6a3ce929d0e0e4736";

test("traceIdOf: a real traced context yields its trace id", () => {
  assert.equal(traceIdOf({ traceId: REAL, spanId: "00f067aa0ba902b7", traceFlags: 1 }), REAL);
});

test("traceIdOf: the all-zero context of an untraced span yields nothing", () => {
  assert.equal(
    traceIdOf({ traceId: "00000000000000000000000000000000", spanId: "0000000000000000", traceFlags: 0 }),
    "",
  );
});

test("traceIdOf: a malformed or missing context yields nothing", () => {
  assert.equal(traceIdOf(undefined), "");
  assert.equal(traceIdOf(null), "");
  assert.equal(traceIdOf({}), "");
  assert.equal(traceIdOf({ traceId: "mutated" }), "");
  assert.equal(traceIdOf({ traceId: REAL.toUpperCase() }), "");
  assert.equal(traceIdOf({ traceId: 123 }), "");
});

// Build prerequisite: `pnpm --filter @handsontable/demo-runtime build`.
// The contract says `trace.id` stays in the line body: the o11y ingest only
// hoists allowlisted keys to structured metadata, so it must stay unlisted.
test("trace.id is not hoisted to structured metadata", async () => {
  const { hoistAttributes } = await import("../packages/runtime/dist/telemetry/index.js");
  const { attributes } = hoistAttributes({ "trace.id": REAL, "session.id": "s" });
  assert.equal(attributes["trace.id"], undefined);
  assert.equal(attributes["session.id"], "s");
});
