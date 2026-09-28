// Observability contract §9 — the lite beacon payload validator, including
// the total-size cap (2048 bytes, decisive over the per-field caps).
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
  // payload's fields are counted (see the case below), which is exactly
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

// The per-beacon `id` prevents byte-identical beacons thrown in the same
// millisecond from being deduped as one (`workers/o11y/src/lite.ts`'s
// `hashRecord` call). Absent entirely for an old/cached reporter — must
// stay accepted — and, when present, a
// `Math.random().toString(36).slice(2,10)` value: 0-16 lowercase base-36
// characters, with `""` a legitimate value (`Math.random()` landing on
// exactly 0), never a missing one.

test("F32: accepts a payload with no id at all (old, pre-F32 reporter)", () => {
  const noId = errPayload();
  assert.equal("id" in noId, false, "precondition: errPayload() carries no id field");
  assert.equal(isValidLitePayload(noId), true);
});

test("F32: accepts a well-formed id", () => {
  assert.equal(isValidLitePayload(errPayload({ id: "a1b2c3d4" })), true);
});

test("F32: accepts an empty-string id (Math.random() landing on exactly 0)", () => {
  assert.equal(isValidLitePayload(errPayload({ id: "" })), true);
});

test("F32: rejects a malformed id — uppercase, over 16 characters, or non-string", () => {
  assert.equal(isValidLitePayload(errPayload({ id: "ABCDEFGH" })), false, "uppercase must be rejected");
  assert.equal(isValidLitePayload(errPayload({ id: "a".repeat(16) })), true, "exactly 16 chars is still valid");
  assert.equal(isValidLitePayload(errPayload({ id: "a".repeat(17) })), false, "over 16 chars must be rejected");
  assert.equal(isValidLitePayload(errPayload({ id: 12345678 })), false, "a number must be rejected, not coerced");
  assert.equal(isValidLitePayload(errPayload({ id: null })), false, "null must be rejected, unlike undefined");
});
