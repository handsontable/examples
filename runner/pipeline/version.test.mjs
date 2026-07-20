import test from "node:test";
import assert from "node:assert/strict";
import { applyHandsontableCss, validateHandsontableVersion } from "../packages/runtime/dist/version.js";

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

// DEV-2102 / ADR-0021 decision 10: majors below 15 were never empirically
// verified, so validateHandsontableVersion rejects them by default — the same
// floor GET /api/versions already enforces, now also covering direct
// session/API calls that bypass the version dropdown.
test("rejects majors below the default floor (15)", () => {
  for (const value of ["14.5.0", "14", "14.2", "0.0.1"]) {
    const result = validateHandsontableVersion(value);
    assert.equal(result.ok, false, `expected ${value} to be rejected`);
    assert.match(result.message, /must be at least 15/);
  }
});

test("accepts majors within the default 15-19 range", () => {
  for (const value of ["15.0.0", "17.1", "19"]) {
    const result = validateHandsontableVersion(value);
    assert.equal(result.ok, true, `expected ${value} to be accepted`);
  }
});

test("pkg.pr.new refs bypass the floor (and ceiling) check", () => {
  assert.equal(validateHandsontableVersion("1234").ok, true);
  assert.equal(validateHandsontableVersion("https://pkg.pr.new/handsontable@abc123").ok, true);
});

test("custom minMajor/maxMajor override the defaults", () => {
  assert.equal(validateHandsontableVersion("14.0.0", 19, 10).ok, true);
  assert.equal(validateHandsontableVersion("9.0.0", 19, 10).ok, false);
});
