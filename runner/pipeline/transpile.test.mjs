import test from "node:test";
import assert from "node:assert/strict";
import { transpileFilesForParcel } from "../packages/runtime/dist/transpile.js";

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
  assert.ok(code.includes("React.createElement"), "JSX compiled to createElement");
  assert.ok(!code.includes(": string"), "type annotations stripped");
  assert.ok(!/\?\./.test(code), "optional chaining downleveled");
  assert.ok(!/\?\?/.test(code), "nullish coalescing downleveled");
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

test("throws a filename-tagged error on unparseable source", async () => {
  await assert.rejects(
    transpileFilesForParcel({ "/src/App.tsx": "const = broken(" }),
    /App\.tsx/,
  );
});
