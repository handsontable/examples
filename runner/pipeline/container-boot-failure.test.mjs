// A Tier-2 boot failure must report its cause, not its transcript (DEV-2533).
//
// `ContainerBootFailure` used to carry the last 40 lines of the pnpm install log as
// its `Error.message`. Three things break when a message is a log: the Sentry issue
// is titled with whatever the tail happened to start with ("Error: Progress: resolved
// 519, reused 350, downloaded 68, added 75"), the culprit is nonsense, and — because
// V8 puts the message inside `error.stack` and stack parsers only skip the first
// line — every subsequent line of the message is parsed as a stack frame. The real
// cause, "Error: Unknown argument: disable-host-check", sat invisibly on the last
// line of the log for four occurrences.
//
// So: `message` is one line, the cause; `log` carries the tail as context. This file
// pins both the selector and the wired `poll()` path — a selector that is never
// called would otherwise pass every unit case while the shipped error stayed a log.

import test from "node:test";
import assert from "node:assert/strict";
import { ContainerRuntime, ContainerBootFailure, bootFailureDetail } from "../packages/runtime/dist/container.js";

const ESC = "\x1b";

/** The DEMOS-T log, shaped as the container actually emitted it: pnpm progress
 *  redrawn in place with erase-line/cursor codes, the dependency diff block, the
 *  boxed build-scripts warning, then a dev server that refused a dead CLI flag. The
 *  cause is the last line — but "last line" is not the rule being tested here, see
 *  PNPM_LOG. */
const ANGULAR_LOG = [
  "::installing dependencies::",
  `Progress: resolved 12, reused 0, downloaded 0, added 0${ESC}[2K${ESC}[1GProgress: resolved 519, reused 350, downloaded 68, added 75`,
  "Packages: +519",
  "++++++++++++++++++++++++++++++++++++++++++++++++++",
  "dependencies:",
  `+ @angular${ESC}[32m/animations 22.0.6${ESC}[39m`,
  "+ handsontable 17.0.1",
  "╭──────────────────────────────────────────────────╮",
  "│   Ignored build scripts: esbuild.                 │",
  "╰──────────────────────────────────────────────────╯",
  "Done in 27.4s using pnpm v10.34.5",
  "::starting dev server::",
  "Error: Unknown argument: disable-host-check",
].join("\n");

/** The canonical install failure the runtime's own doc block names: a pinned
 *  Handsontable version that was never published. pnpm prints its `ERR_` code line
 *  FIRST and its prose hints AFTER, so a "last line mentioning a marker word" rule
 *  picks the useless hint. This fixture is the one that discriminates. */
const PNPM_LOG = [
  "::installing dependencies::",
  "Progress: resolved 4, reused 0, downloaded 0, added 0",
  " ERR_PNPM_NO_MATCHING_VERSION  No matching version found for handsontable@99.0.0",
  "",
  "This error happened while installing the dependencies of demo@0.0.0",
  'The latest release of handsontable is "17.0.1".',
].join("\n");

test("the cause is the line that announces the failure, not the first line of the tail", () => {
  const { cause } = bootFailureDetail(ANGULAR_LOG);
  assert.equal(cause, "Error: Unknown argument: disable-host-check");
});

test("pnpm's ERR_ code beats the hint lines printed after it", () => {
  const { cause } = bootFailureDetail(PNPM_LOG);
  assert.ok(
    cause.startsWith("ERR_PNPM_NO_MATCHING_VERSION"),
    `a hint line is not a cause; got ${JSON.stringify(cause)}`,
  );
  assert.ok(cause.includes("handsontable@99.0.0"), "the unresolvable spec is the whole point of the line");
});

/** The boot script's own cause line. `workers/api/src/index.ts` refuses to touch a
 *  generated starter's lockfile and echoes `::error::…` before `exit 1`, which is the
 *  only reason `::error::` is one of the announcing prefixes at all. Nothing else in
 *  the runner emits it, so nothing else can pin it. */
const FROZEN_INSTALL_LOG = [
  "::seeding immutable baked dependencies::",
  "::reconciling dependencies with pnpm::",
  " ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with \"frozen-lockfile\" because pnpm-lock.yaml is absent",
  "",
  "Note that in CI environments this setting is true by default.",
  "::error::frozen install failed for generated starter metadata; refusing to modify its lockfile",
].join("\n");

/** A failure whose announcing line is not at the start of the line: esbuild (under
 *  vite, next, astro …) prefixes its errors with `✘`, and the source excerpt it prints
 *  AFTER them has no marker word at all. Tier 1 cannot see it and tier 3 would return
 *  the excerpt, so this fixture is the only thing standing between the middle tier and
 *  dead code. */
const ESBUILD_LOG = [
  "::starting dev server::",
  "Done in 9.1s using pnpm v10.34.5",
  '✘ [ERROR] Could not resolve "./app/App"',
  "",
  "    src/main.tsx:3:18:",
  "      3 | import App from './app/App'",
].join("\n");

test("the boot script's own ::error:: line is the cause it went to the trouble of printing", () => {
  const { cause, tail } = bootFailureDetail(FROZEN_INSTALL_LOG);
  assert.equal(
    cause,
    "::error::frozen install failed for generated starter metadata; refusing to modify its lockfile",
  );
  // The runner's final word wins over pnpm's code line above it — it is deliberate,
  // it is stable across occurrences (which is what a title wants), and the pnpm code
  // is one line away in the log that travels beside it.
  assert.ok(tail.includes("ERR_PNPM_OUTDATED_LOCKFILE"), "pnpm's own diagnosis stays in the tail");
});

test("a line that only mentions a failure is used when no line announces one", () => {
  // The middle tier. Without this the `STDERR_MARKERS` fallback could be deleted
  // outright and every other test here would still pass.
  const { cause } = bootFailureDetail(ESBUILD_LOG);
  assert.equal(cause, '✘ [ERROR] Could not resolve "./app/App"');
  assert.ok(!cause.startsWith("      3 |"), "the last line is a source excerpt, not a cause");
});

test("the cause is always a single line", () => {
  // The property that stops a stack parser reading message lines as frames.
  for (const log of [ANGULAR_LOG, PNPM_LOG, FROZEN_INSTALL_LOG, ESBUILD_LOG]) {
    assert.ok(!bootFailureDetail(log).cause.includes("\n"));
  }
});

test("the tail keeps the context the cause line drops", () => {
  const { tail } = bootFailureDetail(ANGULAR_LOG);
  assert.ok(tail.includes("::starting dev server::"), "which phase failed is context, not noise");
  assert.ok(tail.includes("Done in 27.4s using pnpm v10.34.5"), "the install phase succeeded — worth knowing");
});

test("the tail is bounded to the last 40 lines", () => {
  const log = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
  const { tail, cause } = bootFailureDetail(log);
  assert.equal(tail.split("\n").length, 40);
  assert.equal(tail.split("\n")[0], "line 160");
  // No marker anywhere: fall back to the last non-empty line rather than nothing.
  assert.equal(cause, "line 199");
});

test("an empty or escape-only log still produces a sentence", () => {
  for (const log of ["", "   \n\n  ", `${ESC}[2K${ESC}[1G`]) {
    const { cause } = bootFailureDetail(log);
    assert.equal(cause, "Container failed to install dependencies or start.");
  }
});

test("redrawn progress lines leave no escapes and no pre-redraw fragments", () => {
  const { cause, tail } = bootFailureDetail(ANGULAR_LOG);
  for (const [name, value] of [["cause", cause], ["tail", tail]]) {
    assert.ok(!value.includes(ESC), `${name} still carries an escape byte`);
    assert.ok(!value.includes("\r"), `${name} still carries a carriage return`);
    assert.ok(!value.includes("["), `${name} still carries a CSI parameter fragment`);
    assert.ok(
      !value.includes("resolved 12,"),
      `${name} kept a frame that the container erased before printing the next one`,
    );
  }
  assert.ok(tail.includes("Progress: resolved 519, reused 350, downloaded 68, added 75"));
  assert.ok(tail.includes("+ @angular/animations 22.0.6"), "colour codes are not part of the text");
});

test("erase-to-end-of-line does not erase the line", () => {
  // `\x1b[K` clears from the cursor to the end of the row — it is the "wipe whatever
  // the previous, longer line left behind" idiom, and build tools emit it constantly.
  // Treating it like `\x1b[2K` (erase the whole row) would delete the cause outright,
  // which is the very bug this file exists to prevent.
  for (const suffix of ["\x1b[K", "\x1b[0K", "\x1b[1K"]) {
    const { cause } = bootFailureDetail(`boot\nError: Unknown argument: disable-host-check${suffix}`);
    assert.equal(cause, "Error: Unknown argument: disable-host-check", `lost to ${JSON.stringify(suffix)}`);
  }
});

test("a carriage-return redraw keeps only the frame that survived", () => {
  const { cause } = bootFailureDetail("boot\nProgress: 1/9\rerror: everything is on fire");
  assert.equal(cause, "error: everything is on fire");
});

test("preview hostnames are redacted out of both fields", () => {
  // DEV-2527: the preview host label carries a live session token.
  const log = [
    "vite: proxy error for https://4200-sbxabc-tok9.demos.handsontable.com/src/main.ts",
    "Error: failed to load https://4200-sbxabc-tok9.demos.handsontable.com/src/main.ts",
  ].join("\n");
  const { cause, tail } = bootFailureDetail(log);
  for (const [name, value] of [["cause", cause], ["tail", tail]]) {
    assert.ok(!value.includes("tok9"), `${name} leaked a session token`);
    assert.ok(value.includes("<preview>"), `${name} lost the redaction placeholder`);
  }
});

test("an absurdly long cause line is capped", () => {
  const { cause } = bootFailureDetail(`boot\nError: ${"x".repeat(900)}`);
  assert.ok(cause.length <= 503, `a Sentry title is not a place for ${cause.length} characters`);
  assert.ok(cause.endsWith("..."), "truncateMessage marks what it cut");
});

// ---- The wired path -------------------------------------------------------
//
// Everything above passes just as happily if `poll()` never calls the selector.

const settle = () => new Promise((resolve) => setImmediate(resolve));

const ENTRY = {
  framework: "angular",
  displayName: "Angular",
  tier: 2,
  engine: "container",
  sandpackTemplate: null,
  sandpackEnvironment: null,
  container: "angular",
  htWrappers: [],
  entry: "/src/main.ts",
  htmlEntry: null,
  devCommand: "start",
  buildCommand: "build",
  outputDir: "dist",
  outputGlob: null,
  staticExport: false,
  spaMode: true,
  port: 4200,
  installCommand: "install",
  htCoreRange: null,
  minCoreMajor: null,
  fileCount: 2,
  assets: [],
  skipped: [],
  files: {},
};

test("poll() reports the cause as the message and the log beside it", async () => {
  const fetchBefore = globalThis.fetch;
  const windowBefore = globalThis.window;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.fetch = () =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ready: false, log: ANGULAR_LOG, failed: true }),
    });
  const runtime = new ContainerRuntime(ENTRY, { iframe: {}, apiBase: "https://api.test" });
  const errors = [];
  try {
    runtime.sessionId = "s1";
    runtime.port = 4200;
    runtime.onError((e) => errors.push(e));

    runtime.poll();
    await settle();
    await settle();

    assert.equal(errors.length, 1, "a boot failure is reported once, not once per poll");
    const [err] = errors;
    assert.ok(err instanceof ContainerBootFailure);
    assert.equal(err.message, "Error: Unknown argument: disable-host-check");
    assert.ok(!err.message.includes("\n"), "a multiline message is parsed as a stack");
    assert.ok(err.log.includes("::starting dev server::"), "the log still travels, just not as the message");

    // The report-once gate (failedPolls === 0) is an existing invariant this
    // refactor must not disturb: onError is wired to Sentry, and a container left
    // open would otherwise file the same failure every ten seconds.
    // Stand in for the re-poll timer firing. Clearing it first is what the timer
    // itself would do; leaving it pending would orphan a 10s handle (the next poll
    // overwrites `pollTimer`, so `dispose()` could only clear the newest one) and
    // hold the test process open for its full duration.
    clearTimeout(runtime.pollTimer);
    runtime.poll();
    await settle();
    await settle();
    assert.equal(errors.length, 1);
  } finally {
    runtime.dispose();
    globalThis.fetch = fetchBefore;
    globalThis.window = windowBefore;
  }
});
