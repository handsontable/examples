// Observability contract §7 — `fingerprint`, `stripCodeFrame`,
// `feedsNewFingerprintAlert`.
//
// Build prerequisite: `pnpm --filter @handsontable/demo-runtime build`.
// Run: node --experimental-strip-types --test pipeline/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  fingerprint,
  isValidFingerprint,
  stripCodeFrame,
  feedsNewFingerprintAlert,
} from "../packages/runtime/dist/telemetry/index.js";

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

// ---- fix round (finding N1, second wave): one shared validator, `:` allowed
// inside `context` -------------------------------------------------------
//
// Two independent, DIFFERENT regexes (this file's own `isValidFingerprint`
// and `normalise/otlp.ts`'s now-removed `API_FINGERPRINT_PATTERN`) both
// anchored on the FIRST `:` and rejected a second one anywhere in `context`
// — every real call site below sends a `:`-joined call-site path and was
// silently discarded by BOTH old patterns before this fix. Every literal
// context string here is grepped verbatim from the real call sites, not
// invented: `apps/authoring/src/App.tsx`'s `reportError(error,
// "docs-example-load:fetch" | "docs-example-load:path" |
// "docs-bucket-resolve:bucket" | "docs-bucket-resolve:fetch")`, and
// `workers/api/src/index.ts`'s `reportDiagnostic(..., { context:
// "npm-registry:version-exists" | "npm-registry:versions" })`.
const REAL_MULTI_SEGMENT_CONTEXTS = [
  "docs-example-load:fetch",
  "docs-example-load:path",
  "docs-bucket-resolve:bucket",
  "docs-bucket-resolve:fetch",
  "npm-registry:version-exists",
  "npm-registry:versions",
];

test("isValidFingerprint accepts every real multi-segment context call site, computed through the real fingerprint() function (never a hand-typed hex string)", () => {
  for (const ctx of REAL_MULTI_SEGMENT_CONTEXTS) {
    const fp = fingerprint(ctx, "upstream request failed");
    assert.ok(isValidFingerprint(fp), `${ctx} -> ${fp} must be valid`);
    // The context half must survive verbatim — this is what a forgotten
    // `:`-anchor-on-the-FIRST-colon bug would silently truncate.
    assert.ok(fp.startsWith(`${ctx}:`), `expected ${fp} to start with "${ctx}:"`);
  }
});

test("isValidFingerprint still accepts a single-segment context (the common case, unchanged)", () => {
  assert.ok(isValidFingerprint(fingerprint("authoring", "boom")));
  assert.ok(isValidFingerprint(fingerprint("sandpack.compile_error", "boom")), "a dotted metric-name context (metrics.ts)");
});

test("isValidFingerprint rejects a forged/injection-shaped value", () => {
  assert.equal(isValidFingerprint("<!channel> N <https://evil.example|open Grafana>"), false);
  assert.equal(isValidFingerprint("authoring:not-hex-at-all!!"), false);
  assert.equal(isValidFingerprint("AUTHORING:0123456789abcdef"), false, "uppercase context is not the contract's own charset");
  assert.equal(isValidFingerprint("authoring:0123456789ABCDEF"), false, "the hex half must be lowercase");
  assert.equal(isValidFingerprint(":0123456789abcdef"), false, "context must not be empty");
  assert.equal(isValidFingerprint("authoring:"), false, "hex half must not be empty");
});

test("isValidFingerprint rejects an over-long value, even one that otherwise matches the shape", () => {
  const overLong = `${"a".repeat(500)}:0123456789abcdef`;
  assert.equal(isValidFingerprint(overLong), false);
});
