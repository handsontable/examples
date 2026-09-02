import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureEntryScript,
  entryScriptProblem,
  entryScriptTag,
  hasAnyScript,
  localScriptTargets,
} from "../packages/runtime/dist/entry-script.js";

// DEV-2741. `create_demo` published demos whose `/index.html` is a bare
// `<div id="grid"></div>` — no `<script>`, so neither the Tier-1 parcel bundler (whose
// entry *is* the HTML file) nor `vite build` on the `/d/:id` path has a module to run.
// Both produced a page holding the div and nothing else, and neither reported an error.
//
// The shape below is the one measured in production on `/share/6n1lu5k2s3` and
// `/share/6ri5be5l28`.

const FRAGMENT = '<div id="grid" style="height: 460px; width: 100%;"></div>\n';

const DOCUMENT = `<!doctype html>
<html>
  <body>
    <div id="grid"></div>
    <script type="module" src="/index.js"></script>
  </body>
</html>
`;

const FILES = { "/index.js": "console.log(1);", "/package.json": "{}" };

test("the reported fragment is diagnosed as having no script", () => {
  assert.deepEqual(entryScriptProblem(FRAGMENT, FILES), { kind: "no-script" });
});

test("a document that already loads its entry is left alone", () => {
  assert.equal(entryScriptProblem(DOCUMENT, FILES), null);
  assert.equal(ensureEntryScript(DOCUMENT, "/index.js"), DOCUMENT);
});

test("every spelling of a local src counts as loading the module", () => {
  for (const src of ["/index.js", "./index.js", "index.js"]) {
    const html = `<div id="grid"></div><script type="module" src="${src}"></script>`;
    assert.deepEqual(localScriptTargets(html), ["/index.js"], src);
    assert.equal(entryScriptProblem(html, FILES), null, src);
  }
});

test("single-quoted and unquoted src are read too", () => {
  assert.deepEqual(localScriptTargets(`<script src='/a.js'></script>`), ["/a.js"]);
  assert.deepEqual(localScriptTargets(`<script src=/b.js></script>`), ["/b.js"]);
});

test("a local script pointing at a file that was never sent is a dangling entry", () => {
  const html = `<div id="grid"></div><script type="module" src="/main.js"></script>`;
  assert.deepEqual(entryScriptProblem(html, FILES), { kind: "dangling", targets: ["/main.js"] });
});

test("an inline or external script is not ours to judge", () => {
  assert.equal(entryScriptProblem(`<script>hi()</script><div id="grid"></div>`, FILES), null);
  assert.equal(
    entryScriptProblem(`<script src="https://cdn.example/x.js"></script>`, FILES),
    null,
  );
});

test("a demo that loads a module other than the catalog's entry is accepted", () => {
  // `/src/main.js` builds and renders on both paths; refusing it would be a false
  // rejection, which is why the rule is "some module", not "the catalog's entry".
  const html = `<div id="grid"></div><script type="module" src="/src/main.js"></script>`;
  assert.equal(entryScriptProblem(html, { "/src/main.js": "" }), null);
});

test("repairing the fragment appends the entry tag", () => {
  assert.equal(
    ensureEntryScript(FRAGMENT, "/index.js"),
    '<div id="grid" style="height: 460px; width: 100%;"></div>\n' +
      '<script type="module" src="/index.js"></script>\n',
  );
});

test("repairing a document puts the tag before </body>", () => {
  const html = `<!doctype html>\n<html>\n  <body>\n    <div id="grid"></div>\n  </body>\n</html>\n`;
  assert.equal(
    ensureEntryScript(html, "/index.ts"),
    `<!doctype html>\n<html>\n  <body>\n    <div id="grid"></div>\n  ` +
      `<script type="module" src="/index.ts"></script>\n  </body>\n</html>\n`,
  );
});

test("the repair is idempotent on its own output", () => {
  const once = ensureEntryScript(FRAGMENT, "/index.js");
  assert.equal(ensureEntryScript(once, "/index.js"), once);
  assert.equal(entryScriptProblem(once, FILES), null);
});

test("the repaired tag is the one the starters emit", () => {
  assert.equal(entryScriptTag("/index.js"), '<script type="module" src="/index.js"></script>');
  assert.equal(hasAnyScript(FRAGMENT), false);
  assert.equal(hasAnyScript(DOCUMENT), true);
});
