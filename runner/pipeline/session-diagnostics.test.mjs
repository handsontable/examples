// The Tier-2 session-start duration buckets (DEV-2559).
//
// Sentry DEMOS-9 has 83 events and two candidate causes that call for opposite fixes:
// a fixed ceiling somewhere above our Worker (a platform/timeout problem) or container
// starts that are honestly too slow (a boot problem). `session_elapsed_bucket` is the
// facet meant to tell them apart — one dominant bucket with empty neighbours reads as a
// ceiling, a spread across buckets reads as slow boots.
//
// That makes a boundary typo unusually expensive: it would not fail anything, it would
// quietly file a ceiling into two adjacent buckets and answer the question wrong. So
// every boundary is pinned from both sides.
//
// Imported straight from the .ts, the way `sentry-gating.test.mjs` imports
// `reportingGate.ts` — the root `test` script already runs node with
// `--experimental-strip-types`. That import is also the reason `sessionDiagnostics.ts`
// must stay dependency-free: strip-types cannot resolve the sibling `./x.js` specifiers
// the app's own modules use.

import test from "node:test";
import assert from "node:assert/strict";
import { elapsedBucket, responseOrigin } from "../apps/authoring/src/sessionDiagnostics.ts";

test("every boundary is pinned from both sides", () => {
  // A label means strictly "ms < N × 1000", so each pair below is the last value that
  // belongs to a bucket and the first value that does not.
  const pairs = [
    [0, "<1s"],
    [999, "<1s"],
    [1000, "<5s"],
    [4999, "<5s"],
    [5000, "<15s"],
    [14_999, "<15s"],
    [15_000, "<30s"],
    [29_999, "<30s"],
    [30_000, "<60s"],
    [59_999, "<60s"],
    [60_000, "<100s"],
    [99_999, "<100s"],
    [100_000, "<120s"],
    [119_999, "<120s"],
    [120_000, ">=120s"],
  ];
  for (const [ms, label] of pairs) {
    assert.equal(elapsedBucket(ms), label, `${ms}ms belongs in ${label}`);
  }
});

test("anything past the last boundary lands in the overflow bucket, not off the end", () => {
  // The loop falls through rather than indexing, so a duration beyond every boundary
  // has to produce a label rather than `undefined` — an undefined tag value is dropped
  // by Sentry, which would silently exclude the slowest failures from the very facet
  // built to find them.
  assert.equal(elapsedBucket(120_001), ">=120s");
  assert.equal(elapsedBucket(600_000), ">=120s");
  assert.equal(elapsedBucket(Number.MAX_SAFE_INTEGER), ">=120s");
});

test("the label is always a usable tag value", () => {
  // Sentry tag values must be non-empty strings; a bucket that stringified to "" or
  // "undefined" would facet into nothing.
  for (const ms of [0, 1, 999, 1000, 42_000, 100_000, 120_000, 1_000_000]) {
    const label = elapsedBucket(ms);
    assert.equal(typeof label, "string");
    assert.ok(label.length > 0, `${ms}ms produced an empty tag value`);
    assert.doesNotMatch(label, /undefined|NaN/);
  }
});

// `responseOrigin` — the DEMOS-9 facet answering "where did this response come from".
// `import { responseOrigin }` above does not exist on e614db5b, so this whole file
// fails to load before any assertion below runs — that is this test's own discriminator.
test("every provenance branch has a distinct label", () => {
  const cases = [
    ["cloudflare", { ray: "a2cee5e30f0c08c1-PRG", headersReadable: true, headerNames: ["cf-ray"] }],
    ["cloudflare", { ray: "a2cee5e30f0c08c1-PRG", headersReadable: false, headerNames: [] }],
    ["unreadable", { ray: null, headersReadable: false, headerNames: [] }],
    ["headerless", { ray: null, headersReadable: true, headerNames: [] }],
    ["foreign", { ray: null, headersReadable: true, headerNames: ["content-type"] }],
  ];
  for (const [expected, input] of cases) {
    assert.equal(responseOrigin(input), expected, JSON.stringify(input));
  }

  const [cloudflare, , unreadable, headerless, foreign] = cases.map(([, input]) => responseOrigin(input));
  const labels = [cloudflare, unreadable, headerless, foreign];
  for (let i = 0; i < labels.length; i += 1) {
    for (let j = i + 1; j < labels.length; j += 1) {
      assert.notEqual(labels[i], labels[j], `${labels[i]} vs ${labels[j]} must be distinct`);
    }
  }

  // The file's existing "always a usable tag value" discipline, repeated: an
  // undefined tag value is silently dropped by Sentry, which would delete the
  // very facet this exists to create.
  for (const [, input] of cases) {
    const label = responseOrigin(input);
    assert.equal(typeof label, "string");
    assert.ok(label.length > 0);
    assert.doesNotMatch(label, /undefined|NaN/);
  }
});
