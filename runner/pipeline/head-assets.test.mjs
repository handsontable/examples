import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { Parser } from "acorn";
import { SandpackRuntime } from "../packages/runtime/dist/sandpack.js";
import { SCHEME_MESSAGE_TYPE } from "../packages/runtime/dist/scheme.js";
import { MONITOR_MESSAGE_TYPE } from "../packages/runtime/dist/monitor.js";
import {
  HEAD_ASSETS_MARKER,
  HEAD_ASSETS_LINE_PREFIX,
  HEAD_ASSETS_LINE_SUFFIX,
  extractHeadAssets,
  headAssetsSource,
  headAssetsModuleLine,
  injectHeadAssets,
  stripInjectedHeadAssets,
} from "../packages/runtime/dist/head-assets.js";

// DEV-2576. The classic bundler renders the demo's <body> inside its own document
// shell and throws the authored <head> away — measured inside a live preview:
// `document.title` is "Sandbox - CodeSandbox" and there are no stylesheet links,
// while the bundler's own input FS still holds the authored HTML intact. So the
// head has to be re-created from the module entry, which is the one file the
// bundler is guaranteed to evaluate.
//
// What is *not* re-created is a local stylesheet: probing a payload on the deployed
// runner showed `./styles.css` already applying (the bundler resolves the local URL
// through the module graph) while the inline <style> beside it did not. Re-emitting
// it would double-apply and would drag CSS text into the injected line.

const FIXTURE = fs.readFileSync(
  path.join(import.meta.dirname, "fixtures", "head-assets-demo.html"),
  "utf8",
);

const CDN_CORE = "https://cdn.jsdelivr.net/npm/handsontable@18/styles/handsontable.min.css";
const CDN_THEME = "https://cdn.jsdelivr.net/npm/handsontable@18/styles/ht-theme-main.min.css";
const CDN_ICONS = "https://cdn.jsdelivr.net/npm/handsontable@18/styles/ht-icons-main.min.css";

const MODULE_ENTRY = "/index.js";
const HTML_ENTRY = "/index.html";

const filesWith = (html = FIXTURE, code = "grid();\n") => ({
  [HTML_ENTRY]: html,
  [MODULE_ENTRY]: code,
  "/styles.css": "#grid { outline: 3px solid rgb(1, 2, 3) }\n",
});

const hrefOf = (asset) => (asset.attrs ?? []).find(([name]) => name === "href")?.[1];

/** The injected line, as the bundler-facing entry will carry it. */
const lineFrom = (html) => headAssetsModuleLine(extractHeadAssets(html));

// ---------------------------------------------------------------- extraction

test("the fixture head extracts to exactly the assets the preview cannot get otherwise", () => {
  const assets = extractHeadAssets(FIXTURE);

  assert.deepEqual(assets, [
    { kind: "title", text: "Head assets demo" },
    { kind: "element", tag: "link", attrs: [["rel", "stylesheet"], ["href", CDN_CORE]] },
    { kind: "element", tag: "link", attrs: [["rel", "stylesheet"], ["href", CDN_THEME]] },
    { kind: "style", css: ":root { --e2e-head-sentinel: 7px }" },
    {
      kind: "element",
      tag: "meta",
      attrs: [["name", "viewport"], ["content", "width=device-width, initial-scale=1.0"]],
    },
    {
      kind: "element",
      tag: "link",
      attrs: [["rel", "preload"], ["href", CDN_ICONS], ["as", "style"]],
    },
    {
      kind: "element",
      tag: "link",
      attrs: [["rel", "stylesheet"], ["href", "data:text/css,%3Aroot%7B--e2e-data-sentinel%3A%209px%7D"]],
    },
  ]);
});

test("assets come out in document order, not grouped by kind", () => {
  // A plausible implementation buckets by kind (all links, then all styles) or
  // iterates a Record, and Record order is not a language guarantee across engines.
  // Source order is the only order that reproduces the authored cascade: the
  // fixture's inline <style> sits *after* the theme stylesheet, and swapping them
  // changes which one wins.
  const kinds = extractHeadAssets(FIXTURE).map((a) => a.kind);
  assert.deepEqual(kinds, ["title", "element", "element", "style", "element", "element", "element"]);
});

test("a local stylesheet is left to the bundler", () => {
  // Measured on the deployed runner: `./styles.css` linked from the head already
  // applies in the preview (its rule resolves) while the authored inline <style>
  // does not. So this is not a gap to fill — re-emitting it would apply the same
  // rules twice and force the file's text into the injected line.
  const hrefs = extractHeadAssets(FIXTURE).map(hrefOf);
  assert.ok(!hrefs.includes("./styles.css"), "local stylesheet not re-emitted");
});

test("a local non-stylesheet link is dropped, because local URLs answer with the bundler's shell", () => {
  // fetch() from inside the preview for /index.js, ./index.js, /index.html and
  // /package.json all answered 200 text/html with CodeSandbox's own SPA page. A
  // re-emitted /favicon.svg would fetch that document and render nothing.
  const hrefs = extractHeadAssets(FIXTURE).map(hrefOf);
  assert.ok(!hrefs.includes("/favicon.svg"), "local icon not re-emitted");
});

test("tags inside script text and inside comments are not assets", () => {
  // By the time this runs the scheme receiver is already a <script> in that head
  // (`injectSchemeIntoHtml`), so scanning raw head HTML would read our own
  // injection — and a demo can legitimately keep a commented-out link around.
  const hrefs = extractHeadAssets(FIXTURE).map(hrefOf);
  assert.ok(!hrefs.some((h) => h?.includes("in-script.css")), "script text is not scanned");
  assert.ok(!hrefs.some((h) => h?.includes("commented-out.css")), "comments are not scanned");
});

test("<meta charset> and <meta http-equiv> are dropped", () => {
  // Both are parse-time directives; setting them from script does nothing. Worse,
  // a re-created `http-equiv="refresh"` would actually navigate the preview away.
  const assets = extractHeadAssets(
    '<head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/gone">' +
      '<meta name="description" content="kept"></head>',
  );
  assert.deepEqual(assets, [
    { kind: "element", tag: "meta", attrs: [["name", "description"], ["content", "kept"]] },
  ]);
});

test("a <style media> keeps its media, so print CSS stays print CSS", () => {
  const assets = extractHeadAssets('<head><style media="print">body { color: #000 }</style></head>');
  assert.deepEqual(assets, [{ kind: "style", css: "body { color: #000 }", media: "print" }]);
});

test("no head, or a head with nothing to carry, extracts to nothing", () => {
  assert.deepEqual(extractHeadAssets("<html><body>hi</body></html>"), []);
  assert.deepEqual(extractHeadAssets("<head></head>"), []);
  assert.deepEqual(extractHeadAssets('<head><meta charset="utf-8"></head>'), []);
});

// ------------------------------------------------------------ emitted payload

test("the payload parses as ES5", () => {
  // The classic bundler runs its own 2018-era babel over the module entry, and a
  // parse failure there presents as a blank preview with no error card. `new
  // Function` in modern node accepts plenty that babel refuses, so the check names
  // the syntax level rather than just executing the string.
  Parser.parse(headAssetsSource(extractHeadAssets(FIXTURE)), { ecmaVersion: 5 });
});

test("the payload is one physical line, appended after the demo's own source", () => {
  // Appended, like the scheme receiver and unlike the monitor: this line carries
  // the demo's own bytes, so it can be long, and babel's code frame prints the two
  // lines *above* a fault verbatim. Prepending it would bury a syntax error on
  // authored line 1 the way DEV-2557's reporter did.
  const out = injectHeadAssets(filesWith(), HTML_ENTRY, MODULE_ENTRY);
  const code = out[MODULE_ENTRY];
  assert.ok(code.startsWith("grid();\n"), "the authored source stays first");
  const last = code.trimEnd().split("\n").at(-1);
  assert.equal(last, lineFrom(FIXTURE));
  assert.equal(last.split("\n").length, 1);
});

test("the strip constants compose the line exactly, so the strip cannot rot", () => {
  // Matched against the exported constants rather than a pattern, for the reason
  // `stripInjectedReporter` states: a regex over the injected *shape* keeps passing
  // its own tests while silently ceasing to match a reworded injection.
  const assets = extractHeadAssets(FIXTURE);
  const line = headAssetsModuleLine(assets);
  assert.equal(line, `try{(0,eval)(${JSON.stringify(headAssetsSource(assets))})}catch(e){}`);
  assert.ok(line.startsWith(HEAD_ASSETS_LINE_PREFIX));
  assert.ok(line.endsWith(HEAD_ASSETS_LINE_SUFFIX));

  const message = `SyntaxError: Unexpected token\n${line}\n  at eval`;
  const stripped = stripInjectedHeadAssets(message);
  assert.ok(!stripped.includes(CDN_THEME), "the demo's head is out of the message");
  assert.ok(stripped.includes("SyntaxError: Unexpected token"), "the diagnostic survives");
});

test("the payload carries no marker of the other two injectors", () => {
  // Both siblings decide idempotency with indexOf over the whole entry source, so a
  // payload that happened to contain their marker would make the colour-scheme
  // bridge or the monitor silently inert.
  const line = lineFrom(FIXTURE);
  assert.ok(!line.includes(SCHEME_MESSAGE_TYPE));
  assert.ok(!line.includes(MONITOR_MESSAGE_TYPE));
  assert.ok(line.includes(HEAD_ASSETS_MARKER));
});

test("no timestamp, counter or random value reaches the payload", () => {
  // `SandpackRuntime.pushUpdate` skips the push when the derived sandbox is
  // unchanged, and that skip is a correctness fix: the bundler's no-change path
  // resets the document without re-evaluating any module. A fresh value per call
  // would make every keystroke a real compile.
  const source = headAssetsSource(extractHeadAssets(FIXTURE));
  assert.doesNotMatch(source, /Date\.now|Math\.random|new Date/);
  const once = lineFrom(FIXTURE);
  const twice = lineFrom(FIXTURE);
  assert.equal(once, twice);
});

test("editing the head does change the payload", () => {
  // The inverse of the scheme receiver's contract, and deliberately so: that one is
  // a constant because it learns the scheme over postMessage, while this one *is*
  // the head. A head edit has to produce a real diff, or the preview keeps the old
  // title and the old stylesheet.
  const edited = FIXTURE.replace("Head assets demo", "Head assets demo!");
  assert.notEqual(lineFrom(edited), lineFrom(FIXTURE));
});

// --------------------------------------------------------------- the injector

test("the authored map is untouched and only the module entry gains the line", () => {
  // `/d/:id` is correct today *because* the static build reads the authored map,
  // and Download-zip, fork and the CodeSandbox/StackBlitz exports read it too. A
  // prelude leaking in there would ship runner plumbing inside every copy of a demo.
  const authored = filesWith();
  const before = JSON.stringify(authored);

  const out = injectHeadAssets(authored, HTML_ENTRY, MODULE_ENTRY);

  assert.equal(JSON.stringify(authored), before, "authored map untouched");
  assert.ok(out[MODULE_ENTRY].includes(HEAD_ASSETS_MARKER), "module entry carries the payload");
  assert.equal(out[HTML_ENTRY], authored[HTML_ENTRY], "the HTML entry is read, never written");
  assert.equal(out["/styles.css"], authored["/styles.css"], "non-entry files untouched");
});

test("nothing to do returns the very same object", () => {
  // `withInjections` reduces over this result and `sameFiles` diffs it key by key,
  // so a fresh object with equal contents is fine for correctness but wasteful — and
  // returning the same reference is what the two existing injectors promise.
  const files = filesWith();
  assert.equal(injectHeadAssets(files, null, MODULE_ENTRY), files, "no htmlEntry");
  assert.equal(injectHeadAssets(files, undefined, MODULE_ENTRY), files, "htmlEntry undefined");
  assert.equal(injectHeadAssets(files, "/nope.html", MODULE_ENTRY), files, "html file absent");
  assert.equal(injectHeadAssets(files, HTML_ENTRY, "/nope.js"), files, "module file absent");
  assert.equal(injectHeadAssets(files, HTML_ENTRY, HTML_ENTRY), files, "module entry is the document");

  const bareHead = { [HTML_ENTRY]: "<head></head>", [MODULE_ENTRY]: "grid();" };
  assert.equal(injectHeadAssets(bareHead, HTML_ENTRY, MODULE_ENTRY), bareHead, "nothing to carry");
});

test("injecting twice is a no-op, even when the head changed underneath", () => {
  const once = injectHeadAssets(filesWith(), HTML_ENTRY, MODULE_ENTRY);
  const twice = injectHeadAssets(once, HTML_ENTRY, MODULE_ENTRY);
  assert.equal(twice, once, "same object back");

  const withNewHead = { ...once, [HTML_ENTRY]: FIXTURE.replace("Head assets demo", "Changed") };
  const thrice = injectHeadAssets(withNewHead, HTML_ENTRY, MODULE_ENTRY);
  assert.equal(thrice, withNewHead, "marker wins over a changed head");
  assert.equal(
    thrice[MODULE_ENTRY].split(HEAD_ASSETS_MARKER).length - 1,
    once[MODULE_ENTRY].split(HEAD_ASSETS_MARKER).length - 1,
    "not double-prefixed",
  );
});

// ------------------------------------------------------------------ execution

/** A fake document, enough for the payload to build nodes against. */
function fakeDocument() {
  const head = { children: [], appendChild(node) { this.children.push(node); } };
  const created = [];
  const doc = {
    title: "Sandbox - CodeSandbox",
    head,
    createElement(tag) {
      const node = {
        tagName: tag.toUpperCase(),
        attrs: {},
        children: [],
        textContent: "",
        setAttribute(name, value) { this.attrs[name] = value; },
        appendChild(child) { this.children.push(child); this.textContent += child.text ?? ""; },
      };
      if (tag === "link") {
        Object.defineProperty(node, "href", {
          get() { return this.attrs.href ?? ""; },
          set(value) { this.attrs.href = value; },
        });
      }
      if (tag === "textarea") {
        Object.defineProperty(node, "innerHTML", {
          set(value) { this.value = value.replace(/&amp;/g, "&").replace(/&mdash;/g, "—"); },
        });
      }
      created.push(node);
      return node;
    },
    createTextNode: (text) => ({ text }),
    createEvent: () => ({ initEvent() {} }),
    getElementsByTagName(tag) {
      const want = tag.toUpperCase();
      return head.children.filter((node) => node.tagName === want);
    },
  };
  return { doc, created };
}

/** Run an injected module entry the way the bundler would, and report what it built. */
function runPayload(html, seed = []) {
  const { doc } = fakeDocument();
  seed.forEach((node) => doc.head.appendChild(node));
  const dispatched = [];
  const context = vm.createContext({
    document: doc,
    window: { dispatchEvent: (event) => dispatched.push(event) },
    demoRan: false,
  });
  context.window.document = doc;
  const out = injectHeadAssets({ [HTML_ENTRY]: html, [MODULE_ENTRY]: "demoRan = true;\n" }, HTML_ENTRY, MODULE_ENTRY);
  vm.runInContext(out[MODULE_ENTRY], context);
  return { doc, dispatched, context, appended: doc.head.children };
}

test("running the payload rebuilds the authored head", () => {
  // The one case that proves the feature: everything above asserts strings, and the
  // payload is a hand-written ES5 blob no typechecker reads.
  const { doc, appended, context } = runPayload(FIXTURE);

  assert.equal(context.demoRan, true, "the demo's own source still evaluates");
  assert.equal(doc.title, "Head assets demo", "the title reaches the document");
  assert.deepEqual(
    appended.map((node) => `${node.tagName} ${node.attrs.href ?? node.attrs.name ?? node.textContent}`),
    [
      `LINK ${CDN_CORE}`,
      `LINK ${CDN_THEME}`,
      "STYLE :root { --e2e-head-sentinel: 7px }",
      "META viewport",
      `LINK ${CDN_ICONS}`,
      "LINK data:text/css,%3Aroot%7B--e2e-data-sentinel%3A%209px%7D",
    ],
    "every asset, in authored order",
  );
  assert.ok(
    appended.every((node) => node.attrs["data-hot-runner-head"] === ""),
    "every generated node is tagged, so a second evaluation can recognise its own work",
  );
});

test("a stylesheet the document already has is not added twice", () => {
  // The head-dropping is measured on the parcel path; `vue-cli` is not, and a
  // template that *did* keep the head would otherwise fetch every stylesheet twice
  // and stack duplicate rules. `href` on the seed, not just the attribute: that is
  // what a real link reports, and it is what the guard compares.
  const existing = { tagName: "LINK", attrs: { href: CDN_THEME }, href: CDN_THEME, children: [], textContent: "" };
  const { appended } = runPayload(FIXTURE, [existing]);
  const themeLinks = appended.filter((node) => node.href === CDN_THEME || node.attrs.href === CDN_THEME);
  assert.equal(themeLinks.length, 1, "only the pre-existing link, no second copy");
  assert.equal(themeLinks[0], existing, "and it is the one that was already there");
  // The rest of the head still lands — the guard is per-asset, not a bail-out.
  assert.ok(appended.some((node) => node.attrs.href === CDN_CORE), "the other stylesheet still lands");
});

test("a style block the document already has is not added twice", () => {
  const css = ":root { --e2e-head-sentinel: 7px }";
  const existing = { tagName: "STYLE", attrs: {}, children: [], textContent: css };
  const { appended } = runPayload(FIXTURE, [existing]);
  const matching = appended.filter((node) => node.textContent === css);
  assert.equal(matching.length, 1, "only the pre-existing style");
  assert.equal(matching[0], existing);
});

test("the grid is nudged to re-measure once, plus once per stylesheet", () => {
  // Appending means the demo has already built its grid against an unstyled DOM,
  // and a cross-origin stylesheet arrives later still. A generic bubbling `resize`
  // is the demo-agnostic lever — Handsontable's own listener re-measures — and it
  // must be bounded, not a timer or a poll.
  const { dispatched, appended } = runPayload(FIXTURE);
  assert.equal(dispatched.length, 1, "one nudge after the loop");

  const links = appended.filter((node) => node.tagName === "LINK");
  links.forEach((node) => node.onload?.());
  assert.equal(dispatched.length, 1 + links.length, "one more per stylesheet that loads");
});

// -------------------------------------------------------------- the runtime

const entryFor = (over) => ({
  framework: "javascript",
  displayName: "JavaScript",
  tier: 1,
  engine: "sandpack",
  sandpackTemplate: "parcel",
  sandpackEnvironment: "parcel",
  container: null,
  htWrappers: [],
  entry: "/index.js",
  htmlEntry: "/index.html",
  devCommand: null,
  buildCommand: "build",
  outputDir: "dist",
  outputGlob: null,
  ...over,
});

/** Record what the runtime hands the bundler, without mounting one. */
function published(entry, files) {
  const runtime = new SandpackRuntime(entry, { iframe: {} });
  const pushes = [];
  runtime.client = {
    updateSandbox: (setup) => pushes.push(setup),
    destroy() {},
    listen: () => () => {},
  };
  runtime.files = { ...files };
  return { runtime, pushes };
}

test("the runtime injects the head into the module entry, never into the HTML entry", async () => {
  // The existing injectors are reduced over *both* targets on purpose. This one is
  // cross-file, so folding it into that reduce would inject into the HTML too —
  // where, by the premise of the bug, it would be thrown away.
  const { runtime } = published(entryFor(), filesWith());
  const derived = await runtime.sandboxFiles();

  assert.ok(derived["/index.js"].includes(HEAD_ASSETS_MARKER), "module entry carries it");
  assert.ok(!derived["/index.html"].includes(HEAD_ASSETS_MARKER), "HTML entry does not");
  assert.ok(derived["/index.js"].includes(CDN_THEME), "and it carries the theme stylesheet");
});

test("a vue-cli entry is covered too, even though its sandbox entry is the module", async () => {
  // `HTML_ENTRY_ENVS` is {parcel, static}, so on vue-cli `resolveSandboxEntry`
  // answers /src/main.js and the head would never be seen. The gate is the catalog
  // entry's own `htmlEntry`, which vue does declare.
  const files = {
    "/index.html": FIXTURE,
    "/src/main.js": "grid();\n",
    "/package.json": JSON.stringify({ dependencies: { handsontable: "18.0.0" } }),
  };
  const { runtime } = published(
    entryFor({ framework: "vue", sandpackEnvironment: "vue-cli", entry: "/src/main.js" }),
    files,
  );
  const derived = await runtime.sandboxFiles();
  assert.ok(derived["/src/main.js"].includes(HEAD_ASSETS_MARKER));
});

test("an entry with no htmlEntry is left exactly as it is today", async () => {
  const files = {
    "/src/main.js": "grid();\n",
    "/package.json": JSON.stringify({ dependencies: { handsontable: "18.0.0" } }),
  };
  const { runtime } = published(
    entryFor({ framework: "vue", sandpackEnvironment: "vue-cli", entry: "/src/main.js", htmlEntry: null }),
    files,
  );
  const derived = await runtime.sandboxFiles();
  assert.ok(!derived["/src/main.js"].includes(HEAD_ASSETS_MARKER));
});

test("a demo whose title names another injector still gets that injector", async () => {
  // Ordering, pinned: head assets are injected last, so the scheme and monitor
  // guards — plain indexOf over the whole entry — are decided on demo bytes only.
  const html = `<head><title>${SCHEME_MESSAGE_TYPE}</title></head>`;
  const { runtime } = published(entryFor(), filesWith(html));
  const derived = await runtime.sandboxFiles();
  const line = derived["/index.js"];
  assert.ok(line.includes(HEAD_ASSETS_MARKER), "head payload present");
  assert.ok(
    line.indexOf(SCHEME_MESSAGE_TYPE) !== line.lastIndexOf(SCHEME_MESSAGE_TYPE),
    "the scheme receiver is present as well as the demo's title text",
  );
});

test("the runtime's authored map never sees the payload", async () => {
  const { runtime } = published(entryFor(), filesWith());
  await runtime.sandboxFiles();
  assert.ok(!JSON.stringify(runtime.files).includes(HEAD_ASSETS_MARKER));
});
