// What a failed install/build reports as its cause (DEV-2570).
//
// The defect these assertions exist against: `share.ts` described a failed
// `sbx.exec` with the last N characters of `stderr + stdout`. A tail cuts at the
// FRONT, so the surviving first line was whatever the tool printed last — pnpm's
// progress counter (Sentry DEMOS-1W) or the middle of its self-update box
// (DEMOS-1Y) — and the multi-line message then fed lines 2..n to the browser SDK's
// stack-frame regexes, inventing the culprit `│ Changelog: (v/11.22)`.
//
// The fixtures are the real DEMOS-1W / DEMOS-1Y event bodies, stream-split the way
// pnpm actually writes them. `container-boot-failure.test.mjs` covers the same rule
// set from the Tier-2 boot side and must keep passing unedited — that suite is the
// regression guard for the extraction.

import test from "node:test";
import assert from "node:assert/strict";
import {
  causeCode,
  execFailureDetail,
  failureDetail,
} from "../packages/runtime/dist/failure-log.js";
import { register } from "node:module";

// `share.ts` reaches the rest of the Worker through `./x.js` specifiers that only a
// bundler resolves, so it is imported the way `mcp-routes.test.mjs` imports the
// router: through the shared resolver hooks, dynamically, after register().
register("./fixtures/worker-hooks.mjs", import.meta.url);
const { BuildFailure, describeBuildFailure } = await import("../workers/api/src/share.ts");

/** The builder's options, as `share.ts` passes them. */
const BUILDER = { keepLines: 120, fallback: "no output" };

/** pnpm's diagnosis. Written to stderr, and it is not the last thing pnpm says. */
const PNPM_STDERR = ` ERR_PNPM_NO_MATCHING_VERSION  No matching version found for handsontable@13106 while fetching it from https://registry.npmjs.org/

This error happened while installing a direct dependency of /app

The latest release of handsontable is "18.0.0".

Other releases are:
  * beta: 8.0.0-beta.2
  * next: 0.0.0-next-64139ae-20260219
  * rc: 18.0.0-rc5

If you need the full list of all 1737 published versions run "pnpm view handsontable versions".`;

/** ...while stdout keeps counting. This is DEMOS-1W's title. */
const PNPM_STDOUT = `Progress: resolved 1, reused 0, downloaded 0, added 0`;

/** ...and the self-update box lands after the failure. This is DEMOS-1Y's title,
 *  and the box frame is where its culprit was parsed from. */
const PNPM_UPDATE_BOX = `   ╭───────────────────────────────────────────────╮
   │                                               │
   │   Update available! 10.34.5 → 11.22.0.        │
   │   Changelog: https://pnpm.io/v/11.22.0        │
   │   To update, run: corepack use pnpm@11.22.0   │
   │                                               │
   ╰───────────────────────────────────────────────╯`;

test("the cause is the pnpm error code, not the progress counter that followed it", () => {
  const { cause } = execFailureDetail({ stdout: PNPM_STDOUT, stderr: PNPM_STDERR }, BUILDER);
  assert.match(cause, /^ERR_PNPM_NO_MATCHING_VERSION/);
  assert.match(cause, /handsontable@13106/);
});

test("pnpm's self-update box never becomes the cause", () => {
  const { cause } = execFailureDetail(
    { stdout: `${PNPM_UPDATE_BOX}\n${PNPM_STDOUT}`, stderr: PNPM_STDERR },
    BUILDER,
  );
  assert.match(cause, /^ERR_PNPM_NO_MATCHING_VERSION/);
  assert.ok(!cause.includes("Update available"));
  assert.ok(!cause.includes("│"));
});

test("the cause is one line — the property that stops the SDK inventing a stack", () => {
  const { cause } = execFailureDetail(
    { stdout: `${PNPM_UPDATE_BOX}\n${PNPM_STDOUT}`, stderr: PNPM_STDERR },
    BUILDER,
  );
  assert.ok(!cause.includes("\n"));
});

test("the prose hint after the code never outranks the code", () => {
  // pnpm prints "This error happened while installing…" AFTER the ERR_ line, and a
  // backwards scan for anything mentioning a failure would pick the hint.
  const { cause } = execFailureDetail({ stderr: PNPM_STDERR }, BUILDER);
  assert.ok(!cause.startsWith("This error happened"));
});

test("stderr breaks the tie when both streams announce a cause", () => {
  const { cause } = execFailureDetail(
    {
      stdout: "ELIFECYCLE  Command failed with exit code 1.",
      stderr: " ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/nope: Not Found - 404",
    },
    BUILDER,
  );
  assert.match(cause, /^ERR_PNPM_FETCH_404/);
});

/** A real `vite build` failure. `runBuild` execs the binary off `node_modules/.bin`
 *  rather than an npm script (share.ts), so there is no pnpm `ELIFECYCLE` epilogue —
 *  the announcing line is vite's own section label, and the error is under it. */
const VITE_STDOUT = `vite v5.4.21 building for production...
transforming...
error during build:
[vite]: Rollup failed to resolve import "handsontable/styles/x.css" from "/app/src/main.ts".`;

test("an announced cause on stdout outranks trailing noise on stderr", () => {
  // vite/ng/next report real build errors on stdout while stderr carries deprecation
  // and browserslist chatter. A plain "stderr wins" rule promotes the warning.
  const { cause } = execFailureDetail(
    {
      stdout: VITE_STDOUT,
      stderr: "(node:41) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.\nBrowserslist: caniuse-lite is outdated.",
    },
    BUILDER,
  );
  assert.match(cause, /Rollup failed to resolve import/);
  assert.ok(!cause.includes("DeprecationWarning"));
});

test("a label-only cause takes the line under it — the common vite build failure", () => {
  // Stopping at "error during build:" would title every vite failure identically and
  // tell the user nothing; `vite build` is the build command for nearly every
  // framework in the catalog, so this is the dominant path.
  const { cause } = execFailureDetail({ stdout: VITE_STDOUT }, BUILDER);
  assert.equal(
    cause,
    'error during build: [vite]: Rollup failed to resolve import "handsontable/styles/x.css" from "/app/src/main.ts".',
  );
  assert.ok(!cause.includes("\n"));
});

test("a reset at the end of a line erases nothing", () => {
  // `\x1b[0G` means "the next frame replaces this line". At the end of a line there is
  // no next frame, and treating it as one deleted the line — a one-line log then
  // described itself as "no output", with no cause AND no buildLog extra.
  const { cause, tail } = execFailureDetail(
    { stderr: " ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with frozen-lockfile\x1b[0G" },
    BUILDER,
  );
  assert.match(cause, /^ERR_PNPM_OUTDATED_LOCKFILE/);
  assert.notEqual(tail, "");
});

test("a redraw mid-line still keeps only the last frame", () => {
  // The counterpart to the test above: the reset rule must keep collapsing pnpm's
  // progress redraws, or every frame glues into one run-on line.
  const { cause } = execFailureDetail(
    { stdout: "\x1b[2K\x1b[1GProgress: resolved 1\x1b[2K\x1b[1GProgress: resolved 2" },
    BUILDER,
  );
  assert.equal(cause, "Progress: resolved 2");
});

test("a mentioned cause is used only when nothing announces one", () => {
  const { cause, code } = execFailureDetail(
    { stdout: "building...\n✘ [ERROR] Could not resolve \"./missing\"", stderr: "" },
    BUILDER,
  );
  assert.match(cause, /Could not resolve/);
  assert.equal(code, "other");
});

test("the code is the machine token, and prose never becomes one", () => {
  assert.equal(causeCode(" ERR_PNPM_NO_MATCHING_VERSION  No matching version found"), "ERR_PNPM_NO_MATCHING_VERSION");
  assert.equal(causeCode("ELIFECYCLE  Command failed with exit code 1."), "ELIFECYCLE");
  assert.equal(causeCode("npm ERR! code E404"), "NPM_ERR");
  assert.equal(causeCode("::error::frozen install failed for generated starter metadata"), "ERROR");
  assert.equal(causeCode("error during build:"), "other");
  assert.equal(causeCode("Error: connect ECONNREFUSED"), "other");
});

test("the builder's window reaches a cause printed well before the end", () => {
  // A boot log is pre-tailed to 2500 bytes and 40 lines is plenty; a webpack build
  // prints its error and then a hundred lines of asset table.
  const noise = Array.from({ length: 80 }, (_, i) => `  asset chunk-${i}.js 12 KiB [emitted]`).join("\n");
  const { cause } = execFailureDetail(
    { stdout: `ELIFECYCLE  Command failed with exit code 1.\n${noise}`, stderr: "" },
    BUILDER,
  );
  assert.match(cause, /^ELIFECYCLE/);
  // ...and the boot path's 40-line default genuinely could not.
  assert.ok(!failureDetail(`ELIFECYCLE  Command failed with exit code 1.\n${noise}`).cause.startsWith("ELIFECYCLE"));
});

test("empty output yields the caller's fallback, not the container's wording", () => {
  const { cause, code, tail } = execFailureDetail({ stdout: "", stderr: "" }, BUILDER);
  assert.equal(cause, "no output");
  assert.equal(code, "other");
  assert.equal(tail, "");
});

test("ANSI survives nothing — pnpm colourises even into a pipe", () => {
  const coloured = `\x1b[2K\x1b[1G\x1b[90mProgress: resolved 1\x1b[39m\n\x1b[31m ERR_PNPM_NO_MATCHING_VERSION\x1b[39m  No matching version found`;
  const { cause } = execFailureDetail({ stderr: coloured }, BUILDER);
  assert.match(cause, /^ERR_PNPM_NO_MATCHING_VERSION/);
  // eslint-disable-next-line no-control-regex
  assert.ok(!/\x1b/.test(cause));
});

test("the tail is uncapped unless a caller asks — the boot log is bounded upstream", () => {
  // A cap here would measure the cleaned, redacted string rather than the 2500 bytes
  // the status route already tailed, so `bootFailureDetail` would start marking tails
  // it never used to cut. App.tsx concatenates that tail into the user's error card.
  const long = Array.from({ length: 30 }, (_, i) => `line ${i} ${"x".repeat(200)}`).join("\n");
  const { tail } = failureDetail(long);
  assert.ok(tail.length > 2500);
  assert.ok(!tail.startsWith("..."));
});

test("the log rides in tail, never in the cause, and stderr survives the byte cap", () => {
  const { cause, tail } = execFailureDetail(
    { stdout: `${PNPM_UPDATE_BOX}\n${PNPM_STDOUT}`, stderr: PNPM_STDERR },
    { ...BUILDER, maxTailChars: 200 },
  );
  assert.ok(!cause.includes("Progress:"));
  // The cap is per stream plus a `...` marker on each part it cut, and a newline
  // between them.
  assert.ok(tail.length <= 200 + "...".length * 2 + 1, `tail was ${tail.length}`);
  assert.match(tail, /published versions/);
  assert.match(tail, /Progress: resolved 1/);
});

test("the thrown BuildFailure names the phase, stays one line, and carries the log apart", () => {
  const err = describeBuildFailure("install", {
    stdout: `${PNPM_UPDATE_BOX}\n${PNPM_STDOUT}`,
    stderr: PNPM_STDERR,
  });
  assert.ok(err instanceof BuildFailure);
  assert.match(err.message, /^install failed: ERR_PNPM_NO_MATCHING_VERSION/);
  assert.ok(!err.message.includes("\n"));
  assert.equal(err.phase, "install");
  assert.equal(err.code, "ERR_PNPM_NO_MATCHING_VERSION");
  // The output is context, not message — this split is the whole fix.
  assert.match(err.log, /Progress: resolved 1/);
  assert.ok(!err.message.includes("Progress:"));
});

test("a build with no output still describes itself", () => {
  const err = describeBuildFailure("build", { stdout: "", stderr: "" });
  assert.equal(err.message, "build failed: no output");
  assert.equal(err.code, "other");
});

test("a loud stream cannot evict the other from the kept log", () => {
  // The cap keeps the END of the tail, so a single join lets 4000 characters of
  // stderr deprecation noise drop stdout whole — including the very line the cause
  // was picked from, leaving a buildLog extra that explains nothing.
  const noise = Array.from(
    { length: 60 },
    (_, i) => `(node:41) [DEP00${i}] DeprecationWarning: ${"x".repeat(90)}`,
  ).join("\n");
  const { cause, tail } = execFailureDetail(
    { stdout: VITE_STDOUT, stderr: noise },
    { ...BUILDER, maxTailChars: 4000 },
  );
  assert.match(cause, /Rollup failed to resolve import/);
  assert.match(tail, /Rollup failed to resolve import/);
  assert.match(tail, /DeprecationWarning/);
  assert.ok(tail.length <= 4000 + "...".length * 2);
});

test("an empty stream lends its whole share to the other", () => {
  const long = Array.from({ length: 60 }, (_, i) => `line ${i} ${"y".repeat(90)}`).join("\n");
  const { tail } = execFailureDetail({ stdout: long, stderr: "" }, { ...BUILDER, maxTailChars: 4000 });
  assert.ok(tail.length > 3900, `half-budget leak: ${tail.length}`);
});
