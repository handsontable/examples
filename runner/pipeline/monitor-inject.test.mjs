import test from "node:test";
import assert from "node:assert/strict";
import * as acorn from "acorn";
import {
  MONITOR_EVENT_CEILING,
  MONITOR_KINDS,
  MONITOR_MESSAGE_MAX,
  MONITOR_MESSAGE_TYPE,
  MONITOR_STACK_MAX,
  MONITOR_URL_MAX,
  REPORTER_SOURCE,
  createMonitorBudget,
  injectReporter,
  injectReporterIntoHtml,
  isMonitorPayload,
  normalizeMonitorMessage,
  redactPreviewHosts,
  sanitizeMonitorPayload,
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

/** Shape of a real Tier-2 preview host: the third label is the session token. */
const PREVIEW_HOST = "3000-sbx7f2a-tok9xQ.demos.handsontable.com";

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

  // A token-bearing Tier-2 preview host, which is what the page is really served
  // from — the reporter must strip it from everything it sends.
  const location = { host: PREVIEW_HOST };

  // eslint-disable-next-line no-new-func
  new Function("window", "parent", "console", "document", "XMLHttpRequest", "location", REPORTER_SOURCE)(
    win,
    parent,
    consoleStub,
    document,
    undefined,
    location,
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
  new Function("window", "parent", "console", "document", "XMLHttpRequest", "location", REPORTER_SOURCE)(
    h.win,
    { postMessage: () => assert.fail("second injection must be inert") },
    h.console,
    { createElement: () => ({}) },
    undefined,
    { host: PREVIEW_HOST },
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

test("isMonitorPayload rejects a kind outside the closed set", () => {
  // `kind` becomes a Sentry tag and the payload is written by whoever authored the
  // demo, so an arbitrary string here is unbounded tag cardinality of their choosing
  // (Bugbot #190).
  const base = { type: MONITOR_MESSAGE_TYPE, message: "x" };
  assert.equal(isMonitorPayload({ ...base, kind: "error" }), true);
  assert.equal(isMonitorPayload({ ...base, kind: "whatever-i-want" }), false);
  assert.equal(isMonitorPayload({ ...base, kind: "" }), false);
  assert.equal(isMonitorPayload({ ...base, kind: 1 }), false);
});

test("isMonitorPayload rejects wrong types on the optional fields", () => {
  const base = { type: MONITOR_MESSAGE_TYPE, kind: "error", message: "x" };
  assert.equal(isMonitorPayload({ ...base, stack: 42 }), false);
  assert.equal(isMonitorPayload({ ...base, url: {} }), false);
  assert.equal(isMonitorPayload({ ...base, stack: "at f", url: "https://x/y" }), true);
});

test("MONITOR_KINDS covers exactly the kinds the reporter can emit", () => {
  // A kind the reporter sends but the allowlist omits is a silently dropped class of
  // report — the failure mode of a closed set is drift, so pin it.
  assert.deepEqual(
    [...MONITOR_KINDS].sort(),
    ["console-error", "console-warn", "error", "network", "rejection", "stderr"],
  );
});

// ---- preview-token redaction -----------------------------------------------
//
// Security review on #190, HIGH: a Tier-2 preview host is
// `<port>-<sandboxId>-<token>.demos.handsontable.com`, so **the hostname is a session
// credential**. It reaches telemetry three ways, not one — the review named the
// scrubbed URL, but a stack from the preview carries it in every frame, and any
// message quoting a URL carries it too. All three are covered here.

test("reporter strips its own preview host from url, stack and message", () => {
  const h = runReporter();

  h.fire("error", { target: { src: `https://${PREVIEW_HOST}/src/main.js` } });
  const err = new Error(`Failed to fetch https://${PREVIEW_HOST}/api/x`);
  err.stack = `Error: boom\n    at grid (https://${PREVIEW_HOST}/src/main.js:4:9)`;
  h.fire("error", { error: err });

  const blob = JSON.stringify(h.sent);
  assert.equal(blob.includes("tok9xQ"), false, "the session token must not leave the page");
  assert.equal(blob.includes(PREVIEW_HOST), false);
  assert.ok(h.sent[0].url.includes("<preview>"), "url redacted");
  assert.ok(h.sent[1].stack.includes("<preview>"), "stack redacted");
  assert.ok(h.sent[1].message.includes("<preview>"), "message redacted");
  assert.ok(h.sent[1].stack.includes("/src/main.js:4:9"), "the useful part of the frame survives");
});

test("reporter redaction is case-insensitive", () => {
  // The bug the first version of this fix shipped: the session token is mixed-case,
  // but anything through a URL parser — `scrub`, or a browser's own stack frames —
  // returns a lowercased hostname. A case-sensitive compare missed exactly the tokens
  // it existed to remove, and only a mixed-case fixture catches it.
  const h = runReporter();
  h.fire("error", { target: { src: `https://${PREVIEW_HOST.toLowerCase()}/x.js` } });

  assert.equal(h.sent[0].url.includes("tok9x"), false, "lowercased host must redact too");
  assert.ok(h.sent[0].url.includes("<preview>"));
});

test("redactPreviewHosts covers a payload the reporter never touched", () => {
  // The parent's backstop: a demo can post this shape directly, without the reporter.
  const dirty = `at f (https://3000-abc-SECRET.demos.handsontable.com/src/main.js:1:1)`;
  const clean = redactPreviewHosts(dirty);
  assert.equal(clean.includes("SECRET"), false);
  assert.ok(clean.includes("<preview>"));
  assert.ok(clean.includes("/src/main.js:1:1"));
});

test("redactPreviewHosts leaves the app origin and third parties readable", () => {
  // Only hosts with a subdomain label are preview hosts; the app's own origin has
  // none, and a CDN host carries no secret and is worth reading.
  assert.equal(
    redactPreviewHosts("https://demos.handsontable.com/api/versions failed"),
    "https://demos.handsontable.com/api/versions failed",
  );
  assert.equal(redactPreviewHosts("https://unpkg.com/handsontable@18.0.0"), "https://unpkg.com/handsontable@18.0.0");
});

test("sanitizeMonitorPayload bounds every field", () => {
  // Security review on #190, MEDIUM: `stack` was forwarded unbounded — hashed for
  // dedupe, fingerprinted, and sent — so a crafted postMessage was free resource
  // pressure regardless of the event ceiling.
  const clean = sanitizeMonitorPayload({
    type: MONITOR_MESSAGE_TYPE,
    kind: "error",
    message: "m".repeat(5000),
    stack: "s".repeat(50_000),
    url: `https://${PREVIEW_HOST}/${"p".repeat(5000)}`,
  });

  assert.equal(clean.message.length, MONITOR_MESSAGE_MAX + 3);
  assert.equal(clean.stack.length, MONITOR_STACK_MAX + 3);
  // Bounded, then redacted — so the url can come back *shorter* than the cap, because
  // the host it replaced was longer than the placeholder.
  assert.ok(clean.url.length <= MONITOR_URL_MAX + 3, `url still ${clean.url.length} long`);
  assert.equal(clean.url.includes("tok9xQ"), false, "redacted as well as bounded");
  assert.ok(clean.url.includes("<preview>"));
});

test("a host straddling the cap is still redacted", () => {
  // Bugbot #190, HIGH: truncating before redacting cut the hostname in half, and the
  // surviving prefix still carried the token — while `redactPreviewHosts` could no
  // longer match it, because the host it looks for was incomplete. Verified as a real
  // leak before the fix: the full `tok9xQ` reached the payload.
  //
  // The fixture places the token *inside* the cap and the `.demos…` suffix outside it,
  // which is exactly the boundary a crafted postMessage would aim for.
  const prefix = `https://${PREVIEW_HOST.split(".")[0]}`;
  const straddle = "x".repeat(MONITOR_MESSAGE_MAX - prefix.length) + `https://${PREVIEW_HOST}/x`;

  const clean = sanitizeMonitorPayload({
    type: MONITOR_MESSAGE_TYPE,
    kind: "error",
    message: straddle,
    stack: "s".repeat(MONITOR_STACK_MAX - prefix.length) + `at f (https://${PREVIEW_HOST}/a.js:1:1)`,
  });

  assert.equal(clean.message.includes("tok9x"), false, "no token fragment may survive the cap");
  assert.equal(clean.stack.includes("tok9x"), false);
  assert.ok(clean.message.length <= MONITOR_MESSAGE_MAX + 3, "still bounded");
});

test("reporter redacts before truncating too", () => {
  const h = runReporter();
  const prefix = `https://${PREVIEW_HOST.split(".")[0]}`;
  const err = new Error("y".repeat(MONITOR_MESSAGE_MAX - prefix.length) + `https://${PREVIEW_HOST}/x`);
  err.stack = `Error: boom\n    at f (https://${PREVIEW_HOST}/a.js:1:1)`;

  h.fire("error", { error: err });

  assert.equal(JSON.stringify(h.sent).includes("tok9x"), false);
});

test("sanitizeMonitorPayload keeps optional fields absent rather than empty", () => {
  const clean = sanitizeMonitorPayload({ type: MONITOR_MESSAGE_TYPE, kind: "console-warn", message: "x" });
  assert.equal("stack" in clean, false);
  assert.equal("url" in clean, false);
});

// ---- the parent-side budget ------------------------------------------------
//
// Bugbot #190, MEDIUM: the reporter's ceiling runs *inside* the preview, next to code
// the demo's author wrote — and for a shared or docs example that author is not the
// person viewing it. Such a demo can skip the reporter and postMessage crafted
// payloads with unique messages straight at the parent, so the in-page cap bounds
// nothing. These cover the copy that is actually enforceable.

test("budget stops at the ceiling however unique the messages are", () => {
  const budget = createMonitorBudget(3);
  const admitted = Array.from({ length: 50 }, (_, i) => budget.admit("error", `unique ${i}`));
  assert.equal(admitted.filter(Boolean).length, 3, "a flood of distinct messages is still capped");
});

test("budget dedupes on kind + message + first frame", () => {
  const budget = createMonitorBudget(10);
  const stack = "Error: x\n    at boom (https://preview/app.js:1:1)";

  assert.equal(budget.admit("error", "same", stack), true);
  assert.equal(budget.admit("error", "same", stack), false, "identical report");
  assert.equal(budget.admit("console-error", "same", stack), true, "a different kind is a different report");
  assert.equal(
    budget.admit("error", "same", "Error: x\n    at other (https://preview/app.js:9:9)"),
    true,
    "same message, different frame, is a different fault",
  );
});

test("budgets are independent instances", () => {
  // The app holds one per page load; a per-mount budget would hand out a fresh
  // allowance on every example switch.
  const a = createMonitorBudget(1);
  const b = createMonitorBudget(1);
  assert.equal(a.admit("error", "x"), true);
  assert.equal(a.admit("error", "y"), false);
  assert.equal(b.admit("error", "x"), true, "a separate budget is unaffected");
});

test("REPORTER_SOURCE parses as ES5", () => {
  // Bugbot #190 caught a trailing comma in a `.then(...)` call — ES2017 — that the
  // execution tests above could never see, because `new Function` in modern Node
  // accepts it. The classic bundler runs 2018-era babel over the entry it is
  // prepended to, where a parse failure is a blank Tier-1 preview.
  //
  // Parsed, not grepped: a syntax allowlist is a list of the mistakes already made.
  assert.doesNotThrow(() => acorn.parse(REPORTER_SOURCE, { ecmaVersion: 5 }));
});

test("REPORTER_SOURCE cannot break out of a <script> block", () => {
  // It is inlined into HTML by both injectors.
  assert.equal(REPORTER_SOURCE.includes("</script"), false);
});
