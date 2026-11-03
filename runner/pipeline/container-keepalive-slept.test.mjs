// A session the server ended because its container went idle answers the
// keepalive with 410 `session_slept`. The preview frame is dead by then, so the
// visitor must get the error card (with "Restart preview") instead of a silent,
// frozen demo. A plain 410 (the session was closed elsewhere) stays silent.
// Same harness shape as `monitor-stderr-relay.test.mjs`.

import test from "node:test";
import assert from "node:assert/strict";
import { ContainerRuntime } from "../packages/runtime/dist/container.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));

const ENTRY = {
  framework: "angular",
  displayName: "Angular",
  tier: 2,
  engine: "container",
  sandpackTemplate: null,
  sandpackEnvironment: null,
  container: "angular",
  htWrappers: [],
  entry: "/src/app/app.component.ts",
  htmlEntry: null,
  devCommand: "dev",
  buildCommand: "build",
  outputDir: "dist",
  outputGlob: null,
  staticExport: true,
  spaMode: false,
  port: 4200,
  installCommand: "install",
  htCoreRange: null,
  minCoreMajor: null,
  fileCount: 2,
  assets: [],
  skipped: [],
  files: {},
};

const PREVIEW_URL = "https://4200-angular-abc.preview.test/";

const okResponse = () => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve({ ready: true, log: "" }),
  text: () => Promise.resolve(JSON.stringify({ ready: true, log: "" })),
  clone() {
    return this;
  },
});

const goneResponse = (body) => ({
  ok: false,
  status: 410,
  json: () => Promise.resolve(body),
  text: () => Promise.resolve(JSON.stringify(body)),
  clone() {
    return this;
  },
});

/** A pointed runtime whose keepalive ticks every 5 ms; `answerWith` switches what the status route returns. */
async function pointedRuntime() {
  const fetchBefore = globalThis.fetch;
  const windowBefore = globalThis.window;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };

  let next = okResponse;
  const fetches = [];
  globalThis.fetch = (url) => {
    fetches.push(url);
    return Promise.resolve(next());
  };

  const iframe = { src: "", addEventListener() {}, removeEventListener() {} };
  const runtime = new ContainerRuntime(ENTRY, { iframe, apiBase: "https://api.test", renderGraceMs: 1, keepaliveMs: 5 });
  const restore = () => {
    try {
      runtime.dispose();
    } finally {
      globalThis.fetch = fetchBefore;
      globalThis.window = windowBefore;
    }
  };
  const errors = [];
  runtime.onError((err) => errors.push(err));

  try {
    runtime.sessionId = "s1";
    runtime.port = 4200;
    runtime.previewUrl = PREVIEW_URL;
    runtime.poll();
    await settle();
    await settle();
    assert.equal(iframe.src, PREVIEW_URL, "the port answered, so the frame is pointed and the keepalive starts");
  } catch (err) {
    restore();
    throw err;
  }

  /** Answer the next keepalive tick with `make()` and wait until it was consumed. */
  const answerWith = async (make) => {
    next = make;
    const before = fetches.length;
    for (let i = 0; fetches.length === before; i += 1) {
      if (i > 500) throw new Error("the keepalive never ticked");
      await settle();
    }
    for (let i = 0; i < 5; i += 1) await settle();
  };

  return { runtime, iframe, errors, answerWith, restore };
}

test("a keepalive 410 session_slept surfaces the server's sentence and stops pinging", async () => {
  const h = await pointedRuntime();
  try {
    const message = "This demo was paused after a few minutes without activity. Restart the preview to continue.";
    await h.answerWith(() => goneResponse({ error: "session_slept", message }));

    assert.equal(h.errors.length, 1, "one error for the card");
    assert.equal(h.errors[0].message, message);
    assert.equal(h.errors[0].status, 410);
    assert.equal(h.iframe.src, "about:blank", "the dead preview is cleared, as for a budget close");
  } finally {
    h.restore();
  }
});

test("a plain keepalive 410 (closed elsewhere) stays silent", async () => {
  const h = await pointedRuntime();
  try {
    await h.answerWith(() => goneResponse({ error: "session closed" }));
    assert.equal(h.errors.length, 0);
    assert.equal(h.iframe.src, PREVIEW_URL);
  } finally {
    h.restore();
  }
});
