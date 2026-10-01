#!/usr/bin/env node
// containers/o11y/local/idle-stop.mjs
//
// Proves the real box image idle-stops under `wrangler dev` (sleepAfter shortened by
// O11Y_SLEEP_AFTER, local only). It pushes one log line because a wake that ingested
// nothing gets no clean marker by design (ADR-0041 stop protocol).

import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { scrubSecrets } from "./redact.mjs";
import { defaultComposeProjectName } from "../../../scripts/dev-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const O11Y_DIR = join(__dirname, "..");
const WORKER_DIR = join(O11Y_DIR, "..", "..", "workers", "o11y");

// The up-front `down -v` wipes the named project, so it must never be the
// persistent dev stack's own project.
const PROJECT = process.env.COMPOSE_PROJECT_NAME || "o11y-idle-stop";
if (PROJECT === defaultComposeProjectName()) {
  console.error(`error: COMPOSE_PROJECT_NAME="${PROJECT}" is the dev stack's own project; refusing to \`down -v\` it.`);
  process.exit(1);
}
const WRANGLER_PORT = process.env.O11Y_IDLE_WRANGLER_PORT || "4510";
const INSPECTOR_PORT = process.env.O11Y_IDLE_INSPECTOR_PORT || "4511";
const MINIO_PORT = process.env.O11Y_MINIO_PORT || "4512";
const MINIO_CONSOLE_PORT = process.env.O11Y_MINIO_CONSOLE_PORT || "4513";
const CLICKHOUSE_PORT = process.env.O11Y_CLICKHOUSE_PORT || "4514";
const CLICKHOUSE_NATIVE_PORT = process.env.O11Y_CLICKHOUSE_NATIVE_PORT || "4515";
const MINIO_USER = "minioadmin";
const MINIO_PASSWORD = "minioadmin";
const SLEEP_AFTER = process.env.O11Y_IDLE_SLEEP_AFTER || "20s";
if (!/^[1-9]\d*[smh]$/.test(SLEEP_AFTER)) {
  console.error(`error: O11Y_IDLE_SLEEP_AFTER="${SLEEP_AFTER}" must look like 20s, 2m or 1h (non-zero); the box would ignore it.`);
  process.exit(1);
}
const SLEEP_AFTER_MS = Number(SLEEP_AFTER.slice(0, -1)) * { s: 1000, m: 60_000, h: 3_600_000 }[SLEEP_AFTER.slice(-1)];
const SESSION_SECRET = "idle-stop-" + "x".repeat(40);
const SECRETS = [MINIO_PASSWORD, SESSION_SECRET];

const BASE_ENV = {
  ...process.env,
  COMPOSE_PROJECT_NAME: PROJECT,
  O11Y_MINIO_PORT: MINIO_PORT,
  O11Y_MINIO_CONSOLE_PORT: MINIO_CONSOLE_PORT,
  O11Y_CLICKHOUSE_PORT: CLICKHOUSE_PORT,
  O11Y_CLICKHOUSE_NATIVE_PORT: CLICKHOUSE_NATIVE_PORT,
  O11Y_MINIO_ROOT_USER: MINIO_USER,
  O11Y_MINIO_ROOT_PASSWORD: MINIO_PASSWORD,
};

let failures = 0;
function record(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function sh(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: O11Y_DIR, encoding: "utf8", env: BASE_ENV, ...opts });
  if (res.status !== 0 && !opts.allowFail) {
    console.error(scrubSecrets(`command failed: ${cmd} ${args.join(" ")}\n${res.stdout}\n${res.stderr}`, SECRETS));
  }
  return res;
}
const compose = (...args) => sh("docker", ["compose", "-p", PROJECT, "-f", "compose.yml", ...args]);

function s3(args) {
  return sh(
    "curl",
    ["-sS", "--max-time", "15", "--aws-sigv4", "aws:amz:auto:s3", "--user", `${MINIO_USER}:${MINIO_PASSWORD}`, ...args],
    { allowFail: true },
  );
}
function markerExists(wakeId) {
  const res = s3(["-o", "/dev/null", "-w", "%{http_code}", "-I", `http://localhost:${MINIO_PORT}/loki/state/wakes/${wakeId}/clean`]);
  return res.stdout.trim() === "200";
}

const dockerIds = () => new Set(sh("docker", ["ps", "-q"]).stdout.split("\n").filter(Boolean));
const allIds = () => new Set(sh("docker", ["ps", "-aq"]).stdout.split("\n").filter(Boolean));
const isRunning = (id) => sh("docker", ["inspect", id, "--format", "{{.State.Running}}"], { allowFail: true }).stdout.trim() === "true";

/** The wake id the Worker minted, read from the box container's own env. */
function wakeIdOf(id) {
  const env = sh("docker", ["inspect", id, "--format", "{{range .Config.Env}}{{println .}}{{end}}"]).stdout;
  return /^WAKE_ID=(.+)$/m.exec(env)?.[1] ?? null;
}

async function visit() {
  const res = await fetch(`http://localhost:${WRANGLER_PORT}/grafana/api/health`, {
    headers: { "sec-fetch-dest": "document" },
    redirect: "manual",
  }).catch(() => null);
  return res?.status ?? 0;
}

/** Visit until Grafana answers 200 (the waking page is a non-200). */
async function visitUntilReady(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await visit()) === 200) return Date.now() - start;
    await sleep(2000);
  }
  return -1;
}

async function waitFor(pred, timeoutMs, stepMs = 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return Date.now() - start;
    await sleep(stepMs);
  }
  return -1;
}

/** Push one OTLP log line into the box's Loki from inside the container: the
 *  stop protocol writes its marker only once Loki has an index object to
 *  flush, and nothing else feeds an idle box. */
function pushLine(id, line) {
  const nowNs = String(Date.now() * 1_000_000);
  const body = JSON.stringify({
    resourceLogs: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: "demos-api" } }] },
      scopeLogs: [{ logRecords: [{ timeUnixNano: nowNs, body: { stringValue: line }, severityText: "INFO" }] }],
    }],
  });
  return sh("docker", [
    "exec", id, "curl", "-sS", "-o", "/dev/null", "-w", "%{http_code}", "-X", "POST",
    "-H", "Content-Type: application/json", "-H", "X-Scope-OrgID: worker",
    "--data", body, "http://localhost:3100/otlp/v1/logs",
  ], { allowFail: true }).stdout.trim();
}

let wrangler = null;
let containersBefore = new Set();
let scratch = null;
let logPath = null;

let tornDown = false;
function teardown() {
  if (tornDown) return;
  tornDown = true;
  if (wrangler && wrangler.exitCode === null) {
    try {
      process.kill(-wrangler.pid, "SIGTERM");
    } catch {
      wrangler.kill("SIGTERM");
    }
  }
  // wrangler leaves its proxy sidecar behind; remove only the ones this run created.
  for (const id of allIds()) {
    if (containersBefore.has(id)) continue;
    const name = sh("docker", ["inspect", id, "--format", "{{.Name}}"], { allowFail: true }).stdout;
    if (name.includes("workerd-handsontable-demos-o11y-GrafanaBox")) sh("docker", ["rm", "-f", id], { allowFail: true });
  }
  if (process.env.O11Y_IDLE_KEEP !== "1") compose("down", "-v");
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}

async function main() {
  console.log(`o11y box idle-stop — project=${PROJECT} sleepAfter=${SLEEP_AFTER} wrangler=:${WRANGLER_PORT} minio=:${MINIO_PORT}`);

  // wrangler reads `.dev.vars` ahead of `--var`, so an existing one could
  // override the idle window or the env; refuse rather than guess.
  if (existsSync(join(WORKER_DIR, ".dev.vars"))) {
    console.error("error: workers/o11y/.dev.vars exists and would override this script's --var values; move it aside.");
    process.exit(1);
  }

  compose("down", "-v");
  containersBefore = allIds();
  const up = compose("up", "-d", "--wait", "minio", "clickhouse");
  record("minio + clickhouse healthy", up.status === 0, `exit=${up.status}`);
  if (up.status !== 0) return;

  scratch = mkdtempSync(join(tmpdir(), "o11y-idle-stop-"));
  logPath = process.env.O11Y_IDLE_LOG || join(scratch, "wrangler.log");
  const log = createWriteStream(logPath);
  const vars = {
    O11Y_ENV: "local",
    DEV_ADMIN: "idle-stop@handsontable.com",
    O11Y_SESSION_SECRET: SESSION_SECRET,
    O11Y_SLEEP_AFTER: SLEEP_AFTER,
    O11Y_LOCAL_MINIO_PORT: MINIO_PORT,
    O11Y_LOCAL_CLICKHOUSE_PORT: CLICKHOUSE_PORT,
    O11Y_LOCAL_PUBLIC_ORIGIN: `http://localhost:${WRANGLER_PORT}`,
  };
  const before = dockerIds();
  wrangler = spawn(
    join(WORKER_DIR, "node_modules", ".bin", "wrangler"),
    [
      "dev",
      "--port", WRANGLER_PORT,
      "--inspector-port", INSPECTOR_PORT,
      "--persist-to", join(scratch, "state"),
      ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`]),
    ],
    { cwd: WORKER_DIR, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  wrangler.stdout.pipe(log);
  wrangler.stderr.pipe(log);

  // ---- wake 1 ------------------------------------------------------------
  const readyMs = await visitUntilReady(420_000);
  record("visit woke the box and Grafana answered 200", readyMs >= 0, `${readyMs}ms`);
  if (readyMs < 0) return;
  const readyAt = Date.now();

  const [boxId] = [...dockerIds()].filter((id) => !before.has(id) && wakeIdOf(id));
  record("box container found", Boolean(boxId));
  if (!boxId) return;
  // The container is removed on exit; follow its log so a failure can show it.
  const follow = spawn("docker", ["logs", "-f", boxId], { stdio: ["ignore", "pipe", "pipe"] });
  follow.stdout.pipe(log, { end: false });
  follow.stderr.pipe(log, { end: false });
  const wake1 = wakeIdOf(boxId);
  const pushed = pushLine(boxId, `idle-stop-${Date.now()}`);
  record("a log line was accepted by the box's Loki", pushed === "204", `HTTP ${pushed}`);
  record("wake 1 has no clean marker while running", !markerExists(wake1), wake1);

  // ---- idle: no further requests ------------------------------------------
  const stoppedMs = await waitFor(() => !isRunning(boxId), SLEEP_AFTER_MS + 120_000, 2000);
  record("container stopped on its own after the idle window", stoppedMs >= 0, `${Date.now() - readyAt}ms after ready`);
  record(
    "stop came no earlier than sleepAfter",
    Date.now() - readyAt >= SLEEP_AFTER_MS - 5000,
    `sleepAfter=${SLEEP_AFTER_MS}ms`,
  );
  const exit = sh("docker", ["inspect", boxId, "--format", "{{.State.ExitCode}}"], { allowFail: true }).stdout.trim();
  record("box exited 0 (SIGTERM path)", exit === "0", `exit=${exit}`);
  record("clean-shutdown marker present", await waitFor(() => markerExists(wake1), 15_000) >= 0, `state/wakes/${wake1}/clean`);

  // ---- wake 2 --------------------------------------------------------------
  const before2 = dockerIds();
  const ready2 = await visitUntilReady(420_000);
  record("second visit restarts the box", ready2 >= 0, `${ready2}ms`);
  if (ready2 >= 0) {
    const [boxId2] = [...dockerIds()].filter((id) => !before2.has(id) && wakeIdOf(id));
    const wake2 = boxId2 ? wakeIdOf(boxId2) : null;
    record("second wake mints a new wake id", Boolean(wake2) && wake2 !== wake1, `${wake1} -> ${wake2}`);
    record("wake 1 marker survives wake 2", markerExists(wake1));
  }
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
  console.error(scrubSecrets(String(err?.stack ?? err), SECRETS));
  failures++;
} finally {
  if (failures > 0 && logPath && existsSync(logPath)) {
    console.error("---- wrangler log (tail) ----");
    console.error(scrubSecrets(readFileSync(logPath, "utf8").split("\n").slice(-60).join("\n"), SECRETS));
  }
  teardown();
}
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
