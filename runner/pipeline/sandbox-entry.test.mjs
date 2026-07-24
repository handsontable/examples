import test from "node:test";
import assert from "node:assert/strict";
import { resolveSandboxEntry } from "../packages/runtime/dist/sandbox-entry.js";

// DEV-2130: a catalog entry whose `entry` points at a file absent from the
// sandbox files used to mount a sandbox that compiled "successfully" without
// executing anything — blank preview, no error banner. The resolver must
// throw instead: mount() rejects and the app surfaces "Setup failed", while
// streaming updates swallow the throw and keep the last good sandbox.

const FILES = {
  "/package.json": "{}",
  "/index.html": "<html></html>",
  "/src/main.jsx": "code",
};

test("returns the module entry when it exists", () => {
  assert.equal(
    resolveSandboxEntry(undefined, "/src/main.jsx", "/index.html", FILES),
    "/src/main.jsx",
  );
});

test("throws when the module entry file is missing", () => {
  assert.throws(
    () => resolveSandboxEntry(undefined, "/src/main.tsx", null, FILES),
    /entry file \/src\/main\.tsx.*not found/,
  );
});

test("html-entry environments resolve the html entry and require it to exist", () => {
  assert.equal(resolveSandboxEntry("parcel", "/src/main.jsx", "/index.html", FILES), "/index.html");
  assert.throws(
    () => resolveSandboxEntry("static", "/src/main.jsx", "/missing.html", FILES),
    /entry file \/missing\.html.*not found/,
  );
});

test("parcel without an html entry maps the module entry to its compiled .js name", () => {
  const files = { ...FILES, "/src/main.js": "compiled" };
  assert.equal(resolveSandboxEntry("parcel", "/src/main.tsx", null, files), "/src/main.js");
  assert.throws(
    () => resolveSandboxEntry("parcel", "/src/other.tsx", null, files),
    /entry file \/src\/other\.js.*not found/,
  );
});
