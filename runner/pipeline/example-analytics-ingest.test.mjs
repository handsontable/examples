// ADR-0042 — proves the FULL round trip for `example.*`, not just the
// server-side half T02's own `o11y-normalise.test.mjs` "Faro example.open"
// case covers.
//
// That existing case feeds `processFaroBody` a fixture whose Faro item
// already carries the raw `hot.metric_kind`/`hot.ref`/`hot.area` keys —
// it never proves the browser actually SENDS them. The browser's own
// `beforeSend` hook runs the same `scrubTelemetry` allowlist
// (`attrs.ts#ALLOWED_ATTRIBUTE_KEYS`) BEFORE the request ever leaves the
// tab, and before this task that allowlist had no entry for
// `hot.metric_kind`/`hot.ref`/`hot.area` at all (T02-D4's own doc comment:
// "T06/T09 must use these exact key names... nothing else pins this
// convention today" — T12 is that pin). A browser build sending the plain
// `HotAttrs` bag would have had every one of `kind`/`ref`/`area` silently
// stripped client-side, long before `processFaroBody`'s own internal
// (re-run) scrub or `readAeOnlyAttrs`'s pre-scrub read ever got a chance —
// `o11y-normalise.test.mjs`'s fixture-only test cannot see that, because it
// starts downstream of the browser.
//
// This file: (1) runs the exact item shape `apps/authoring/src/telemetry/
// faro.ts#attrsToContext` + Faro's own `pushEvent` would produce through
// `scrubTelemetry` — simulating the browser's `beforeSend` — and asserts the
// three ADR-0042 keys survive; (2) feeds the resulting wire body through the
// real o11y ingest path and asserts zero inbox items and exactly one
// Analytics Engine point with blob17/18/19 filled. The inbox is Loki's only
// feed (§8), so "never reaches the inbox" is the same claim as "never
// reaches Loki."
//
// Run: node --experimental-strip-types --test pipeline/example-analytics-ingest.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./fixtures/o11y-worker-hooks.mjs", import.meta.url);

const { processFaroBody } = await import("../workers/o11y/src/normalise/faro.ts");
const { scrubTelemetry, AE_COLUMNS } = await import("../packages/runtime/dist/telemetry/index.js");

const ENV = { O11Y_ENV: "production" };
const SERVICE = { name: "demos-authoring", version: "deadbeef1234", environment: "production" };

/** Mirrors `apps/authoring/src/telemetry/faro.ts#attrsToContext`'s mapping
 *  for the fields this test exercises — a `HotAttrs`-shaped call becomes
 *  this raw wire `context`, dotted-key-remapped, before `beforeSend` runs.
 *  If that module's `DOTTED_ATTR_KEY` table changes, this literal has to
 *  change with it (faro.ts itself cannot be imported under
 *  `--experimental-strip-types`: it pulls in `@grafana/faro-web-sdk`, a real
 *  browser package this harness does not resolve — the same constraint
 *  `sentry.ts`/`demoEventReport.ts` document for their own files). */
function rawExampleOpenItem() {
  return {
    type: "event",
    payload: {
      name: "example.open",
      attributes: {
        "hot.metric_kind": "docs",
        "hot.ref": "guides/accessibility/accessibility/accessibility.md",
        "hot.area": "Accessibility",
        "hot.framework": "reactts",
        "hot.ht_major": "18",
        "hot.bucket": "18.1",
        "hot.reason": "entry",
      },
    },
    meta: { app: { name: "demos-authoring", version: "deadbeef1234" } },
  };
}

test("browser scrub (beforeSend) keeps hot.metric_kind/hot.ref/hot.area — this task's own ALLOWED_ATTRIBUTE_KEYS addition", () => {
  const scrubbed = scrubTelemetry(rawExampleOpenItem());
  assert.ok(scrubbed, "the item must survive scrubbing at all (not a console-dropped kind)");
  const attrs = scrubbed.payload.attributes;
  assert.equal(attrs["hot.metric_kind"], "docs");
  assert.equal(attrs["hot.ref"], "guides/accessibility/accessibility/accessibility.md");
  assert.equal(attrs["hot.area"], "Accessibility");
  // Not asserted here: `hot.bucket`/`hot.reason` survival is the T07 fix
  // round's own `ATTR_HOT_BUCKET`/`ATTR_HOT_REASON` addition to this same
  // AE-only category (`attrs.ts#AE_ONLY_ATTRIBUTE_KEYS`), not yet merged
  // into this task's base at the time this file was written (COMMON.md: T07
  // merges before T12; this worktree may still predate that merge) — T07
  // owns proving those two, this file owns `kind`/`ref`/`area`.
  //
  // Sanity: an attribute genuinely outside every allowlist category is still
  // dropped — this test is not accidentally passing because the allowlist
  // has become a no-op.
  const withForbidden = rawExampleOpenItem();
  withForbidden.payload.attributes["url.full"] = "https://example.com/secret?token=abc";
  const scrubbedForbidden = scrubTelemetry(withForbidden);
  assert.equal(scrubbedForbidden.payload.attributes["url.full"], undefined);
});

test("example.open: end to end from a scrubbed browser payload to one AE point, zero inbox items", async () => {
  const scrubbed = scrubTelemetry(rawExampleOpenItem());
  // The real Faro transport body shape (T02-D6): one shared `meta` plus
  // separate typed arrays, `events` here.
  const wireBody = { meta: scrubbed.meta, events: [{ name: scrubbed.payload.name, attributes: scrubbed.payload.attributes }] };

  const [item] = await processFaroBody(wireBody, ENV, SERVICE, Date.now());

  // A-I4 remainder (rereview.md, closed second wave): an example.* event
  // now gets a hash-only ingestItem (no `record`) so a redelivered batch
  // can't double-count this AE point — but it must still never reach the
  // inbox/Loki (§6 unchanged): `record` stays absent.
  assert.ok(item.ingestItem, "example.* still needs a hash to dedupe on (A-I4 remainder)");
  assert.equal(item.ingestItem.record, undefined, "example.* is never stored (§6) — never reaches the inbox, so never Loki");
  assert.equal(item.invalid, undefined);
  assert.equal(item.aePoints.length, 1);
  const point = item.aePoints[0];
  assert.equal(point.indexes[0], "example.open");

  const blobAt = (column) => {
    const slot = AE_COLUMNS[column];
    const n = Number(/^blob(\d+)$/.exec(slot)[1]);
    return point.blobs[n - 1];
  };
  assert.equal(blobAt("kind"), "docs", "blob17");
  assert.equal(blobAt("ref"), "guides/accessibility/accessibility/accessibility.md", "blob18");
  assert.equal(blobAt("area"), "Accessibility", "blob19");
  assert.equal(blobAt("framework"), "reactts");
  assert.equal(blobAt("ht_major"), "18");
  // `bucket` (blob16) / `reason` (blob9) are T07's own AE-only keys — see the
  // comment on the scrub test above for why they are not asserted here.
});

test("example.engaged: same taxonomy channel, no reason blob", async () => {
  const item = {
    type: "event",
    payload: {
      name: "example.engaged",
      attributes: {
        "hot.metric_kind": "starter",
        "hot.ref": "react",
        "hot.framework": "react",
        "hot.ht_major": "18",
        "hot.bucket": "18.1",
      },
    },
    meta: { app: { name: "demos-authoring", version: "deadbeef1234" } },
  };
  const scrubbed = scrubTelemetry(item);
  const wireBody = { meta: scrubbed.meta, events: [{ name: scrubbed.payload.name, attributes: scrubbed.payload.attributes }] };
  const [result] = await processFaroBody(wireBody, ENV, SERVICE, Date.now());
  // A-I4 remainder: hash-only ingestItem, still never stored — see the
  // "example.open" test above for the full reasoning.
  assert.ok(result.ingestItem);
  assert.equal(result.ingestItem.record, undefined);
  assert.equal(result.aePoints.length, 1);
  assert.equal(result.aePoints[0].indexes[0], "example.engaged");
});
