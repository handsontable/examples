#!/usr/bin/env node
// containers/o11y/local/prod-datasource-check.mjs
// Boots the real box image with PRODUCTION-shaped ClickHouse env (header names
// and values empty, as GrafanaBox sets them) and checks the bare datasource
// variant was provisioned: every other automated boot sets both header names
// and so never reaches this path. The ClickHouse URL may be unreachable; only
// the datasource shape and the absence of the empty-header-name error matter.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { defaultComposeProjectName } from "../../../scripts/dev-lib.mjs";

const O11Y_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

// The up-front `down -v` wipes the named project, so it must never be the
// persistent dev stack's own project.
const PROJECT = process.env.COMPOSE_PROJECT_NAME || "o11y-prod-datasource";
if (PROJECT === defaultComposeProjectName()) {
  console.error(`error: COMPOSE_PROJECT_NAME="${PROJECT}" is the dev stack's own project; refusing to \`down -v\` it.`);
  process.exit(1);
}
const GRAFANA_PORT = process.env.O11Y_PRODDS_GRAFANA_PORT || "4220";
const BASE_ENV = {
  ...process.env,
  COMPOSE_PROJECT_NAME: PROJECT,
  O11Y_GRAFANA_PORT: GRAFANA_PORT,
  O11Y_LOKI_PORT: process.env.O11Y_PRODDS_LOKI_PORT || "4221",
  O11Y_MINIO_PORT: process.env.O11Y_PRODDS_MINIO_PORT || "4222",
  O11Y_MINIO_CONSOLE_PORT: process.env.O11Y_PRODDS_MINIO_CONSOLE_PORT || "4223",
  O11Y_CLICKHOUSE_PORT: process.env.O11Y_PRODDS_CLICKHOUSE_PORT || "4224",
  O11Y_CLICKHOUSE_NATIVE_PORT: process.env.O11Y_PRODDS_CLICKHOUSE_NATIVE_PORT || "4225",
  O11Y_WAKE_ID: "prod-datasource-check",
};

let failures = 0;
function record(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const scratch = mkdtempSync(join(tmpdir(), "o11y-prod-datasource-"));
// Production shape: the Worker passes the header vars empty (box.ts), which
// selects the bare datasource variant.
const overridePath = join(scratch, "compose.prod.yml");
writeFileSync(
  overridePath,
  [
    "services:",
    "  box:",
    "    environment:",
    '      O11Y_CLICKHOUSE_HEADER1_NAME: ""',
    '      O11Y_CLICKHOUSE_HEADER1_VALUE: ""',
    '      O11Y_CLICKHOUSE_HEADER2_NAME: ""',
    '      O11Y_CLICKHOUSE_HEADER2_VALUE: ""',
    "",
  ].join("\n"),
);

function compose(...args) {
  const res = spawnSync("docker", ["compose", "-p", PROJECT, "-f", "compose.yml", "-f", overridePath, ...args], {
    cwd: O11Y_DIR,
    encoding: "utf8",
    env: BASE_ENV,
  });
  if (res.status !== 0) console.error(`command failed: docker compose ${args.join(" ")}\n${res.stdout}\n${res.stderr}`);
  return res;
}

let tornDown = false;
function teardown() {
  if (tornDown) return;
  tornDown = true;
  if (process.env.O11Y_PRODDS_KEEP !== "1") compose("down", "-v");
  rmSync(scratch, { recursive: true, force: true });
}

const grafana = (path) =>
  fetch(`http://localhost:${GRAFANA_PORT}/grafana/api/${path}`, {
    headers: { "X-O11Y-GRAFANA-USER": "prod-datasource-check@handsontable.com" },
  });

async function main() {
  console.log(`o11y box production datasource check — project=${PROJECT} grafana=:${GRAFANA_PORT}`);
  compose("down", "-v");
  const up = compose("up", "-d", "--build", "--wait", "minio", "box");
  record("box image boots with production-shaped env", up.status === 0, `exit=${up.status}`);
  if (up.status !== 0) return;

  const start = Date.now();
  let ready = false;
  while (Date.now() - start < 120_000 && !ready) {
    ready = (await grafana("health").then((r) => r.status).catch(() => 0)) === 200;
    if (!ready) await sleep(2000);
  }
  record("grafana answers /api/health", ready);
  if (!ready) return;

  const res = await grafana("datasources/uid/clickhouse-runner-events").catch(() => null);
  const body = res?.status === 200 ? await res.json() : null;
  record("clickhouse datasource is provisioned", res?.status === 200, `HTTP ${res?.status}`);
  if (!body) return;
  const headerKeys = Object.keys(body.jsonData ?? {}).filter((k) => /^httpHeader/i.test(k));
  record("datasource jsonData has no httpHeader* key", headerKeys.length === 0, headerKeys.join(",") || "none");

  const health = await grafana("datasources/uid/clickhouse-runner-events/health").catch(() => null);
  const healthText = health ? await health.text() : "";
  record("datasource health is not an invalid header field name error", !/invalid header field name/i.test(healthText), `HTTP ${health?.status} ${healthText.slice(0, 160)}`);
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    teardown();
    process.exit(130);
  });
}

try {
  await main();
} catch (err) {
  console.error(String(err?.stack ?? err));
  failures++;
} finally {
  if (failures > 0) console.error(compose("logs", "--no-color", "--tail", "60", "box").stdout);
  teardown();
}
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
