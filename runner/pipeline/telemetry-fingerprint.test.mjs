// Observability contract §7 — `fingerprint`, `stripCodeFrame`,
// `feedsNewFingerprintAlert`.
//
// Build prerequisite: `pnpm --filter @handsontable/demo-runtime build`.
// Run: node --experimental-strip-types --test pipeline/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { fingerprint, stripCodeFrame, feedsNewFingerprintAlert } from "../packages/runtime/dist/telemetry/index.js";

// Captured verbatim from a real `@babel/standalone` `transform()` throw
// (`babel.transform("const x = ;", { presets: ["env"] })` and a two-line
// variant), not hand-typed — the exact shape `codeFrameColumns` renders.
const SINGLE_LINE_FRAME = "unknown: Unexpected token (1:10)\n\n> 1 | const x = ;\n    |           ^";
const MULTI_LINE_FRAME =
  "unknown: Unexpected token (2:12)\n\n  1 | function f() {\n> 2 |   return x +;\n    |             ^\n  3 | }\n  4 |";

test("stripCodeFrame removes a real Babel code frame, keeping the message", () => {
  assert.equal(stripCodeFrame(SINGLE_LINE_FRAME), "unknown: Unexpected token (1:10)");
  assert.equal(stripCodeFrame(MULTI_LINE_FRAME), "unknown: Unexpected token (2:12)");
});

test("stripCodeFrame is a no-op on text with no gutter or caret lines", () => {
  assert.equal(stripCodeFrame("TypeError: x is not a function"), "TypeError: x is not a function");
});

test("fingerprint pins FNV-1a 64 to the published test vectors, via messages normalizeMonitorMessage leaves untouched", () => {
  // normalizeMonitorMessage leaves a message with no url/timestamp/quote/digit
  // untouched, so these exercise the raw hash exactly.
  assert.equal(fingerprint("ctx", ""), "ctx:cbf29ce484222325");
  assert.equal(fingerprint("ctx", "a"), "ctx:af63dc4c8601ec8c");
  assert.equal(fingerprint("ctx", "foobar"), "ctx:85944171f73967e8");
});

test("fingerprint is deterministic for the same context and message", () => {
  assert.equal(fingerprint("demo-runtime", "boom"), fingerprint("demo-runtime", "boom"));
});

test("fingerprint collapses a demo-runtime keystroke ladder to one shape", () => {
  const rungs = ["t", "tr", "tru", "truthy"].map((id) =>
    fingerprint("demo-runtime", `${id} is not defined`),
  );
  const distinct = new Set(rungs);
  assert.equal(distinct.size, 1, `expected one fingerprint for the ladder, got ${distinct.size}: ${[...distinct]}`);
});

test("fingerprint does not collapse two genuinely different messages", () => {
  const a = fingerprint("demo-runtime", "Cannot read properties of undefined (reading 'x')");
  const b = fingerprint("demo-runtime", "Maximum call stack size exceeded");
  assert.notEqual(a, b);
});

test("fingerprint strips a code frame before hashing, so a frame-bearing and a frame-free message with the same text fingerprint the same", () => {
  const withFrame = fingerprint("api", `Unexpected token\n\n${SINGLE_LINE_FRAME.split("\n\n")[1]}`);
  const withoutFrame = fingerprint("api", "Unexpected token");
  assert.equal(withFrame, withoutFrame);
});

test("feedsNewFingerprintAlert excludes only demo-runtime", () => {
  assert.equal(feedsNewFingerprintAlert("demo-runtime"), false);
  for (const surface of ["authoring", "share", "embed", "d", "api", "o11y"]) {
    assert.equal(feedsNewFingerprintAlert(surface), true, surface);
  }
});
