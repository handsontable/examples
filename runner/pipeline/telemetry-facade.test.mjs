// Regression test for a T02-D fix outside T02's own "Owns" row
// (`packages/runtime/src/telemetry/facade.ts`, T00's file — see
// `runner/tasks/o11y/T02-o11y-ingest.md`'s Outcome for the full story):
// `noopTelemetry` used to mint its `pageLoadId` eagerly, inside a
// module-scope IIFE, calling `crypto.randomUUID()` before any request
// handler ran. Workers refuses "generating random values … within global
// scope" for exactly this shape — a real `wrangler dev` for `workers/o11y`
// (which imports this barrel transitively through
// `@handsontable/demo-runtime/telemetry`) failed to start with
// `Disallowed operation called within global scope`, discovered running
// this task's own required Verify step, not by reading the source.
//
// `node --test` does not enforce workerd's global-scope restriction, so this
// test proves the *lazy* contract directly instead: importing the module
// alone must not call `crypto.randomUUID`, only the first `pageLoadId()`
// call may. Reverted (the eager IIFE restored) this goes red on the first
// assertion — the import itself calls `randomUUID` before `pageLoadId()` is
// ever invoked.

import test from "node:test";
import assert from "node:assert/strict";

test("noopTelemetry.pageLoadId() mints lazily, not at module import time", async () => {
  let calls = 0;
  const realRandomUUID = crypto.randomUUID.bind(crypto);
  crypto.randomUUID = () => {
    calls++;
    return realRandomUUID();
  };
  try {
    const { noopTelemetry } = await import(
      `../packages/runtime/dist/telemetry/facade.js?bust=${Date.now()}-${Math.random()}`
    );
    assert.equal(calls, 0, "importing the module must not itself generate randomness");

    const id = noopTelemetry.pageLoadId();
    assert.equal(calls, 1, "the first call mints exactly one id");
    assert.equal(typeof id, "string");
    assert.ok(id.length > 0);

    const again = noopTelemetry.pageLoadId();
    assert.equal(again, id, "the id is stable across calls");
    assert.equal(calls, 1, "a second call must not mint again");
  } finally {
    crypto.randomUUID = realRandomUUID;
  }
});
