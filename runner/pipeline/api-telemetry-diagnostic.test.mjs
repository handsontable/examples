import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// `reportDiagnostic` (`workers/api/src/telemetry/diagnostic.ts`) is the API
// worker's handled-error report: a structured line and an `error.handled`
// point, never a Sentry event (contract §11). `diagnostic.ts`
// imports `./lines.js` and `./points.js` (sibling `.ts` files), which
// `--experimental-strip-types` cannot resolve through a `.js` specifier
// from a single-file import (see `resource.ts`'s own doc comment) — so
// this file uses the same copy-and-rewrite harness
// `pipeline/chat-sanitise.test.mjs` uses for `chat.ts`, applied to the
// `telemetry/` subtree instead.
//
// Unlike `chat.ts`, `diagnostic.ts` also has a bare package specifier
// (`@handsontable/demo-runtime/telemetry`), so the copy has to land
// somewhere Node's module resolution still walks up into
// `workers/api/node_modules` (a real symlink there) — an OS temp dir does
// not have that ancestry. The copy below lands inside `workers/api/`
// itself instead, and is removed after.

const workersApiDir = join(import.meta.dirname, "..", "workers/api");
const telemetrySrc = join(workersApiDir, "src/telemetry");
const envSrc = join(workersApiDir, "src/env.ts");
const dir = mkdtempSync(join(workersApiDir, ".hot-diagnostic-"));
// The copy-and-import below must not run as a plain top-level sequence
// with `rmSync` last — a failing import (a typo in one of the copied
// files, a resolution error) would skip the cleanup and leave the scratch
// directory behind for `git add -A` to pick up (see `.gitignore`'s own
// `workers/api/.hot-*` entry). `try/finally` guarantees the directory is
// always removed, whether the import below succeeds or throws.
let reportDiagnostic;
try {
  // diagnostic.ts's own chain: diagnostic.ts -> lines.ts, points.ts
  // -> resource.ts. `env.ts` is imported everywhere as `import type` only
  // (erased by strip-types, never resolved), but is copied too so a stray
  // value use would fail loudly instead of silently resolving to nothing.
  for (const file of ["diagnostic.ts", "lines.ts", "points.ts", "resource.ts"]) {
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
const ENV = { PREVIEW_HOST: "demos.handsontable.com" };

// Handled diagnostics stay out of Sentry (contract §11, ADR-0041 §E.1): the
// only way `reportDiagnostic` could reach it is through the SDK, so the
// module must not import one.
test("reportDiagnostic never reaches Sentry: diagnostic.ts imports no Sentry SDK", () => {
  const source = readFileSync(join(telemetrySrc, "diagnostic.ts"), "utf8");
  assert.doesNotMatch(source, /from\s+"@sentry\//);
  assert.doesNotMatch(source, /\bSentry\./);
});

test("reportDiagnostic: does not throw without a Sentry client", () => {
  assert.doesNotThrow(() => reportDiagnostic(ENV, new Error("boom"), { context: "test-site", routeClass: "api/test" }));
});

// The structured error line `reportDiagnostic` writes via `logErrorLine`
// must carry the contract-fingerprint under `hot.fingerprint` (contract
// §3 AE-only key) — otherwise the API worker's handled errors have no way
// to reach the §F.3 new-fingerprint registry once they arrive at the o11y
// worker as a worker-tenant OTLP export.
test("reportDiagnostic: the structured error line carries hot.fingerprint = fingerprint(context, message)", () => {
  const lines = [];
  const realConsoleError = console.error;
  console.error = (...args) => lines.push(args.join(" "));
  try {
    reportDiagnostic(ENV, new Error("boom"), { context: "test-site", routeClass: "api/test" });
  } finally {
    console.error = realConsoleError;
  }
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed["log.kind"], "error");
  assert.equal(parsed.context, "test-site");
  assert.match(parsed["hot.fingerprint"], /^test-site:[0-9a-f]{16}$/);
});

// The scratch-directory copy+import above must not be a plain top-level
// sequence ending in a bare `rmSync` — a failing import would leave
// `workers/api/.hot-diagnostic-*` behind, ungitignored, for `git add -A`
// to pick up. Structural (the fix is the shape of this file's own
// top-level code, not something a runtime assertion can observe after the
// fact — the directory from a real run is already gone by the time any
// test() body runs, success or failure).
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
