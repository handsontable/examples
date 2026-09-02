// Sentry DEMOS-4G / DEMOS-4V: 28 `handsoncode/demos` issues, one event each, all the
// same Angular build failure — "Application bundle generation failed. [<n> seconds] -
// <ISO>". The envelope line carries a live timestamp, so `relayStderr`'s dedupe
// (`stderrSeen`, keyed on the raw line) never collapses it: every failed edit relays a
// fresh copy and spends a `MONITOR_EVENT_CEILING` slot on a line with no new
// diagnostic. After ~20 such relays a visitor's genuine runtime `DemoError`s are
// silently never reported (`sentry.ts`'s budget is shared across monitor kinds).
//
// The fix keys `stderrSeen` on `normalizeMonitorMessage(message)` — the same
// fingerprint `sentry.ts:263` groups the Sentry issue by — instead of the raw line, so
// the relay and the parent's grouping agree. This file drives that through the real
// keepalive path (`relayStderr` is private; there is nothing else that reaches it).

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

/** A pointed, monitored runtime with `onStderr` wired before `poll()` (`relayStderr`
 *  returns early while `stderrCbs` is empty), and a `fetch` stub the keepalive drives
 *  through the status route. No `document` stub: Node has no global `document`, so
 *  the `typeof document !== "undefined"` guard short-circuits and the keepalive always
 *  proceeds — matching `pointed()` in `container-preview-readiness.test.mjs`, which
 *  doesn't stub it either. */
async function keptAlive() {
  const fetchBefore = globalThis.fetch;
  const windowBefore = globalThis.window;
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
  };

  let currentLog = "";
  const fetches = [];
  globalThis.fetch = (url) => {
    // Captured per call, not read lazily: an in-flight tick must never observe a
    // log that was set after it started, or a later `serve()` could race an
    // earlier one's response.
    const body = { ready: true, log: currentLog };
    fetches.push(url);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
      clone() {
        return this;
      },
    });
  };

  const iframe = {
    src: "",
    addEventListener() {},
    removeEventListener() {},
  };

  const runtime = new ContainerRuntime(ENTRY, {
    iframe,
    apiBase: "https://api.test",
    renderGraceMs: 1,
    keepaliveMs: 5,
    monitor: true,
  });

  const relayed = [];
  runtime.onStderr((line) => relayed.push(line));

  runtime.sessionId = "s1";
  runtime.port = 4200;
  runtime.previewUrl = PREVIEW_URL;

  runtime.poll();
  await settle();
  await settle();
  assert.equal(iframe.src, PREVIEW_URL, "the port answered, so the frame is pointed and the keepalive starts");

  /** Set the status route's log tail and wait for a keepalive tick to consume it
   *  through `clone().json()` and the relay drain — gated on the stub's own call
   *  log, not on elapsed time, so a tick that never lands fails loudly instead of
   *  the assert racing a timer that hasn't fired yet. */
  const serve = async (log) => {
    currentLog = log;
    const before = fetches.length;
    while (fetches.length === before) await settle();
    await settle();
    await settle();
  };

  return {
    runtime,
    relayed,
    serve,
    restore() {
      runtime.dispose();
      globalThis.fetch = fetchBefore;
      globalThis.window = windowBefore;
    },
  };
}

const log = (seconds, iso) =>
  [
    "✘ [ERROR] TS1005: ',' expected. [plugin angular-compiler]",
    "",
    "    src/app/app.component.ts:12:34:", // no marker word — filtered, as today
    `Application bundle generation failed. [${seconds} seconds] - ${iso}`,
  ].join("\n");

const BUILD_1 = log("0.431", "2026-08-25T18:06:09.937Z");
const BUILD_2 = log("1.595", "2026-08-27T14:20:04.952Z");

test("re-running one broken build does not spend a second relay slot", async () => {
  // Two keepalive ticks, the same fault, only the clock different. Today this
  // relays three events: the TS line once (it dedupes on its own raw text) and the
  // envelope twice (its timestamp makes every raw line unique).
  const h = await keptAlive();
  try {
    await h.serve(BUILD_1);
    await h.serve(BUILD_2);
    assert.equal(h.relayed.length, 2, JSON.stringify(h.relayed));
    assert.ok(h.relayed.some((m) => m.includes("TS1005")), "the diagnostic line is what must survive");
    // Names the collapsed population directly, rather than inferring it from a
    // total, so a tick that never landed fails loudly instead of arithmetically.
    assert.equal(
      h.relayed.filter((m) => m.includes("Application bundle generation failed")).length,
      1,
      "the envelope is one report per fault, not one per rebuild",
    );
  } finally {
    h.restore();
  }
});

test("a genuinely different fault still gets through", async () => {
  // Guards the dedupe against over-collapsing: the key must not be so coarse that
  // a new compiler error is mistaken for the old one.
  const h = await keptAlive();
  try {
    await h.serve(BUILD_1);
    await h.serve(BUILD_1.replace("TS1005: ','", "TS2304: 'foo'"));
    assert.ok(h.relayed.some((m) => m.includes("TS2304")), "a new diagnostic must still be reported");
  } finally {
    h.restore();
  }
});

// --- DEMOS-5C: the boot script's own recovered-install narration -------------
//
// `index.ts`'s boot script echoes `::frozen install failed for custom metadata;
// retrying non-frozen::` on stdout when an edited package.json cannot match its
// lockfile — the DESIGNED, benign, recovered fallback, not a fault. It matches
// STDERR_MARKERS only because it contains the word "failed", so relayStderr
// reported a recovered path as a defect and spent a MONITOR_EVENT_CEILING slot
// doing it.

test("the boot script's own recovered-install narration is not reported as a fault", async () => {
  const h = await keptAlive();
  try {
    await h.serve(
      [
        "::seeding immutable baked dependencies::",
        "::reconciling dependencies with pnpm::",
        "::frozen install failed for custom metadata; retrying non-frozen::",
        "::starting dev server::",
        "  VITE v5.4.0  ready in 431 ms",
      ].join("\n"),
    );
    // THE discriminating assertion.
    assert.deepEqual(
      h.relayed,
      [],
      "a fallback the runner narrates on its own designed path is not a defect",
    );
  } finally {
    h.restore();
  }
});

test("the boot script's ::error:: line is still relayed", async () => {
  // Guards the filter against being silently widened into swallowing real
  // errors: `::error::` is the runner's own deliberate fatal marker, emitted
  // right before `exit 1`.
  const h = await keptAlive();
  try {
    await h.serve(
      [
        "::reconciling dependencies with pnpm::",
        "::error::frozen install failed for generated starter metadata; refusing to modify its lockfile",
      ].join("\n"),
    );
    assert.equal(h.relayed.length, 1, JSON.stringify(h.relayed));
    assert.match(h.relayed[0], /^::error::/);
  } finally {
    h.restore();
  }
});
