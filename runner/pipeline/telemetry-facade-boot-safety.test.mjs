import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

// T05 fix round (controller review): `pipeline/telemetry-facade-noop.test.mjs`
// pins `noopTelemetry.pageLoadId()`'s *contract* (stable across calls) but,
// by its own doc comment, cannot reproduce or guard the actual boot crash —
// Node has no "no I/O in module scope" restriction the way workerd does, so a
// test that only calls `pageLoadId()` after import passes identically whether
// the mint is eager (module top level) or lazy (inside the function). This
// file closes that gap the way the controller asked: stub
// `globalThis.crypto.randomUUID` BEFORE importing the module, and assert the
// import itself never calls it — the one thing that actually distinguishes
// "eager IIFE" from "lazy accessor".
//
// A fresh module evaluation is required for the "import alone" assertion to
// mean anything (a cached module from an earlier import would already have
// run its top-level code before this file's stub was installed) — cache-
// busted via a query string on the specifier, the same technique this repo
// already uses elsewhere for a rotated chunk URL (DEV-2569).

const facadeUrl = pathToFileURL(
  join(import.meta.dirname, "..", "packages/runtime/dist/telemetry/facade.js"),
).href;

function stubRandomUUID() {
  const original = globalThis.crypto.randomUUID;
  let calls = 0;
  globalThis.crypto.randomUUID = (...args) => {
    calls += 1;
    return original.apply(globalThis.crypto, args);
  };
  return {
    count: () => calls,
    restore: () => { globalThis.crypto.randomUUID = original; },
  };
}

test("importing facade.js alone never calls crypto.randomUUID (the eager-IIFE regression)", async () => {
  const stub = stubRandomUUID();
  try {
    // Cache-busted: a fresh module instance, so its top-level code (if any)
    // runs AFTER the stub above is installed, not before.
    const mod = await import(`${facadeUrl}?bust=${Date.now()}-${Math.random()}`);
    assert.equal(stub.count(), 0, "importing the module must not itself mint a page-load id");
    // The lazy accessor still has to work, and only now: first call mints
    // (count -> 1), every later call reuses the same id (count stays 1).
    const first = mod.noopTelemetry.pageLoadId();
    assert.equal(stub.count(), 1, "the first pageLoadId() call mints exactly once");
    const second = mod.noopTelemetry.pageLoadId();
    assert.equal(stub.count(), 1, "a second call must not mint again");
    assert.equal(first, second);
  } finally {
    stub.restore();
  }
});
