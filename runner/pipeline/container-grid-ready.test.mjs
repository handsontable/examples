// Tier-2 `ready` means the grid is mounted in the preview frame.
//
// The injected scheme receiver announces `probesGrid` when it can watch the DOM and
// posts `grid: true` on the first rendered cell. Once a document has announced, load
// plus grace no longer decides readiness; a document that never announces keeps the
// load-and-grace path. Runs against `dist`, the shipped module.

import test from "node:test";
import assert from "node:assert/strict";
import { ContainerRuntime } from "../packages/runtime/dist/container.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));
const afterGrace = () => new Promise((resolve) => setTimeout(resolve, 20));

const PREVIEW_URL = "https://4321-astro-abc.preview.test/";
const PREVIEW_ORIGIN = "https://4321-astro-abc.preview.test";
const SOURCE = "hot-runner-scheme";

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

/** `statuses` is consumed one per poll; the last entry repeats. */
async function pointed(statuses = [{ ready: true, log: "" }], { point = true, gridWaitMs = 3_600_000 } = {}) {
  const fetchBefore = globalThis.fetch;
  const windowBefore = globalThis.window;
  const windowListeners = new Map();
  globalThis.window = {
    addEventListener(type, fn) { windowListeners.set(type, fn); },
    removeEventListener(type) { windowListeners.delete(type); },
  };
  let polls = 0;
  globalThis.fetch = () => {
    const body = statuses[Math.min(polls, statuses.length - 1)];
    polls += 1;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };

  const frameListeners = new Map();
  const contentWindow = {};
  const iframe = {
    src: "",
    contentWindow,
    addEventListener(type, fn) { frameListeners.set(type, fn); },
    removeEventListener(type) { frameListeners.delete(type); },
  };
  const runtime = new ContainerRuntime(ENTRY, {
    iframe,
    apiBase: "https://api.test",
    renderGraceMs: 1,
    gridWaitMs,
    keepaliveMs: 3_600_000,
  });
  const ready = [];
  const errors = [];
  const phases = [];
  runtime.sessionId = "s1";
  runtime.port = 4321;
  runtime.previewUrl = PREVIEW_URL;
  runtime.onReady(() => ready.push(true));
  runtime.onError((e) => errors.push(e));
  runtime.onBootPhases((e) => phases.push(e.phases));

  const pollOnce = async () => {
    clearTimeout(runtime.pollTimer);
    runtime.poll();
    await settle();
    await settle();
  };
  if (point) {
    await pollOnce();
    assert.equal(iframe.src, PREVIEW_URL, "the port answered, so the frame is pointed at it");
  }

  const send = (data, { origin = PREVIEW_ORIGIN, source = contentWindow } = {}) =>
    windowListeners.get("message")({ origin, source, data });

  return {
    runtime,
    iframe,
    pollOnce,
    ready,
    errors,
    phases,
    hello: (opts) => send({ source: SOURCE, ready: true, probesGrid: true }, opts),
    helloWithoutProbe: () => send({ source: SOURCE, ready: true }),
    grid: (opts) => send({ source: SOURCE, grid: true }, opts),
    post: (state) => send({ source: "demo-preview", state }),
    load: () => frameListeners.get("load")(),
    restore() {
      runtime.dispose();
      globalThis.fetch = fetchBefore;
      globalThis.window = windowBefore;
    },
  };
}

test("a document that watches for its grid is not ready after load plus grace", async () => {
  const h = await pointed();
  try {
    h.hello();
    h.load();
    await afterGrace();
    assert.deepEqual(h.ready, [], "the frame loaded but no grid is mounted yet");
  } finally {
    h.restore();
  }
});

test("the grid message makes a watching document ready", async () => {
  const h = await pointed();
  try {
    h.hello();
    h.load();
    await afterGrace();
    h.grid();
    assert.deepEqual(h.ready, [true]);
    assert.deepEqual(h.errors, []);
  } finally {
    h.restore();
  }
});

test("a grid that mounts before the frame's load is ready without waiting for the grace", async () => {
  const h = await pointed();
  try {
    h.hello();
    h.grid();
    assert.deepEqual(h.ready, [true]);
    h.load();
    await afterGrace();
    assert.deepEqual(h.ready, [true], "ready is reported once");
  } finally {
    h.restore();
  }
});

test("a grid message from another origin or another window is ignored", async () => {
  const h = await pointed();
  try {
    h.hello();
    h.load();
    h.grid({ origin: "https://evil.test" });
    h.grid({ source: {} });
    await afterGrace();
    assert.deepEqual(h.ready, [], "any frame or opener can post to the shell");
  } finally {
    h.restore();
  }
});

test("a document that never announces keeps the load-and-grace path", async () => {
  const h = await pointed();
  try {
    h.load();
    await afterGrace();
    assert.deepEqual(h.ready, [true]);
  } finally {
    h.restore();
  }
});

test("a receiver that cannot watch the DOM keeps the load-and-grace path", async () => {
  const h = await pointed();
  try {
    h.helloWithoutProbe();
    h.load();
    await afterGrace();
    assert.deepEqual(h.ready, [true]);
  } finally {
    h.restore();
  }
});

test("the hard fallback does not call a document ready while its hello awaits the load", async () => {
  const h = await pointed();
  try {
    h.hello();
    const fallback = h.runtime.readyFallbackTimer;
    const fire = fallback._onTimeout;
    clearTimeout(fallback);
    fire();
    await afterGrace();
    assert.deepEqual(h.ready, []);
  } finally {
    h.restore();
  }
});

test("a watching document that never mounts a grid is confirmed ready after the bounded wait", async () => {
  const h = await pointed([{ ready: true, log: "" }], { gridWaitMs: 5 });
  try {
    h.hello();
    h.load();
    assert.deepEqual(h.ready, [], "the wait has not elapsed");
    await afterGrace();
    assert.deepEqual(h.ready, [true], "an empty or failed demo must not keep the boot overlay up for good");
  } finally {
    h.restore();
  }
});

test("a port that stopped answering is not called ready when the bounded wait ends", async () => {
  const h = await pointed([{ ready: true, log: "" }], { gridWaitMs: 5 });
  try {
    h.hello();
    h.load();
    globalThis.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ready: false, log: "" }) });
    await afterGrace();
    assert.deepEqual(h.ready, []);
  } finally {
    h.restore();
  }
});

test("a document without a hello after one that never mounted a grid is not left waiting", async () => {
  const h = await pointed();
  try {
    h.hello();
    h.load();
    await afterGrace();
    assert.deepEqual(h.ready, []);

    // The frame navigates to a document whose receiver never announces.
    h.load();
    await afterGrace();
    assert.deepEqual(h.ready, [true]);
  } finally {
    h.restore();
  }
});

test("a hello that lands during the previous document's grace still gates the next load", async () => {
  const h = await pointed();
  try {
    // Document one never announces; its grace is running when document two says hello.
    h.runtime.opts.renderGraceMs = 50;
    h.load();
    h.hello();
    h.load();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(h.ready, [], "the watching document is not ready on a grace alone");
    h.grid();
    assert.deepEqual(h.ready, [true]);
  } finally {
    h.restore();
  }
});

test("create-request timing is recorded by mount() as the container_up phase", async () => {
  const fetchBefore = globalThis.fetch;
  const windowBefore = globalThis.window;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.fetch = (url) =>
    Promise.resolve(
      String(url).endsWith("/api/session")
        ? { ok: true, status: 200, json: () => Promise.resolve({ previewUrl: PREVIEW_URL, port: 4321 }) }
        : { ok: true, status: 200, json: () => Promise.resolve({ ready: false, log: "" }) },
    );
  const iframe = { src: "", contentWindow: {}, addEventListener() {}, removeEventListener() {} };
  const runtime = new ContainerRuntime(ENTRY, { iframe, apiBase: "https://api.test", keepaliveMs: 3_600_000 });
  try {
    await runtime.mount({});
    assert.ok(Number.isInteger(runtime.containerUpMs) && runtime.containerUpMs >= 0);
    assert.equal(typeof runtime.createDoneAt, "number", "the install phase starts when the create request resolves");
  } finally {
    runtime.dispose();
    globalThis.fetch = fetchBefore;
    globalThis.window = windowBefore;
  }
});

test("a recovered frame after the boot page is judged on its own announcement", async () => {
  const h = await pointed();
  try {
    h.hello();
    h.post("booting");
    h.load();
    await afterGrace();
    assert.deepEqual(h.ready, []);

    // The next document does not announce: the watch from the first one is gone.
    h.load();
    await afterGrace();
    assert.deepEqual(h.ready, [true]);
  } finally {
    h.restore();
  }
});

test("boot phases are reported once, in order, when the grid makes the preview ready", async () => {
  const h = await pointed(
    [
      { ready: false, log: "", phase: "installing" },
      { ready: false, log: "", phase: "starting" },
      { ready: true, log: "", phase: "starting" },
    ],
    { point: false },
  );
  try {
    h.runtime.createDoneAt = performance.now();
    h.runtime.containerUpMs = 1200;
    await h.pollOnce();
    await h.pollOnce();
    assert.equal(h.iframe.src, "", "the port has not answered yet");
    await h.pollOnce();
    assert.equal(h.iframe.src, PREVIEW_URL);
    assert.equal(h.phases.length, 0, "nothing is reported before ready");

    h.hello();
    h.load();
    h.grid();
    assert.equal(h.phases.length, 1);
    assert.deepEqual(
      h.phases[0].map((p) => p.phase),
      ["container_up", "install", "dev_server", "first_render"],
    );
    assert.equal(h.phases[0][0].durationMs, 1200, "container_up is the create request's own duration");
    for (const p of h.phases[0]) {
      assert.ok(Number.isInteger(p.durationMs) && p.durationMs >= 0, `${p.phase} has a non-negative duration`);
    }
    h.grid();
    assert.equal(h.phases.length, 1, "a second grid message does not re-report");
  } finally {
    h.restore();
  }
});

test("a status route that reports no phase still yields the phases that were measured", async () => {
  const h = await pointed([{ ready: true, log: "" }], { point: false });
  try {
    h.runtime.createDoneAt = performance.now();
    h.runtime.containerUpMs = 900;
    await h.pollOnce();
    h.hello();
    h.load();
    h.grid();
    assert.deepEqual(
      h.phases[0].map((p) => p.phase),
      ["container_up", "first_render"],
      "install and dev_server need the phase marker, and are left out rather than guessed",
    );
  } finally {
    h.restore();
  }
});
