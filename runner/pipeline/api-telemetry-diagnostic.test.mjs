import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// T05 fix round (controller review): `reportDiagnostic`'s `sentryScopeIsFull`
// gate (`workers/api/src/telemetry/diagnostic.ts`) had no direct test — only
// the decision function (`sentryScopeIsFull` itself, in
// `api-telemetry-signals.test.mjs`) was pinned, not the wiring that actually
// calls `Sentry.captureException` behind it. `diagnostic.ts` imports
// `./lines.js` and `./points.js` (sibling `.ts` files), which
// `--experimental-strip-types` cannot resolve through a `.js` specifier from
// a single-file import (see `resource.ts`'s own doc comment) — so this file
// uses the same copy-and-rewrite harness `pipeline/chat-sanitise.test.mjs`
// already uses for `chat.ts`, applied to the `telemetry/` subtree instead.
//
// Unlike `chat.ts`, `diagnostic.ts` also has two BARE package specifiers
// (`@sentry/cloudflare`, `@handsontable/demo-runtime/telemetry`), so the copy
// has to land somewhere Node's module resolution still walks up into
// `workers/api/node_modules` (both are real symlinks there) — the OS temp
// dir chat-sanitise.test.mjs uses does not have that ancestry, confirmed by
// a first attempt: `Cannot find package '@sentry/cloudflare'`. The copy
// below lands inside `workers/api/` itself instead, and is removed after.
//
// `reportDiagnostic` takes an injectable `capture` function (fix round
// addition) — the test below passes a recorder instead of the real
// `@sentry/cloudflare` call.

const workersApiDir = join(import.meta.dirname, "..", "workers/api");
const telemetrySrc = join(workersApiDir, "src/telemetry");
const envSrc = join(workersApiDir, "src/env.ts");
const dir = mkdtempSync(join(workersApiDir, ".hot-diagnostic-"));
// Minor triage item 8 (C-M15): the copy-and-import below used to run as a
// plain top-level sequence with `rmSync` last — a failing import (a typo in
// one of the copied files, a resolution error) skipped the cleanup and left
// the scratch directory behind for `git add -A` to pick up, since it was
// never gitignored either (see `.gitignore`'s own `workers/api/.hot-*`
// entry, added alongside this fix). `try/finally` guarantees the directory
// is always removed, whether the import below succeeds or throws.
let reportDiagnostic;
try {
  // diagnostic.ts's own chain: diagnostic.ts -> lines.ts, points.ts, scope.ts
  // -> resource.ts. `env.ts` is imported everywhere as `import type` only
  // (erased by strip-types, never resolved), but is copied too so a stray
  // value use would fail loudly instead of silently resolving to nothing.
  for (const file of ["diagnostic.ts", "lines.ts", "points.ts", "scope.ts", "resource.ts"]) {
    writeFileSync(join(dir, file), readFileSync(join(telemetrySrc, file), "utf8").replaceAll('.js"', '.ts"'));
  }
  writeFileSync(join(dir, "env.ts"), readFileSync(envSrc, "utf8"));
  ({ reportDiagnostic } = await import(join(dir, "diagnostic.ts")));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// `getSink`/`emitPoint` inside `reportDiagnostic` would otherwise reach for
// the local ClickHouse sink (a real `fetch` to localhost:8123) — production
// env shape with no `RUNNER_EVENTS` binding hits `resource.ts`'s documented
// no-op sink instead, so this test touches the network not at all.
const ENV_FULL = { PREVIEW_HOST: "demos.handsontable.com", SENTRY_SCOPE: "full" };
const ENV_UNCAUGHT = { PREVIEW_HOST: "demos.handsontable.com", SENTRY_SCOPE: "uncaught" };

function recorder() {
  const calls = [];
  const capture = (err, context) => calls.push({ err, context });
  return { calls, capture };
}

test("reportDiagnostic: SENTRY_SCOPE=full calls the injected capture once", () => {
  const { calls, capture } = recorder();
  const err = new Error("boom");
  reportDiagnostic(ENV_FULL, err, { context: "test-site", routeClass: "api/test" }, capture);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].err, err);
});

test("reportDiagnostic: SENTRY_SCOPE=uncaught calls the injected capture zero times", () => {
  const { calls, capture } = recorder();
  reportDiagnostic(ENV_UNCAUGHT, new Error("boom"), { context: "test-site", routeClass: "api/test" }, capture);
  assert.equal(calls.length, 0);
});

test("reportDiagnostic: absent SENTRY_SCOPE defaults to full (calls the capture)", () => {
  const { calls, capture } = recorder();
  reportDiagnostic({ PREVIEW_HOST: "demos.handsontable.com" }, new Error("boom"), { context: "test-site", routeClass: "api/test" }, capture);
  assert.equal(calls.length, 1);
});

test("reportDiagnostic: the captured context carries tags/fingerprint/level through", () => {
  const { calls, capture } = recorder();
  reportDiagnostic(ENV_FULL, new Error("boom"), {
    context: "test-site",
    routeClass: "api/test",
    tags: { upstream: "npm-registry" },
    sentryFingerprint: ["a", "b"],
    level: "warning",
  }, capture);
  assert.deepEqual(calls[0].context, {
    level: "warning",
    tags: { upstream: "npm-registry" },
    fingerprint: ["a", "b"],
  });
});

test("reportDiagnostic: with no capture argument, does not throw (falls back to the real Sentry call)", () => {
  // The default path (every real call site in index.ts/chat.ts/theme-ai.ts)
  // — under `uncaught` scope the gate is closed before the real
  // `Sentry.captureException` would ever run, so this is safe to exercise
  // without an active Sentry client.
  assert.doesNotThrow(() => reportDiagnostic(ENV_UNCAUGHT, new Error("boom"), { context: "test-site", routeClass: "api/test" }));
});

// C-I2 (fix round): the structured error line `reportDiagnostic` writes via
// `logErrorLine` must carry the contract-fingerprint under `hot.fingerprint`
// (contract §3 AE-only key) — otherwise the API worker's handled errors have
// no way to reach the §F.3 new-fingerprint registry once they arrive at the
// o11y worker as a worker-tenant OTLP export (see the F3 fix-round report for
// the other, out-of-ownership half of the wiring).
test("reportDiagnostic: the structured error line carries hot.fingerprint = fingerprint(context, message)", () => {
  const lines = [];
  const realConsoleError = console.error;
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const { capture } = recorder();
    reportDiagnostic(ENV_UNCAUGHT, new Error("boom"), { context: "test-site", routeClass: "api/test" }, capture);
  } finally {
    console.error = realConsoleError;
  }
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed["log.kind"], "error");
  assert.equal(parsed.context, "test-site");
  assert.match(parsed["hot.fingerprint"], /^test-site:[0-9a-f]{16}$/);
});

// Minor triage item 9. `index.ts`'s chat-gateway and theme-gateway
// `reportDiagnostic` calls live inside the main worker's `fetch` handler
// (a route match deep inside a ~2000-line switch), not something this suite
// can invoke directly without a full request/env — same constraint
// `pipeline/mcp-create.test.mjs`'s own "the update route calls
// isMcpCreated()" test documents for the same file. Structural, same style:
// the route source is read as text and the exact `sentryFingerprint` shape
// is asserted for each call site — a passing `reportDiagnostic` fingerprint-
// passthrough test elsewhere proves the FUNCTION honours `sentryFingerprint`
// when given one; this proves each call site actually PASSES one. Reverting
// either fix (dropping the `sentryFingerprint` line from either
// `reportDiagnostic` call) makes the matching assertion below fail.
test("the chat-gateway and theme-gateway reportDiagnostic calls set a status-grouped sentryFingerprint (C-M13)", () => {
  const root = join(import.meta.dirname, "..");
  const source = readFileSync(join(root, "workers/api/src/index.ts"), "utf8");

  const chatStart = source.indexOf('context: "chat-gateway"');
  assert.ok(chatStart > -1, "the chat-gateway reportDiagnostic call exists in index.ts");
  const chatCall = source.slice(chatStart, source.indexOf("});", chatStart));
  assert.match(
    chatCall,
    /sentryFingerprint:\s*\["litellm-gateway",\s*String\(err\.status\)\]/,
    "chat-gateway must fingerprint by gateway + status, not by the default message-based grouping (which carries a unique request_id)",
  );

  const themeStart = source.indexOf('context: "theme-gateway"');
  assert.ok(themeStart > -1, "the theme-gateway reportDiagnostic call exists in index.ts");
  const themeCall = source.slice(themeStart, source.indexOf("});", themeStart));
  assert.match(
    themeCall,
    /sentryFingerprint:\s*\["litellm-gateway",\s*String\(err\.status\)\]/,
    "theme-gateway must fingerprint by gateway + status too",
  );
});

// Minor triage item 8 (C-M15): the scratch-directory copy+import above used
// to be a plain top-level sequence ending in a bare `rmSync` — a failing
// import left `workers/api/.hot-diagnostic-*` behind, ungitignored, for
// `git add -A` to pick up. Structural (the fix IS the shape of this file's
// own top-level code, not something a runtime assertion can observe after
// the fact — the directory from a real run is already gone by the time any
// test() body runs, success or failure). Reverting the try/finally back to
// a bare sequence, or dropping `.gitignore`'s `workers/api/.hot-*` line,
// makes the matching assertion below fail.
test("scratch-dir cleanup is wrapped in try/finally, and workers/api/.hot-* is gitignored", () => {
  const selfSource = readFileSync(fileURLToPath(import.meta.url), "utf8");
  assert.match(
    selfSource,
    /try\s*\{[\s\S]*await import\(join\(dir, "diagnostic\.ts"\)\)[\s\S]*\}\s*finally\s*\{\s*rmSync\(dir,/,
    "the copy+import block must be wrapped in try/finally, with rmSync(dir, ...) in the finally",
  );

  const gitignore = readFileSync(join(import.meta.dirname, "..", ".gitignore"), "utf8");
  assert.match(gitignore, /^workers\/api\/\.hot-\*$/m, "runner/.gitignore must ignore workers/api/.hot-* scratch dirs");
});
