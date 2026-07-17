import test from "node:test";
import assert from "node:assert/strict";
import { applyHandsontableCss } from "../packages/runtime/dist/version.js";

const cssUrl = (version) =>
  `https://unpkg.com/handsontable@${version}/dist/handsontable.full.min.css`;

test("rewrites the baked CSS URL in root index.html", () => {
  const files = {
    "/index.html": `<link rel="stylesheet" href="${cssUrl("18.0.0")}" />`,
    "/src/main.ts": "console.log('unchanged');",
  };

  const result = applyHandsontableCss(files, { ref: "17.1.0", pkgPrNew: false });

  assert.notStrictEqual(result, files);
  assert.equal(result["/index.html"], `<link rel="stylesheet" href="${cssUrl("17.1.0")}" />`);
  assert.equal(result["/src/main.ts"], files["/src/main.ts"]);
});

test("rewrites the baked CSS URL in src/index.html", () => {
  const files = {
    "/src/index.html": `<link rel="stylesheet" href="${cssUrl("18.0.0")}" />`,
  };

  const result = applyHandsontableCss(files, { ref: "17.1.0", pkgPrNew: false });

  assert.equal(result["/src/index.html"], `<link rel="stylesheet" href="${cssUrl("17.1.0")}" />`);
});

test("leaves files unchanged without a matching HTML entry or for pkg.pr.new versions", () => {
  const noHtmlFiles = { "/src/main.ts": "console.log('unchanged');" };
  assert.strictEqual(
    applyHandsontableCss(noHtmlFiles, { ref: "17.1.0", pkgPrNew: false }),
    noHtmlFiles,
  );

  const pkgPrNewFiles = {
    "/index.html": `<link rel="stylesheet" href="${cssUrl("18.0.0")}" />`,
  };
  assert.strictEqual(
    applyHandsontableCss(pkgPrNewFiles, { ref: "1234", pkgPrNew: true }),
    pkgPrNewFiles,
  );
});
