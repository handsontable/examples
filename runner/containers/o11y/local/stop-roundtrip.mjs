#!/usr/bin/env node
// containers/o11y/local/stop-roundtrip.mjs
//
// Proves ADR-0041 exit criterion 1 and 2 against a REAL docker compose
// stack, not a mock: push OTLP lines to both Loki tenants, SIGTERM the box,
// confirm the clean-shutdown marker, force-recreate the box container (a
// genuinely fresh container — no volume on Loki's data dir, so nothing
// survives but what MinIO holds) and confirm every line is still
// queryable. Then the negative control: SIGKILL a second wake and confirm
// NO marker is written.
//
// Zero npm dependencies (T00 owns adding any); shells out to `docker
// compose` and `curl --aws-sigv4` (same technique as
// containers/o11y/supervisor/lib.sh) for the S3-signed marker check, and
// uses Node's built-in fetch for everything else.
//
// Usage: node containers/o11y/local/stop-roundtrip.mjs
// Exit code 0 = every check passed. Non-zero = at least one failed; see the
// FAIL lines. Run through `rtk proxy` per .superpowers/sdd/README/COMMON.md.

import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const O11Y_DIR = join(__dirname, "..");

const PROJECT = process.env.COMPOSE_PROJECT_NAME || "o11y-t01";
const GRAFANA_PORT = process.env.O11Y_GRAFANA_PORT || "4200";
const LOKI_PORT = process.env.O11Y_LOKI_PORT || "4201";
const MINIO_PORT = process.env.O11Y_MINIO_PORT || "4202";
const MINIO_CONSOLE_PORT = process.env.O11Y_MINIO_CONSOLE_PORT || "4203";
const CLICKHOUSE_PORT = process.env.O11Y_CLICKHOUSE_PORT || "4204";
const CLICKHOUSE_NATIVE_PORT = process.env.O11Y_CLICKHOUSE_NATIVE_PORT || "4205";
const MINIO_USER = process.env.O11Y_MINIO_ROOT_USER || "minioadmin";
const MINIO_PASSWORD = process.env.O11Y_MINIO_ROOT_PASSWORD || "minioadmin";

const RUN_ID = randomUUID().slice(0, 8);

let failures = 0;
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const BASE_ENV = {
  ...process.env,
  COMPOSE_PROJECT_NAME: PROJECT,
  O11Y_GRAFANA_PORT: GRAFANA_PORT,
  O11Y_LOKI_PORT: LOKI_PORT,
  O11Y_MINIO_PORT: MINIO_PORT,
  O11Y_MINIO_CONSOLE_PORT: MINIO_CONSOLE_PORT,
  O11Y_CLICKHOUSE_PORT: CLICKHOUSE_PORT,
  O11Y_CLICKHOUSE_NATIVE_PORT: CLICKHOUSE_NATIVE_PORT,
  O11Y_MINIO_ROOT_USER: MINIO_USER,
  O11Y_MINIO_ROOT_PASSWORD: MINIO_PASSWORD,
};

function sh(cmd, args, opts = {}) {
  const { env: extraEnv, ...restOpts } = opts;
  const res = spawnSync(cmd, args, {
    cwd: O11Y_DIR,
    encoding: "utf8",
    env: { ...BASE_ENV, ...extraEnv },
    ...restOpts,
  });
  if (res.status !== 0 && !opts.allowFail) {
    console.error(`command failed: ${cmd} ${args.join(" ")}\n${res.stdout}\n${res.stderr}`);
  }
  return res;
}

function compose(...args) {
  return sh("docker", ["compose", "-p", PROJECT, "-f", "compose.yml", ...args]);
}

// --- S3-signed helpers against the MinIO bucket, mirroring lib.sh ---------

function curlS3(args, opts = {}) {
  return sh(
    "curl",
    [
      "-sS",
      "--max-time",
      "15",
      "--aws-sigv4",
      "aws:amz:auto:s3",
      "--user",
      `${MINIO_USER}:${MINIO_PASSWORD}`,
      ...args,
    ],
    { allowFail: true, ...opts },
  );
}

function markerExists(wakeId) {
  const res = curlS3([
    "-o",
    "/dev/null",
    "-w",
    "%{http_code}",
    "-I",
    `http://localhost:${MINIO_PORT}/loki/state/wakes/${wakeId}/clean`,
  ]);
  return res.stdout.trim() === "200";
}

// --- Loki push / query -----------------------------------------------------

function otlpBody(tenant, lines, extra = {}) {
  const nowNs = String(Date.now() * 1_000_000);
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: tenant === "browser" ? "demos-authoring" : "demos-api" } },
            { key: "service.version", value: { stringValue: "roundtrip-sha" } },
            { key: "deployment.environment.name", value: { stringValue: "local" } },
            { key: "hot.surface", value: { stringValue: tenant === "browser" ? "authoring" : "api" } },
            { key: "hot.tier", value: { stringValue: "1" } },
            { key: "hot.framework", value: { stringValue: "react" } },
            { key: "hot.ht_major", value: { stringValue: "18" } },
            { key: "hot.outcome", value: { stringValue: "ready" } },
            ...Object.entries(extra).map(([key, value]) => ({ key, value: { stringValue: String(value) } })),
          ],
        },
        scopeLogs: [
          {
            logRecords: lines.map((line) => ({
              timeUnixNano: nowNs,
              body: { stringValue: line },
              severityText: "INFO",
            })),
          },
        ],
      },
    ],
  };
}

async function pushLines(tenant, lines, extra = {}) {
  const res = await fetch(`http://localhost:${LOKI_PORT}/otlp/v1/logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Scope-OrgID": tenant },
    body: JSON.stringify(otlpBody(tenant, lines, extra)),
  });
  return res.status;
}

async function queryLines(tenant, serviceName, sinceMs) {
  const startNs = String((sinceMs - 3_600_000) * 1_000_000);
  const url = new URL(`http://localhost:${LOKI_PORT}/loki/api/v1/query_range`);
  url.searchParams.set("query", `{service_name="${serviceName}"}`);
  url.searchParams.set("start", startNs);
  url.searchParams.set("limit", "100");
  const res = await fetch(url, { headers: { "X-Scope-OrgID": tenant } });
  if (res.status !== 200) return { status: res.status, lines: [] };
  const body = await res.json();
  const lines = (body?.data?.result ?? []).flatMap((stream) => stream.values.map((v) => v[1]));
  return { status: res.status, lines };
}

async function waitReady(timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const [g, l] = await Promise.all([
        fetch(`http://localhost:${GRAFANA_PORT}/grafana/api/health`).then((r) => r.status).catch(() => 0),
        fetch(`http://localhost:${LOKI_PORT}/ready`).then((r) => r.status).catch(() => 0),
      ]);
      if (g === 200 && l === 200) return Date.now() - start;
    } catch {
      // keep polling
    }
    await sleep(1000);
  }
  return -1;
}

function boxContainerId() {
  const res = compose("ps", "-q", "box");
  return res.stdout.trim();
}

// --- main -------------------------------------------------------------------

async function main() {
  console.log(`o11y box stop-roundtrip — project=${PROJECT} run=${RUN_ID}`);
  console.log(`ports: grafana=${GRAFANA_PORT} loki=${LOKI_PORT} minio=${MINIO_PORT}`);

  console.log("\n== bring up minio + clickhouse ==");
  compose("up", "-d", "minio", "minio-init", "clickhouse");
  // Wait for minio-init to finish (bucket created) before touching the box.
  let minioInitDone = false;
  for (let i = 0; i < 30; i++) {
    const id = compose("ps", "-a", "-q", "minio-init").stdout.trim();
    if (id) {
      const code = sh("docker", ["inspect", id, "--format", "{{.State.ExitCode}}"], { allowFail: true }).stdout.trim();
      if (code === "0") {
        minioInitDone = true;
        break;
      }
    }
    await sleep(1000);
  }
  record("minio-init completed (bucket created)", minioInitDone);

  // ---- run 1: clean stop -----------------------------------------------
  const wakeIdClean = `roundtrip-clean-${RUN_ID}`;
  console.log(`\n== run 1 (clean stop): wakeId=${wakeIdClean} ==`);
  {
    const bootStart = Date.now();
    sh("docker", [
      "compose", "-p", PROJECT, "-f", "compose.yml",
      "up", "-d", "--no-deps", "--force-recreate", "box",
    ], { env: { O11Y_WAKE_ID: wakeIdClean } });
    // compose.yml reads O11Y_WAKE_ID at container-create time; the env above
    // must reach the `up` invocation directly.
    const readyMs = await waitReadyForBox();
    record("run1: box became ready", readyMs >= 0, `${readyMs}ms`);
    console.log(`local boot: ${readyMs}ms`);
  }

  const pushedBrowser = ["roundtrip-browser-a", "roundtrip-browser-b", "roundtrip-browser-c"];
  const pushedWorker = ["roundtrip-worker-a", "roundtrip-worker-b"];
  const pushStart = Date.now();
  const bStatus = await pushLines("browser", pushedBrowser, { "hot.demo_id": "r-roundtrip" });
  const wStatus = await pushLines("worker", pushedWorker, { "hot.demo_id": "r-roundtrip" });
  record("run1: browser push accepted", bStatus === 204, `HTTP ${bStatus}`);
  record("run1: worker push accepted", wStatus === 204, `HTTP ${wStatus}`);
  await sleep(500);

  const containerId1 = boxContainerId();
  record("run1: box container found", Boolean(containerId1));

  const termStart = Date.now();
  sh("docker", ["kill", "-s", "TERM", containerId1]);
  sh("docker", ["wait", containerId1]);
  const termMs = Date.now() - termStart;
  const exitCode1 = sh("docker", ["inspect", containerId1, "--format", "{{.State.ExitCode}}"]).stdout.trim();
  record("run1: SIGTERM stop wall time recorded", true, `${termMs}ms`);
  record("run1: box exited 0 on SIGTERM", exitCode1 === "0", `exit=${exitCode1}`);
  record("run1: clean-shutdown marker present", markerExists(wakeIdClean), `state/wakes/${wakeIdClean}/clean`);

  // ---- restart from a genuinely fresh container -------------------------
  console.log("\n== restart (fresh container, same MinIO bucket) ==");
  const wakeIdRestart = `roundtrip-restart-${RUN_ID}`;
  sh("docker", [
    "compose", "-p", PROJECT, "-f", "compose.yml",
    "up", "-d", "--no-deps", "--force-recreate", "box",
  ], { env: { O11Y_WAKE_ID: wakeIdRestart } });
  const readyMs2 = await waitReadyForBox();
  record("restart: box became ready", readyMs2 >= 0, `${readyMs2}ms`);

  const { status: bqStatus, lines: bLines } = await queryLines("browser", "demos-authoring", pushStart);
  const { status: wqStatus, lines: wLines } = await queryLines("worker", "demos-api", pushStart);
  record("restart: browser query 200", bqStatus === 200, `HTTP ${bqStatus}`);
  record("restart: worker query 200", wqStatus === 200, `HTTP ${wqStatus}`);
  const browserSetOk = pushedBrowser.every((l) => bLines.includes(l)) && bLines.length === pushedBrowser.length;
  const workerSetOk = pushedWorker.every((l) => wLines.includes(l)) && wLines.length === pushedWorker.length;
  record(
    "restart: 100% of pushed browser lines queryable (exact set)",
    browserSetOk,
    `expected ${JSON.stringify(pushedBrowser)} got ${JSON.stringify(bLines)}`,
  );
  record(
    "restart: 100% of pushed worker lines queryable (exact set)",
    workerSetOk,
    `expected ${JSON.stringify(pushedWorker)} got ${JSON.stringify(wLines)}`,
  );

  // ---- run 2: negative control — SIGKILL writes no marker ---------------
  console.log("\n== run 2 (negative control): SIGKILL ==");
  const wakeIdKill = `roundtrip-kill-${RUN_ID}`;
  sh("docker", [
    "compose", "-p", PROJECT, "-f", "compose.yml",
    "up", "-d", "--no-deps", "--force-recreate", "box",
  ], { env: { O11Y_WAKE_ID: wakeIdKill } });
  const readyMs3 = await waitReadyForBox();
  record("run2: box became ready", readyMs3 >= 0, `${readyMs3}ms`);
  await pushLines("browser", ["roundtrip-kill-canary"], { "hot.demo_id": "r-roundtrip" });
  await sleep(300);

  const containerId2 = boxContainerId();
  sh("docker", ["kill", "-s", "KILL", containerId2]);
  sh("docker", ["wait", containerId2]);
  const exitCode2 = sh("docker", ["inspect", containerId2, "--format", "{{.State.ExitCode}}"]).stdout.trim();
  record("run2: box exit code is the SIGKILL code (137)", exitCode2 === "137", `exit=${exitCode2}`);
  record("run2: NO marker written for a SIGKILL'd wake", !markerExists(wakeIdKill), `state/wakes/${wakeIdKill}/clean`);
  // The clean run's own marker must still be the only one with this run id.
  record(
    "run2: the earlier clean-run marker is untouched",
    markerExists(wakeIdClean),
    `state/wakes/${wakeIdClean}/clean`,
  );

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;

  async function waitReadyForBox() {
    return waitReady();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
