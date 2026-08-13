// Importing from JSFiddle / StackBlitz (DEV-2504).
//
// Both parsers read an undocumented payload — a server-rendered textarea and a
// Redux snapshot — so the fixtures here are recorded from real projects:
//
//   pipeline/fixtures/jsfiddle-1bw9tphk.html              (jsfiddle.net/1bw9tphk/1/)
//   pipeline/fixtures/stackblitz-vitejs-vite-de8qy2bm.html (stackblitz.com/edit/vitejs-vite-de8qy2bm)
//
// Trimmed for size, never reshaped: when a provider changes its page, these are
// what fail. No network — the fetch is injected.
//
// Run: node --experimental-strip-types --test pipeline/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ImportError,
  assertHandsontableProject,
  detectFramework,
  packageFromCdnUrl,
  importFromUrl,
  parseJsFiddle,
  parseStackBlitz,
  resolveSource,
  usesHandsontable,
} from "../workers/api/src/import-url.ts";

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(dir, "fixtures", name), "utf8");
const JSFIDDLE = fixture("jsfiddle-1bw9tphk.html");
const STACKBLITZ = fixture("stackblitz-vitejs-vite-de8qy2bm.html");
/** The fiddle from the DEV-2509 report: five CDN scripts, three globals. */
const CDN_FIDDLE = fixture("jsfiddle-cdn-globals.html");

/** The catalog's framework keys, as the Worker passes them in. */
const KNOWN = new Set([
  "javascript", "typescript", "react", "react-js", "vue", "angular",
  "next.js", "nuxt", "remix", "astro",
]);

// ---- the host gate ---------------------------------------------------------

test("recognizes JSFiddle URLs in every shape they are shared in", () => {
  for (const input of [
    "https://jsfiddle.net/1bw9tphk/1/",
    "https://jsfiddle.net/1bw9tphk/1",
    "https://www.jsfiddle.net/1bw9tphk/1/show/",
    "https://jsfiddle.net/1bw9tphk/1/embedded/js,html,css/",
  ]) {
    const { provider, url } = resolveSource(input);
    assert.equal(provider, "jsfiddle", input);
    assert.equal(url, "https://jsfiddle.net/1bw9tphk/1/", input);
  }
  // A user-scoped fiddle keeps its user segment.
  assert.equal(
    resolveSource("https://jsfiddle.net/someone/abc123/2/").url,
    "https://jsfiddle.net/someone/abc123/2/",
  );
});

test("recognizes StackBlitz URLs and drops the ?file= the user copied", () => {
  const { provider, url } = resolveSource(
    "https://stackblitz.com/edit/vitejs-vite-de8qy2bm?file=index.html",
  );
  assert.equal(provider, "stackblitz");
  assert.equal(url, "https://stackblitz.com/edit/vitejs-vite-de8qy2bm");
  // A github-backed project serves the same editor page under its own path.
  assert.equal(
    resolveSource("https://stackblitz.com/github/handsontable/examples").url,
    "https://stackblitz.com/github/handsontable/examples",
  );
});

test("CodeSandbox is refused with the route that does work", () => {
  // Its API answers 403 behind a bot challenge and the devbox page carries no
  // files, so the error has to be an instruction, not a failure.
  assert.throws(
    () => resolveSource("https://codesandbox.io/p/devbox/nj3gp2?file=%2Fpackage.json"),
    (error) => error instanceof ImportError && /Export the sandbox to a \.zip/.test(error.message),
  );
});

test("refuses anything outside the allowlist, including lookalike hosts", () => {
  for (const input of [
    "https://jsfiddle.net.evil.example/1bw9tphk/",
    "https://evil.example/?u=https://jsfiddle.net/1bw9tphk/",
    "https://github.com/handsontable/examples",
    "http://jsfiddle.net/1bw9tphk/1/",           // http, not https
    "https://127.0.0.1/",
    "https://192.168.1.10/admin",
    "not a url",
  ]) {
    assert.throws(() => resolveSource(input), ImportError, input);
  }
});

// ---- JSFiddle --------------------------------------------------------------

test("a fiddle becomes a runnable three-file workspace", () => {
  const result = parseJsFiddle(JSFIDDLE, "https://jsfiddle.net/1bw9tphk/1/");
  assert.deepEqual(
    Object.keys(result.files).sort(),
    ["/index.html", "/package.json", "/script.js", "/style.css"],
  );
  // The HTML panel is a fragment; the import has to host it in a document that
  // references the two sibling files, the way JSFiddle's own runner does.
  assert.match(result.files["/index.html"], /<!doctype html>/i);
  assert.match(result.files["/index.html"], /<link rel="stylesheet" href="\.\/style\.css" \/>/);
  assert.match(result.files["/index.html"], /<script type="module" src="\.\/script\.js"><\/script>/);
  assert.match(result.files["/index.html"], /Imported from https:\/\/jsfiddle\.net\/1bw9tphk\/1\//);
  // /package.json is not optional: POST /api/demos rejects a file set without one.
  assert.ok(JSON.parse(result.files["/package.json"]).devDependencies.vite);
});

test("panel contents are HTML-unescaped, not carried as entities", () => {
  const result = parseJsFiddle(JSFIDDLE, "https://jsfiddle.net/1bw9tphk/1/");
  // The panels arrive decoded — no `&lt;`, no `&quot;` — and the JS is the real
  // source. The Handsontable CSS the fiddle linked from a CDN is *not* here any
  // more: it became an npm import (DEV-2509, tested below), because a CDN URL with
  // no version in it would ignore the version picker.
  assert.equal(result.files["/index.html"].includes("&lt;"), false);
  assert.equal(result.files["/index.html"].includes("&quot;"), false);
  assert.match(result.files["/script.js"], /const HEADERS = \[/);
  assert.match(result.files["/style.css"], /:root \{/);
});

test("a fiddle's title comes from the page, minus the site suffix", () => {
  const html = JSFIDDLE.replace(/<title>[\s\S]*?<\/title>/, "<title>Invoice grid - JSFiddle - Code Playground</title>");
  assert.equal(parseJsFiddle(html, "u").title, "Invoice grid");
});

test("a page with no panels fails with the manual route, not a crash", () => {
  assert.throws(
    () => parseJsFiddle("<html><body>nothing here</body></html>", "u"),
    (error) => error instanceof ImportError && error.status === 502,
  );
});

test("an empty fiddle is refused rather than imported blank", () => {
  const html = `<textarea name="code_html" id="textarea-code-html"></textarea>
    <textarea name="code_css" id="textarea-code-css">  </textarea>
    <textarea name="code_js" id="textarea-code-js"></textarea>`;
  assert.throws(() => parseJsFiddle(html, "u"), /no HTML and no JavaScript/);
});

// ---- CDN globals -> npm imports (DEV-2509) ---------------------------------

test("a CDN-based fiddle becomes a module the bundler can resolve", () => {
  // The reported bug: this exact fiddle imported "successfully" and then died with
  // `ReferenceError: Handsontable is not defined`, because its libraries were
  // <script> tags and its code called them as globals.
  const result = parseJsFiddle(CDN_FIDDLE, "https://jsfiddle.net/1bw9tphk/1/");
  const html = result.files["/index.html"];
  const js = result.files["/script.js"];
  const pkg = JSON.parse(result.files["/package.json"]);

  // Every recognized CDN script is gone from the markup…
  for (const url of [
    "cdn.jsdelivr.net/npm/handsontable/dist/handsontable.full.min.js",
    "cdn.jsdelivr.net/npm/hyperformula/dist/hyperformula.full.min.js",
    "cdn.jsdelivr.net/npm/highlight.js@11/lib/highlight.min.js",
  ]) {
    assert.equal(html.includes(url), false, url);
  }
  // …and back as imports under the identifiers the globals had, so the fiddle's
  // own code needs no rewriting.
  assert.match(js, /^\/\/ Imported from a CDN-based demo/m);
  assert.match(js, /import Handsontable from 'handsontable';/);
  assert.match(js, /import \{ HyperFormula \} from 'hyperformula';/);
  assert.match(js, /import hljs from 'highlight\.js';/);
  // Inline scripts in the HTML used the globals too, so they stay on globalThis.
  assert.match(js, /globalThis\.Handsontable = Handsontable;/);
  // The body survived, unedited.
  assert.match(js, /const DATA = \[/);
  assert.match(js, /hljs\.highlightAll\(\);/);

  // Dependencies, with the version the CDN URL pinned where it pinned one.
  assert.equal(pkg.dependencies.handsontable, "latest"); // unversioned CDN URL
  assert.equal(pkg.dependencies["highlight.js"], "^11");
  assert.equal(pkg.dependencies["hyperformula"], "latest");
  // The fiddle also loads xlsx and chart.js and never calls them, so they are
  // dropped rather than depended on — the same branch the dedicated test covers.
  assert.equal(pkg.dependencies.xlsx, undefined);
  assert.equal(pkg.dependencies["chart.js"], undefined);
  // Deterministic order, so re-importing the same fiddle gives the same manifest.
  assert.deepEqual(Object.keys(pkg.dependencies), [...Object.keys(pkg.dependencies)].sort());
});

test("Handsontable's CSS follows the selected version, not the CDN's latest", () => {
  const result = parseJsFiddle(CDN_FIDDLE, "u");
  assert.equal(result.files["/index.html"].includes("npm/handsontable/styles/"), false);
  assert.match(result.files["/script.js"], /import 'handsontable\/styles\/handsontable\.min\.css';/);
  assert.match(result.files["/script.js"], /import 'handsontable\/styles\/ht-theme-main\.min\.css';/);
  // A third-party stylesheet is left alone: it loads fine and pins nothing we care
  // about.
  assert.match(result.files["/index.html"], /highlight\.js@11\/styles\/atom-one-dark\.min\.css/);
});

test("an unrecognized CDN script keeps its tag and is reported", () => {
  const html = `<textarea name="code_html" id="textarea-code-html">&lt;script src=&quot;https://cdn.jsdelivr.net/npm/some-unknown-lib@2/dist/x.min.js&quot;&gt;&lt;/script&gt;
    &lt;div id=&quot;grid&quot;&gt;&lt;/div&gt;</textarea>
    <textarea name="code_js" id="textarea-code-js">new Handsontable(document.getElementById('grid'), {});</textarea>`;
  const result = parseJsFiddle(html, "u");
  // Dropping someone's library silently would be worse than saying it may not run.
  assert.match(result.files["/index.html"], /some-unknown-lib@2/);
  assert.equal(
    result.skipped.some((s) => /may not run in the preview/.test(s.reason)),
    true,
  );
});

test("a CDN script whose global is never used is dropped, not depended on", () => {
  const html = `<textarea name="code_html" id="textarea-code-html">&lt;script src=&quot;https://cdn.jsdelivr.net/npm/jquery@3/dist/jquery.min.js&quot;&gt;&lt;/script&gt;
    &lt;script src=&quot;https://cdn.jsdelivr.net/npm/handsontable/dist/handsontable.full.min.js&quot;&gt;&lt;/script&gt;</textarea>
    <textarea name="code_js" id="textarea-code-js">new Handsontable(document.body, {});</textarea>`;
  const result = parseJsFiddle(html, "u");
  const pkg = JSON.parse(result.files["/package.json"]);
  assert.equal(pkg.dependencies.jquery, undefined, "no dependency for an unused global");
  assert.equal(pkg.dependencies.handsontable, "latest");
  assert.equal(result.skipped.some((s) => /never referenced/.test(s.reason)), true);
});

test("a fiddle that already uses imports gets no preamble", () => {
  const html = `<textarea name="code_html" id="textarea-code-html">&lt;div id=&quot;grid&quot;&gt;&lt;/div&gt;</textarea>
    <textarea name="code_js" id="textarea-code-js">import Handsontable from 'handsontable';
new Handsontable(document.getElementById('grid'), {});</textarea>`;
  const result = parseJsFiddle(html, "u");
  assert.equal(result.files["/script.js"].includes("Imported from a CDN-based demo"), false);
  assert.equal((result.files["/script.js"].match(/import Handsontable/g) ?? []).length, 1);
});

test("the CDN URL shapes we actually see all resolve to a package", () => {
  const cases = [
    ["https://cdn.jsdelivr.net/npm/handsontable/dist/handsontable.full.min.js", "handsontable", null],
    ["https://cdn.jsdelivr.net/npm/highlight.js@11/lib/highlight.min.js", "highlight.js", "11"],
    ["https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js", "xlsx", "0.18.5"],
    ["https://cdn.jsdelivr.net/npm/@handsontable/pikaday@1.0.0/dist/pikaday.js", "@handsontable/pikaday", "1.0.0"],
    ["https://unpkg.com/hyperformula@3.4.0/dist/hyperformula.full.min.js", "hyperformula", "3.4.0"],
    ["https://unpkg.com/@handsontable/pikaday/dist/pikaday.js", "@handsontable/pikaday", null],
    ["https://cdnjs.cloudflare.com/ajax/libs/handsontable/14.0.0/handsontable.min.js", "handsontable", "14.0.0"],
  ];
  for (const [url, name, range] of cases) {
    const found = packageFromCdnUrl(url);
    assert.equal(found?.name, name, url);
    assert.equal(found?.range ?? null, range, url);
  }
  // Not a CDN we read packages from.
  assert.equal(packageFromCdnUrl("https://example.com/lib.js"), null);
  assert.equal(packageFromCdnUrl("not a url"), null);
});

// ---- StackBlitz ------------------------------------------------------------

test("a StackBlitz project becomes its own file set", () => {
  const result = parseStackBlitz(STACKBLITZ);
  assert.equal(result.title, "ToolBar Demo");
  const paths = Object.keys(result.files).sort();
  // The .svg comes along: it is text, and vite treats an inline icon as a module.
  assert.deepEqual(paths, [
    "/index.html",
    "/package.json",
    "/src/icons/bold.svg",
    "/src/main.ts",
    "/src/style.css",
  ]);
  assert.match(result.files["/src/main.ts"], /import Handsontable from 'handsontable'/);
  assert.equal(JSON.parse(result.files["/package.json"]).dependencies.handsontable, "^18.0.0");
});

test("folders, build output, lockfiles and binaries are left behind", () => {
  const result = parseStackBlitz(STACKBLITZ);
  // `src` is a folder row in the payload — it has no contents to import.
  assert.equal(result.files["/src"], undefined);
  // dist/ and package-lock.json are in the real project and must not come along.
  assert.equal(result.files["/dist/index.html"], undefined);
  assert.equal(result.files["/package-lock.json"], undefined);
  // An .svg is text, but it is still reported rather than silently included or
  // silently dropped — the author should know what did not come across.
  const svg = result.skipped.find((s) => s.path === "/src/icons/bold.svg");
  assert.equal(svg, undefined, "svg is text and should import");
});

test("a page without the Redux payload names the Download fallback", () => {
  assert.throws(
    () => parseStackBlitz("<html><body>SPA shell</body></html>"),
    (error) => error instanceof ImportError && /Download button/.test(error.message),
  );
});

test("a project with no package.json is refused with the reason", () => {
  const store = JSON.stringify({
    project: {
      title: "No manifest",
      appFiles: { "index.html": { name: "index.html", type: "file", contents: "<div/>", fullPath: "index.html" } },
    },
  });
  const html = `<script type="application/json" data-redux-store="">${store}</script>`;
  assert.throws(() => parseStackBlitz(html), /no package\.json/);
});

test("a traversal path is refused, not normalized", () => {
  // Security review: these keys reach the builder as CONTAINER_ROOT + path when a
  // demo is saved, so `../../` must not survive the import. Refused rather than
  // rewritten — a path that needs fixing to be safe is not one to import.
  const store = JSON.stringify({
    project: {
      title: "Crafted",
      appFiles: {
        "package.json": { type: "file", contents: JSON.stringify({ dependencies: { handsontable: "18.0.0" } }), fullPath: "package.json" },
        "ok.ts": { type: "file", contents: "import 'handsontable';", fullPath: "src/ok.ts" },
        "escape": { type: "file", contents: "pwned", fullPath: "../../etc/passwd.ts" },
        "dotdot": { type: "file", contents: "pwned", fullPath: "src/../../outside.ts" },
        "windows": { type: "file", contents: "pwned", fullPath: "..\\..\\windows\\evil.ts" },
      },
    },
  });
  const result = parseStackBlitz(`<script type="application/json" data-redux-store="">${store}</script>`);
  assert.deepEqual(Object.keys(result.files).sort(), ["/package.json", "/src/ok.ts"]);
  assert.equal(
    result.skipped.filter((entry) => entry.reason === "unsafe path").length,
    3,
    "every traversal path is reported",
  );
  // Nothing escaped, under any spelling.
  for (const path of Object.keys(result.files)) {
    assert.equal(path.includes(".."), false, path);
    assert.match(path, /^\/[^/]/, path);
  }
});

test("an .env file is skipped and said out loud", () => {
  const store = JSON.stringify({
    project: {
      title: "Secrets",
      appFiles: {
        "package.json": { type: "file", contents: "{}", fullPath: "package.json" },
        ".env.local": { type: "file", contents: "TOKEN=hunter2", fullPath: ".env.local" },
      },
    },
  });
  const html = `<script type="application/json" data-redux-store="">${store}</script>`;
  const result = parseStackBlitz(html);
  assert.equal(result.files["/.env.local"], undefined);
  assert.deepEqual(result.skipped, [{ path: "/.env.local", reason: "environment file" }]);
});

// ---- framework detection ---------------------------------------------------

test("the framework follows the dependencies, then the file extensions", () => {
  const pkg = (deps) => ({ "/package.json": JSON.stringify({ dependencies: deps }) });
  assert.equal(detectFramework(pkg({ next: "15" }), KNOWN), "next.js");
  assert.equal(detectFramework(pkg({ "@angular/core": "18" }), KNOWN), "angular");
  assert.equal(detectFramework(pkg({ vue: "3" }), KNOWN), "vue");
  // React resolves by what the files are, because the catalog has both.
  assert.equal(detectFramework({ ...pkg({ react: "19" }), "/src/App.tsx": "" }, KNOWN), "react");
  assert.equal(detectFramework({ ...pkg({ react: "19" }), "/src/App.jsx": "" }, KNOWN), "react-js");
  // No framework dependency: vanilla, TS or JS by extension.
  assert.equal(detectFramework({ ...pkg({ handsontable: "18" }), "/index.ts": "" }, KNOWN), "typescript");
  assert.equal(detectFramework({ ...pkg({ handsontable: "18" }), "/index.js": "" }, KNOWN), "javascript");
  // Malformed manifest degrades instead of throwing: an author can change the
  // framework afterwards, but cannot recover code from a refused import.
  assert.equal(detectFramework({ "/package.json": "{ not json" }, KNOWN), "javascript");
});

test("the real fixtures resolve to sensible frameworks", () => {
  const fiddle = parseJsFiddle(JSFIDDLE, "u");
  assert.equal(detectFramework(fiddle.files, KNOWN), "javascript");
  const project = parseStackBlitz(STACKBLITZ);
  // handsontable + vite + a .ts entry -> the TypeScript starter.
  assert.equal(detectFramework(project.files, KNOWN), "typescript");
});

// ---- the Handsontable-only rule --------------------------------------------

test("recognizes Handsontable however a project pulls it in", () => {
  const cases = [
    ["a dependency", { "/package.json": JSON.stringify({ dependencies: { handsontable: "18.0.0" } }) }],
    ["a wrapper dependency", { "/package.json": JSON.stringify({ dependencies: { "@handsontable/react-wrapper": "18.0.0" } }) }],
    ["a devDependency", { "/package.json": JSON.stringify({ devDependencies: { handsontable: "latest" } }) }],
    ["an ES import", { "/src/main.ts": "import Handsontable from 'handsontable';" }],
    ["a subpath import", { "/src/main.ts": `import { registerAllModules } from "handsontable/registry";` }],
    ["a side-effect CSS import", { "/src/main.ts": "import 'handsontable/styles/handsontable.min.css';" }],
    ["require()", { "/index.js": 'const Handsontable = require("handsontable");' }],
    ["a jsdelivr tag", { "/index.html": '<script src="https://cdn.jsdelivr.net/npm/handsontable/dist/handsontable.full.min.js"></script>' }],
    ["an unpkg tag", { "/index.html": '<link href="https://unpkg.com/handsontable/styles/ht-theme-main.min.css" rel="stylesheet">' }],
    ["a cdnjs tag", { "/index.html": '<script src="https://cdnjs.cloudflare.com/ajax/libs/handsontable/14.0.0/handsontable.min.js"></script>' }],
    ["the global constructor", { "/script.js": "new Handsontable(document.body, { data: [] });" }],
    ["a static helper", { "/script.js": "Handsontable.helper.spreadsheetColumnLabel(1);" }],
  ];
  for (const [label, files] of cases) assert.equal(usesHandsontable(files), true, label);
});

test("a project with no Handsontable in it is refused, with the fix", () => {
  // This playground hosts Handsontable demos; a stray React app would be running
  // on our build minutes and our share links.
  const files = {
    "/package.json": JSON.stringify({ dependencies: { react: "19.0.0", "ag-grid-community": "33.0.0" } }),
    "/src/App.tsx": "import { AgGridReact } from 'ag-grid-react';",
  };
  assert.equal(usesHandsontable(files), false);
  assert.throws(
    () => assertHandsontableProject(files),
    (error) => error instanceof ImportError && /only hosts Handsontable demos/.test(error.message),
  );
});

test("a near-miss name does not pass the rule", () => {
  // Substring matching would let both of these through.
  assert.equal(
    usesHandsontable({ "/package.json": JSON.stringify({ dependencies: { "handsontable-clone": "1.0.0" } }) }),
    false,
  );
  assert.equal(usesHandsontable({ "/readme.md": "we used to use handsontable here" }), false);
});

test("both real fixtures pass the rule", () => {
  // The fiddle has no package.json — it pulls Handsontable from jsDelivr — and the
  // StackBlitz project declares it as a dependency. Both routes must count.
  assert.equal(usesHandsontable(parseJsFiddle(JSFIDDLE, "u").files), true);
  assert.equal(usesHandsontable(parseStackBlitz(STACKBLITZ).files), true);
});

test("importFromUrl refuses a non-Handsontable project end to end", async () => {
  const store = JSON.stringify({
    project: {
      title: "Someone else's app",
      appFiles: {
        "package.json": { type: "file", contents: JSON.stringify({ dependencies: { react: "19" } }), fullPath: "package.json" },
        "src/App.jsx": { type: "file", contents: "export default () => null;", fullPath: "src/App.jsx" },
      },
    },
  });
  await assert.rejects(
    importFromUrl("https://stackblitz.com/edit/whatever", {
      knownFrameworks: KNOWN,
      fetchImpl: async () =>
        new Response(`<script type="application/json" data-redux-store="">${store}</script>`, { status: 200 }),
    }),
    /only hosts Handsontable demos/,
  );
});

// ---- the whole path, with the fetch injected -------------------------------

test("importFromUrl fetches the rewritten URL and returns a workspace", async () => {
  const seen = [];
  const result = await importFromUrl("https://stackblitz.com/edit/vitejs-vite-de8qy2bm?file=index.html", {
    knownFrameworks: KNOWN,
    fetchImpl: async (url) => {
      seen.push(url);
      return new Response(STACKBLITZ, { status: 200, headers: { "Content-Type": "text/html" } });
    },
  });
  // The user's URL is never the one fetched — the allowlist rebuilds it.
  assert.deepEqual(seen, ["https://stackblitz.com/edit/vitejs-vite-de8qy2bm"]);
  assert.equal(result.provider, "stackblitz");
  assert.equal(result.framework, "typescript");
  assert.ok(result.files["/src/main.ts"]);
});

test("a fiddle with no CSS or JS panel links only what exists", () => {
  // Bugbot: the wrapper used to hardcode both references, so a fiddle with an
  // empty panel opened with a <link>/<script> pointing at a file that was never
  // written — a failed module load in the preview.
  const htmlOnly = `<textarea name="code_html" id="textarea-code-html">&lt;div id=&quot;example&quot;&gt;&lt;/div&gt;
    &lt;script src=&quot;https://cdn.jsdelivr.net/npm/handsontable/dist/handsontable.full.min.js&quot;&gt;&lt;/script&gt;</textarea>
    <textarea name="code_css" id="textarea-code-css"></textarea>
    <textarea name="code_js" id="textarea-code-js"></textarea>`;
  const result = parseJsFiddle(htmlOnly, "https://jsfiddle.net/x/1/");
  assert.deepEqual(Object.keys(result.files).sort(), ["/index.html", "/package.json"]);
  assert.equal(result.files["/index.html"].includes("style.css"), false);
  assert.equal(result.files["/index.html"].includes("script.js"), false);

  // …and the inverse: JS but no CSS keeps the script and drops the stylesheet.
  const noCss = `<textarea name="code_html" id="textarea-code-html">&lt;div&gt;&lt;/div&gt;</textarea>
    <textarea name="code_css" id="textarea-code-css"></textarea>
    <textarea name="code_js" id="textarea-code-js">new Handsontable(document.body, {});</textarea>`;
  const second = parseJsFiddle(noCss, "https://jsfiddle.net/x/1/");
  assert.deepEqual(Object.keys(second.files).sort(), ["/index.html", "/package.json", "/script.js"]);
  assert.match(second.files["/index.html"], /script\.js/);
  assert.equal(second.files["/index.html"].includes("style.css"), false);
});

test("a redirect is followed only while it stays on the allowlist", async () => {
  // Security review: implicit redirect-following would widen the SSRF boundary
  // from "provider pages" to "wherever a provider points us". Providers do
  // redirect (jsfiddle normalizes /:slug -> /:slug/1/), so hops are followed —
  // and each one re-runs the host gate.
  const seen = [];
  const result = await importFromUrl("https://jsfiddle.net/1bw9tphk/", {
    knownFrameworks: KNOWN,
    fetchImpl: async (url) => {
      seen.push(url);
      // A relative Location, as jsfiddle's own normalization sends.
      if (seen.length === 1) return new Response("", { status: 301, headers: { location: "/1bw9tphk/1/" } });
      return new Response(JSFIDDLE, { status: 200 });
    },
  });
  assert.deepEqual(seen, ["https://jsfiddle.net/1bw9tphk/", "https://jsfiddle.net/1bw9tphk/1/"]);
  assert.equal(result.provider, "jsfiddle");
});

test("a redirect off the allowlist is refused, not followed", async () => {
  const seen = [];
  await assert.rejects(
    importFromUrl("https://jsfiddle.net/1bw9tphk/1/", {
      knownFrameworks: KNOWN,
      fetchImpl: async (url) => {
        seen.push(url);
        return new Response("", { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
      },
    }),
    ImportError,
  );
  // The hop was never requested.
  assert.deepEqual(seen, ["https://jsfiddle.net/1bw9tphk/1/"]);
});

test("a redirect loop stops at the hop limit", async () => {
  let calls = 0;
  await assert.rejects(
    importFromUrl("https://stackblitz.com/edit/loop", {
      knownFrameworks: KNOWN,
      fetchImpl: async () => {
        calls += 1;
        return new Response("", { status: 302, headers: { location: "https://stackblitz.com/edit/loop2" } });
      },
    }),
    /redirected too many times/,
  );
  assert.ok(calls <= 5, `stopped after ${calls} requests`);
});

test("a 404 from the provider is reported as private-or-missing", async () => {
  await assert.rejects(
    importFromUrl("https://jsfiddle.net/nope/1/", {
      knownFrameworks: KNOWN,
      fetchImpl: async () => new Response("", { status: 404 }),
    }),
    (error) => error instanceof ImportError && error.status === 404,
  );
});

test("an oversized page is refused before it is parsed", async () => {
  await assert.rejects(
    importFromUrl("https://jsfiddle.net/1bw9tphk/1/", {
      knownFrameworks: KNOWN,
      fetchImpl: async () =>
        new Response("x", { status: 200, headers: { "content-length": String(64 * 1024 * 1024) } }),
    }),
    (error) => error instanceof ImportError && error.status === 413,
  );
});
