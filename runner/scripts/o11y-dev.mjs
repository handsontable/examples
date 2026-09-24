#!/usr/bin/env node
// `pnpm o11y:dev` (ADR-0041 §I) — the standalone o11y-only entry point,
// kept separate from `pnpm dev:full` for someone who only wants the o11y
// worker running (e.g. working a pure o11y bug, without the API worker,
// Docker compose, or the Slack capture server). Shares its bootstrap and
// port-resolution logic with `dev.mjs`/`dev-lib.mjs` (this task's dev-stack
// work) instead of duplicating it.
//
// This does NOT also start `containers/o11y/compose.yml` — `wrangler dev`
// manages its OWN container instance via the SAME Dockerfile, and running
// both would fight over the same image/ports for no benefit. `compose.yml`
// remains the right tool for a standalone Loki+Grafana+MinIO+ClickHouse
// stack; use `pnpm dev:full` to get both the o11y worker AND compose's
// minio/clickhouse wired together correctly (RUNNER_EVENTS_CLICKHOUSE_URL,
// the local Slack capture server, etc.).
//
// Usage: `pnpm o11y:dev` from `runner/`, or `node scripts/o11y-dev.mjs`.
// Env overrides: O11Y_DEV_PORT (default 4200), O11Y_DEV_INSPECTOR_PORT
// (default 4201) — same names/defaults `dev.mjs --tier=full` reads.

import { spawn } from "node:child_process";
import path from "node:path";
import {
  RUNNER_ROOT,
  resolvePorts,
  bootstrapDevVars,
  o11yDevVarsPatch,
  O11Y_DEVVARS_STRIP_KEYS,
  readDevVarsLine,
  ephemeralSecret,
  o11yLocalPublicOrigin,
  PORT_DEFAULTS,
} from "./dev-lib.mjs";

const o11yDir = path.join(RUNNER_ROOT, "workers", "o11y");

let ports;
try {
  ports = resolvePorts("o11y-only", process.env);
} catch (err) {
  console.error(`[o11y:dev] ${err.message}`);
  process.exit(1);
}

// o11yDevVarsPatch also wants O11Y_SLACK_CAPTURE_PORT, for the
// SLACK_WEBHOOK_URL default it bakes in on a fresh bootstrap. This
// standalone command doesn't start that server, so fall back to the
// documented default rather than requiring an unrelated port override.
const patchPorts = {
  ...ports,
  O11Y_SLACK_CAPTURE_PORT: Number(process.env.O11Y_SLACK_CAPTURE_PORT) || PORT_DEFAULTS.O11Y_SLACK_CAPTURE_PORT,
};

const devVarsPath = path.join(o11yDir, ".dev.vars");
const examplePath = path.join(o11yDir, ".dev.vars.example");

let bootstrap;
try {
  bootstrap = bootstrapDevVars({
    examplePath,
    devVarsPath,
    patch: o11yDevVarsPatch(patchPorts),
    stripKeys: O11Y_DEVVARS_STRIP_KEYS,
  });
} catch (err) {
  console.error(`[o11y:dev] ${err.message}`);
  process.exit(1);
}
if (bootstrap.created) {
  console.log(`[o11y:dev] created ${devVarsPath} from .dev.vars.example — edit it if you need real secret values`);
  if (bootstrap.patched.length) console.log(`[o11y:dev] filled in local-dev defaults for: ${bootstrap.patched.join(", ")}`);
}

// O11Y_ENV=local and DEV_ADMIN must both be set for the local session bypass
// (K1: env.ts, gates/session.ts#verifySession — replaces the old Access
// gate) and the local jurisdiction-skip paths (inbox/accessor.ts, box.ts) to
// engage. Fail loudly rather than silently running against an unusable
// config.
const envLine = readDevVarsLine(devVarsPath, "O11Y_ENV");
if (envLine !== "local") {
  console.error(`[o11y:dev] ${devVarsPath} must set O11Y_ENV=local — refusing to start against a non-local config`);
  process.exit(1);
}

console.log(`[o11y:dev] starting wrangler dev on port ${ports.O11Y_DEV_PORT} (inspector ${ports.O11Y_DEV_INSPECTOR_PORT})`);
console.log(
  `[o11y:dev] once ready, replay the fixtures in another shell: node scripts/o11y-replay-fixtures.mjs --base http://localhost:${ports.O11Y_DEV_PORT}`,
);
console.log(
  "[o11y:dev] a local Slack-webhook capture server is NOT started by this command — use `pnpm dev:full` for that, or point SLACK_WEBHOOK_URL in .dev.vars at your own `node scripts/o11y-slack-capture.mjs --port <port>`.",
);
console.log(
  "[o11y:dev] the box's local container image build + first `wake()` can take anywhere from a few seconds to well over a minute. This is a real, environment-dependent Container-platform characteristic, not a hang.",
);
console.log(
  '[o11y:dev] to trigger the */10 cron by hand (wrangler no longer wires --test-scheduled/__scheduled locally): curl "http://localhost:' +
    ports.O11Y_DEV_PORT +
    '/cdn-cgi/local/scheduled" (wrangler 4.136.3)',
);

// Spawn `node_modules/.bin/wrangler` directly, not via `npx` — `npx` is a
// wrapper process, and killing it does not reliably kill the real
// `wrangler`/`workerd` grandchild it spawns (the exact orphan-container risk
// this task's research flagged; `detached: true` + signalling the whole
// process group below is what actually reaches workerd's own children too).
const sessionSecret = ephemeralSecret();
const child = spawn(
  path.join("node_modules", ".bin", "wrangler"),
  [
    "dev",
    "--port",
    String(ports.O11Y_DEV_PORT),
    "--inspector-port",
    String(ports.O11Y_DEV_INSPECTOR_PORT),
    "--var",
    `O11Y_SESSION_SECRET:${sessionSecret}`,
    "--var",
    `O11Y_LOCAL_PUBLIC_ORIGIN:${o11yLocalPublicOrigin(ports)}`,
  ],
  { cwd: o11yDir, stdio: "inherit", detached: process.platform !== "win32" },
);

child.on("exit", (code) => process.exit(code ?? 0));

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    try {
      process.kill(-child.pid, sig);
    } catch {
      child.kill(sig);
    }
  });
}
