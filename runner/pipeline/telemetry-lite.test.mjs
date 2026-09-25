// Observability contract §9 — the lite beacon payload validator, including the
// T00-D5 total-size cap (2048 bytes, decisive over the per-field caps).
//
// Build prerequisite: `pnpm --filter @handsontable/demo-runtime build`.
// Run: node --experimental-strip-types --test pipeline/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  LITE_MESSAGE_MAX,
  LITE_PAYLOAD_MAX_BYTES,
  LITE_STACK_MAX,
  isValidLitePayload,
} from "../packages/runtime/dist/telemetry/index.js";

function errPayload(overrides = {}) {
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
    ts: Date.now(),
    ...overrides,
  };
}

test("accepts a well-formed error payload", () => {
  assert.equal(isValidLitePayload(errPayload()), true);
});

test("accepts a well-formed vital payload", () => {
  assert.equal(
    isValidLitePayload({
      v: 1,
      t: "vital",
      s: "d",
      demo: "r-react-18-0-0",
      ht: "18",
      fw: "react",
      n: "LCP",
      val: 2200,
      dev: "mobile",
      ts: Date.now(),
    }),
    true,
  );
});

test("rejects a non-object, null, and a wrong v", () => {
  assert.equal(isValidLitePayload(null), false);
  assert.equal(isValidLitePayload("nope"), false);
  assert.equal(isValidLitePayload(errPayload({ v: 2 })), false);
});

test("rejects an unknown surface", () => {
  assert.equal(isValidLitePayload(errPayload({ s: "authoring" })), false);
});

test("rejects a vital name that isn't one of the four", () => {
  const bad = errPayload({ t: "vital", n: "FID", val: 10 });
  assert.equal(isValidLitePayload(bad), false);
});

test("rejects err with a non-null val", () => {
  assert.equal(isValidLitePayload(errPayload({ val: 1 })), false);
});

test("rejects a message over LITE_MESSAGE_MAX", () => {
  assert.equal(isValidLitePayload(errPayload({ m: "x".repeat(LITE_MESSAGE_MAX + 1) })), false);
  assert.equal(isValidLitePayload(errPayload({ m: "x".repeat(LITE_MESSAGE_MAX) })), true);
});

test("rejects a stack over LITE_STACK_MAX", () => {
  assert.equal(isValidLitePayload(errPayload({ st: "x".repeat(LITE_STACK_MAX + 1) })), false);
  // A stack well under the field cap, in an otherwise small payload, is fine —
  // note a stack *at* LITE_STACK_MAX is not asserted valid here: at 2000 chars
  // it already exceeds LITE_PAYLOAD_MAX_BYTES on its own once the rest of the
  // payload's fields are counted (see the T00-D5 case below), which is exactly
  // the "field caps don't promise they fit together" the module documents.
  assert.equal(isValidLitePayload(errPayload({ st: "x".repeat(200) })), true);
});

test("T00-D5: rejects a payload whose individual fields all pass their own caps but whose total exceeds LITE_PAYLOAD_MAX_BYTES", () => {
  // m at its own cap (500) + st at its own cap (2000) is already ~2500+ bytes
  // of JSON — comfortably over the 2048-byte total.
  const maxed = errPayload({ m: "m".repeat(LITE_MESSAGE_MAX), st: "s".repeat(LITE_STACK_MAX) });
  assert.equal(isValidLitePayload(maxed), false, "each field cap alone must not be enough");
  assert.ok(new TextEncoder().encode(JSON.stringify(maxed)).length > LITE_PAYLOAD_MAX_BYTES);
});

test("a payload built to actually fit under the total cap passes", () => {
  const fits = errPayload({ m: "short message", st: "s".repeat(1500) });
  assert.ok(new TextEncoder().encode(JSON.stringify(fits)).length <= LITE_PAYLOAD_MAX_BYTES);
  assert.equal(isValidLitePayload(fits), true);
});
