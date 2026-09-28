// `hot.bucket`/`hot.reason`/`hot.fingerprint` survive the browser scrub
// (`scrubTelemetry`, `attrs.ts#AE_ONLY_ATTRIBUTE_KEYS` — never hoisted into
// a stored record) and land in their AE slots through `readAeOnlyAttrs` →
// `toAePoint`: `bucket` in `blob16`, `reason` in `blob9`, `fingerprint` in
// `blob11` (contract §3 AE-only keys, §4 slots).
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
