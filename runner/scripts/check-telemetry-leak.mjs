#!/usr/bin/env node
// A durable post-build leak check for the local-telemetry path (contract
// §10). Builds nothing — run against an already-built
// `apps/authoring/dist/` (CI wires it in right after the production
// build). Exit 0 ("ok") when no sentinel is found; exit 1 and lists every
// match otherwise.

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

// Each sentinel is a string that only survives in a production dist/ if
// dead-code elimination failed or the local-telemetry flag leaked in —
// see main.tsx/sentry.ts/faro.ts for where each one is gated.
const SENTINELS = [
  "__test_crash_boundary",
  "T06 e2e render-crash probe",
  "VITE_TELEMETRY_LOCAL",
  "__t06SentryCapture",
  "__t06ReportDemoEvent",
  "__t06Telemetry",
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
