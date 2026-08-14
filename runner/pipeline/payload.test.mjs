// Ad-hoc payloads posted to /api/payload (DEV-2516).
//
// The Theme Builder hands us a generated project directly, so unlike the URL
// importers there is no page to record a fixture from — the inputs here are the
// three shapes it exports (vanilla JS, React JS, Angular), written out inline.
//
// What these pin is the refusal side: a public endpoint that turns arbitrary
// browser-supplied keys into workspace paths has to reject traversal, secrets,
// binaries and bulk before anything is stored. The route half (rate limit, KV,
// 404) has no unit-test path in this repo — there is no worker harness — and is
// covered end to end instead, the way profile.test.mjs describes.
//
// Run: node --experimental-strip-types --test pipeline/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  ImportError,
  MAX_PAYLOAD_CHARS,
  validatePayloadFiles,
} from "../workers/api/src/import-url.ts";

/** The catalog's framework keys, as the Worker passes them in. */
const KNOWN = new Set([
  "javascript", "typescript", "react", "react-js", "vue", "angular",
  "next.js", "nuxt", "remix", "astro",
]);

const validate = (files, options = {}) =>
  validatePayloadFiles(files, { knownFrameworks: KNOWN, ...options });

/** A minimal accepted payload, for the cases that are about something else. */
const MINIMAL = {
  "/package.json": JSON.stringify({ dependencies: { handsontable: "^18.0.0" } }),
  "/main.js": 'import Handsontable from "handsontable";\nnew Handsontable(el, {});\n',
};

// ---- the shape of the body --------------------------------------------------

test("refuses a body that carries no files", () => {
  for (const input of [undefined, null, "files", 42, [], {}]) {
    assert.throws(() => validate(input), ImportError, JSON.stringify(input ?? null));
  }
});

test("refuses a file whose contents are not text", () => {
  assert.throws(
    () => validate({ ...MINIMAL, "/data.json": { rows: 3 } }),
    (error) => error instanceof ImportError && error.status === 400,
  );
});

// ---- what must never become a workspace key ---------------------------------

test("refuses traversal and absolute-ish paths", () => {
  // These keys end up composed with the builder container's root on save, so a
  // path that needed rewriting to be safe is not one we should accept at all.
  for (const path of ["../etc/passwd", "/src/../../etc/passwd", "C:/x.js", "./", ""]) {
    assert.throws(() => validate({ ...MINIMAL, [path]: "x" }), ImportError, path);
  }
});

test("refuses environment files", () => {
  for (const path of ["/.env", "/.env.local", "/config/.env.production"]) {
    assert.throws(
      () => validate({ ...MINIMAL, [path]: "SECRET=1" }),
      (error) => error instanceof ImportError && /Environment files/.test(error.message),
      path,
    );
  }
});

test("refuses anything that is not a text file", () => {
  for (const path of ["/logo.png", "/fonts/inter.woff2", "/archive.zip"]) {
    assert.throws(() => validate({ ...MINIMAL, [path]: "binary-ish" }), ImportError, path);
  }
});

// ---- noise the builder re-derives -------------------------------------------

test("drops lockfiles, node_modules and build output instead of refusing them", () => {
  // Dropped rather than 400'd: an export that happens to carry one of these is
  // otherwise fine, and the builder resolves them itself. The lockfile is the
  // one that matters — it would pin the version the workspace is rewritten to.
  const { files } = validate({
    ...MINIMAL,
    "/package-lock.json": "{}",
    "/pnpm-lock.yaml": "lockfileVersion: 9",
    "/node_modules/handsontable/index.js": "module.exports = {};",
    "/dist/bundle.js": "/* built */",
    "/.DS_Store": "junk",
  });
  assert.deepEqual(Object.keys(files).sort(), ["/main.js", "/package.json"]);
});

test("refuses a payload that is nothing but noise", () => {
  assert.throws(
    () => validate({ "/package-lock.json": "{}", "/dist/bundle.js": "x" }),
    (error) => error instanceof ImportError && /no files this playground can open/.test(error.message),
  );
});

// ---- the ceilings -----------------------------------------------------------

test("refuses a payload over the size ceiling with 413", () => {
  const big = { ...MINIMAL, "/data.js": "x".repeat(MAX_PAYLOAD_CHARS + 1) };
  assert.throws(
    () => validate(big),
    (error) => error instanceof ImportError && error.status === 413,
  );
});

test("accepts a payload the size a real Theme Builder export is", () => {
  // ~40 KB, its data.js the bulk of it — comfortably inside the ceiling.
  const { framework } = validate({ ...MINIMAL, "/data.js": "x".repeat(32 * 1024) });
  assert.equal(framework, "javascript");
});

test("counts the ceiling across files, not per file", () => {
  const half = "x".repeat(Math.ceil(MAX_PAYLOAD_CHARS / 2) + 1);
  assert.throws(
    () => validate({ ...MINIMAL, "/a.js": half, "/b.js": half }),
    (error) => error instanceof ImportError && error.status === 413,
  );
});

test("refuses a payload over the file-count ceiling", () => {
  const many = { ...MINIMAL };
  for (let i = 0; i < 100; i++) many[`/f${i}.js`] = "//";
  assert.throws(
    () => validate(many),
    (error) => error instanceof ImportError && /more than \d+ files/.test(error.message),
  );
});

// ---- it has to be a Handsontable project ------------------------------------

test("refuses a project that does not use Handsontable", () => {
  assert.throws(
    () => validate({
      "/package.json": JSON.stringify({ dependencies: { lodash: "^4.0.0" } }),
      "/main.js": "console.log('hi');",
    }),
    (error) => error instanceof ImportError && /only hosts Handsontable demos/.test(error.message),
  );
});

test("accepts a project whose Handsontable comes from a CDN tag", () => {
  // A vanilla export may carry no dependency at all — the evidence is the tag
  // and the constructor, which is the path usesHandsontable() exists for.
  const { framework } = validate({
    "/index.html": '<script src="https://cdn.jsdelivr.net/npm/handsontable/dist/handsontable.full.min.js"></script>',
    "/main.js": "new Handsontable(document.body, { data: [] });",
  });
  assert.equal(framework, "javascript");
});

// ---- the three Theme Builder variants ---------------------------------------

test("detects the vanilla JavaScript export", () => {
  const { framework, files } = validate({
    "/package.json": JSON.stringify({ dependencies: { handsontable: "^18.0.0" } }),
    "/index.html": "<div id='root'></div>",
    "/main.js": 'import Handsontable from "handsontable";\n',
    "/theme.js": "export const theme = {};\n",
  });
  assert.equal(framework, "javascript");
  assert.deepEqual(Object.keys(files).sort(), ["/index.html", "/main.js", "/package.json", "/theme.js"]);
});

test("detects the React export as react-js, not react", () => {
  // The Theme Builder emits .jsx; `react` would send it to the TypeScript
  // starter and every file would arrive with the wrong extension.
  const { framework } = validate({
    "/package.json": JSON.stringify({
      dependencies: { react: "^18.0.0", handsontable: "^18.0.0", "@handsontable/react-wrapper": "^18.0.0" },
    }),
    "/src/App.jsx": 'import { HotTable } from "@handsontable/react-wrapper";\n',
  });
  assert.equal(framework, "react-js");
});

test("detects the Angular export", () => {
  const { framework } = validate({
    "/package.json": JSON.stringify({
      dependencies: { "@angular/core": "^18.0.0", "@handsontable/angular-wrapper": "^18.0.0" },
    }),
    "/src/app.component.ts": 'import { HotTableModule } from "@handsontable/angular-wrapper";\n',
  });
  assert.equal(framework, "angular");
});

// ---- the framework hint -----------------------------------------------------

test("honours a framework hint that names a starter we have", () => {
  const { framework } = validate(MINIMAL, { framework: "vue" });
  assert.equal(framework, "vue");
});

test("ignores a hint that is not a catalog key", () => {
  // The route is public and this value becomes a usage_daily dimension, so an
  // unknown hint must fall back to detection rather than pass through.
  for (const hint of ["svelte", "../../etc", "x".repeat(200), ""]) {
    assert.equal(validate(MINIMAL, { framework: hint }).framework, "javascript", hint);
  }
});

// ---- normalization ----------------------------------------------------------

test("normalizes CRLF and relative keys the way the importers do", () => {
  const { files } = validate({
    "package.json": JSON.stringify({ dependencies: { handsontable: "^18.0.0" } }),
    "src/main.js": 'import Handsontable from "handsontable";\r\nnew Handsontable(el, {});\r\n',
  });
  assert.deepEqual(Object.keys(files).sort(), ["/package.json", "/src/main.js"]);
  assert.ok(!files["/src/main.js"].includes("\r"), "CRLF survived");
});
