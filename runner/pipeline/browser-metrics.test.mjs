// Observability contract §5 browser metric catalogue (ADR-0041 §F.2, docs/observability-contract.md).
//
// Drives `apps/authoring/src/telemetry/metrics.ts` against a FAKE `DemoRuntime`
// (onReady/onError only — `trackPreviewReady` needs nothing more) and a
// `recordingTelemetry()` from the contract module. Every recorded call is also
// replayed through the REAL `toAePoint` (not just asserted against the recording),
// because `recordingTelemetry` validates nothing on its own — a misspelled outcome
// or an attribute outside its metric's closed set would otherwise pass silently.
//
// `packages/runtime/src/sandpack.ts` and `container.ts`'s own timing hooks are
// exercised separately, against the REAL runtimes, in `sandpack-reload.test.mjs`
// and `session-start-failure.test.mjs` — this file cannot catch a hook wired wrong
// inside either engine, only whether `metrics.ts`'s own emission logic is correct
// once a hook fires.
//
// Build prerequisite: `pnpm --filter @handsontable/demo-runtime build`.
// Run: node --experimental-strip-types --test pipeline/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { recordingTelemetry, toAePoint } from "../packages/runtime/dist/telemetry/index.js";
import {
  emitBucketResolve,
  emitVersionSwitch,
  htMajorOf,
  startClock,
  trackPreviewReady,
  wireRuntimeMetrics,
} from "../apps/authoring/src/telemetry/metrics.ts";

const SERVICE = { service_name: "demos-authoring", service_version: "abc123", environment: "production" };

/** Replay every recorded `.metric()` call through the real `toAePoint` — the
 *  producer-contract check `recordingTelemetry` itself does not perform. Throws
 *  (failing the test) on a misspelled outcome, an attribute outside its metric's
 *  closed set, or an attribute with no AE slot. */
function assertValidAgainstRegistry(telemetry) {
  for (const { name, values, attrs } of telemetry.metrics) {
    toAePoint(name, values, { ...SERVICE, ...attrs });
  }
}

/** A minimal `DemoRuntime` stand-in: only `onReady`/`onError`, which is all
 *  `trackPreviewReady` reads. Exposes `fireReady`/`fireError` for the test to
 *  drive it, matching the real runtimes' "replay ready to a late subscriber"
 *  behaviour is NOT modelled here on purpose — `trackPreviewReady` subscribes
 *  once, synchronously, before either engine could have already settled. */
function fakeRuntime() {
  const readyCbs = [];
  const errorCbs = [];
  return {
    onReady(cb) {
      readyCbs.push(cb);
    },
    onError(cb) {
      errorCbs.push(cb);
    },
    fireReady() {
      for (const cb of readyCbs) cb();
    },
    fireError(e) {
      for (const cb of errorCbs) cb(e);
    },
  };
}

const CTX = { surface: "authoring", tier: 1, framework: "react", versionRef: "18.1.0", bucket: "18.1" };

test("preview.ready_ms: one point on ready, with the right attributes", () => {
  const telemetry = recordingTelemetry();
  const runtime = fakeRuntime();
  trackPreviewReady(runtime, CTX, telemetry, { timeoutMs: 50_000 });

  runtime.fireReady();

  assert.equal(telemetry.metrics.length, 1);
  const [call] = telemetry.metrics;
  assert.equal(call.name, "preview.ready_ms");
  assert.equal(call.attrs.outcome, "ready");
  assert.equal(call.attrs.surface, "authoring");
  assert.equal(call.attrs.tier, "1");
  assert.equal(call.attrs.framework, "react");
  assert.equal(call.attrs.ht_major, "18");
  assert.equal(call.attrs.bucket, "18.1");
  assert.ok(typeof call.values.duration_ms === "number" && call.values.duration_ms >= 0);
  assertValidAgainstRegistry(telemetry);
});

test("preview.ready_ms: a second onReady (a later recompile) does not re-emit", () => {
  const telemetry = recordingTelemetry();
  const runtime = fakeRuntime();
  trackPreviewReady(runtime, CTX, telemetry, { timeoutMs: 50_000 });

  runtime.fireReady();
  runtime.fireReady();
  runtime.fireReady();

  assert.equal(telemetry.metrics.length, 1, "guard: settled must latch after the first ready");
});

test("preview.ready_ms: abandon() before ready emits outcome abandoned", () => {
  const telemetry = recordingTelemetry();
  const runtime = fakeRuntime();
  const tracker = trackPreviewReady(runtime, CTX, telemetry, { timeoutMs: 50_000 });

  tracker.abandon();

  assert.equal(telemetry.metrics.length, 1);
  assert.equal(telemetry.metrics[0].attrs.outcome, "abandoned");
  assertValidAgainstRegistry(telemetry);
});

test("preview.ready_ms: abandon() after ready is a no-op (no second point, no outcome flip)", () => {
  const telemetry = recordingTelemetry();
  const runtime = fakeRuntime();
  const tracker = trackPreviewReady(runtime, CTX, telemetry, { timeoutMs: 50_000 });

  runtime.fireReady();
  tracker.abandon();

  assert.equal(telemetry.metrics.length, 1, "guard: abandon() must not fire once ready already settled");
  assert.equal(telemetry.metrics[0].attrs.outcome, "ready");
});

test("preview.ready_ms: a mount() rejection observed via observe() reports outcome error, not abandoned", async () => {
  // The case that motivates observe() at all (DEV-2130 / ContainerRuntime's
  // dispose()-before-rethrow): a rejection that never reaches onError.
  const telemetry = recordingTelemetry();
  const runtime = fakeRuntime();
  const tracker = trackPreviewReady(runtime, CTX, telemetry, { timeoutMs: 50_000 });

  const mountPromise = Promise.reject(new Error("Setup failed"));
  tracker.observe(mountPromise);
  await mountPromise.catch(() => {});
  // Let the .catch() microtask inside trackPreviewReady settle too.
  await Promise.resolve();

  assert.equal(telemetry.metrics.length, 1);
  assert.equal(telemetry.metrics[0].attrs.outcome, "error");

  // A cleanup that runs after the rejection (the effect unmounting, or a version
  // switch) must not turn this into "abandoned" — the guard is what this proves.
  tracker.abandon();
  assert.equal(telemetry.metrics.length, 1, "guard: observe()'s error must latch before abandon() can fire");
  assertValidAgainstRegistry(telemetry);
});

test("preview.ready_ms: onError reports outcome error", () => {
  const telemetry = recordingTelemetry();
  const runtime = fakeRuntime();
  trackPreviewReady(runtime, CTX, telemetry, { timeoutMs: 50_000 });

  runtime.fireError(new Error("boom"));

  assert.equal(telemetry.metrics.length, 1);
  assert.equal(telemetry.metrics[0].attrs.outcome, "error");
});

test("preview.ready_ms: a timeout reports outcome timeout, and a later ready is ignored", async () => {
  const telemetry = recordingTelemetry();
  const runtime = fakeRuntime();
  trackPreviewReady(runtime, CTX, telemetry, { timeoutMs: 5 });

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(telemetry.metrics.length, 1);
  assert.equal(telemetry.metrics[0].attrs.outcome, "timeout");

  runtime.fireReady();
  assert.equal(telemetry.metrics.length, 1, "guard: a ready arriving after the timeout must not re-emit");
});

test("preview.ready_ms: a version with no ref attached reads ht_major as none", () => {
  const telemetry = recordingTelemetry();
  const runtime = fakeRuntime();
  trackPreviewReady(runtime, { ...CTX, versionRef: "" }, telemetry, { timeoutMs: 50_000 });

  runtime.fireReady();

  assert.equal(telemetry.metrics[0].attrs.ht_major, "none");
});

// ---- htMajorOf --------------------------------------------------------------------

test("htMajorOf reads a release version's major, a next prerelease as next, and a pkg.pr.new ref as next (T07-D1)", () => {
  assert.equal(htMajorOf("18.1.0"), "18");
  assert.equal(htMajorOf("19.0.0-next.1"), "next");
  assert.equal(htMajorOf("0.0.0-next-abc123-20260101"), "next");
  assert.equal(htMajorOf("https://pkg.pr.new/handsontable/handsontable@7940"), "next");
  assert.equal(htMajorOf(null), "none");
  assert.equal(htMajorOf(undefined), "none");
});

// ---- sandpack.compile_ms / compile_error / bundler_unreachable --------------------

function fakeSandpackRuntime() {
  const compileTimingCbs = [];
  const compileErrorCbs = [];
  const bundlerUnreachableCbs = [];
  return {
    onCompileTiming(cb) {
      compileTimingCbs.push(cb);
    },
    onCompileError(cb) {
      compileErrorCbs.push(cb);
    },
    onBundlerUnreachable(cb) {
      bundlerUnreachableCbs.push(cb);
    },
    fireCompileTiming(e) {
      for (const cb of compileTimingCbs) cb(e);
    },
    fireCompileError(e) {
      for (const cb of compileErrorCbs) cb(e);
    },
    fireBundlerUnreachable(e) {
      for (const cb of bundlerUnreachableCbs) cb(e);
    },
  };
}

const SANDPACK_CTX = { framework: "vue", versionRef: "17.1.0" };

test("sandpack.compile_ms: reports the hook's own duration and outcome, tier fixed to 1", () => {
  const telemetry = recordingTelemetry();
  const runtime = fakeSandpackRuntime();
  wireRuntimeMetrics(runtime, SANDPACK_CTX, telemetry);

  runtime.fireCompileTiming({ durationMs: 123, outcome: "ok" });

  assert.equal(telemetry.metrics.length, 1);
  const [call] = telemetry.metrics;
  assert.equal(call.name, "sandpack.compile_ms");
  assert.equal(call.values.duration_ms, 123);
  assert.equal(call.attrs.tier, "1");
  assert.equal(call.attrs.outcome, "ok");
  assert.equal(call.attrs.ht_major, "17");
  assertValidAgainstRegistry(telemetry);
});

test("sandpack.compile_error: fingerprinted, no authored text in the recorded attrs", () => {
  const telemetry = recordingTelemetry();
  const runtime = fakeSandpackRuntime();
  wireRuntimeMetrics(runtime, SANDPACK_CTX, telemetry);

  const message = "SyntaxError: Unexpected token (2:7) in /src/App.vue";
  runtime.fireCompileError({ message });

  assert.equal(telemetry.metrics.length, 1);
  const [call] = telemetry.metrics;
  assert.equal(call.name, "sandpack.compile_error");
  assert.match(call.attrs.fingerprint, /^sandpack\.compile_error:[0-9a-f]{16}$/);
  // `HotAttrs` has no free-text field, so the message itself cannot travel even by
  // accident — asserted anyway, against every attr value, as the guard for it.
  for (const value of Object.values(call.attrs)) {
    assert.ok(!String(value).includes("Unexpected token"), "no authored code in the recorded attrs");
  }
  assertValidAgainstRegistry(telemetry);
});

test("sandpack.compile_error: the same fingerprint (a keystroke ladder) reports once, not once per keystroke", () => {
  const telemetry = recordingTelemetry();
  const runtime = fakeSandpackRuntime();
  wireRuntimeMetrics(runtime, SANDPACK_CTX, telemetry);

  runtime.fireCompileError({ message: "'t' is not defined" });
  runtime.fireCompileError({ message: "'tr' is not defined" });
  runtime.fireCompileError({ message: "'tru' is not defined" });

  assert.equal(
    telemetry.metrics.length,
    1,
    "guard: the demo-runtime ladder collapse must dedupe these to one fingerprint",
  );
});

test("sandpack.compile_error: a genuinely different message gets its own point", () => {
  const telemetry = recordingTelemetry();
  const runtime = fakeSandpackRuntime();
  wireRuntimeMetrics(runtime, SANDPACK_CTX, telemetry);

  runtime.fireCompileError({ message: "'t' is not defined" });
  runtime.fireCompileError({ message: "Unexpected token }" });

  assert.equal(telemetry.metrics.length, 2);
  assert.notEqual(telemetry.metrics[0].attrs.fingerprint, telemetry.metrics[1].attrs.fingerprint);
});

test("sandpack.bundler_unreachable: reports duration, ht_major only", () => {
  const telemetry = recordingTelemetry();
  const runtime = fakeSandpackRuntime();
  wireRuntimeMetrics(runtime, SANDPACK_CTX, telemetry);

  runtime.fireBundlerUnreachable({ durationMs: 9001 });

  assert.equal(telemetry.metrics.length, 1);
  const [call] = telemetry.metrics;
  assert.equal(call.name, "sandpack.bundler_unreachable");
  assert.equal(call.values.duration_ms, 9001);
  assert.equal(call.attrs.ht_major, "17");
  assertValidAgainstRegistry(telemetry);
});

// ---- session.start_ms / hmr.roundtrip_ms -----------------------------------------

function fakeContainerRuntime() {
  const sessionStartCbs = [];
  const hmrCbs = [];
  return {
    onSessionStart(cb) {
      sessionStartCbs.push(cb);
    },
    onHmr(cb) {
      hmrCbs.push(cb);
    },
    fireSessionStart(e) {
      for (const cb of sessionStartCbs) cb(e);
    },
    fireHmr(e) {
      for (const cb of hmrCbs) cb(e);
    },
  };
}

const CONTAINER_CTX = { framework: "next", versionRef: "18.2.0" };

test("session.start_ms: reports elapsed/outcome, and never sets reason (T07-D2 — no cold/warm signal exists)", () => {
  const telemetry = recordingTelemetry();
  const runtime = fakeContainerRuntime();
  wireRuntimeMetrics(runtime, CONTAINER_CTX, telemetry);

  runtime.fireSessionStart({ elapsedMs: 4200, outcome: "ready" });

  assert.equal(telemetry.metrics.length, 1);
  const [call] = telemetry.metrics;
  assert.equal(call.name, "session.start_ms");
  assert.equal(call.values.duration_ms, 4200);
  assert.equal(call.attrs.outcome, "ready");
  assert.equal(call.attrs.reason, undefined, "guard: reason must stay unset, not a guessed cold/warm");
  assertValidAgainstRegistry(telemetry);
});

test("session.start_ms: every session.start outcome value round-trips through toAePoint", () => {
  const telemetry = recordingTelemetry();
  const runtime = fakeContainerRuntime();
  wireRuntimeMetrics(runtime, CONTAINER_CTX, telemetry);

  for (const outcome of ["ready", "at_capacity", "container_starting", "boot_timeout", "budget_denied", "error"]) {
    runtime.fireSessionStart({ elapsedMs: 1, outcome });
  }

  assert.equal(telemetry.metrics.length, 6);
  assertValidAgainstRegistry(telemetry);
});

test("hmr.roundtrip_ms: reports the hook's own duration", () => {
  const telemetry = recordingTelemetry();
  const runtime = fakeContainerRuntime();
  wireRuntimeMetrics(runtime, CONTAINER_CTX, telemetry);

  runtime.fireHmr({ durationMs: 87 });

  assert.equal(telemetry.metrics.length, 1);
  const [call] = telemetry.metrics;
  assert.equal(call.name, "hmr.roundtrip_ms");
  assert.equal(call.values.duration_ms, 87);
  assert.equal(call.attrs.framework, "next");
  assert.equal(call.attrs.ht_major, "18");
  assertValidAgainstRegistry(telemetry);
});

// ---- version.switch / bucket.resolve_ms ------------------------------------------

test("version.switch: both to- and from-version go through the ht_major closed set, not the raw ref", () => {
  const telemetry = recordingTelemetry();
  emitVersionSwitch(telemetry, { framework: "react", toRef: "18.1.0", fromRef: "17.1.0", bucket: "18.1" });

  assert.equal(telemetry.metrics.length, 1);
  const [call] = telemetry.metrics;
  assert.equal(call.name, "version.switch");
  assert.equal(call.attrs.ht_major, "18");
  assert.equal(call.attrs.reason, "17");
  assert.equal(call.attrs.bucket, "18.1");
  assertValidAgainstRegistry(telemetry);
});

test("version.switch: a pkg.pr.new fromRef never lands raw in the reason blob (guard against unbounded AE data)", () => {
  const telemetry = recordingTelemetry();
  emitVersionSwitch(telemetry, {
    framework: "react",
    toRef: "18.1.0",
    fromRef: "https://pkg.pr.new/handsontable/handsontable@7940",
  });

  assert.equal(telemetry.metrics[0].attrs.reason, "next");
  assertValidAgainstRegistry(telemetry);
});

test("version.switch: an absent fromRef reads reason as none", () => {
  const telemetry = recordingTelemetry();
  emitVersionSwitch(telemetry, { framework: "react", toRef: "18.1.0" });

  assert.equal(telemetry.metrics[0].attrs.reason, "none");
  assertValidAgainstRegistry(telemetry);
});

test("bucket.resolve_ms: ok and error outcomes both round-trip", () => {
  const telemetry = recordingTelemetry();
  emitBucketResolve(telemetry, { bucket: "18.1", outcome: "ok", durationMs: 12 });
  emitBucketResolve(telemetry, { bucket: "18.1", outcome: "error", durationMs: 34 });

  assert.equal(telemetry.metrics.length, 2);
  assert.equal(telemetry.metrics[0].values.duration_ms, 12);
  assert.equal(telemetry.metrics[1].attrs.outcome, "error");
  assertValidAgainstRegistry(telemetry);
});

// ---- startClock ---------------------------------------------------------------

test("startClock reports elapsed time against an injected clock", () => {
  let now = 1000;
  const elapsed = startClock(() => now);
  now = 1042;
  assert.equal(elapsed(), 42);
});
