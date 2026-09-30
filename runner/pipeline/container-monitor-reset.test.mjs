// Vite HMR keeps the injected document, so the in-preview reporter's per-page error
// budget never re-arms on Tier 2 unless the runtime posts the same reset Tier 1 does.
// These drive a real ContainerRuntime.flush() against `dist` with a recording frame.

import test from "node:test";
import assert from "node:assert/strict";
import { ContainerRuntime } from "../packages/runtime/dist/container.js";
import { MONITOR_EVENT_CEILING, MONITOR_MESSAGE_TYPE, MONITOR_RESET } from "../packages/runtime/dist/monitor.js";

const ENTRY = {
  framework: "astro", displayName: "Astro", tier: 2, engine: "container",
  sandpackTemplate: null, sandpackEnvironment: null, container: "astro", htWrappers: [],
  entry: "/src/pages/index.astro", htmlEntry: null, devCommand: "dev", buildCommand: "build",
  outputDir: "dist", outputGlob: null, staticExport: true, spaMode: false, port: 4321,
  installCommand: "install", htCoreRange: null, minCoreMajor: null, fileCount: 2,
  assets: [], skipped: [], files: {},
};

const RESET = { type: MONITOR_MESSAGE_TYPE, reset: MONITOR_RESET };

/** A mounted runtime whose frame records every message posted into it and whose
 *  file-write route records its order relative to those posts. */
function mounted({ monitor = true, ready = true } = {}) {
  const fetchBefore = globalThis.fetch;
  const windowBefore = globalThis.window;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  const log = [];
  globalThis.fetch = () => {
    log.push("write");
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  };
  const iframe = {
    src: "",
    contentWindow: { postMessage: (data) => log.push(data) },
    addEventListener() {},
    removeEventListener() {},
  };
  const runtime = new ContainerRuntime(ENTRY, { iframe, apiBase: "https://api.test", monitor, keepaliveMs: 3_600_000 });
  runtime.sessionId = "s1";
  runtime.mounted = true;
  runtime.didReady = ready;
  const stderr = [];
  runtime.onStderr((line) => stderr.push(line));
  return {
    runtime, log, stderr,
    restore() {
      runtime.dispose();
      globalThis.fetch = fetchBefore;
      globalThis.window = windowBefore;
    },
  };
}

test("a flush of edits re-arms the reporter before the files are written", async () => {
  const h = mounted();
  try {
    h.runtime.writeFile("/src/a.astro", "a");
    await h.runtime.flush();
    assert.deepEqual(h.log, [RESET, "write"]);
  } finally {
    h.restore();
  }
});

test("no reset is posted for an empty flush, before ready, or without monitoring", async () => {
  for (const [name, opts, edit] of [
    ["empty batch", {}, false],
    ["not ready", { ready: false }, true],
    ["monitor off", { monitor: false }, true],
  ]) {
    const h = mounted(opts);
    try {
      if (edit) h.runtime.writeFile("/src/a.astro", "a");
      await h.runtime.flush();
      assert.equal(h.log.filter((m) => m !== "write").length, 0, name);
    } finally {
      h.restore();
    }
  }
});

test("a flush gives the dev-server stderr relay a fresh budget without re-relaying seen lines", async () => {
  const h = mounted();
  try {
    // Letters, not digits: the relay's dedupe key collapses numbers.
    const lines = (n) => Array.from({ length: n }, (_, i) => `Error: fault ${String.fromCharCode(97 + i)}${String.fromCharCode(97 + i)} failed`).join("\n");
    h.runtime.relayStderr(lines(MONITOR_EVENT_CEILING + 5));
    assert.equal(h.stderr.length, MONITOR_EVENT_CEILING, "guard: the budget is spent");

    h.runtime.writeFile("/src/a.astro", "a");
    await h.runtime.flush();
    h.runtime.relayStderr(lines(MONITOR_EVENT_CEILING + 5)); // the log tail repeats on every ping
    assert.equal(h.stderr.length, MONITOR_EVENT_CEILING + 5, "the five unseen lines relay; the twenty seen ones do not");
  } finally {
    h.restore();
  }
});
