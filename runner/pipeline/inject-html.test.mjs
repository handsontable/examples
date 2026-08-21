import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { Parser } from "acorn";
import { injectReporterIntoHtml } from "../packages/runtime/dist/monitor.js";
import { injectSchemeIntoHtml } from "../packages/runtime/dist/scheme.js";
import { SELF_REMOVING_PRELUDE, injectedScriptTag } from "../packages/runtime/dist/inject-html.js";

// DEV-2580. Both HTML injectors put their receiver in the `<head>` of a document
// the framework's server already rendered, and remix hydrates with
// `hydrateRoot(document, …)` on React 18 — which strict-matches head children, so
// an extra node there is a hydration mismatch and the whole document is
// client-rendered. What is pinned here is the property that makes the injection
// invisible to a hydrator: the tag deletes its own element as it runs.
//
// Executed, not read: a test asserting the emitted string "contains the removal
// snippet" would keep passing over a snippet that removes the wrong node, or that
// never runs because the payload threw first.

/** The inline source of the first `<script>` in `html`. */
function firstScriptSource(html) {
  const match = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match, "the injector emitted no inline script");
  return match[1];
}

/** A head with one child: the script that is executing. Records the removal. */
function makeDocument({ currentScript = true } = {}) {
  const removed = [];
  const head = {
    removeChild(node) {
      removed.push(node);
      node.parentNode = null;
      return node;
    },
    appendChild(node) {
      node.parentNode = head;
      return node;
    },
  };
  const script = { tagName: "SCRIPT", parentNode: head };
  return { doc: { currentScript: currentScript ? script : null, head }, script, removed };
}

/** Execute one injected `<script>`'s source against stubs. The payloads reach for
 *  bare `window`/`parent`/`console`/`document`/`location`, so hand them in as
 *  parameters the same way `monitor-inject.test.mjs` does. */
function runTag(source, { doc, throws = false } = {}) {
  // The scheme receiver stands down when `window.parent === window` and posts its
  // `ready` through it, so the stub parent has to be a distinct object.
  const parent = { postMessage() {} };
  const win = { addEventListener() {}, parent };
  // eslint-disable-next-line no-new-func
  const run = new Function(
    "window",
    "parent",
    "console",
    "document",
    "XMLHttpRequest",
    "location",
    source,
  );
  const call = () =>
    run(win, parent, { error() {}, warn() {} }, doc, undefined, { host: "x.test" });
  if (throws) assert.throws(call);
  else call();
}

for (const [name, html] of [
  ["the monitor", injectReporterIntoHtml("<html><head><title>d</title></head><body>hi</body></html>")],
  ["the scheme receiver", injectSchemeIntoHtml("<html><head><title>d</title></head><body>hi</body></html>")],
]) {
  test(`${name} removes its own script element from the head it was injected into`, () => {
    const { doc, script, removed } = makeDocument();
    runTag(firstScriptSource(html), { doc });
    assert.deepEqual(removed, [script], "the injected script element must be gone");
    assert.equal(script.parentNode, null);
  });
}

test("removal happens before the payload, so a throwing payload still leaves no node", () => {
  // The order is the guarantee: a `finally` around the payload would be one more
  // thing to get wrong, and a payload is allowed to throw.
  const { doc, script, removed } = makeDocument();
  runTag(firstScriptSource(injectedScriptTag("throw new Error('boom');")), { doc, throws: true });
  assert.deepEqual(removed, [script]);
});

test("a document with no currentScript is not an error", () => {
  // `document.currentScript` is null for a module or async script. The receivers
  // must never be the reason a preview fails to boot.
  const { doc, removed } = makeDocument({ currentScript: false });
  runTag(firstScriptSource(injectedScriptTag("var ok = 1;")), { doc });
  assert.deepEqual(removed, []);
});

test("the prelude leaks no global into the demo's document", () => {
  // An inline classic script runs in global scope, so a bare `var s` would land on
  // `window` and collide with whatever the demo calls `s`.
  const context = vm.createContext({ document: makeDocument().doc });
  const before = new Set(Object.keys(context));
  vm.runInContext(SELF_REMOVING_PRELUDE, context);
  const added = Object.keys(context).filter((key) => !before.has(key));
  assert.deepEqual(added, [], `the prelude added globals: ${added.join(", ")}`);
});

test("the prelude parses as ES5", () => {
  // Tier-1's parcel path runs babel 6 over the injected HTML entry, which will not
  // parse anything newer — the same gate the two receivers carry.
  Parser.parse(SELF_REMOVING_PRELUDE, { ecmaVersion: 5 });
});

test("the tag is byte-deterministic", () => {
  // `SandpackRuntime.sameFiles` skips the compile when the sandbox is unchanged.
  assert.equal(injectedScriptTag("run();"), injectedScriptTag("run();"));
});
