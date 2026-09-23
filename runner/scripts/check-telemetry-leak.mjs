#!/usr/bin/env node
// A durable post-build leak check for T06's local-telemetry path (contract §10:
// "a post-build leak check fails if the local path survives into it").
//
// Builds nothing — run it against an already-built `apps/authoring/dist/` (T10
// wires it into CI right after the production build step, the same way
// `check-compiler-chunk.mjs` is already run there).
//
// What it greps for and why each string is a genuine sentinel, not an
// incidental match:
//
//  - `__test_crash_boundary` / `T06 e2e render-crash probe` — `main.tsx`'s
//    `CrashProbe` test seam (T06-D3). Its whole `if` guard is gated on
//    `import.meta.env.VITE_TELEMETRY_LOCAL === "1"`, a build-time constant Vite
//    replaces literally — `"1" === "1"` when built WITH the flag (folds true,
//    keeps the branch and its string literals reachable) vs `undefined ===
//    "1"` when built WITHOUT it (folds false, and Rollup's dead-code
//    elimination removes the whole branch, literals included — measured, not
//    assumed, see the task file's T06-D3). Finding either string in a
//    production `dist/` means either the flag leaked into the build, or DCE
//    stopped eliminating the branch — both are the leak this check exists to
//    catch.
//  - `VITE_TELEMETRY_LOCAL` itself — the raw env-var NAME never has a reason to
//    survive minification as a string (Vite replaces `import.meta.env.X`
//    reads with the value, not the name); if it appears literally, something
//    is reading it dynamically (e.g. `import.meta.env["VITE_TELEMETRY_LOCAL"]`
//    or a debug dump) in a way the static replacement cannot fold away.
//  - `__t06SentryCapture` / `__t06ReportDemoEvent` — `sentry.ts`'s fix-round-I3
//    e2e-only hooks (the local-test `Sentry.init()` transport spy and the
//    `reportDemoEvent` test bypass). Gated by the same `localTestSentryEnabled()`
//    (`VITE_TELEMETRY_LOCAL === "1"` + localhost/127.0.0.1) as the CrashProbe
//    seam, same dead-code-elimination guarantee.
//
// Exit 0 and prints "ok" when none of the sentinels are found; exit 1 and
// lists every match otherwise.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../apps/authoring/dist");

if (!existsSync(dist)) {
  console.error(`no build to check at ${dist} — run \`pnpm --filter @handsontable/demo-authoring build\` first`);
  process.exit(1);
}

const assetsDir = path.join(dist, "assets");
if (!existsSync(assetsDir)) {
  console.error(`${assetsDir} does not exist — the build did not finish`);
  process.exit(1);
}

const SENTINELS = [
  "__test_crash_boundary",
  "T06 e2e render-crash probe",
  "VITE_TELEMETRY_LOCAL",
  "__t06SentryCapture",
  "__t06ReportDemoEvent",
];

const jsFiles = readdirSync(assetsDir).filter((f) => f.endsWith(".js"));
if (jsFiles.length === 0) {
  console.error(`${assetsDir} has no .js assets — the build did not finish`);
  process.exit(1);
}

const hits = [];
for (const file of jsFiles) {
  const code = readFileSync(path.join(assetsDir, file), "utf8");
  for (const sentinel of SENTINELS) {
    if (code.includes(sentinel)) hits.push(`assets/${file}: "${sentinel}"`);
  }
}

if (hits.length) {
  console.error("telemetry leak check failed — local-path sentinel(s) found in a production build:");
  for (const h of hits) console.error(`  - ${h}`);
  console.error("Rebuild with .env.local absent and VITE_TELEMETRY_LOCAL unset.");
  process.exit(1);
}

console.log(`telemetry leak check ok: no local-path sentinel found across ${jsFiles.length} JS asset(s)`);
