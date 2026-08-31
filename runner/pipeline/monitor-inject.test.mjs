import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import * as acorn from "acorn";
import {
  MONITOR_BREADCRUMB_CEILING,
  MONITOR_EVENT_CEILING,
  MONITOR_KINDS,
  MONITOR_MESSAGE_MAX,
  MONITOR_MESSAGE_TYPE,
  MONITOR_STACK_MAX,
  MONITOR_URL_MAX,
  REPORTER_MODULE_LINE,
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

// ---- DEV-2557: the module entry may shift the demo by at most one line -------
//
// Every position the bundler reports for the entry file is offset by whatever we
// prepended to it. Inlining the reporter body cost 226 lines at the releases the
// Sentry events were tagged with, and 283 after DEV-2552 grew it — which is how a
// syntax error in a 70-line file came back as "(257:22)". The injection is now one
// physical line, so the distortion *we* add is one line, and it stays that way only
// because these tests check it.

const MODULE_ENTRY = "/src/main.js";
const MODULE_SOURCE = ["import { grid } from './grid';", "", "// a comment", "grid();", ""].join("\n");

test("DEV-2557: a module entry is shifted by exactly one line", () => {
  // Computed from the split rather than asserted against a constant: a constant is
  // what put the wrong number in the ticket in the first place.
  const injected = injectReporter({ [MODULE_ENTRY]: MODULE_SOURCE }, MODULE_ENTRY)[MODULE_ENTRY];
  const before = MODULE_SOURCE.split("\n");
  const after = injected.split("\n");

  assert.equal(after.length - before.length, 1, "exactly one line added");
  for (let i = 0; i < before.length; i += 1) {
    assert.equal(after[i + 1], before[i], `authored line ${i + 1} lands on reported line ${i + 2}`);
  }
  assert.ok(after[0].includes(MONITOR_MESSAGE_TYPE), "and that one line is the reporter");
});

test("DEV-2557: the injected module prefix carries no line terminator", () => {
  // `JSON.stringify` escapes \n and \r but NOT U+2028/U+2029, which JS treats as
  // line terminators. REPORTER_SOURCE is ASCII today; this is the only thing
  // standing between a future non-ASCII edit and a silent return of the offset.
  // Built with `fromCharCode` rather than written literally, so no editor or
  // formatter can quietly normalise away the characters this test exists to reject.
  for (const [name, ch] of [
    ["LF", "\n"],
    ["CR", "\r"],
    ["U+2028", String.fromCharCode(0x2028)],
    ["U+2029", String.fromCharCode(0x2029)],
  ]) {
    assert.equal(REPORTER_MODULE_LINE.includes(ch), false, `prefix must not contain ${name}`);
  }
});

test("DEV-2557: module-entry injection is idempotent and byte-deterministic", () => {
  // The existing pair of tests covers the HTML entry only. `alreadyInjected` keys on
  // MONITOR_MESSAGE_TYPE appearing in the source, and the marker has to survive the
  // JSON escaping of the reporter body for a double injection to stay a no-op.
  const files = { [MODULE_ENTRY]: MODULE_SOURCE };
  const a = injectReporter(files, MODULE_ENTRY);
  const b = injectReporter(files, MODULE_ENTRY);
  assert.equal(a[MODULE_ENTRY], b[MODULE_ENTRY], "two builds of the same source are byte-identical");

  const twice = injectReporter(a, MODULE_ENTRY);
  assert.equal(twice, a, "second injection returns the same object, untouched");
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

test("the head injection adds no whitespace of its own", () => {
  // DEV-2580: the reporter goes into the head of a document the framework's server
  // already rendered, and a React 18 hydrator that owns the document strict-matches
  // head children. The newline that used to sit in front of the tag is a text node
  // there, and it is as fatal as the script element the tag now removes — measured
  // on the remix starter, each one reproduces React #418 alone. Mirrors the same
  // assertion in `scheme-bridge.test.mjs`: without it, half of the fix can be
  // reverted and ship a green suite.
  const out = injectReporterIntoHtml(HTML);
  assert.match(out, /<head[^>]*><script>/);
  assert.doesNotMatch(injectReporterIntoHtml("<body><div id=root></div></body>"), /<body[^>]*>\s/);
  assert.ok(injectReporterIntoHtml("<div id=root></div>").endsWith("<div id=root></div>"));
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

/** The stub environment the reporter is executed against — no DOM implementation
 *  needed. Extracted from `runReporter` so the DEV-2557 vm test can install the
 *  *same* stubs as real context globals and compare the two runs; the eval form
 *  evaluates in global scope and can never see `new Function` parameters.
 *
 *  Options, each present because one behaviour can only be reached through it:
 *  `fetch` and `XMLHttpRequest` install the transports the reporter wraps,
 *  `location` overrides the page's own host (pass `undefined` to make it
 *  unreadable), and `brokenAnchor` makes `document.createElement` throw, which is
 *  the only way to produce a network event with no attributable URL. */
function makeReporterStubs(options = {}) {
  const sent = [];
  const listeners = new Map();
  const passthrough = [];

  const win = {
    addEventListener(type, cb) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(cb);
    },
  };
  if (options.fetch) win.fetch = options.fetch;
  if (options.XMLHttpRequest) win.XMLHttpRequest = options.XMLHttpRequest;
  const parent = { postMessage: (payload) => sent.push(payload) };
  const consoleStub = {
    error: (...args) => passthrough.push(["error", ...args]),
    warn: (...args) => passthrough.push(["warn", ...args]),
  };
  const document = {
    createElement: () => {
      if (options.brokenAnchor) throw new Error("no document");
      return {
        set href(value) {
          // Resolved against the *preview's own* URL, because that is what a real
          // browser does with an anchor: `a.href = "/api/x"` resolves against the
          // document. This base is load-bearing now that the reporter compares the
          // parsed host against `location.host` — a foreign base would make every
          // relative request in these tests look third-party.
          const u = new URL(value, `https://${PREVIEW_HOST}`);
          this.protocol = u.protocol;
          this.host = u.host;
          this.pathname = u.pathname;
        },
      };
    },
  };

  // A token-bearing Tier-2 preview host, which is what the page is really served
  // from — the reporter must strip it from everything it sends.
  const location = "location" in options ? options.location : { host: PREVIEW_HOST };

  return {
    sent,
    passthrough,
    win,
    parent,
    document,
    location,
    XMLHttpRequest: options.XMLHttpRequest,
    console: consoleStub,
    fire(type, event) {
      for (const cb of listeners.get(type) ?? []) cb(event);
    },
  };
}

/** Run REPORTER_SOURCE against those stubs and return the harness. Bare `window`,
 *  `parent`, `console`, `document` and `XMLHttpRequest` in the reporter resolve to
 *  these parameters. */
function runReporter(options = {}) {
  const h = makeReporterStubs(options);
  // eslint-disable-next-line no-new-func
  new Function("window", "parent", "console", "document", "XMLHttpRequest", "location", REPORTER_SOURCE)(
    h.win,
    h.parent,
    h.console,
    h.document,
    h.XMLHttpRequest,
    h.location,
  );
  return h;
}

/** A fresh XHR stub class per call — the reporter patches `prototype.open`, so a
 *  shared class would end up wrapped once per harness. */
function makeFakeXHR() {
  return class FakeXHR {
    constructor() {
      this.handlers = {};
      this.status = 200;
    }
    addEventListener(type, cb) {
      (this.handlers[type] ||= []).push(cb);
    }
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    emit(type) {
      for (const cb of this.handlers[type] ?? []) cb.call(this);
    }
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

test("DEV-2557: the one-line eval form installs the same hooks as the inlined reporter", () => {
  // The one-line injection buys its line count with an indirect eval, so the eval
  // path has to be *executed*, not assumed — the DEV-2129 lesson again. `runReporter`
  // above cannot do it: it hands the stubs in as `new Function` parameters, and an
  // indirect eval evaluates in global scope where those bindings do not exist. Hence
  // a vm context, where the same stubs are real globals.
  //
  // Asserted as an equivalence against the inlined run rather than as "something was
  // sent": the payload is what the parent validates and Sentry receives, and a
  // divergence in it is the failure that would matter.
  const inlined = runReporter();
  inlined.fire("error", { error: new Error("boom"), message: "boom" });

  const evaled = makeReporterStubs();
  const context = vm.createContext({
    window: evaled.win,
    parent: evaled.parent,
    console: evaled.console,
    document: evaled.document,
    location: evaled.location,
    URL,
  });
  const injected = injectReporter({ [MODULE_ENTRY]: "globalThis.__demoRan = true;" }, MODULE_ENTRY)[MODULE_ENTRY];
  vm.runInContext(injected, context, { filename: MODULE_ENTRY });

  assert.equal(context.__demoRan, true, "the demo's own source still evaluates after the prefix");

  evaled.fire("error", { error: new Error("boom"), message: "boom" });
  assert.equal(evaled.sent.length, 1, "the eval-installed listener fired");
  assert.ok(isMonitorPayload(evaled.sent[0]), "payload passes the parent's own validation");
  // Structural compare: the payload is built inside the vm realm, so its prototype is
  // not this realm's Object.prototype and a strict deep-equal would fail on that
  // alone. The stack differs only by the two `new Error` call sites.
  assert.deepEqual(
    { ...evaled.sent[0], stack: undefined },
    { ...inlined.sent[0], stack: undefined },
    "eval-injected reporter produces the same payload as the inlined one",
  );
  assert.ok(evaled.sent[0].stack.includes("Error: boom"), "stack still relayed");
});

test("reporter relays an unhandled rejection", () => {
  const h = runReporter();
  h.fire("unhandledrejection", { reason: new Error("nope") });
  assert.equal(h.sent[0].kind, "rejection");
  assert.equal(h.sent[0].message, "nope");
});

test("reporter treats a failed resource load as a network fault", () => {
  const h = runReporter();
  h.fire("error", { target: { src: `https://${PREVIEW_HOST}/assets/x.js?token=secret` } });

  assert.equal(h.sent[0].kind, "network");
  assert.equal(h.sent[0].url, "https://<preview>/assets/x.js", "query stripped");
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

// ---- console.error(Error) belongs to the error channel (DEV-2552) -----------
//
// The Sandpack sandbox does both: it `console.error`s the evaluation failure *and*
// lets the throw reach the window `error` listener. Relaying both filed one fault as
// two Sentry issues — a stackless `console-error` at warning level (DEMOS-1A) and a
// stacked `error` (DEMOS-18) — which the dedupe could not merge, because its key
// (`kind|message|firstFrame`) starts with the kind.
//
// So the console copy is re-homed, not dropped: sent under kind `error` carrying the
// Error's own message and stack, which makes the key identical to the window
// listener's for the same Error. Whichever arrives first wins; the second is deduped.
//
// Re-homing rather than dropping is the whole point. Not every Error that reaches
// `console.error` has a window-`error` twin — DEMOS-19 (a DOMException out of React's
// commit phase) has none, and Angular's default `ErrorHandler` console.errors every
// error zone.js swallows, which is that framework's entire error reporting on both
// tiers. Dropping by content would have deleted those faults outright.

test("DEV-2552: console.error of an Error is relayed on the error channel, with its stack", () => {
  // The regression guard for the no-twin case above: no window `error` event is fired
  // here, and the fault must still be reported exactly once.
  const h = runReporter();
  h.console.error(new Error("boom"));

  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].kind, "error", "not `console-error` — this one has a stack");
  assert.equal(h.sent[0].message, "boom");
  assert.ok(h.sent[0].stack.includes("Error: boom"));
  assert.equal(h.passthrough.length, 1, "the demo's own console output must be untouched");
});

test("DEV-2552: an Error anywhere in the arguments re-homes the event, message and all", () => {
  // The message is the Error's own, not the joined arguments: that is what keeps the
  // dedupe key identical to the window listener's when the caller prefixes the log,
  // as Angular's `console.error('ERROR', err)` does.
  const h = runReporter();
  h.console.error("ERROR", 42, new Error("x"));

  assert.deepEqual(
    h.sent.map((p) => [p.kind, p.message]),
    [["error", "x"]],
  );
  assert.equal(h.passthrough.length, 1);
});

test("DEV-2552: one fault, one event, in either order", () => {
  // The duplication this ticket is about. Order-independent by construction, which
  // matters because the console copy consistently arrives first — a "skip what was
  // already seen" rule would have kept the stackless one.
  for (const consoleFirst of [true, false]) {
    const h = runReporter();
    const err = new Error("c is not defined");
    const fireWindow = () => h.fire("error", { error: err, message: err.message });
    if (consoleFirst) {
      h.console.error(err);
      fireWindow();
    } else {
      fireWindow();
      h.console.error(err);
    }

    assert.equal(h.sent.length, 1, `exactly one event (console first: ${consoleFirst})`);
    assert.equal(h.sent[0].kind, "error");
    assert.equal(h.sent[0].message, "c is not defined");
    assert.ok(h.sent[0].stack.includes("Error: c is not defined"));
  }
});

test("DEV-2552: an Error with a throwing message getter neither throws nor is lost", () => {
  // The extraction runs at the callsite, outside `send`'s own try/catch, and it must
  // not be able to throw out of the demo's `console.error` call — that would cost the
  // demo its console output as well as the report.
  const h = runReporter();
  const err = new Error("ignored");
  Object.defineProperty(err, "message", {
    get() {
      throw new Error("hostile getter");
    },
  });
  h.console.error(err);

  assert.deepEqual(
    h.sent.map((p) => [p.kind, p.message]),
    [["error", "unknown error"]],
  );
  assert.equal(h.passthrough.length, 1, "the demo's own console output still happens");
});

test("DEV-2552: a stackless console.error stays on the console channel", () => {
  // The regression guard against over-reaching: string arguments are what the console
  // channel exists for, and the library warnings it catches (an already-registered
  // theme, a bad dateFormat, a sanitizer notice) all look like this.
  const h = runReporter();
  h.console.error("bad", 42);

  assert.deepEqual(
    h.sent.map((p) => [p.kind, p.message]),
    [["console-error", "bad 42"]],
  );
});

test("DEV-2552: console.warn is not re-homed — it has no error-channel twin", () => {
  const h = runReporter();
  h.console.warn(new Error("careful"));

  assert.deepEqual(
    h.sent.map((p) => [p.kind, p.message]),
    [["console-warn", "careful"]],
  );
});

// ---- network events are same-origin only (DEV-2539, DEMOS-Z) ----------------
//
// The reporter runs inside the preview document, so `location.host` *is* the preview
// origin on both tiers — Sandpack's bundler host for Tier 1, the token-bearing
// `<port>-<id>-<token>.demos.handsontable.com` for Tier 2. Anything else is a third
// party, and a third party's failure is not the demo's fault: Tier 1's own bundler
// beacons to `col.csbops.io`, an ad blocker turns that into a fetch rejection, and
// the unfiltered wrapper filed one Sentry issue per visitor with a blocker.
//
// The gate lives in the reporter and nowhere else, on purpose: by the time a payload
// reaches the parent the host has been redacted to `<preview>` by design, so a
// parent-side origin check would be a check against a forgeable string.

test("reporter drops a third-party beacon", async () => {
  // The shape that actually produced the noise: a rejected `fetch`, not a resource
  // load. The wrapper must still rethrow — the reporter never changes what the demo
  // sees.
  const stub = () => Promise.reject(new TypeError("Failed to fetch"));
  const h = runReporter({ fetch: stub });

  // Asserted before the drop, because an empty `h.sent` proves nothing on its own:
  // it is also what a reporter that never installed the wrapper produces.
  assert.notEqual(h.win.fetch, stub, "the reporter wrapped window.fetch");

  await assert.rejects(() => h.win.fetch("https://col.csbops.io/data/sandpack", { method: "POST" }), /Failed to fetch/);
  assert.deepEqual(h.sent, [], "a blocked third-party beacon is not a demo fault");
});

test("reporter keeps a same-origin request failure", async () => {
  const h = runReporter({ fetch: () => Promise.resolve({ ok: false, status: 500 }) });

  const res = await h.win.fetch("/api/data", { method: "POST" });

  assert.equal(res.status, 500, "the demo still gets its own response");
  assert.deepEqual(
    h.sent.map((p) => [p.kind, p.message, p.url]),
    [["network", "POST 500", "https://<preview>/api/data"]],
  );
});

test("reporter drops a failed third-party resource load", () => {
  const h = runReporter();
  h.fire("error", { target: { src: "https://cdn.example.com/x.js" } });
  assert.deepEqual(h.sent, []);
});

test("reporter filters XHR by origin too", () => {
  // The XHR wrapper is a second, independent path to the same `send`, and it hooks
  // two events — `error`, and `load` with status >= 400. Both are exercised here, in
  // both directions, because each is a separate `scrub(this.__hotUrl)` callsite: drop
  // the `scrub` from either one and a third-party failure comes back *with its query
  // string*, which is the token exposure `scrub` exists to prevent.
  const XHR = makeFakeXHR();
  const h = runReporter({ XMLHttpRequest: XHR });

  const foreign = new XHR();
  foreign.open("GET", "https://cdn.example.com/data.json?token=secret");
  foreign.status = 404;
  foreign.emit("load");
  assert.deepEqual(h.sent, [], "cross-host XHR failure dropped");

  const foreignErr = new XHR();
  foreignErr.open("POST", "https://col.csbops.io/data/sandpack?token=secret");
  foreignErr.emit("error");
  assert.deepEqual(h.sent, [], "cross-host XHR transport error dropped");

  const own = new XHR();
  own.open("GET", "/api/rows");
  own.status = 500;
  own.emit("load");

  const ownErr = new XHR();
  ownErr.open("PUT", `https://${PREVIEW_HOST}/api/save?token=secret`);
  ownErr.emit("error");

  assert.deepEqual(
    h.sent.map((p) => [p.kind, p.message, p.url]),
    [
      ["network", "GET 500", "https://<preview>/api/rows"],
      ["network", "PUT failed", "https://<preview>/api/save"],
    ],
  );
});

test("a network event with no attributable url is dropped", () => {
  // `scrub` returns "" when the URL cannot be parsed. A network fault nobody can
  // locate is not worth an issue — that is half of what DEMOS-12 complained about.
  const h = runReporter({ brokenAnchor: true });
  h.fire("error", { target: { src: "https://cdn.example.com/x.js" } });
  assert.deepEqual(h.sent, []);
});

test("a data: url counts as the demo's own", () => {
  // A parsed host of "" cannot be a third-party beacon; it is the demo's own bytes.
  const h = runReporter();
  h.fire("error", { target: { src: "data:text/javascript,boom" } });
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].kind, "network");
});

test("the network filter fails open when the page's own host is unreadable", () => {
  // `location` unreadable leaves HOST empty, exactly as `redact` already handles.
  // Blinding the monitor is worse than relaying noise, so the gate must not become a
  // drop-everything when it cannot tell.
  const h = runReporter({ location: undefined });
  h.fire("error", { target: { src: "https://cdn.example.com/x.js" } });
  assert.equal(h.sent.length, 1, "fail open, not closed");
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

test("console warnings have their own ceiling and cannot crowd out errors", () => {
  // DEV-2539. Warnings are context, not faults: parent-side they become breadcrumbs
  // rather than issues, so they get a looser cap — but a separate one. Sharing the
  // relay ceiling would let a demo that warns on every render spend all 20 slots
  // before the console.error that explains the breakage is ever posted.
  const h = runReporter();
  for (let i = 0; i < MONITOR_BREADCRUMB_CEILING + 10; i++) h.console.warn(`warn ${i}`);
  h.console.error("the real fault");

  assert.equal(
    h.sent.filter((p) => p.kind === "console-warn").length,
    MONITOR_BREADCRUMB_CEILING,
    "warnings capped on their own budget",
  );
  assert.deepEqual(
    h.sent.filter((p) => p.kind === "console-error").map((p) => p.message),
    ["the real fault"],
    "the error still gets through after a flood of warnings",
  );
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

// Sentry DEMOS-4G, DEMOS-4V. `normalizeMonitorMessage`'s number rule
// (`/\b\d+(\.\d+)*\b/g`) has a trailing `\b` that fails to match where a digit run
// abuts a letter, so an ISO timestamp's milliseconds and `Z` survived, and every
// Tier-2 build failure minted a fresh Sentry fingerprint — 28 issues, one event
// each, in `handsoncode/demos`.

/** DEMOS-4G and DEMOS-4V: the same Angular build failure, two of the 28 issues it opened. */
const BUNDLE_A = "Application bundle generation failed. [0.431 seconds] - 2026-08-25T18:06:09.937Z";
const BUNDLE_B = "Application bundle generation failed. [1.595 seconds] - 2026-08-27T14:20:04.952Z";

const TS1005 = "✘ [ERROR] TS1005: ',' expected. [plugin angular-compiler]"; // DEMOS-3K
const TS2554 = "✘ [ERROR] TS2554: Expected 2 arguments, but got 1. [plugin angular-compiler]";
const TS2555 = "✘ [ERROR] TS2555: Expected 2 arguments, but got 1. [plugin angular-compiler]";

test("one build failure is one fingerprint, whatever the clock said", () => {
  assert.equal(normalizeMonitorMessage(BUNDLE_A), normalizeMonitorMessage(BUNDLE_B));
});

test("a compiler diagnostic code survives normalisation", () => {
  // THE discriminator. Collapsing the timestamp by relaxing the number rule's word
  // boundaries (/\d+(\.\d+)*/g) also passes the inequality test below, because the
  // prose differs — and silently turns every TS code into TS<n>. This assertion is
  // what fails under that fix.
  assert.match(normalizeMonitorMessage(TS1005), /\bTS1005\b/);
});

test("two codes with identical prose stay two issues", () => {
  // Constructed, not observed: no two live issues share prose today. TS2554/TS2555
  // both read "Expected N arguments, but got M", so the code is the only
  // discriminator — exactly the case a boundary-dropping fix fails to cover.
  assert.notEqual(normalizeMonitorMessage(TS2554), normalizeMonitorMessage(TS2555));
});

test("the other timestamp shapes a dev server prints collapse too", () => {
  // The [T ] and offset arms of the pattern, which the Angular fixture does not reach.
  assert.equal(
    normalizeMonitorMessage("done 2026-08-25 18:06:09 ok"),
    normalizeMonitorMessage("done 2026-08-27T14:20:04+02:00 ok"),
  );
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
  // `console-warn` stays *inside* the set (DEV-2539). It no longer files an issue —
  // `reportDemoEvent` turns it into a breadcrumb — but the payload has to reach that
  // branch, and rejecting it here would make the breadcrumb path dead code.
  assert.equal(isMonitorPayload({ ...base, kind: "console-warn" }), true);
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
  //
  // This must stay pointed at REPORTER_SOURCE and never at the injected output.
  // Since DEV-2557 the module entry carries the reporter as a single JSON string
  // literal, which parses at ES5 no matter what is inside it — repointing the guard
  // there would check nothing, forever.
  //
  // And the slip it catches got *quieter*, not louder, on that path: the injected form
  // is `try{(0,eval)(...)}catch(e){}`, so a parse failure inside the string is swallowed
  // by that catch and costs the demo nothing visible — Tier-1 monitoring simply goes
  // off, with no build error and no blank preview to notice it by. The HTML entry
  // (Tier-2's only channel, `workers/api/src/monitor-inject.ts`) still inlines the body,
  // where a slip is loud. This assertion is the only thing that fails first.
  assert.doesNotThrow(() => acorn.parse(REPORTER_SOURCE, { ecmaVersion: 5 }));
});

test("REPORTER_SOURCE cannot break out of a <script> block", () => {
  // It is inlined into HTML by both injectors.
  assert.equal(REPORTER_SOURCE.includes("</script"), false);
});
