// Unpacking a dropped `.zip` (DEV-2531).
//
// The fixtures are built with `zipSync` — the same library the app's Download
// button writes with — so these tests exercise a real archive rather than a mock
// of one, and a change in fflate's output shows up here rather than in a drop.

import test from "node:test";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";

import { commonRoot, expandZip as expand, isZipFileName } from "../packages/editor-shell/src/dropZip.ts";
import {
  MAX_DROP_FILE_BYTES,
  isExcludedPath,
  isTextFileName,
} from "../packages/editor-shell/src/dropFiles.ts";

// The real rules, not a stand-in: `FileTree` hands these same three to `expandZip`,
// so a change to what a drop accepts changes what an archive accepts too.
const RULES = { isTextFileName, isExcludedPath, maxFileBytes: MAX_DROP_FILE_BYTES };
const expandZip = (bytes, limit) => expand(bytes, RULES, limit);

/** Build a zip from `{ path: text }`, the way a user's archive looks. */
const zip = (entries, opts = {}) =>
  zipSync(
    Object.fromEntries(
      Object.entries(entries).map(([path, value]) => [
        path,
        typeof value === "string" ? strToU8(value) : value,
      ]),
    ),
    opts,
  );

test("a project archive lands as a project", () => {
  const bytes = zip({
    "invoice-demo/package.json": '{ "dependencies": { "handsontable": "18.0.0" } }',
    "invoice-demo/index.html": "<div id=\"example\"></div>\n",
    "invoice-demo/src/index.js": "import Handsontable from 'handsontable';\n",
  });

  const { files, rejected, error } = expandZip(bytes);
  assert.equal(error, undefined);
  assert.deepEqual(rejected, []);
  // The single wrapping directory is stripped: the user zipped their project, they
  // did not ask for a folder named after it.
  assert.deepEqual(
    files.map((f) => f.path).sort(),
    ["index.html", "package.json", "src/index.js"],
  );
  assert.match(files.find((f) => f.path === "src/index.js").contents, /^import Handsontable/);
});

test("two roots, or a file at the root, keep their paths", () => {
  assert.equal(commonRoot(["a/one.js", "a/two.js"]), "a");
  assert.equal(commonRoot(["a/one.js", "b/two.js"]), "");
  assert.equal(commonRoot(["index.js", "a/one.js"]), "");
  assert.equal(commonRoot([]), "");

  const flat = expandZip(zip({ "index.js": "1", "src/app.js": "2" }));
  assert.deepEqual(flat.files.map((f) => f.path).sort(), ["index.js", "src/app.js"]);
});

test("the drop's own rules apply to every entry, one at a time", () => {
  const bytes = zip({
    "p/index.js": "ok\n",
    // Never, whatever else is in the archive.
    "p/.env": "SECRET=1\n",
    "p/.env.local": "SECRET=2\n",
    // Silently skipped: nobody meant to hand these over.
    "p/node_modules/left-pad/index.js": "module.exports = 1\n",
    "p/dist/bundle.js": "console.log(1)\n",
    "p/package-lock.json": "{}",
    // Refused *by name*, and named in the report.
    "p/logo.png": "not really a png but the name is what counts",
  });

  const { files, rejected } = expandZip(bytes);
  assert.deepEqual(files.map((f) => f.path), ["index.js"]);
  const reasons = Object.fromEntries(rejected.map((r) => [r.path, r.reason]));
  assert.deepEqual(Object.keys(reasons).sort(), [".env", ".env.local", "logo.png"]);
  assert.equal(reasons["logo.png"], "not a text file");
  // Build output and lockfiles are skipped without a line in the report — they are
  // noise, not decisions the reader needs to hear about.
  assert.ok(!rejected.some((r) => r.path.includes("node_modules")));
  assert.ok(!rejected.some((r) => r.path === "dist/bundle.js"));
  assert.ok(!rejected.some((r) => r.path === "package-lock.json"));
});

test("zip-slip and absolute paths are refused, not resolved", () => {
  for (const path of ["../evil.js", "p/../../evil.js", "/etc/passwd"]) {
    const { files, rejected } = expandZip(zip({ [path]: "x", "p/keep.js": "1" }));
    assert.ok(
      !files.some((f) => f.path.includes("..") || f.path.startsWith("/")),
      `${path} produced ${JSON.stringify(files.map((f) => f.path))}`,
    );
    assert.ok(
      rejected.some((r) => r.reason === "unsafe path in the archive"),
      `${path} was not reported`,
    );
  }
});

test("a binary hiding behind a text extension is refused", () => {
  // A .json whose bytes are not text: decoding gives U+FFFD, and writing that into
  // the workspace would be silent mojibake.
  const bytes = zip({ "p/data.json": new Uint8Array([0xff, 0xfe, 0x00, 0x41]), "p/ok.json": "{}" });
  const { files, rejected } = expandZip(bytes);
  assert.deepEqual(files.map((f) => f.path), ["ok.json"]);
  assert.equal(rejected.find((r) => r.path === "data.json").reason, "not a text file");
});

test("CRLF is normalised, like every other path into a workspace", () => {
  const { files } = expandZip(zip({ "p/a.js": "one\r\ntwo\r\n" }));
  assert.equal(files[0].contents, "one\ntwo\n");
});

test("an oversized entry is refused; the rest of the archive still lands", () => {
  const big = "x".repeat(600 * 1024);
  const { files, rejected } = expandZip(zip({ "p/big.js": big, "p/small.js": "1" }));
  assert.deepEqual(files.map((f) => f.path), ["small.js"]);
  assert.match(rejected.find((r) => r.path === "big.js").reason, /larger than 512 KB/);
});

test("the unpacked total is capped, so a bomb cannot fill the tab", () => {
  // Three 40 KB entries against a 100 KB ceiling: two fit, the third is reported.
  const text = "y".repeat(40 * 1024);
  const { files, rejected } = expandZip(
    zip({ "p/a.js": text, "p/b.js": text, "p/c.js": text }),
    100 * 1024,
  );
  assert.equal(files.length, 2);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /too large to unpack/);
});

test("something that is not a zip is one clear rejection", () => {
  const { files, rejected, error } = expandZip(strToU8("this is not an archive at all"));
  assert.deepEqual(files, []);
  assert.deepEqual(rejected, []);
  assert.match(error, /not a readable \.zip/);
});

test("an empty archive says so rather than looking like success", () => {
  const { error } = expandZip(zipSync({}));
  assert.equal(error, "the archive is empty");
});

test("isZipFileName is by extension, case-insensitively", () => {
  assert.ok(isZipFileName("project.zip"));
  assert.ok(isZipFileName("PROJECT.ZIP"));
  assert.ok(!isZipFileName("project.zip.js"));
  assert.ok(!isZipFileName("project.tar.gz"));
});

// ── The three things the review caught ────────────────────────────────────────

test("a `.` segment is not traversal (DEV-2531 review)", () => {
  // Some zip tools store paths as `./src/a.js`. Refusing those as unsafe threw away
  // whole archives; only `..` is traversal.
  const { files, rejected } = expandZip(zip({ "./src/a.js": "1", "./package.json": "{}" }));
  assert.deepEqual(files.map((f) => f.path).sort(), ["package.json", "src/a.js"]);
  assert.deepEqual(rejected, []);
  // …and `..` is still refused.
  const evil = expandZip(zip({ "p/../../evil.js": "x", "p/ok.js": "1" }));
  assert.ok(evil.rejected.some((r) => r.reason === "unsafe path in the archive"));
});

test("nothing is inflated before the caps are consulted", () => {
  // A bomb: two entries that declare 5 MB each against a 1 MB ceiling. The first pass
  // reads the central directory only, so neither is expanded — proven by the fact
  // that the rejection names the size rule rather than the process running out of
  // memory, and by both entries being refused rather than the first one landing.
  const big = "z".repeat(2 * 1024 * 1024);
  const { files, rejected } = expandZip(zip({ "p/a.js": big, "p/b.js": big }), 1024 * 1024);
  assert.deepEqual(files, []);
  assert.equal(rejected.length, 2);
  assert.ok(rejected.every((r) => /larger than|too large to unpack/.test(r.reason)));
});

test("a lying header is caught by the bytes themselves", () => {
  // The declared size is a claim; the inflated length is the fact. Both are checked,
  // so an archive that under-reports cannot smuggle a large file through.
  const { files } = expandZip(zip({ "p/ok.js": "x".repeat(100) }), 10 * 1024);
  assert.deepEqual(files.map((f) => f.path), ["ok.js"]);
});
