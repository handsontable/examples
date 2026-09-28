import test from "node:test";
import assert from "node:assert/strict";
import { SandpackRuntime } from "../packages/runtime/dist/sandpack.js";
import { isTranspileFailure, transpileFilesForParcel } from "../packages/runtime/dist/transpile.js";
import { fingerprint, recordingTelemetry, toAePoint } from "../packages/runtime/dist/telemetry/index.js";
import { createDemoEventCollapse, DEMO_EDIT_SETTLE_MS } from "../apps/authoring/src/demoEventCollapse.ts";
import { wireRuntimeMetrics } from "../apps/authoring/src/telemetry/metrics.ts";

// A syntax error typed into a Tier-1 parcel example must still produce a
// `sandpack.compile_error` point: the parcel pre-transpile
// (`transpileFilesForParcel`, client-side babel) throws on the half-typed
// source, so `pushUpdate`'s catch must not drop it before anything reaches
// the bundler — the only place the compile error exists as an error object.
//
// These tests drive the real `SandpackRuntime` on a parcel entry with the
// real babel (no bundler: a fake client records what would have been
// pushed), and, for the ladder, the real `wireRuntimeMetrics` and the real
// edit-burst collapse. `sentry.ts` (which owns the app's collapse instance
// and emits `preview.runtime_error`) imports `@sentry/react` and cannot be
// loaded here, so its two entry points are mirrored by `relayRuntimeError`
// and `collapseCompileError` below — same key rules, same `replacesRun` flag.
//
// Build prerequisite: `pnpm --filter @handsontable/demo-runtime build`.

const ENTRY = {
  framework: "javascript",
  displayName: "JavaScript",
  tier: 1,
  engine: "sandpack",
  sandpackTemplate: "parcel",
  sandpackEnvironment: "parcel",
  container: null,
  htWrappers: [],
  entry: "/index.js",
  htmlEntry: "/index.html",
  devCommand: null,
  buildCommand: "build",
  outputDir: "dist",
  outputGlob: null,
  staticExport: false,
  spaMode: false,
  port: null,
  installCommand: "install",
  htCoreRange: null,
  minCoreMajor: null,
  fileCount: 3,
  assets: [],
  skipped: [],
  files: {},
};

const BASE_SOURCE = "const data = [[1, 2], [3, 4]];\nconsole.log(data.length);\n";
const FILES = {
  "/package.json": JSON.stringify({ dependencies: { handsontable: "18.0.0" } }),
  "/index.html": '<!doctype html><html><body><div id="app"></div><script src="./index.js"></script></body></html>',
  "/index.js": BASE_SOURCE,
};

/** A runtime with a fake client attached, skipping the bundler (same shape as
 *  `head-assets.test.mjs#published`). */
function mountedParcel() {
  const runtime = new SandpackRuntime(ENTRY, { iframe: {} });
  const pushes = [];
  runtime.client = {
    updateSandbox: (setup) => pushes.push(setup),
    destroy() {},
    listen: () => () => {},
  };
  runtime.files = { ...FILES };
  const compileErrors = [];
  const errors = [];
  runtime.onCompileError((e) => compileErrors.push(e));
  runtime.onError((e) => errors.push(e));
  return { runtime, pushes, compileErrors, errors };
}

/** Let the async transpile chain of the pushes so far settle. Babel is loaded
 *  once (below), after which a transpile is a handful of microtasks. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test.before(async () => {
  // Warm the lazily-imported @babel/standalone so `settle()` never races its load.
  await transpileFilesForParcel({ "/warm.js": "1;" });
});

test("the parcel transpile failure is marked as such, and is not a CompilerUnavailableError", async () => {
  const failure = await transpileFilesForParcel({ "/index.js": "const R9C = ;" }).then(
    () => null,
    (e) => e,
  );
  assert.ok(failure instanceof Error);
  assert.ok(isTranspileFailure(failure));
  // Sentry parity: still a plain `Error` with the same message shape, so the linked
  // `cause` of the mount path's `Tier1CompileError` capture is byte-identical.
  assert.equal(failure.name, "Error");
  assert.match(failure.message, /^Failed to transpile \/index\.js for the parcel sandbox: /);
  assert.ok(!isTranspileFailure(new Error("Failed to transpile /x.js for the parcel sandbox: fake")), "the marker, not the text");
});

test("edit path: a syntax error reports one compile error, pushes nothing, and raises no error card", async () => {
  const { runtime, pushes, compileErrors, errors } = mountedParcel();

  runtime.writeFile("/index.js", BASE_SOURCE + "const R9C = ;\n");
  await settle();

  assert.equal(pushes.length, 0, "the broken source never reaches the bundler (last good render stays)");
  assert.equal(compileErrors.length, 1, "but it is the preview's compile error");
  assert.match(compileErrors[0].message, /Failed to transpile \/index\.js for the parcel sandbox/);
  assert.equal(errors.length, 0, "no onError: the card and the Sentry capture are unchanged");
});

test("edit path: only the newest push reports — a superseded keystroke's failure is typed past", async () => {
  const { runtime, pushes, compileErrors } = mountedParcel();

  // Two keystrokes before either transpile settles: the first is broken, the
  // second finishes the line.
  runtime.writeFile("/index.js", BASE_SOURCE + "const R9C = \n");
  runtime.writeFile("/index.js", BASE_SOURCE + "const R9C = 1;\n");
  await settle();

  assert.equal(compileErrors.length, 0, "the stale failure must not be reported");
  assert.equal(pushes.length, 1, "the newest edit compiled and was pushed");
});

test("edit path: a runtime SyntaxError (JSON.parse) is not a compile error — it parses, and is pushed", async () => {
  const { runtime, pushes, compileErrors } = mountedParcel();

  runtime.writeFile("/index.js", BASE_SOURCE + "JSON.parse('{');\n");
  await settle();

  assert.equal(compileErrors.length, 0);
  assert.equal(pushes.length, 1, "it runs, and whatever it throws is the in-preview reporter's");
});

test("edit path: a missing entry mid-rename (DEV-2130) is not a compile error", async () => {
  const { runtime, compileErrors, pushes } = mountedParcel();

  runtime.deleteFile("/index.html"); // the parcel sandbox entry
  await settle();

  assert.equal(pushes.length, 0);
  assert.equal(compileErrors.length, 0);
});

test("mount: a demo whose source does not parse reports its compile error at once, and the mount still rejects with the same error", async () => {
  const runtime = new SandpackRuntime(ENTRY, { iframe: {} });
  const compileErrors = [];
  runtime.onCompileError((e) => compileErrors.push(e));

  const rejection = await runtime.mount({ ...FILES, "/index.js": "const R9C = ;\n" }).then(
    () => null,
    (e) => e,
  );

  assert.ok(isTranspileFailure(rejection), "the mount rejects with the transpile failure, unchanged");
  assert.equal(compileErrors.length, 1);
  assert.equal(compileErrors[0].message, rejection.message, "same (bounded) diagnostic");
});

// ---- the typed ladder, end to end through the metrics wiring and the collapse --

/** A hand-driven timer, as in `demo-event-collapse.test.mjs`. */
function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimer(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
  };
}

const SERVICE = { service_name: "demos-authoring", service_version: "abc123", environment: "production" };

function ladderHarness() {
  const clock = fakeTimers();
  const telemetry = recordingTelemetry();
  const collapse = createDemoEventCollapse({
    emit: (emitItem) => emitItem(),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  // Mirrors `sentry.ts#collapseCompileError`.
  const collapseCompileError = (emit) =>
    collapse.report("compile:sandpack.compile_error", emit, { replacesRun: true });
  // Mirrors `sentry.ts#reportDemoEventUnguarded` → `emitCollapsedDemoEvent`.
  const relayRuntimeError = (message) => {
    const fp = fingerprint("demo-runtime", message);
    collapse.report(fp, () =>
      telemetry.metric(
        "preview.runtime_error",
        { count: 1 },
        { surface: "demo-runtime", tier: "1", framework: "javascript", ht_major: "18", reason: "uncaught", fingerprint: fp },
      ),
    );
  };
  const { runtime, pushes } = mountedParcel();
  wireRuntimeMetrics(runtime, { framework: "javascript", versionRef: "18.0.0" }, telemetry, { collapseCompileError });
  const points = (name) => telemetry.metrics.filter((m) => m.name === name);
  return { clock, telemetry, collapse, runtime, pushes, relayRuntimeError, points };
}

test("a typed syntax-error ladder yields exactly 1 sandpack.compile_error and 0 preview.runtime_error", async () => {
  const { clock, telemetry, collapse, runtime, pushes, relayRuntimeError, points } = ladderHarness();
  const line = "const R9C = ;";

  let inFlight = null;
  for (let i = 1; i <= line.length; i++) {
    const prefix = line.slice(0, i);
    collapse.noteEdit(); // App.tsx#writeFile, on every non-quiet keystroke
    // The previous keystroke's run relays its throw only now: compile slower
    // than the typist (the case the collapse cannot see through on its own).
    if (inFlight) relayRuntimeError(inFlight);
    inFlight = null;
    const before = pushes.length;
    runtime.writeFile("/index.js", BASE_SOURCE + prefix + "\n");
    await settle();
    // `c`, `co`, `con`, `cons` parse and are pushed; that run throws a ReferenceError.
    if (pushes.length > before) inFlight = `${prefix} is not defined`;
  }
  assert.equal(pushes.length, 4, "guard: the four identifier prefixes really ran, so the ladder has runtime rungs");
  clock.advance(DEMO_EDIT_SETTLE_MS);

  assert.equal(points("sandpack.compile_error").length, 1, "one compile error for the typed line");
  assert.equal(points("preview.runtime_error").length, 0, "and no runtime error from the rungs it was typed through");
  for (const { name, values, attrs } of telemetry.metrics) toAePoint(name, values, { ...SERVICE, ...attrs });
  const [point] = points("sandpack.compile_error");
  assert.deepEqual(Object.keys(point.attrs).sort(), ["fingerprint", "framework", "ht_major"]);
  assert.equal(point.attrs.framework, "javascript");
  assert.equal(point.attrs.ht_major, "18");
});

test("a first-load compile failure counts immediately, with no edit burst to wait for", async () => {
  const clock = fakeTimers();
  const telemetry = recordingTelemetry();
  const collapse = createDemoEventCollapse({ emit: (f) => f(), setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const runtime = new SandpackRuntime(ENTRY, { iframe: {} });
  wireRuntimeMetrics(runtime, { framework: "javascript", versionRef: "18.0.0" }, telemetry, {
    collapseCompileError: (emit) => collapse.report("compile:sandpack.compile_error", emit, { replacesRun: true }),
  });

  await runtime.mount({ ...FILES, "/index.js": "const R9C = ;\n" }).catch(() => {});

  assert.equal(telemetry.metrics.filter((m) => m.name === "sandpack.compile_error").length, 1, "no clock advanced, already counted");
});

test("a runtime JSON.parse SyntaxError stays a preview.runtime_error, never a compile error", async () => {
  const { clock, collapse, runtime, pushes, relayRuntimeError, points } = ladderHarness();

  collapse.noteEdit();
  runtime.writeFile("/index.js", BASE_SOURCE + "JSON.parse('{');\n");
  await settle();
  assert.equal(pushes.length, 1, "guard: it compiled and ran");
  relayRuntimeError("SyntaxError: Expected property name or '}' in JSON at position 1");
  clock.advance(DEMO_EDIT_SETTLE_MS);

  assert.equal(points("preview.runtime_error").length, 1);
  assert.equal(points("sandpack.compile_error").length, 0);
});
