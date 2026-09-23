import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
// diagnostic.ts's own chain: diagnostic.ts -> lines.ts, points.ts, scope.ts
// -> resource.ts. `env.ts` is imported everywhere as `import type` only
// (erased by strip-types, never resolved), but is copied too so a stray
// value use would fail loudly instead of silently resolving to nothing.
for (const file of ["diagnostic.ts", "lines.ts", "points.ts", "scope.ts", "resource.ts"]) {
  writeFileSync(join(dir, file), readFileSync(join(telemetrySrc, file), "utf8").replaceAll('.js"', '.ts"'));
}
writeFileSync(join(dir, "env.ts"), readFileSync(envSrc, "utf8"));
const { reportDiagnostic } = await import(join(dir, "diagnostic.ts"));
rmSync(dir, { recursive: true, force: true });

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
