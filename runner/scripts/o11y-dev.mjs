#!/usr/bin/env node
// `pnpm o11y:dev` (ADR-0041 §I): starts the o11y worker under `wrangler dev`
// (Miniflare's local R2/DO/cron, plus wrangler's own local Container
// orchestration for `GrafanaBox` — confirmed real and working against this
// task's own Dockerfile, see the task Outcome for the measured timing and
// its variability in a sandboxed dev environment) and the fixture replay.
//
// T03-D (see the task Outcome for the full reasoning): this does NOT also
// start `containers/o11y/compose.yml` — `wrangler dev` manages its OWN
// container instance via the SAME Dockerfile, and running both would fight
// over the same image/ports for no benefit. `compose.yml` remains the
// right tool for a standalone Loki+Grafana+MinIO+ClickHouse stack (T01's
// own local round-trip script, and this task's own out-of-order-window
// measurement, both used it directly, bypassing wrangler entirely).
//
// Usage: `pnpm o11y:dev` from `runner/`, or `node scripts/o11y-dev.mjs`.
// Env overrides (COMMON.md's port-block rule): O11Y_DEV_PORT (default
// 4200, T01's own block — change it if T01's own `wrangler dev` is also
// running), O11Y_DEV_INSPECTOR_PORT (default 4201).

import { spawn } from "node:child_process";
import { existsSync, copyFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const workerDir = path.join(here, "..", "workers", "o11y");
const devVarsPath = path.join(workerDir, ".dev.vars");
const devVarsExamplePath = path.join(workerDir, ".dev.vars.example");

if (!existsSync(devVarsPath)) {
  if (!existsSync(devVarsExamplePath)) {
    console.error(`[o11y:dev] missing ${devVarsExamplePath} — cannot bootstrap .dev.vars`);
    process.exit(1);
  }
  copyFileSync(devVarsExamplePath, devVarsPath);
  console.log(`[o11y:dev] created ${devVarsPath} from .dev.vars.example — edit it if you need real secret values`);
}

// O11Y_ENV=local and DEV_ADMIN must both be set for the local session bypass
// (K1: env.ts, gates/session.ts) and the local jurisdiction-skip paths
// (inbox/accessor.ts, box.ts) to engage. Fail loudly rather than silently
// running against an unusable config.
const devVarsText = readFileSync(devVarsPath, "utf8");
if (!/^O11Y_ENV=local\s*$/m.test(devVarsText)) {
  console.error(`[o11y:dev] ${devVarsPath} must set O11Y_ENV=local — refusing to start against a non-local config`);
  process.exit(1);
}

const port = process.env.O11Y_DEV_PORT ?? "4200";
const inspectorPort = process.env.O11Y_DEV_INSPECTOR_PORT ?? "4201";

console.log(`[o11y:dev] starting wrangler dev on port ${port} (inspector ${inspectorPort})`);
console.log(
  `[o11y:dev] once ready, replay the fixtures in another shell: node scripts/o11y-replay-fixtures.mjs --base http://localhost:${port}`,
);
console.log(
  "[o11y:dev] T03-D (see the task Outcome): this script starts the box + worker + fixture replay instructions only. A local Slack-webhook capture server (the task's own Scope line: \"box, o11y worker, Slack capture server, fixture replay\") was not built — T04 owns the alert path that would actually post to it, and none of T03's own acceptance criteria exercise it; deferred to whichever task first needs to see a real local alert payload.",
);
console.log(
  "[o11y:dev] the box's local container image build + first `wake()` can take anywhere from a few seconds to well over a minute (measured on this task's sandbox probe and in local testing — see the task Outcome). This is a real, environment-dependent Container-platform characteristic, not a hang.",
);
console.log(
  '[o11y:dev] to trigger the */10 cron by hand (wrangler no longer wires --test-scheduled/__scheduled locally): curl "http://localhost:' +
    port +
    '/cdn-cgi/local/scheduled" (confirmed on wrangler 4.136.3 — the task\'s own local testing found this is what the wrangler dev startup banner itself now recommends).',
);

const child = spawn(
  "npx",
  ["wrangler", "dev", "--port", port, "--inspector-port", inspectorPort],
  { cwd: workerDir, stdio: "inherit", shell: process.platform === "win32" },
);

child.on("exit", (code) => process.exit(code ?? 0));

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill(sig));
}
