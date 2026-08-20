import test from "node:test";
import assert from "node:assert/strict";
import { Parser } from "acorn";
import { SandpackRuntime } from "../packages/runtime/dist/sandpack.js";
import {
  SCHEME_MESSAGE_TYPE,
  SCHEME_STYLE_ID,
  SCHEME_RECEIVER_SOURCE,
  injectSchemeReceiver,
} from "../packages/runtime/dist/scheme.js";
import { injectScheme } from "../workers/api/src/monitor-inject.ts";

// DEV-2561 / ADR-0035. The shell's colour scheme is chrome; the preview is a
// separate, cross-origin document. This bridge is the only path between them, so
// what is pinned here is the part that is easy to break without noticing: that the
// receiver is a constant, that it never reaches a demo someone downloads, and that
// Tier 2 is *not* gated the way the monitor is.

const HTML = "<!doctype html><html><head><title>demo</title></head><body>hi</body></html>";

test("the receiver parses as ES5", () => {
  // Tier-1's parcel path runs babel 6 over injected code, which will not parse
  // anything newer — and `new Function` in modern node would accept plenty that
  // babel 6 refuses, so the check has to name the syntax level.
  Parser.parse(SCHEME_RECEIVER_SOURCE, { ecmaVersion: 5 });
});

test("the receiver is a byte-deterministic constant", () => {
  // `SandpackRuntime.sameFiles` skips the compile when the sandbox is unchanged.
  // A receiver carrying the current scheme — or a timestamp, or an id — would turn
  // every toggle into a full rebuild, which is the cost the postMessage bridge
  // exists to avoid.
  const once = injectSchemeReceiver({ "/index.js": "run();" }, "/index.js");
  const twice = injectSchemeReceiver({ "/index.js": "run();" }, "/index.js");
  assert.equal(once["/index.js"], twice["/index.js"]);
  // The scheme arrives over `postMessage`; a resolved `color-scheme:` value in the
  // source would mean it was baked in at injection time instead.
  assert.doesNotMatch(SCHEME_RECEIVER_SOURCE, /color-scheme:(light|dark|auto)/);
});

test("the override is !important, and says which element it targets", () => {
  // Measured, not assumed: `ThemeManager` prepends its own `<style>` *inside* the
  // theme wrapper, so an equal-specificity rule of ours loses on document order and
  // changes nothing at all. Losing the `!important` is a silent no-op, which is
  // exactly the kind of regression a test has to hold.
  assert.match(SCHEME_RECEIVER_SOURCE, /color-scheme:' \+ mode \+ ' !important/);
  assert.match(SCHEME_RECEIVER_SOURCE, /\[class\*="ht-theme-"\]/);
});

test("a JS entry keeps its own line numbers", () => {
  // Appended, not prepended: the receiver only answers a message, so it can go last
  // and leave every compile position the visitor is shown untouched. The monitor
  // cannot do this — it has to be hooked before the demo's scripts run — which is
  // why it settles for one physical line instead (DEV-2557).
  const out = injectSchemeReceiver({ "/index.js": "run();\n" }, "/index.js");
  assert.ok(out["/index.js"].startsWith("run();\n"), "the authored source stays first");
  const last = out["/index.js"].trimEnd().split("\n").at(-1);
  assert.ok(last.startsWith("try{"));
  assert.ok(last.includes(SCHEME_MESSAGE_TYPE));
});

test("an HTML entry gets a script in the head, and not a byte of whitespace", () => {
  const out = injectSchemeReceiver({ "/index.html": HTML }, "/index.html");
  // No newline between the tag and `<head>`: a React 18 hydrator that owns the
  // document strict-matches head children, and the leftover text node is as fatal
  // as the script element itself (DEV-2580, measured on the remix starter).
  assert.match(out["/index.html"], /<head[^>]*><script>/);
  assert.ok(out["/index.html"].includes("<title>demo</title>"), "the demo's document survives");
});

test("injection is idempotent, and a missing entry is not an error", () => {
  const once = injectSchemeReceiver({ "/index.js": "run();" }, "/index.js");
  assert.deepEqual(injectSchemeReceiver(once, "/index.js"), once);
  const files = { "/index.js": "run();" };
  assert.deepEqual(injectSchemeReceiver(files, "/nope.js"), files);
});

/** A runtime with a fake client attached, skipping mount() (needs a DOM + bundler).
 *  Same shape as `monitor-inject.test.mjs`, which pins the monitor's half of this. */
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
};

test("the receiver reaches the bundler but never the authored file map", async () => {
  // The authored map is what Download-zip, fork and the StackBlitz/CodeSandbox
  // exports read. Runner plumbing inside a downloaded demo is the failure this
  // invariant exists to prevent, and it is invisible from the preview itself.
  const pushes = [];
  const runtime = new SandpackRuntime(RUNTIME_ENTRY, { iframe: {} });
  runtime.client = {
    updateSandbox: (setup) => pushes.push(setup),
    listen: () => () => {},
    destroy() {},
  };
  runtime.files = {
    "/package.json": JSON.stringify({ dependencies: { handsontable: "18.0.0" } }),
    "/src/main.js": "console.log('demo');",
  };
  runtime.published = {};
  await runtime.reload();

  const pushed = pushes.at(-1).files["/src/main.js"].code;
  assert.ok(pushed.includes(SCHEME_MESSAGE_TYPE), "the bundler must see the receiver");
  assert.equal(
    runtime.files["/src/main.js"].includes(SCHEME_MESSAGE_TYPE),
    false,
    "the authored map must not carry it",
  );
});

test("the receiver is injected with monitoring off", async () => {
  // The monitor is gated on `opts.monitor`; this one is not. A preview the shell
  // cannot re-theme is the bug, not a missing diagnostic.
  const pushes = [];
  const runtime = new SandpackRuntime(RUNTIME_ENTRY, { iframe: {}, monitor: false });
  runtime.client = {
    updateSandbox: (setup) => pushes.push(setup),
    listen: () => () => {},
    destroy() {},
  };
  runtime.files = {
    "/package.json": JSON.stringify({ dependencies: { handsontable: "18.0.0" } }),
    "/src/main.js": "console.log('demo');",
  };
  runtime.published = {};
  await runtime.reload();

  const pushed = pushes.at(-1).files["/src/main.js"].code;
  assert.ok(pushed.includes(SCHEME_MESSAGE_TYPE));
  assert.equal(pushed.includes("hot-runner-monitor"), false, "the monitor stays gated");
});

test("Tier 2 injects without the monitor's flag", async () => {
  // The monitor is opt-in diagnostics; this is the only channel by which the
  // shell's toggle reaches a Tier-2 grid. Gating it on `MONITOR_DEMOS` would make a
  // shipped feature depend on a diagnostics flag and leave `wrangler dev` unable to
  // exercise it at all.
  const out = await injectScheme(
    new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } }),
  );
  const body = await out.text();
  assert.ok(body.includes(SCHEME_MESSAGE_TYPE));
  assert.ok(body.includes(SCHEME_STYLE_ID));
});

test("Tier 2 leaves everything that is not an identity-encoded document alone", async () => {
  const untouched = [
    new Response("{}", { headers: { "content-type": "application/json" } }),
    new Response(HTML, { headers: { "content-type": "text/html", "content-encoding": "gzip" } }),
  ];
  for (const response of untouched) {
    const body = await (await injectScheme(response)).text();
    assert.equal(body.includes(SCHEME_MESSAGE_TYPE), false);
  }
});

test("Tier 2 drops a now-wrong Content-Length", async () => {
  const out = await injectScheme(
    new Response(HTML, {
      headers: { "content-type": "text/html", "content-length": String(HTML.length) },
    }),
  );
  assert.equal(out.headers.get("content-length"), null);
});

// ---- the receiver, executed ---------------------------------------------------

/** A document stub with constructible-stylesheet support, and a real enough
 *  `adoptedStyleSheets` to catch the ObservableArray trap: assignment works,
 *  `concat`/`filter` do not exist on it. */
function makeSchemeStubs({ constructible = true, breakConstructor = false } = {}) {
  const created = [];
  class FakeSheet {
    constructor() {
      if (breakConstructor) throw new Error("no constructible stylesheets here");
      this.cssText = "";
      created.push(this);
    }
    replaceSync(text) {
      this.cssText = text;
    }
  }
  if (!constructible) delete FakeSheet.prototype.replaceSync;

  const elements = [];
  const head = {
    appendChild(node) {
      node.parentNode = head;
      elements.push(node);
      return node;
    },
    removeChild(node) {
      node.parentNode = null;
      elements.splice(elements.indexOf(node), 1);
      return node;
    },
  };
  const store = { sheets: [] };
  const document = {
    head,
    get adoptedStyleSheets() {
      return constructible ? store.sheets : undefined;
    },
    set adoptedStyleSheets(next) {
      store.sheets = next;
    },
    getElementById: (id) => elements.find((el) => el.id === id) ?? null,
    createElement: () => ({ id: "", textContent: "", parentNode: null }),
  };

  const listeners = [];
  const win = {
    addEventListener: (type, cb) => type === "message" && listeners.push(cb),
  };
  const parent = { postMessage() {} };
  win.parent = parent;

  // eslint-disable-next-line no-new-func
  new Function("window", "parent", "document", "CSSStyleSheet", SCHEME_RECEIVER_SOURCE)(
    win,
    parent,
    document,
    FakeSheet,
  );

  return {
    created,
    elements,
    adopted: () => store.sheets,
    send: (mode) => listeners.forEach((cb) => cb({ data: { source: SCHEME_MESSAGE_TYPE, mode } })),
  };
}

test("a mode is carried by an adopted stylesheet, never by a node in the head", () => {
  // DEV-2580: the shell answers `ready` while the preview's head is still parsing,
  // so a `<style>` appended there is present when a React 18 document hydrator runs
  // — and is exactly as fatal as the injected `<script>` was. An adopted sheet is
  // not a node, so no hydrator can see it.
  const h = makeSchemeStubs();
  h.send("dark");
  assert.equal(h.elements.length, 0, "the receiver must add no element to the head");
  assert.equal(h.adopted().length, 1);
  assert.match(h.adopted()[0].cssText, /color-scheme: *dark *!important/);
});

test("a second mode replaces the rule instead of adopting a second sheet", () => {
  const h = makeSchemeStubs();
  h.send("dark");
  h.send("light");
  assert.equal(h.adopted().length, 1);
  assert.equal(h.created.length, 1);
  assert.match(h.adopted()[0].cssText, /color-scheme: *light/);
});

test("`auto` detaches the sheet rather than blanking it", () => {
  // An adopted-but-empty sheet is invisible in the cascade but indistinguishable
  // from an active one from the outside, which would make `hasOverride` in
  // `e2e/preview-scheme.spec.ts` assert nothing.
  const h = makeSchemeStubs();
  h.send("dark");
  h.send("auto");
  assert.deepEqual(h.adopted(), []);
});

test("a sheet the demo adopted itself survives ours coming and going", () => {
  // `adoptedStyleSheets` is an ObservableArray: the receiver copies it with
  // `Array.prototype.slice` and assigns the copy back, so a demo's own sheet has to
  // still be there afterwards.
  const h = makeSchemeStubs();
  const theirs = { cssText: "theirs" };
  h.adopted().push(theirs);
  h.send("dark");
  assert.equal(h.adopted().length, 2);
  h.send("auto");
  assert.deepEqual(h.adopted(), [theirs]);
});

for (const [name, options] of [
  ["without constructible stylesheets", { constructible: false }],
  ["when the constructor throws", { breakConstructor: true }],
]) {
  test(`the toggle still works ${name}, over the <style> fallback`, () => {
    // Older Safari. The toggle keeps working there and a React 18 document hydrator
    // keeps mismatching — a browser-gated residue on the record, not a silent hole.
    const h = makeSchemeStubs(options);
    h.send("dark");
    assert.equal(h.elements.length, 1);
    assert.equal(h.elements[0].id, SCHEME_STYLE_ID);
    assert.match(h.elements[0].textContent, /color-scheme:dark !important/);
    h.send("auto");
    assert.equal(h.elements.length, 0);
  });
}
