// T07 fix round — the confirmed attribute drop, controller ruling.
//
// `bucket`, `reason` and `fingerprint` (three of `HotAttrs`' fields with no §3
// resource-attribute/structured-metadata slot) were silently stripped by the
// browser-side scrub allowlist before `/telemetry/collect` ever saw them —
// `attrs.ts#ALLOWED_ATTRIBUTE_KEYS` never listed the `hot.bucket`/`hot.reason`/
// `hot.fingerprint` keys `apps/authoring/src/telemetry/faro.ts#DOTTED_ATTR_KEY`
// now maps them to. Fix: `attrs.ts#AE_ONLY_ATTRIBUTE_KEYS` (T02-D4's AE-only
// channel, same non-hoisted treatment as `DIAGNOSTIC_TAG_KEYS` — never a
// resource attribute, never a Loki label, never hoisted into a stored
// record by `convert.ts#hoistAttributes`; only `toAePoint`, via
// `workers/o11y/src/normalise/browser-attrs.ts#readAeOnlyAttrs`, ever reads
// them).
//
// Two tests, both real functions, no mocks:
//
// 1. `scrubTelemetry` (`packages/runtime` — the SAME function Faro's
//    `beforeSend` runs in the browser AND the o11y worker re-runs at ingest,
//    T00-D6's order) is driven directly on a Faro-item-shaped object whose
//    context already carries the dotted `hot.bucket`/`hot.reason`/
//    `hot.fingerprint` keys `faro.ts#attrsToContext` now produces — proving
//    the browser/re-run scrub keeps them. `apps/authoring/src/telemetry/
//    faro.ts` itself cannot be imported under `node --test` (pulls in
//    `@grafana/faro-web-sdk` + `import.meta.env`, same constraint
//    `pipeline/faro-config.test.mjs`'s header documents), so this is the
//    real "facade → beforeSend/scrub" path as far as `node --test` can drive
//    it — everything upstream of `scrubTelemetry` (`attrsToContext`'s own
//    key remap) is a pure, already-reviewed one-line mapping this test's
//    literal `hot.*` context keys stand in for.
// 2. The scrubbed context is then fed through the real ingest conversion —
//    `readAeOnlyAttrs` (`workers/o11y`, T02-D4's channel) → `toAePoint` — and
//    the resulting `AePoint`'s §4 slots are asserted directly: `bucket` in
//    `blob16` (`preview.ready_ms`), `reason` in `blob9` (`version.switch`),
//    `fingerprint` in `blob11` (`sandpack.compile_error`).
//
// Both fail before the fix: reverting `attrs.ts#AE_ONLY_ATTRIBUTE_KEYS` (or
// the `ALLOWED_ATTRIBUTE_KEYS` spread that includes it) makes test 1's three
// `assert.equal` calls fail (the keys are gone after `scrubTelemetry`), which
// cascades into test 2 reading `undefined` from `readAeOnlyAttrs` and the AE
// point's blob16/blob9/blob11 landing at `""`, the unfilled-slot default —
// confirmed by revert (see the T07 task Outcome's fix-round section).
//
// Build prerequisite: `pnpm --filter @handsontable/demo-runtime build`.
// Run: node --experimental-strip-types --test pipeline/telemetry-ae-only-attrs.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { scrubTelemetry, toAePoint } from "../packages/runtime/dist/telemetry/index.js";

register("./fixtures/o11y-worker-hooks.mjs", import.meta.url);
const { readAeOnlyAttrs } = await import("../workers/o11y/src/normalise/browser-attrs.ts");

const SERVICE = { service_name: "demos-authoring", service_version: "abc123", environment: "production" };

/** A Faro measurement item, shaped the way `attrsToContext` + Faro's
 *  `pushMeasurement` produce one — `context` uses the dotted keys
 *  `DOTTED_ATTR_KEY` now maps `bucket`/`reason`/`fingerprint` to. */
function faroMeasurement(context) {
  return {
    type: "measurement",
    payload: { values: { duration_ms: 1 }, timestamp: new Date().toISOString(), context },
    meta: { app: { name: "demos-authoring", version: "abc123", environment: "production" } },
  };
}

test("scrubTelemetry keeps hot.bucket/hot.reason/hot.fingerprint (the browser/re-run scrub allowlist) — T07 fix round", () => {
  const item = faroMeasurement({
    "hot.surface": "authoring",
    "hot.bucket": "18.1",
    "hot.reason": "17",
    "hot.fingerprint": "sandpack.compile_error:deadbeefcafefeed",
  });

  const scrubbed = scrubTelemetry(item);

  assert.ok(scrubbed, "scrubTelemetry must not drop the whole item");
  assert.equal(scrubbed.payload.context?.["hot.surface"], "authoring", "sanity: an already-working key still survives");
  assert.equal(scrubbed.payload.context?.["hot.bucket"], "18.1", "guard: hot.bucket must survive the scrub allowlist");
  assert.equal(scrubbed.payload.context?.["hot.reason"], "17", "guard: hot.reason must survive the scrub allowlist");
  assert.equal(
    scrubbed.payload.context?.["hot.fingerprint"],
    "sandpack.compile_error:deadbeefcafefeed",
    "guard: hot.fingerprint must survive the scrub allowlist",
  );
});

test("bucket/reason/fingerprint reach their §4 AE slots (blob16/blob9/blob11) through the real ingest conversion — T07 fix round", () => {
  // Each built from the SAME scrubbed context a real Faro request would now
  // carry — `scrubTelemetry` runs first, exactly as `processOneItem`'s
  // T00-D6 order does server-side (and as Faro's `beforeSend` does in the
  // browser), so this exercises the real allowlist, not a hand-picked bag.
  const readyScrubbed = scrubTelemetry(
    faroMeasurement({
      "hot.surface": "authoring",
      "hot.tier": "1",
      "hot.framework": "react",
      "hot.ht_major": "18",
      "hot.outcome": "ready",
      "hot.bucket": "18.1",
    }),
  );
  const readyPoint = toAePoint(
    "preview.ready_ms",
    { duration_ms: 842 },
    { ...SERVICE, ...readAeOnlyAttrs(readyScrubbed.payload.context), surface: "authoring", tier: "1", framework: "react", ht_major: "18", outcome: "ready" },
  );
  assert.equal(readyPoint.blobs[15], "18.1", "guard: bucket must land in blob16 (index 15)");

  const switchScrubbed = scrubTelemetry(
    faroMeasurement({ "hot.framework": "react", "hot.ht_major": "18", "hot.reason": "17", "hot.bucket": "18.1" }),
  );
  const switchPoint = toAePoint(
    "version.switch",
    { count: 1 },
    { ...SERVICE, ...readAeOnlyAttrs(switchScrubbed.payload.context), framework: "react", ht_major: "18" },
  );
  assert.equal(switchPoint.blobs[8], "17", "guard: reason must land in blob9 (index 8)");

  const errorScrubbed = scrubTelemetry(
    faroMeasurement({
      "hot.framework": "vue",
      "hot.ht_major": "17",
      "hot.fingerprint": "sandpack.compile_error:deadbeefcafefeed",
    }),
  );
  const errorPoint = toAePoint(
    "sandpack.compile_error",
    {},
    { ...SERVICE, ...readAeOnlyAttrs(errorScrubbed.payload.context), framework: "vue", ht_major: "17" },
  );
  assert.equal(errorPoint.blobs[10], "sandpack.compile_error:deadbeefcafefeed", "guard: fingerprint must land in blob11 (index 10)");
});
