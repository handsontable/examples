import test from "node:test";
import assert from "node:assert/strict";
import { SandpackCompileError, SandpackRuntime } from "../packages/runtime/dist/sandpack.js";
import { MONITOR_COMPILE_MESSAGE_MAX } from "../packages/runtime/dist/monitor.js";

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
//
// This file also covers the compile-error message contract (DEV-2550): what
// `onMessage`'s `show-error` branch turns the bundler's raw string into before it
// reaches the error card and Sentry.

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
  // What mount() records in buildSetup: the sandbox the bundler now holds. Without it the
  // no-op check has no baseline to compare against, and every push looks like a change.
  runtime.published = { ...FILES };
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

test("a push that fails to build a setup does not count as published", async () => {
  const { runtime, client } = mounted();

  // Delete the entry: `setupFrom` refuses a sandbox whose entry is missing (DEV-2130),
  // which is what a mid-rename keystroke produces. Nothing reaches the bundler.
  runtime.deleteFile("/src/main.js");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.pushes.length, 0, "a sandbox with no entry must not be published");

  // Finish the rename / undo it. The bundler still holds the original sources, so this
  // recomputed sandbox is byte-identical to what it has — and must not be pushed. It
  // would be if the failed push above had recorded itself as published.
  runtime.writeFile("/src/main.js", "console.log('demo');");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.pushes.length, 0, "restoring the sources the bundler already has must not compile");
});

test("reload() before mount() is a no-op", async () => {
  const runtime = new SandpackRuntime(ENTRY, { iframe: {} });
  await runtime.reload();
});

// ---------------------------------------------------------------------------
// DEV-2550 — the `show-error` message contract.
//
// The bundler's `show-error` string is third-party output about visitor-authored
// code, and it was the one DEV-2527 channel that reached both the error card and
// `Sentry.captureException` unbounded: the reported event (DEMOS-15) carried a
// babel code frame followed by a multi-kilobyte inline
// `sourceMappingURL=data:application/json;base64,…` blob, so the actual diagnostic
// was buried and the Sentry payload was mostly base64.
//
// The handler therefore builds a *new* error from that string. It never reads and
// writes back a property of anything it was handed — which is what the frozen
// fixtures below pin. A frozen error cannot reach this path from the hosted bundler
// today (`message` arrives as a string over `postMessage`); the fixtures exist
// because the tempting alternative implementation — `err.message = bound(err.message)`
// — throws on exactly the kind of object the bundler's own message is about, and
// that throw is the failure this ticket describes.

/** Collect what a runtime reports, driving the private `show-error` branch directly. */
function showError(message) {
  const runtime = new SandpackRuntime(ENTRY, { iframe: {} });
  const seen = [];
  runtime.onError((e) => seen.push(e));
  runtime.onMessage(message === undefined ? { type: "action", action: "show-error" } : { type: "action", action: "show-error", message });
  assert.equal(seen.length, 1, "a show-error action must report exactly one error");
  return seen[0];
}

/** What babel 6 (the bundler's transpiler) raises, including the non-writable `message`
 *  that its own `File#wrap` then fails to prefix — the inner text of DEMOS-15. */
function babelSyntaxError() {
  const err = new SyntaxError("/src/main.ts: Invalid regular expression flag. (257:22)");
  err.loc = { line: 257, column: 22 };
  err.codeFrame = "  256 |\n> 257 |   const re = /handsontable/qq;\n      |                          ^";
  err._babel = true;
  Object.defineProperty(err, "message", {
    value: err.message,
    writable: false,
    configurable: false,
  });
  return err;
}

test("DEV-2550: a frozen error is reported, not mutated", () => {
  const frozen = Object.freeze(new Error("SyntaxError: /src/main.ts: Unexpected token (12:3)"));
  // The fixture is genuinely frozen: the naive fix would throw right here.
  assert.throws(() => {
    frozen.message = "rewritten";
  }, TypeError);

  const reported = showError(frozen);

  assert.notEqual(reported, frozen, "the handler must build its own error, never hand back the input");
  assert.ok(reported instanceof SandpackCompileError);
  assert.match(reported.message, /Unexpected token \(12:3\)/);
  assert.equal(frozen.message, "SyntaxError: /src/main.ts: Unexpected token (12:3)", "the input must come out unchanged");
  assert.ok(Object.isFrozen(frozen));
});

test("DEV-2550: a babel SyntaxError with a non-writable message is reported, not mutated", () => {
  const err = babelSyntaxError();
  assert.throws(() => {
    err.message = "/src/main.ts: " + err.message;
  }, TypeError, "the fixture must reproduce the non-writable `message` babel's File#wrap trips over");

  const reported = showError(err);

  assert.notEqual(reported, err);
  assert.ok(reported instanceof SandpackCompileError);
  assert.match(reported.message, /Invalid regular expression flag\. \(257:22\)/);
  assert.equal(err.message, "/src/main.ts: Invalid regular expression flag. (257:22)");
});

test("DEV-2550: an inline source map is stripped, before the cap can act on it", () => {
  // Blob first, diagnostic after it: if the strip ran after truncation the diagnostic
  // would be past the cap and gone, and the payload would be half a base64 blob.
  const blob = "//# sourceMappingURL=data:application/json;charset=utf-8;base64," + "A".repeat(8000);
  const reported = showError(`${blob}\nSyntaxError: /src/main.ts: Invalid regular expression flag. (257:22)`);

  assert.ok(!reported.message.includes("data:"), `a data: blob survived: ${reported.message.slice(0, 200)}`);
  assert.ok(!reported.message.includes("AAAA"));
  assert.match(reported.message, /sourceMappingURL=<omitted>/);
  assert.match(reported.message, /Invalid regular expression flag\. \(257:22\)/);
});

test("DEV-2550: the real DEMOS-15 payload keeps its diagnostic and loses its bulk", () => {
  const raw = [
    "Cannot assign to read only property 'message' of object 'SyntaxError: /src/main.ts: Invalid regular expression flag. (257:22)'",
    "  255 |",
    "> 257 |   const re = /handsontable/qq;",
    "      |                          ^",
    "//# sourceMappingURL=data:application/json;charset=utf-8;base64," + "Q".repeat(60000),
  ].join("\n");

  const reported = showError(raw);

  assert.match(reported.message, /Invalid regular expression flag\. \(257:22\)/);
  assert.match(reported.message, /const re = \/handsontable\/qq;/, "the code frame is the useful part and must survive the cap");
  assert.ok(!reported.message.includes("QQQQ"));
  assert.ok(
    reported.message.length <= MONITOR_COMPILE_MESSAGE_MAX + 3,
    `expected the message bounded to ${MONITOR_COMPILE_MESSAGE_MAX}, got ${reported.message.length}`,
  );
});

test("DEV-2550: an over-long message is truncated at the compile cap", () => {
  const reported = showError("E".repeat(10000));

  assert.equal(reported.message.length, MONITOR_COMPILE_MESSAGE_MAX + 3);
  assert.ok(reported.message.endsWith("..."));
});

test("DEV-2550: a short message is reported byte-identical", () => {
  // The regression this fix must not introduce: the user's own diagnostic, rewritten
  // or trimmed by the bounding it passes through.
  const raw = "  SyntaxError: /src/main.js: Unexpected token, expected \",\" (4:2)\n";
  assert.equal(showError(raw).message, raw);
});

test("DEV-2550: the dependency-fetch message reaches describeRuntimeError intact", () => {
  // App.tsx's `/could not fetch dependencies/i` branch rewrites this into the
  // "check that this version is published on npm" card. The phrase leads the
  // bundler's message, so the cap cannot reach it — pinned here rather than
  // left to inspection.
  const raw = "Could not fetch dependencies, please try again in a couple seconds: request to https://registry.npmjs.org/handsontable failed";
  assert.equal(showError(raw).message, raw);
  assert.match(showError(raw + " " + "x".repeat(9000)).message, /^could not fetch dependencies/i);
});

test("DEV-2550: a show-error with no message keeps the generic fallback", () => {
  assert.equal(showError(undefined).message, "Sandpack compile error");
  assert.equal(showError("").message, "Sandpack compile error");
  assert.equal(showError("   \n").message, "Sandpack compile error");
});

test("DEV-2550: a preview host is redacted before the cap can split it", () => {
  // Positioned so that truncating first keeps `3000-sbx7f2a-tok9xQ.demos.hand` — the
  // session token, in a form `redactPreviewHosts` can no longer match. Redacting
  // first collapses the host to a placeholder that fits, so nothing is cut at all.
  // Both assertions below have to be reachable: padded to leave the token *inside*
  // the cap, `!includes` would pass against the broken order too.
  const raw = "x".repeat(MONITOR_COMPILE_MESSAGE_MAX - 30) + "3000-sbx7f2a-tok9xQ.demos.handsontable.com";
  const reported = showError(raw);

  assert.ok(!reported.message.includes("tok9xQ"), "a session token reached the error message");
  assert.ok(reported.message.endsWith("<preview>"));
});

test("DEV-2550: the reported error names itself, so the Sentry title says what it is", () => {
  const reported = showError("SyntaxError: /src/main.js: Unexpected token (1:1)");
  assert.ok(reported instanceof Error);
  assert.equal(reported.name, "SandpackCompileError");
});
