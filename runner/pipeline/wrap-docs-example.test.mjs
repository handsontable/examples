// Unit test for the docs-example wrapper. Run: node --test pipeline/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { wrapDocsExample } from "./wrap-docs-example.mjs";

const cases = [
  {
    label: "javascript (.js)",
    framework: "javascript",
    userFiles: { "example1.js": "const x = 1;", "example1.html": '<div id="example1"></div>' },
    entry: "src/main.js",
  },
  {
    label: "typescript (.ts)",
    framework: "javascript", // wrapper picks TS from the .ts fragment
    userFiles: { "example1.ts": "const x: number = 1;", "example1.html": '<div id="example1"></div>' },
    entry: "src/main.ts",
  },
  {
    label: "react (.tsx)",
    framework: "react",
    userFiles: { "example1.tsx": "export default function App() { return null; }" },
    entry: "src/main.tsx",
    wrapper: "@handsontable/react-wrapper",
  },
  {
    label: "vue (.vue)",
    framework: "vue",
    userFiles: { "example1.vue": "<template><div/></template>\n<script setup></script>" },
    entry: "src/main.ts",
    wrapper: "@handsontable/vue3",
  },
  {
    label: "angular (.ts)",
    framework: "angular",
    userFiles: {
      "example1.ts":
        "/* file: app.component.ts */\nimport { Component } from '@angular/core';\n@Component({ selector: 'app-root', template: '' })\nexport class AppComponent {}\n/* end-file */",
      "example1.html": "<app-root></app-root>",
    },
    entry: "src/main.ts",
    wrapper: "@handsontable/angular-wrapper",
  },
];

for (const c of cases) {
  test(`wraps ${c.label} into a runnable project`, () => {
    const files = wrapDocsExample({
      framework: c.framework,
      hotVersion: "18.0.0",
      exampleId: "example1",
      userFiles: c.userFiles,
    });
    assert.ok(files["package.json"], "has package.json");
    const pkg = JSON.parse(files["package.json"]); // must be valid JSON
    assert.ok(pkg.dependencies.handsontable, "pins handsontable");
    if (c.wrapper) assert.ok(pkg.dependencies[c.wrapper], `pins ${c.wrapper}`);
    assert.ok(files[c.entry] !== undefined, `emits entry ${c.entry}`);
    // index.html present for every framework (Angular uses src/index.html).
    const html = files["index.html"] ?? files["src/index.html"];
    assert.ok(html !== undefined, "emits an index.html");

    // DEV-2207: the wrapper emits NO Handsontable stylesheet, and this asserts
    // it against real wrapper output rather than a hand-written URL literal —
    // the independent literals in version.test.mjs are how the previous shape
    // (`dist/handsontable.full.min.css`, removed from the package at 17.0.0)
    // kept passing tests for 2723 artifacts that were all 404ing.
    for (const dead of [
      "handsontable.full.min.css",
      "handsontable/styles",
      "styles/handsontable",
      "ht-theme-",
    ]) {
      assert.equal(html.includes(dead), false, `emits no ${dead} reference`);
    }
    assert.equal(
      /<link\b[^>]*handsontable[^>]*\.css/i.test(html),
      false,
      "emits no Handsontable stylesheet <link> of any shape",
    );
  });
}

test("uses resolved Angular type dependency versions", () => {
  const files = wrapDocsExample({
    framework: "angular",
    hotVersion: "18.0.0",
    exampleId: "example1",
    userFiles: {
      "example1.ts":
        "/* file: app.component.ts */\nimport { Component } from '@angular/core';\nimport Papa from 'papaparse';\n@Component({ selector: 'app-root', template: '' })\nexport class AppComponent { data = Papa; }\n/* end-file */",
      "example1.html": "<app-root></app-root>",
    },
    extraDeps: { papaparse: "5.5.2" },
    extraDevDeps: { "@types/papaparse": "5.3.16" },
  });
  const pkg = JSON.parse(files["package.json"]);

  assert.equal(pkg.dependencies.papaparse, "5.5.2");
  assert.equal(pkg.devDependencies["@types/papaparse"], "5.3.16");
  assert.equal(Object.values(pkg.devDependencies).includes("latest"), false);
});

// DEV-2182: upstream `pikaday` ships no typings, so the Angular project (the
// only type-checked variant) must carry the stub or `ng serve` fails on TS7016
// and the demo renders blank. The `@handsontable/pikaday` fork bundles its own
// `pikaday.d.ts` and must NOT get one.
test("adds the pikaday typings stub for upstream pikaday only", () => {
  const angularSource = (specifier) =>
    `/* file: app.component.ts */\nimport { Component } from '@angular/core';\nimport Pikaday from '${specifier}';\nimport '${specifier}/css/pikaday.css';\n@Component({ selector: 'app-root', template: '' })\nexport class AppComponent { picker = Pikaday; }\n/* end-file */`;

  const upstream = JSON.parse(
    wrapDocsExample({
      framework: "angular",
      hotVersion: "18.0.0",
      exampleId: "example1",
      userFiles: { "example1.ts": angularSource("pikaday"), "example1.html": "<app-root></app-root>" },
      extraDeps: { pikaday: "1.8.2", moment: "2.30.1" },
      extraDevDeps: { "@types/pikaday": "1.7.10", "@types/moment": "2.13.0" },
    })["package.json"],
  );

  assert.equal(upstream.dependencies.pikaday, "1.8.2");
  assert.equal(upstream.devDependencies["@types/pikaday"], "1.7.10");

  const fork = JSON.parse(
    wrapDocsExample({
      framework: "angular",
      hotVersion: "18.0.0",
      exampleId: "example1",
      userFiles: {
        "example1.ts": angularSource("@handsontable/pikaday"),
        "example1.html": "<app-root></app-root>",
      },
      extraDeps: { "@handsontable/pikaday": "1.0.0", moment: "2.30.1" },
      // The stub is *offered* — as the docs resolver could hand it over — and the
      // "only" below is the wrapper declining it. With no `@types/pikaday` in the
      // input, the negative assertion asserted the test's own setup: a regression
      // that blind-merged every extraDevDeps entry would still have passed it.
      extraDevDeps: { "@types/pikaday": "1.7.10", "@types/moment": "2.13.0" },
    })["package.json"],
  );

  assert.equal(fork.dependencies["@handsontable/pikaday"], "1.0.0");
  assert.equal("@types/pikaday" in fork.devDependencies, false);
});
