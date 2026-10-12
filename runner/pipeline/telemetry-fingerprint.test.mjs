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
  fingerprintShape,
  isExpectedTransientError,
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

// ---- one shared validator, `:` allowed inside `context` ---------------------
//
// A validator anchored on the first `:` and rejecting a second one
// anywhere in `context` would silently discard every real call site below,
// which sends a `:`-joined call-site path. Every literal context string
// here is grepped verbatim from the real call sites:
// `apps/authoring/src/App.tsx`'s `reportError(error,
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

// ---- one fault from two builds is one fingerprint ----------------------------
//
// The same Handsontable fault reported from two demo bundles. A message that
// carries stack frames (a framework wrapper, an old reporter) names the minified
// function and the hashed asset, which differ per build.

const DESTROYED =
  'Error: The "getSelectedRangeActive" method cannot be called because this Handsontable instance has been destroyed';

test("the same destroyed-instance error from two bundles hashes to one fingerprint", () => {
  const a =
    DESTROYED +
    "\n    at C (https://demos.handsontable.com/d/3r69e2t5d5/assets/index--HS2Dc1G.js:42:3482)" +
    "\n    at Zr (https://demos.handsontable.com/d/3r69e2t5d5/assets/index--HS2Dc1G.js:9:120)";
  const b =
    DESTROYED + "\n    at Qa (https://demos.handsontable.com/d/5d674q626s/assets/index-DL2fgPd5.js:7:99)";
  assert.equal(fingerprint("d", a), fingerprint("d", b));
  assert.equal(fingerprint("d", a), fingerprint("d", DESTROYED), "frames add nothing to the clean message's hash");
  // The clean message is the production hash of the first of the three reports.
  assert.equal(fingerprint("d", DESTROYED), "d:98ed8d1ab9973816");
});

test("a bare hashed asset name does not reach the hash", () => {
  const a = `${DESTROYED} in index-DL2fgPd5.js:42:3482`;
  const b = `${DESTROYED} in index--HS2Dc1G.js:7:99`;
  assert.equal(fingerprint("d", a), fingerprint("d", b));
  // Firefox/Safari frame shape.
  assert.equal(
    fingerprint("d", `${DESTROYED}\nrender@https://x.dev/d/a/assets/index-AAAAAAAA.js:1:2`),
    fingerprint("d", DESTROYED),
  );
});

test("stripping bundle identity keeps distinct faults distinct and fingerprintShape idempotent", () => {
  assert.notEqual(fingerprint("d", "TypeError: a is not a function"), fingerprint("d", "TypeError: b is null"));
  const withFrames = `${DESTROYED}\n    at C (https://x.dev/assets/index-DL2fgPd5.js:42:3482)`;
  const once = fingerprintShape(withFrames);
  assert.equal(fingerprintShape(once), once);
  assert.ok(!/index-|:\d+:\d+|\bat C\b/.test(once), once);
});

// ---- expected transient classes ---------------------------------------------

test("isExpectedTransientError matches stale-chunk and container-starting wordings only", () => {
  for (const text of [
    "ChunkLoadError: Failed to load chunk _next/static/chunks/0abc._.js from module 123",
    "ChunkLoadError: Loading chunk 42 failed.",
    "ChunkLoadError: anything at all, matched by name",
    "Error: Loading chunk vendors-node_modules_x failed.",
    "Error: Loading CSS chunk 7 failed.",
    "SandboxError: Container is starting. Please retry in a moment.",
  ]) {
    assert.equal(isExpectedTransientError(text), true, text);
  }
  for (const text of [
    "TypeError: x is not a function",
    "Error: The container is not running",
    "TypeError: Failed to fetch dynamically imported module: https://x.dev/a.js",
  ]) {
    assert.equal(isExpectedTransientError(text), false, text);
  }
});
