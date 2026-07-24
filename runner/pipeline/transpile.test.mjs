import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { transpileFilesForParcel } from "../packages/runtime/dist/transpile.js";

// Execute a compiled module with a stubbed `react` package and return the
// stub's createElement call log. Static assertions alone let a "React is not
// defined" regression ship — compiled JSX must actually run.
async function runWithReactStub(compiledCode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "transpile-exec-"));
  try {
    const reactDir = path.join(root, "node_modules", "react");
    fs.mkdirSync(reactDir, { recursive: true });
    fs.writeFileSync(path.join(reactDir, "package.json"), JSON.stringify({ name: "react", version: "0.0.0", type: "module", main: "index.js" }));
    fs.writeFileSync(
      path.join(reactDir, "index.js"),
      "export const calls = [];\n" +
        "export function createElement(type, props, ...children) { calls.push({ type, props, children }); return { type, props, children }; }\n" +
        "export const Fragment = Symbol('Fragment');\n" +
        "export const useMemo = (fn) => fn();\n" +
        "export const useRef = (v) => ({ current: v });\n" +
        "export const useEffect = () => {};\n" +
        "export const useState = (v) => [v, () => {}];\n" +
        "export default { createElement, Fragment, useMemo, useRef, useEffect, useState };\n",
    );
    const modPath = path.join(root, "app.mjs");
    fs.writeFileSync(modPath, compiledCode);
    const mod = await import(pathToFileURL(modPath).href);
    const react = await import(pathToFileURL(path.join(reactDir, "index.js")).href);
    return { mod, calls: react.calls };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Execute a compiled module against a stubbed npm package. Used to prove that
// downleveled classes can still subclass a *native* ES6 class exported by a
// dependency dist that babel 6 never touches (hyperformula's FunctionPlugin).
async function runWithStubPackage(compiledCode, pkgName, stubSource) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "transpile-exec-"));
  try {
    const pkgDir = path.join(root, "node_modules", pkgName);
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: pkgName, version: "0.0.0", type: "module", main: "index.js" }));
    fs.writeFileSync(path.join(pkgDir, "index.js"), stubSource);
    const modPath = path.join(root, "app.mjs");
    fs.writeFileSync(modPath, compiledCode);
    return await import(pathToFileURL(modPath).href);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// DEV-2129: the classic Sandpack `parcel` environment (babel-standalone 6.26)
// shares Handsontable's internal module registry across entry points (plugins
// work) but cannot parse TS/TSX or ES2018+ syntax. transpileFilesForParcel
// pre-compiles example files to a babel-6-parseable floor so every Tier-1
// framework can run on `parcel`.

const TSX_APP = `import React, { useRef } from 'react';
import { HotTable } from '@handsontable/react-wrapper';

const App = () => {
  const ref = useRef<{ hotInstance?: { name: string } }>(null);
  const name: string = ref.current?.hotInstance?.name ?? 'none';
  return <HotTable data={[[name]]} licenseKey="non-commercial-and-evaluation" />;
};

export default App;
`;

test("compiles TSX to plain JS renamed to .js: no types, no JSX, no ES2020 syntax", async () => {
  const out = await transpileFilesForParcel({ "/src/App.tsx": TSX_APP });

  assert.equal(out["/src/App.tsx"], undefined);
  const code = out["/src/App.js"];
  assert.ok(code, "App.tsx becomes App.js");
  assert.ok(!/<[A-Za-z]/.test(code.replace(/"[^"]*"|'[^']*'/g, "")), "no raw JSX left");
  assert.match(code, /import \{ createElement as .*\} from "react"/, "JSX factory imported");
  assert.ok(!code.includes(": string"), "type annotations stripped");
  assert.ok(!/\?\./.test(code), "optional chaining downleveled");
  assert.ok(!/\?\?/.test(code), "nullish coalescing downleveled");
});

// Modern React docs examples never `import React` (they're written for the
// automatic JSX runtime). The classic-runtime output we generate for the old
// parcel bundler must therefore bring its own factory import, or every such
// example throws "React is not defined" at first render (prod regression,
// 2026-07-24).
test("compiled JSX from a module that never imports React executes", async () => {
  const out = await transpileFilesForParcel({
    "/src/App.tsx":
      "import { useMemo } from 'react';\n" +
      "const App = () => <div title=\"x\"><span>hi</span></div>;\n" +
      "export default App;\n",
  });
  const { mod, calls } = await runWithReactStub(out["/src/App.js"]);
  mod.default();
  assert.ok(calls.length >= 2, "createElement was reached through the injected import");
  assert.ok(calls.some((c) => c.type === "div"), "renders the div element");
});

test("compiled JSX fragments execute without a React import", async () => {
  const out = await transpileFilesForParcel({
    "/src/App.jsx": "const App = () => <><b>a</b></>;\nexport default App;\n",
  });
  const { mod, calls } = await runWithReactStub(out["/src/App.js"]);
  mod.default();
  assert.ok(calls.length >= 1, "fragment JSX executes");
});

test("a source that already imports React still compiles and executes once", async () => {
  const out = await transpileFilesForParcel({
    "/src/App.tsx":
      "import React from 'react';\nconst App = () => <div />;\nexport default App;\n",
  });
  const { mod, calls } = await runWithReactStub(out["/src/App.js"]);
  mod.default();
  assert.equal(calls.length, 1);
});

test("keeps ES module syntax (parcel resolves imports; CJS would break dedupe)", async () => {
  const out = await transpileFilesForParcel({ "/src/App.tsx": TSX_APP });
  const code = out["/src/App.js"];
  assert.match(code, /import .*react/i);
  assert.match(code, /export default/);
});

test("downlevels modern syntax in plain .js files in place", async () => {
  const out = await transpileFilesForParcel({
    "/src/main.js": "const el = document.querySelector('#x');\nconst v = el?.dataset?.value ?? 'z';\nconst o = { ...v };\nexport { o };\n",
  });
  const code = out["/src/main.js"];
  assert.ok(code, ".js path unchanged");
  assert.ok(!/\?\./.test(code));
  assert.ok(!/\?\?/.test(code));
  assert.ok(!/\{\s*\.\.\./.test(code), "object spread downleveled (babel 6 parse floor)");
});

test("compiles .ts to .js", async () => {
  const out = await transpileFilesForParcel({
    "/src/main.ts": "const n: number = 1;\nexport default n;\n",
  });
  assert.equal(out["/src/main.ts"], undefined);
  assert.ok(out["/src/main.js"].includes("const n = 1"));
});

test("rewrites HTML script references to the compiled .js entry", async () => {
  const out = await transpileFilesForParcel({
    "/index.html": '<script type="module" src="/src/main.tsx"></script>',
    "/src/main.tsx": "export default 1;\n",
  });
  assert.ok(out["/index.html"].includes('src="/src/main.js"'));
  assert.ok(!out["/index.html"].includes("main.tsx"));
});

test("rewrites bare and ./-relative HTML references to renamed sources", async () => {
  const out = await transpileFilesForParcel({
    "/index.html": '<script type="module" src="index.ts"></script><script src="./src/app.tsx"></script>',
    "/index.ts": "export default 1;\n",
    "/src/app.tsx": "export default 2;\n",
  });
  assert.ok(out["/index.html"].includes('src="index.js"'));
  assert.ok(out["/index.html"].includes('src="./src/app.js"'));
  assert.ok(!/\.tsx?"/.test(out["/index.html"]));
});

test("drops <link> tags pointing at local files missing from the sandbox", async () => {
  // The parcel environment resolves every local URL in the HTML entry as a
  // module and hard-fails the whole sandbox on a miss (e.g. /favicon.svg in
  // the React starter). Local stylesheets that exist must survive.
  const out = await transpileFilesForParcel({
    "/index.html":
      '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />' +
      '<link rel="stylesheet" href="./styles.css" />' +
      '<link rel="stylesheet" href="https://cdn.example.com/x.css" />',
    "/styles.css": "body {}",
    "/index.ts": "export default 1;\n",
  });
  assert.ok(!out["/index.html"].includes("favicon.svg"), "missing local link dropped");
  assert.ok(out["/index.html"].includes("./styles.css"), "present local link kept");
  assert.ok(out["/index.html"].includes("https://cdn.example.com/x.css"), "external link kept");
});

test("passes .d.ts declaration files through untouched (nothing imports them)", async () => {
  const files = { "/env.d.ts": '/// <reference types="vite/client" />\ndeclare const V: string;\n' };
  const out = await transpileFilesForParcel(files);
  assert.equal(out["/env.d.ts"], files["/env.d.ts"]);
  assert.equal(out["/env.d.js"], undefined);
});

test("leaves non-source files untouched", async () => {
  const files = {
    "/package.json": '{ "dependencies": {} }',
    "/styles.css": "body { color: red; }",
  };
  const out = await transpileFilesForParcel(files);
  assert.equal(out["/package.json"], files["/package.json"]);
  assert.equal(out["/styles.css"], files["/styles.css"]);
});

// The parcel bundler's babel 6 downlevels any `class` it sees to an ES5
// constructor function that calls its parent with `Parent.call(this)` — which
// throws "Class constructor X cannot be invoked without 'new'" when the parent
// is a native ES6 class from a dependency dist (hyperformula's FunctionPlugin,
// prod regression 2026-07-24). Downlevel classes ourselves: babel 8's class
// transform goes through Reflect.construct, which native parents accept, and
// babel 6 then sees no `class` at all.
test("downlevels classes to ES5 so babel 6 never transforms them", async () => {
  const out = await transpileFilesForParcel({
    "/src/main.js":
      "import { FunctionPlugin } from 'hyperformula';\n" +
      "export class MyPlugin extends FunctionPlugin {\n" +
      "  hello() { return 'hi'; }\n" +
      "}\n",
  });
  const code = out["/src/main.js"];
  assert.ok(!/\bclass\b/.test(code.replace(/"[^"]*"|'[^']*'/g, "")), "no class syntax left");
});

test("downleveled class can subclass a native ES6 class from a dependency", async () => {
  const out = await transpileFilesForParcel({
    "/src/main.js":
      "import { FunctionPlugin } from 'hyperformula';\n" +
      "export class MyPlugin extends FunctionPlugin {\n" +
      "  constructor() { super(); this.own = 1; }\n" +
      "}\n",
  });
  const mod = await runWithStubPackage(
    out["/src/main.js"],
    "hyperformula",
    // Native class, never transpiled — like a real dependency dist.
    "export class FunctionPlugin { constructor() { this.base = true; } }\n",
  );
  const instance = new mod.MyPlugin();
  assert.equal(instance.base, true, "native parent constructor ran");
  assert.equal(instance.own, 1, "subclass constructor ran");
});

test("throws a filename-tagged error on unparseable source", async () => {
  await assert.rejects(
    transpileFilesForParcel({ "/src/App.tsx": "const = broken(" }),
    /App\.tsx/,
  );
});
