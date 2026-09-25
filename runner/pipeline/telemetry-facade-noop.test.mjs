import test from "node:test";
import assert from "node:assert/strict";
import { noopTelemetry, recordingTelemetry } from "../packages/runtime/dist/telemetry/facade.js";

// T05 fix (cross-task, `packages/runtime/src/telemetry/facade.ts`, T00-owned):
// `noopTelemetry` used to mint its page-load id in a module-top-level IIFE —
// `const pageLoadId = mintPageLoadId()` running at import time, calling
// `crypto.randomUUID()` outside any handler. Harmless under plain Node (this
// file's own import proves that alone is not enough to catch it), but
// measured against a real `wrangler dev` running the API worker (T05's first
// real consumer of `@handsontable/demo-runtime/telemetry` in a Worker, not a
// throwaway typecheck probe): workerd refuses "asynchronous I/O ... and
// generating random values ... within global scope" and the whole Worker
// fails to boot. `pipeline/`'s Node harness cannot reproduce that failure
// mode at all (Node has no such restriction) — this only pins the *contract*
// noopTelemetry must keep (mint once, stay stable), not the boot crash
// itself; the crash and the fix are recorded in the T05 task Outcome.

test("noopTelemetry.pageLoadId() is stable across calls", () => {
  const a = noopTelemetry.pageLoadId();
  const b = noopTelemetry.pageLoadId();
  assert.equal(a, b);
  assert.ok(a.length > 0);
});

test("noopTelemetry.metric/event/error are no-ops that never throw", () => {
  assert.doesNotThrow(() => noopTelemetry.metric("api.request", { count: 1 }, {}));
  assert.doesNotThrow(() => noopTelemetry.event("example.open", {}));
  assert.doesNotThrow(() => noopTelemetry.error(new Error("x"), "ctx"));
});

test("recordingTelemetry still mints its own id eagerly (a test double, not the boot path)", () => {
  // Unlike noopTelemetry, recordingTelemetry's default id is minted at call
  // time (inside a function, called by a test), never at module import — no
  // fix needed here, and this pins that the two are not accidentally merged.
  const rec = recordingTelemetry();
  assert.equal(typeof rec.pageLoadId(), "string");
  assert.ok(rec.pageLoadId().length > 0);
});

test("recordingTelemetry records what it is given", () => {
  const rec = recordingTelemetry("fixed-id");
  rec.metric("api.request", { count: 1 }, { route_class: "api/versions", outcome: "2xx" });
  rec.event("example.open", { kind: "starter" });
  rec.error(new Error("boom"), "ctx", { surface: "api" });
  assert.equal(rec.pageLoadId(), "fixed-id");
  assert.deepEqual(rec.metrics, [
    { name: "api.request", values: { count: 1 }, attrs: { route_class: "api/versions", outcome: "2xx" } },
  ]);
  assert.equal(rec.events.length, 1);
  assert.equal(rec.errors.length, 1);
});
