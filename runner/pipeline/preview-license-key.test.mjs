// The `next` starters and docs examples ship a commented-out `licenseKey` placeholder.
// Core skips the license check only on handsontable.com and one-label subdomains, but
// the live previews run on `*-sandpack.codesandbox.io` (Tier 1) and
// `<port>-<session>.demos.handsontable.com` (Tier 2), so the grid showed the lock
// screen. The runtime swaps the placeholder for the internal test key in the files the
// preview executes, and only there.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as acorn from "acorn";
import { injectPreviewLicenseKey, PREVIEW_LICENSE_KEY } from "../packages/runtime/dist/license-key.js";
import { transpileFilesForParcel } from "../packages/runtime/dist/transpile.js";
import { SandpackRuntime } from "../packages/runtime/dist/sandpack.js";
import { ContainerRuntime } from "../packages/runtime/dist/container.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NEXT_STARTERS = path.join(HERE, "../apps/authoring/public/starter-examples/next");
const PLACEHOLDER = "your-license-key";

function starter(name) {
  return JSON.parse(fs.readFileSync(path.join(NEXT_STARTERS, `${name}.json`), "utf8"));
}

/** Import an ES module from source and return its namespace. */
async function importSource(code, deps = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "license-key-"));
  try {
    for (const [name, src] of Object.entries(deps)) {
      const dir = path.join(root, "node_modules", name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
      fs.writeFileSync(path.join(dir, "index.js"), src);
    }
    const file = path.join(root, "mod.mjs");
    fs.writeFileSync(file, code);
    return await import(pathToFileURL(file).href);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("the key carries no single quote, which the Vue attribute form relies on", () => {
  assert.equal(PREVIEW_LICENSE_KEY.includes("'"), false);
  assert.match(PREVIEW_LICENSE_KEY, /^This is a Handsontable license key for HANDSONTABLE INTERNAL TEST KEY/);
});

for (const [name, line, prop] of [
  ["single-quoted option", "  // licenseKey: 'your-license-key', // get a key at https://handsontable.com/pricing/", "licenseKey"],
  ["double-quoted option", "    // licenseKey: \"your-license-key\", // get a key at https://handsontable.com/pricing/", "licenseKey"],
  ["Angular global config", "        // license: 'your-license-key', // get a key at https://handsontable.com/pricing/", "license"],
  ["tab indent, last property", "\t// licenseKey: 'your-license-key' // get a key at https://handsontable.com/pricing/", "licenseKey"],
]) {
  test(`an object-option placeholder becomes a live option that evaluates to the key: ${name}`, async () => {
    const src = `export default {\n  data: [],\n${line}\n};\n`;
    const out = injectPreviewLicenseKey({ "/src/index.js": src })["/src/index.js"];
    // Parsed at ES5 object-literal syntax too: babel 6 sees this line on parcel.
    acorn.parse(out.replace("export default", "var x ="), { ecmaVersion: 5 });
    const mod = await importSource(out);
    assert.equal(mod.default[prop], PREVIEW_LICENSE_KEY);
  });
}

test("the JSX attribute placeholder reaches the component as a prop after the real parcel transpile", async () => {
  const src = [
    'import React from "react";',
    'const HotTable = "hot-table";',
    "export const el = (",
    "  <HotTable",
    "    data={[]}",
    '    // licenseKey="your-license-key" // get a key at https://handsontable.com/pricing/',
    "  >",
    "  </HotTable>",
    ");",
    "",
  ].join("\n");
  const injected = injectPreviewLicenseKey({ "/src/index.jsx": src });
  const compiled = await transpileFilesForParcel(injected);
  const [code] = Object.entries(compiled).filter(([p]) => p.startsWith("/src/index")).map(([, c]) => c);
  const mod = await importSource(code, {
    react:
      "export function createElement(type, props) { return { type, props }; }\n" +
      "export const Fragment = Symbol('Fragment');\n" +
      "export default { createElement, Fragment };\n",
  });
  assert.equal(mod.el.props.licenseKey, PREVIEW_LICENSE_KEY);
});

test("the Vue template placeholder becomes a license-key attribute on the HotTable tag", () => {
  const files = starter("vue").files;
  const [vuePath] = Object.keys(files).filter((p) => files[p].includes(PLACEHOLDER));
  assert.ok(vuePath, "guard: the vue starter carries the placeholder");
  const out = injectPreviewLicenseKey(files)[vuePath];
  const tag = out.indexOf("<HotTable");
  assert.equal(out.slice(tag, tag + 200), `<HotTable license-key='${PREVIEW_LICENSE_KEY}'`.slice(0, 200));
  assert.equal(out.includes(PLACEHOLDER), false);
});

test("every placeholder in every next starter is replaced", () => {
  const names = fs
    .readdirSync(NEXT_STARTERS)
    .filter((f) => f.endsWith(".json") && f !== "manifest.json")
    .map((f) => f.slice(0, -5));
  let seen = 0;
  for (const name of names) {
    const files = starter(name).files;
    const out = injectPreviewLicenseKey(files);
    for (const [p, src] of Object.entries(files)) {
      if (!src.includes(PLACEHOLDER)) continue;
      seen++;
      assert.equal(out[p].includes(PLACEHOLDER), false, `${name}:${p}`);
      assert.ok(out[p].includes(PREVIEW_LICENSE_KEY.slice(0, 60)), `${name}:${p}`);
    }
  }
  assert.ok(seen >= 16, `guard: expected the placeholder in every next starter, saw ${seen}`);
});

test("a key the user typed, or a file with no placeholder, is left alone", () => {
  const files = {
    "/src/a.js": "new Handsontable(el, {\n  licenseKey: 'my-own-key',\n});\n",
    "/src/b.jsx": '<HotTable licenseKey="my-own-key" />\n',
    "/package.json": '{"name":"your-license-key"}',
  };
  assert.equal(injectPreviewLicenseKey(files), files, "nothing to do returns the same map");
});

test("Tier 1: the bundler gets the key, the authored files keep the placeholder", async () => {
  const entry = starter("react");
  const runtime = new SandpackRuntime(entry, { iframe: {} });
  const setup = await runtime.buildSetup(entry.files);
  const bundled = Object.values(setup.files).map((f) => f.code).join("\n");
  // A prop of the compiled createElement call, not a rewritten comment left by babel.
  assert.ok(bundled.includes(`licenseKey: ${JSON.stringify(PREVIEW_LICENSE_KEY)}`), "the compiled sandbox carries the key");
  for (const [p, f] of Object.entries(setup.files)) {
    if (p.endsWith(".js")) acorn.parse(f.code, { ecmaVersion: "latest", sourceType: "module" });
  }
  const authored = Object.values(runtime.files).join("\n");
  assert.ok(authored.includes(PLACEHOLDER), "Download-zip and the exports still see the placeholder");
  assert.equal(authored.includes(PREVIEW_LICENSE_KEY.slice(0, 60)), false);
});

test("Tier 2: the session create and every edit carry the key, the authored files do not", async () => {
  const entry = starter("angular");
  const fetchBefore = globalThis.fetch;
  const windowBefore = globalThis.window;
  const bodies = [];
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.fetch = (url, init) => {
    if (init?.body) bodies.push({ url: String(url), body: init.body });
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => Promise.resolve({ previewUrl: "https://4200-s.demos.handsontable.com/", port: 4200 }),
    });
  };
  const iframe = { src: "", contentWindow: null, addEventListener() {}, removeEventListener() {} };
  const runtime = new ContainerRuntime(entry, { iframe, apiBase: "https://api.test", keepaliveMs: 3_600_000 });
  try {
    await runtime.mount(entry.files).catch(() => {});
    const create = bodies.find((b) => b.url.endsWith("/api/session"));
    assert.ok(create, "guard: mount posted the session create");
    assert.ok(create.body.includes(JSON.stringify(PREVIEW_LICENSE_KEY).slice(1, 60)), "create carries the key");

    const [edited] = Object.keys(entry.files).filter((p) => entry.files[p].includes(PLACEHOLDER));
    runtime.sessionId ??= "s1";
    runtime.writeFile(edited, entry.files[edited] + "\n// edit\n");
    await runtime.flush();
    const write = bodies.find((b) => b.url.endsWith("/file"));
    assert.ok(write, "guard: the edit was written");
    assert.ok(write.body.includes(JSON.stringify(PREVIEW_LICENSE_KEY).slice(1, 60)), "the edit carries the key");

    assert.equal(Object.values(runtime.files).join("\n").includes(PREVIEW_LICENSE_KEY.slice(0, 60)), false);
  } finally {
    runtime.dispose();
    globalThis.fetch = fetchBefore;
    globalThis.window = windowBefore;
  }
});
