// "Ready" must describe the demo, not the Worker's apology for it (DEV-2547).
//
// Tier-2 readiness is a port probe, and the shell used to emit ready a fixed grace
// after the preview frame's `load`. The Worker's own boot page
// (`workers/api/src/preview-boot.ts`) fires that `load` exactly like a real demo
// does, so `data-preview-status` reached "ready" over a "Reconnecting to the demo"
// card with no grid behind it — the reported symptom, for which nothing was logged
// and no error card ever appeared.
//
// The page now posts its state to the parent. This file pins the three outcomes
// that follow (real document, recoverable boot page, dead server) and the origin
// check, against `dist` — the shipped module, not the source.

import test from "node:test";
import assert from "node:assert/strict";
import { ContainerRuntime } from "../packages/runtime/dist/container.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));
/** Long enough for a 1ms grace timer to have fired, short enough to stay a unit test. */
const afterGrace = () => new Promise((resolve) => setTimeout(resolve, 20));

const PREVIEW_URL = "https://4321-astro-abc.preview.test/";
const PREVIEW_ORIGIN = "https://4321-astro-abc.preview.test";

const ENTRY = {
  framework: "astro",
  displayName: "Astro",
  tier: 2,
  engine: "container",
  sandpackTemplate: null,
  sandpackEnvironment: null,
  container: "astro",
  htWrappers: [],
  entry: "/src/pages/index.astro",
  htmlEntry: null,
  devCommand: "dev",
  buildCommand: "build",
  outputDir: "dist",
  outputGlob: null,
  staticExport: true,
  spaMode: false,
  port: 4321,
  installCommand: "install",
  htCoreRange: null,
  minCoreMajor: null,
  fileCount: 2,
  assets: [],
  skipped: [],
  files: {},
};

/** A pointed runtime: the status route says ready, so `poll()` wires the frame
 *  listeners and sets `iframe.src`. Returns the two handlers it registered. */
async function pointed() {
  const fetchBefore = globalThis.fetch;
  const windowBefore = globalThis.window;
  const windowListeners = new Map();
  globalThis.window = {
    addEventListener(type, fn) { windowListeners.set(type, fn); },
    removeEventListener(type) { windowListeners.delete(type); },
  };
  globalThis.fetch = () =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ready: true, log: "" }) });

  const frameListeners = new Map();
  const iframe = {
    src: "",
    addEventListener(type, fn) { frameListeners.set(type, fn); },
    removeEventListener(type) { frameListeners.delete(type); },
  };
  const runtime = new ContainerRuntime(ENTRY, {
    iframe,
    apiBase: "https://api.test",
    renderGraceMs: 1,
    // Nothing in these cases should reach the network again; a 60s interval would
    // also hold the test process open.
    keepaliveMs: 3_600_000,
  });
  const ready = [];
  const errors = [];
  runtime.sessionId = "s1";
  runtime.port = 4321;
  runtime.previewUrl = PREVIEW_URL;
  runtime.onReady(() => ready.push(true));
  runtime.onError((e) => errors.push(e));

  runtime.poll();
  await settle();
  await settle();
  assert.equal(iframe.src, PREVIEW_URL, "the port answered, so the frame is pointed at it");

  const post = (state, origin = PREVIEW_ORIGIN) =>
    windowListeners.get("message")({ origin, data: { source: "demo-preview", state } });

  return {
    runtime,
    ready,
    errors,
    post,
    load: () => frameListeners.get("load")(),
    restore() {
      runtime.dispose();
      globalThis.fetch = fetchBefore;
      globalThis.window = windowBefore;
    },
  };
}

test("a real demo document still reaches ready after the grace", async () => {
  const h = await pointed();
  try {
    h.load();
    await afterGrace();
    assert.deepEqual(h.ready, [true]);
    assert.deepEqual(h.errors, []);
  } finally {
    h.restore();
  }
});

test("the boot page holds ready back, and a recovered frame still gets it", async () => {
  const h = await pointed();
  try {
    // The page's inline script runs at parse time, so its message precedes the
    // `load` it belongs to.
    h.post("booting");
    h.load();
    await afterGrace();
    assert.deepEqual(h.ready, [], "a 'Reconnecting to the demo' frame is not a ready demo");
    assert.deepEqual(h.errors, [], "and it is not a failure either — the page retries itself");

    // The meta-refresh navigation that finds the dev server up. This is the case a
    // suppress-and-wait fix regresses into a permanent boot overlay.
    h.load();
    await afterGrace();
    assert.deepEqual(h.ready, [true]);
  } finally {
    h.restore();
  }
});

test("a message that lands after its own load still cancels the grace", async () => {
  const h = await pointed();
  try {
    h.load();
    h.post("booting");
    await afterGrace();
    assert.deepEqual(h.ready, []);
  } finally {
    h.restore();
  }
});

test("the terminal page reports an error instead of ready, once", async () => {
  const h = await pointed();
  try {
    h.post("dead");
    h.load();
    await afterGrace();
    assert.deepEqual(h.ready, []);
    assert.equal(h.errors.length, 1);
    assert.match(h.errors[0].message, /stopped responding/);

    // The terminal page is served per request; onError is wired to Sentry.
    h.post("dead");
    h.load();
    await afterGrace();
    assert.equal(h.errors.length, 1);
  } finally {
    h.restore();
  }
});

test("a message from anywhere but the preview origin is ignored", async () => {
  const h = await pointed();
  try {
    h.post("dead", "https://evil.test");
    h.post("booting", "https://evil.test");
    h.load();
    await afterGrace();
    assert.deepEqual(h.errors, [], "any frame or opener can post to the shell");
    assert.deepEqual(h.ready, [true]);
  } finally {
    h.restore();
  }
});

test("the hard fallback only covers a load event that never fired", async () => {
  const h = await pointed();
  try {
    // The 20s fallback used to fire unconditionally, which called a frame ready long
    // after it had told us it was holding the boot page.
    h.post("booting");
    h.load();
    await afterGrace();
    // Stand in for the 20s timer firing. Clearing it first is what the timer itself
    // would do, and the callback nulls the handle, so `dispose()` could not clear the
    // real one afterwards — it would hold the test process open for its full duration.
    const fallback = h.runtime.readyFallbackTimer;
    const fire = fallback._onTimeout;
    clearTimeout(fallback);
    fire();
    assert.deepEqual(h.ready, []);
  } finally {
    h.restore();
  }
});
