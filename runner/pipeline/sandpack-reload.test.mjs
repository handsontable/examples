import test from "node:test";
import assert from "node:assert/strict";
import { SandpackRuntime } from "../packages/runtime/dist/sandpack.js";

// DEV-2176: the classic bundler drops every `compile` message carrying
// `isInitializationCompile: true` after the first one — from its own
// src/sandbox/index.ts:
//
//   let first = true;
//   if (msg.type === "compile") {
//     if (msg.isInitializationCompile === true && !first) return;   // dropped
//     compile(msg); first = false;
//   }
//
// `loadSandpackClient` spends that single allowance itself, replaying the setup
// on the bundler's `initialized` message, so a refresh that asks for another
// initialization compile is silently discarded: no `start`, no `done`, no error,
// and the preview never re-runs. Every push — refresh included — must therefore
// go out as an ordinary (non-initial) compile.
//
// A non-initial compile is necessary but not sufficient, which is what the rest of
// this file now covers. Measured against the live bundler: a compile whose module
// contents are byte-identical to what it already holds resets the preview document
// and re-evaluates nothing — `start` … `success`, `done` with no compile error, and
// a blank frame. So `reload()` stamps the entry to guarantee a diff, and ordinary
// edits skip the push entirely when nothing changed (the render on screen is
// already the right one).

/** A catalog entry the runtime will hand to the bundler as-is (no parcel pre-transpile). */
const ENTRY = {
  framework: "vue",
  displayName: "Vue",
  tier: 1,
  engine: "sandpack",
  sandpackTemplate: "vue",
  sandpackEnvironment: "vue-cli",
  container: null,
  htWrappers: [],
  entry: "/src/main.js",
  htmlEntry: null,
  devCommand: null,
  buildCommand: "build",
  outputDir: "dist",
  outputGlob: null,
  staticExport: false,
  spaMode: false,
  port: null,
  installCommand: "install",
  htCoreRange: null,
  minCoreMajor: null,
  fileCount: 2,
  assets: [],
  skipped: [],
  files: {},
};

const FILES = {
  "/package.json": JSON.stringify({ dependencies: { handsontable: "16.0.1" } }),
  "/src/main.js": "console.log('demo');",
};

/** Stand in for the mounted sandpack client and record every compile push. */
function fakeClient() {
  const pushes = [];
  return {
    pushes,
    updateSandbox(setup, isInitializationCompile) {
      pushes.push({ setup, isInitializationCompile });
    },
    listen() {
      return () => {};
    },
    destroy() {},
  };
}

/** A runtime with a client attached, skipping mount() (which needs a DOM + the bundler). */
function mounted() {
  const runtime = new SandpackRuntime(ENTRY, { iframe: {} });
  const client = fakeClient();
  runtime.client = client;
  runtime.files = { ...FILES };
  return { runtime, client };
}

test("reload() pushes a non-initial compile, so the bundler does not drop it", async () => {
  const { runtime, client } = mounted();

  await runtime.reload();

  assert.equal(client.pushes.length, 1);
  assert.equal(
    client.pushes[0].isInitializationCompile,
    false,
    "refresh must not ask for an initialization compile — the bundler discards those after the first",
  );
});

test("streaming edits stay non-initial too", async () => {
  const { runtime, client } = mounted();

  runtime.writeFile("/src/main.js", "console.log('edited');");
  // writeFile() dispatches through the same async transpile chain as reload(),
  // it just doesn't hand back the promise.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(client.pushes.length, 1);
  assert.equal(client.pushes[0].isInitializationCompile, false);
});

test("reload() publishes the current sources", async () => {
  const { runtime, client } = mounted();
  runtime.writeFile("/src/main.js", "console.log('edited');");

  await runtime.reload();

  const last = client.pushes.at(-1).setup;
  // Starts with, not equals: `reload()` appends a stamp comment (see below). The
  // authored source has to be there in full and unaltered ahead of it.
  assert.ok(
    last.files["/src/main.js"].code.startsWith("console.log('edited');"),
    `expected the edited source to be published, got: ${last.files["/src/main.js"].code}`,
  );
  assert.equal(last.entry, "/src/main.js");
});

test("reload() stamps the entry, so the bundler always has a diff to act on", async () => {
  const { runtime, client } = mounted();

  await runtime.reload();
  await runtime.reload();

  const [first, second] = client.pushes.map((p) => p.setup.files["/src/main.js"].code);
  assert.notEqual(
    first,
    second,
    "two refreshes must not publish identical entry code — the bundler treats a no-change compile as nothing to do and blanks the preview",
  );
  for (const code of [first, second]) {
    // A comment, so the stamp can never change what the module does.
    assert.match(code, /^console\.log\('demo'\);\n\/\/ hot-runner-compile \d+\n$/);
  }
});

test("an edit that changes nothing is not pushed at all", async () => {
  const { runtime, client } = mounted();

  runtime.writeFile("/src/main.js", "console.log('edited');");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.pushes.length, 1, "the edit itself must reach the bundler");

  // What break-then-undo produces: the broken push dies in the transpile, so undoing
  // it recomputes a sandbox identical to the one the bundler already has. Pushing that
  // blanks a preview that is currently correct, so it must not be pushed.
  runtime.writeFile("/src/main.js", "console.log('edited');");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.pushes.length, 1, "a byte-identical sandbox must not be published");
});

test("reload() before mount() is a no-op", async () => {
  const runtime = new SandpackRuntime(ENTRY, { iframe: {} });
  await runtime.reload();
});
