import test from "node:test";
import assert from "node:assert/strict";
import {
  MONITOR_EVENT_CEILING,
  MONITOR_MESSAGE_MAX,
  MONITOR_MESSAGE_TYPE,
  REPORTER_SOURCE,
  injectReporter,
  injectReporterIntoHtml,
  isMonitorPayload,
  normalizeMonitorMessage,
  truncateMessage,
} from "../packages/runtime/dist/monitor.js";

// DEV-2527. Two things are being protected here.
//
// 1) The injection must never touch the authored file map. That map is what
//    Download-zip, fork and "open in StackBlitz" export, so a reporter that leaked
//    into it would ship in every downloaded demo. `SandpackRuntime` injects into
//    the *derived* bundler view for exactly this reason.
//
// 2) The reporter is a hand-written ES5 string, which no typechecker reads and no
//    build step executes. So these tests *run* it against a stub window rather than
//    grepping it — the DEV-2129 lesson (a transpiler test that only inspected its
//    output passed while the output could not execute).

const HTML_ENTRY = "/index.html";
const HTML = `<!doctype html>
<html>
  <head><title>demo</title></head>
  <body><div id="root"></div><script src="/src/main.js"></script></body>
</html>
`;

test("injects into an HTML entry without mutating the authored map", () => {
  const authored = { [HTML_ENTRY]: HTML, "/src/main.js": "grid();" };
  const before = JSON.stringify(authored);

  const out = injectReporter(authored, HTML_ENTRY);

  assert.ok(out[HTML_ENTRY].includes(MONITOR_MESSAGE_TYPE), "reporter present in derived map");
  assert.equal(JSON.stringify(authored), before, "authored map untouched");
  assert.ok(out[HTML_ENTRY].includes("<title>demo</title>"), "original head preserved");
  assert.ok(out[HTML_ENTRY].includes('<script src="/src/main.js">'), "demo script preserved");
  assert.equal(out["/src/main.js"], "grid();", "non-entry files untouched");
});

test("injects before the demo's own scripts", () => {
  const out = injectReporter({ [HTML_ENTRY]: HTML }, HTML_ENTRY);
  const reporterAt = out[HTML_ENTRY].indexOf(MONITOR_MESSAGE_TYPE);
  const demoAt = out[HTML_ENTRY].indexOf('src="/src/main.js"');
  assert.ok(reporterAt !== -1 && demoAt !== -1);
  assert.ok(reporterAt < demoAt, "a throw while the demo evaluates must still be seen");
});

test("prepends to a JS module entry", () => {
  const out = injectReporter({ "/src/main.js": "grid();" }, "/src/main.js");
  assert.ok(out["/src/main.js"].includes(MONITOR_MESSAGE_TYPE));
  assert.ok(out["/src/main.js"].trimEnd().endsWith("grid();"), "demo source stays last");
});

test("injection is byte-deterministic", () => {
  // `sameFiles` skips the compile when the sandbox is unchanged. A reporter that
  // varied between builds would make every keystroke a real diff and defeat it.
  const a = injectReporter({ [HTML_ENTRY]: HTML }, HTML_ENTRY);
  const b = injectReporter({ [HTML_ENTRY]: HTML }, HTML_ENTRY);
  assert.equal(a[HTML_ENTRY], b[HTML_ENTRY]);
});

test("is a no-op when the entry is missing from the map", () => {
  // resolveSandboxEntry throws for this case and setupFrom surfaces it as
  // "Setup failed" (DEV-2130). Monitoring must not become the reported cause.
  const files = { "/src/main.js": "grid();" };
  assert.equal(injectReporter(files, "/index.html"), files, "same object, unchanged");
});

test("is idempotent", () => {
  const once = injectReporter({ [HTML_ENTRY]: HTML }, HTML_ENTRY);
  const twice = injectReporter(once, HTML_ENTRY);
  assert.equal(twice[HTML_ENTRY], once[HTML_ENTRY]);
});

test("falls back to body, then to a prepend, when there is no head", () => {
  const bodyOnly = injectReporterIntoHtml("<body><div id=root></div></body>");
  assert.ok(bodyOnly.startsWith("<body>"), "body tag stays first");
  assert.ok(bodyOnly.includes(MONITOR_MESSAGE_TYPE));

  const fragment = injectReporterIntoHtml("<div id=root></div>");
  assert.ok(fragment.includes(MONITOR_MESSAGE_TYPE));
  assert.ok(fragment.trimEnd().endsWith("<div id=root></div>"));
});

// ---- the reporter, executed -------------------------------------------------

/** Run REPORTER_SOURCE against stubs and return the harness. Bare `window`,
 *  `parent`, `console`, `document` and `XMLHttpRequest` in the reporter resolve to
 *  these parameters, so no DOM implementation is needed. */
function runReporter() {
  const sent = [];
  const listeners = new Map();
  const passthrough = [];

  const win = {
    addEventListener(type, cb) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(cb);
    },
  };
  const parent = { postMessage: (payload) => sent.push(payload) };
  const consoleStub = {
    error: (...args) => passthrough.push(["error", ...args]),
    warn: (...args) => passthrough.push(["warn", ...args]),
  };
  const document = {
    createElement: () => ({
      set href(value) {
        const u = new URL(value, "http://demo.invalid");
        this.protocol = u.protocol;
        this.host = u.host;
        this.pathname = u.pathname;
      },
    }),
  };

  // eslint-disable-next-line no-new-func
  new Function("window", "parent", "console", "document", "XMLHttpRequest", REPORTER_SOURCE)(
    win,
    parent,
    consoleStub,
    document,
    undefined,
  );

  return {
    sent,
    passthrough,
    win,
    console: consoleStub,
    fire(type, event) {
      for (const cb of listeners.get(type) ?? []) cb(event);
    },
  };
}

test("reporter relays an uncaught error", () => {
  const h = runReporter();
  h.fire("error", { error: new Error("boom"), message: "boom" });

  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].type, MONITOR_MESSAGE_TYPE);
  assert.equal(h.sent[0].kind, "error");
  assert.equal(h.sent[0].message, "boom");
  assert.ok(h.sent[0].stack.includes("Error: boom"));
  assert.ok(isMonitorPayload(h.sent[0]), "payload passes the parent's own validation");
});

test("reporter relays an unhandled rejection", () => {
  const h = runReporter();
  h.fire("unhandledrejection", { reason: new Error("nope") });
  assert.equal(h.sent[0].kind, "rejection");
  assert.equal(h.sent[0].message, "nope");
});

test("reporter treats a failed resource load as a network fault", () => {
  const h = runReporter();
  h.fire("error", { target: { src: "https://cdn.example.com/x.js?token=secret" } });

  assert.equal(h.sent[0].kind, "network");
  assert.equal(h.sent[0].url, "https://cdn.example.com/x.js", "query stripped");
});

test("reporter wraps console.error/warn and calls through", () => {
  const h = runReporter();
  h.console.error("bad", 42);
  h.console.warn("careful");

  assert.deepEqual(
    h.sent.map((p) => [p.kind, p.message]),
    [["console-error", "bad 42"], ["console-warn", "careful"]],
  );
  assert.equal(h.passthrough.length, 2, "the demo's own console output still happens");
});

test("reporter dedupes identical reports", () => {
  const h = runReporter();
  const err = new Error("same");
  h.fire("error", { error: err });
  h.fire("error", { error: err });
  h.fire("error", { error: err });
  assert.equal(h.sent.length, 1);
});

test("reporter stops at the ceiling", () => {
  const h = runReporter();
  for (let i = 0; i < MONITOR_EVENT_CEILING + 10; i++) {
    h.fire("error", { error: new Error(`distinct ${i}`) });
  }
  assert.equal(h.sent.length, MONITOR_EVENT_CEILING);
});

test("reporter truncates the message", () => {
  const h = runReporter();
  h.fire("error", { error: new Error("x".repeat(MONITOR_MESSAGE_MAX + 100)) });
  assert.equal(h.sent[0].message.length, MONITOR_MESSAGE_MAX + 3);
  assert.ok(h.sent[0].message.endsWith("..."));
});

test("reporter never relays twice into the same window", () => {
  const h = runReporter();
  // A second injection (an HTML entry plus a module prepend, say) must not
  // double-hook console or double-count the ceiling.
  new Function("window", "parent", "console", "document", "XMLHttpRequest", REPORTER_SOURCE)(
    h.win,
    { postMessage: () => assert.fail("second injection must be inert") },
    h.console,
    { createElement: () => ({}) },
    undefined,
  );
  h.console.error("once");
  assert.equal(h.sent.length, 1);
});

// ---- parent-side helpers ---------------------------------------------------

test("truncateMessage caps and marks", () => {
  assert.equal(truncateMessage("short"), "short");
  assert.equal(truncateMessage("y".repeat(600)).length, MONITOR_MESSAGE_MAX + 3);
  assert.equal(truncateMessage(new Error("wrapped")), "Error: wrapped");
});

test("normalizeMonitorMessage collapses what differs between two reports of one fault", () => {
  const a = normalizeMonitorMessage('Cannot read "row" of undefined at index 41 (https://x.dev/a?b=1)');
  const b = normalizeMonitorMessage('Cannot read "col" of undefined at index 7 (https://y.dev/c?d=2)');
  assert.equal(a, b, "same fault must fingerprint the same");
});

// ---- wired through SandpackRuntime -----------------------------------------
//
// The injector being correct is not the same as the runtime using it correctly. What
// matters here is which of the two file maps the reporter lands in: the derived one
// the bundler compiles, never `runtime.files`, which is what Download-zip and fork
// export.

/** A non-parcel entry, so `sandboxFiles()` takes its synchronous path (no babel). */
const RUNTIME_ENTRY = {
  framework: "vue",
  displayName: "Vue",
  tier: 1,
  engine: "sandpack",
  sandpackTemplate: "vue",
  sandpackEnvironment: "vue-cli",
  container: null,
  htWrappers: [],
  entry: "/src/main.js",
  htmlEntry: null,
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
  fileCount: 2,
  assets: [],
  skipped: [],
  files: {},
};

const RUNTIME_FILES = {
  "/package.json": JSON.stringify({ dependencies: { handsontable: "16.0.1" } }),
  "/src/main.js": "console.log('demo');",
};

/** A runtime with a fake client attached, skipping mount() (needs a DOM + bundler). */
async function pushedSetup(options) {
  const { SandpackRuntime } = await import("../packages/runtime/dist/sandpack.js");
  const pushes = [];
  const runtime = new SandpackRuntime(RUNTIME_ENTRY, { iframe: {}, ...options });
  runtime.client = {
    updateSandbox: (setup) => pushes.push(setup),
    listen: () => () => {},
    destroy() {},
  };
  runtime.files = { ...RUNTIME_FILES };
  runtime.published = {};
  await runtime.reload();
  return { setup: pushes.at(-1), authored: runtime.files };
}

test("SandpackRuntime injects into the bundler's view when monitoring is on", async () => {
  const { setup, authored } = await pushedSetup({ monitor: true });

  assert.ok(
    setup.files["/src/main.js"].code.includes(MONITOR_MESSAGE_TYPE),
    "the compiled entry must carry the reporter",
  );
  assert.ok(
    setup.files["/src/main.js"].code.includes("console.log('demo');"),
    "the demo's own source must survive alongside it",
  );
  assert.equal(
    authored["/src/main.js"],
    "console.log('demo');",
    "the authored map is what Download-zip exports — it must stay clean",
  );
});

test("SandpackRuntime injects into both entries when they differ", async () => {
  // The parcel entry is the HTML file, and whether the classic bundler keeps a
  // <script> from its head is not knowable here — so the JS module gets it too. The
  // reporter's own `__hotRunnerMonitor` guard makes the second one inert at runtime.
  const { SandpackRuntime } = await import("../packages/runtime/dist/sandpack.js");
  const pushes = [];
  const runtime = new SandpackRuntime(
    { ...RUNTIME_ENTRY, sandpackEnvironment: "static", htmlEntry: "/index.html" },
    { iframe: {}, monitor: true },
  );
  runtime.client = { updateSandbox: (setup) => pushes.push(setup), listen: () => () => {}, destroy() {} };
  runtime.files = { ...RUNTIME_FILES, "/index.html": HTML };
  runtime.published = {};

  await runtime.reload();

  const files = pushes.at(-1).files;
  assert.ok(files["/index.html"].code.includes(MONITOR_MESSAGE_TYPE), "html entry");
  assert.ok(files["/src/main.js"].code.includes(MONITOR_MESSAGE_TYPE), "module entry");
});

test("SandpackRuntime injects nothing when the flag is off", async () => {
  const { setup } = await pushedSetup({});
  assert.equal(setup.files["/src/main.js"].code.includes(MONITOR_MESSAGE_TYPE), false);
});

test("isMonitorPayload rejects anything else on the page", () => {
  assert.equal(isMonitorPayload({ type: "webpackHotUpdate" }), false);
  assert.equal(isMonitorPayload(null), false);
  assert.equal(isMonitorPayload("hot-runner-monitor"), false);
  assert.equal(isMonitorPayload({ type: MONITOR_MESSAGE_TYPE, kind: "error" }), false, "message required");
});
