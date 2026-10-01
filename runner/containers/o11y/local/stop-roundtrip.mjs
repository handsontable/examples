#!/usr/bin/env node
// containers/o11y/local/stop-roundtrip.mjs
//
// Proves ADR-0041 exit criterion 1 and 2 against a REAL docker compose
// stack: push OTLP lines, SIGTERM the box, confirm the clean-shutdown
// marker, force-recreate it, and confirm every line is still queryable.
// Then the negative control: SIGKILL a second wake, confirm NO marker.
//
// Usage: node containers/o11y/local/stop-roundtrip.mjs. Exit 0 = every
// check passed. Run through `rtk proxy` — judge by exit code.

import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { scrubSecrets } from "./redact.mjs";
import { defaultComposeProjectName } from "../../../scripts/dev-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const O11Y_DIR = join(__dirname, "..");

// This script's own up-front `down -v` (below) wipes whatever project
// name it resolves to. The default must never collide with a persistent
// dev stack's own default (`defaultComposeProjectName()`, imported from
// dev-lib.mjs so the two can't drift) or compose.yml's own "o11y-t01"
// example.
//
// A distinct DEFAULT alone is not enough: an inherited
// `COMPOSE_PROJECT_NAME` env var would still win and let `down -v` wipe
// the real dev stack, so reusing the dev stack's project name is a hard refusal.
const DEV_STACK_DEFAULT_PROJECT = defaultComposeProjectName();
const REQUESTED_PROJECT = process.env.COMPOSE_PROJECT_NAME || "o11y-stop-roundtrip";
if (REQUESTED_PROJECT === DEV_STACK_DEFAULT_PROJECT) {
  console.error(
    `error: COMPOSE_PROJECT_NAME="${DEV_STACK_DEFAULT_PROJECT}" is dev.mjs's own persistent dev-stack project name ` +
      `for this worktree (scripts/dev-lib.mjs's defaultComposeProjectName()) — this script's own \`down -v\` would ` +
      `wipe its named volumes (minio-data/clickhouse-data). Refusing to run under this project name; set ` +
      `COMPOSE_PROJECT_NAME to something else (or unset it to use this script's own "o11y-stop-roundtrip" default).`,
  );
  process.exit(1);
}
const PROJECT = REQUESTED_PROJECT;
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

// MINIO_USER/MINIO_PASSWORD (root creds) are always scrubbed from a
// failure log; `opts.redact` lets a call site add its own per-run secrets.
// Output is redacted, not suppressed — a failure still prints for
// diagnosis, just never a real credential.
function sh(cmd, args, opts = {}) {
  const { env: extraEnv, redact: redactValues = [], ...restOpts } = opts;
  const res = spawnSync(cmd, args, {
    cwd: O11Y_DIR,
    encoding: "utf8",
    env: { ...BASE_ENV, ...extraEnv },
    ...restOpts,
  });
  if (res.status !== 0 && !opts.allowFail) {
    const secrets = [MINIO_USER, MINIO_PASSWORD, ...redactValues];
    const scrub = (text) => scrubSecrets(text ?? "", secrets);
    console.error(`command failed: ${scrub(`${cmd} ${args.join(" ")}`)}\n${scrub(res.stdout)}\n${scrub(res.stderr)}`);
  }
  return res;
}

// A trailing plain-object argument to `compose(...)` is treated as options
// for `sh()` (e.g. `{ allowFail: true }` or `redact`) and popped off before
// building the compose args, so every existing call site (which only ever
// passes strings) is unaffected.
function compose(...args) {
  let opts = {};
  const last = args[args.length - 1];
  if (last !== null && typeof last === "object" && !Array.isArray(last)) {
    opts = args.pop();
  }
  return sh("docker", ["compose", "-p", PROJECT, "-f", "compose.yml", ...args], opts);
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

/** The supervisor's own stdout log lines for a container — used to confirm
 *  which branch of `run_stop_protocol` actually
 *  refused the marker (a listing failure vs. an upload failure vs. neither
 *  applying), rather than inferring it only from "no marker" (which both
 *  branches, and several others, all produce identically). */
function boxLogs(containerId) {
  const res = sh("docker", ["logs", containerId], { allowFail: true });
  return `${res.stdout}\n${res.stderr}`;
}

// --- main -------------------------------------------------------------------

async function main() {
  console.log(`o11y box stop-roundtrip — project=${PROJECT} run=${RUN_ID}`);
  console.log(`ports: grafana=${GRAFANA_PORT} loki=${LOKI_PORT} minio=${MINIO_PORT}`);

  // compose.yml's minio/clickhouse use named volumes, so a PRIOR run that
  // crashed before its own `down -v` (O11Y_ROUNDTRIP_KEEP unset) could
  // leave volumes around for THIS run to silently reuse. This `down -v`
  // guarantees a genuinely empty start regardless. Harmless when nothing is left over.
  compose("down", "-v");

  console.log("\n== bring up minio + clickhouse ==");
  // `minio-init` (a one-shot `mc mb` container) is not used — quay.io/minio/mc
  // is not pullable. Bitnami's `minio` image creates the `loki` bucket
  // itself via MINIO_DEFAULT_BUCKETS (compose.yml) before its healthcheck
  // goes green, so `--wait` (blocks until every started service is
  // healthy/running) is sufficient.
  const bringUpRes = compose("up", "-d", "--wait", "minio", "clickhouse");
  record(
    "minio became healthy (bucket created — compose.yml's MINIO_DEFAULT_BUCKETS)",
    bringUpRes.status === 0,
    `exit=${bringUpRes.status}`,
  );

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

  // Behavioural check that [live] max_connections=0 actually turns Live off
  // for Grafana's own frontend — `liveEnabled` in /api/frontend/settings is
  // what the shipped Grafana UI reads before ever opening a socket. This
  // does NOT check the raw /api/live/ws endpoint itself (that remains
  // reachable — see grafana.ini's own note); it checks the one surface the
  // product actually consults.
  {
    const res = await fetch(`http://localhost:${GRAFANA_PORT}/grafana/api/frontend/settings`, {
      headers: { "X-O11Y-GRAFANA-USER": "roundtrip-probe@handsontable.com" },
    });
    const body = res.status === 200 ? await res.json() : null;
    record(
      "run1: /api/frontend/settings reports liveEnabled=false",
      res.status === 200 && body?.liveEnabled === false,
      `HTTP ${res.status} liveEnabled=${body?.liveEnabled}`,
    );
  }

  const pushedBrowser = [`roundtrip-browser-a-${RUN_ID}`, `roundtrip-browser-b-${RUN_ID}`, `roundtrip-browser-c-${RUN_ID}`];
  const pushedWorker = [`roundtrip-worker-a-${RUN_ID}`, `roundtrip-worker-b-${RUN_ID}`];
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

  // ---- run 1b: zero-ingest wake -------------------------------------------
  //
  // A wake that pushes NOTHING to Loki never produces a new uploader-named
  // index object, so shutdown.sh writes no marker for it — the ledger's
  // own "clean" comes from having nothing provisional to lose
  // (`resolveOverWakes`), never from a marker that doesn't exist.
  //
  // Measured here: a Loki with no writes this wake exits 1 on SIGTERM, not
  // 0. `shutdown.sh` only checks the upload when `loki_exit -eq 0`, so this
  // takes the SAME no-marker path via a different branch; recorded as
  // evidence, not asserted.
  console.log("\n== run 1b (zero ingest): no OTLP push at all ==");
  const wakeIdZero = `roundtrip-zero-${RUN_ID}`;
  sh("docker", [
    "compose", "-p", PROJECT, "-f", "compose.yml",
    "up", "-d", "--no-deps", "--force-recreate", "box",
  ], { env: { O11Y_WAKE_ID: wakeIdZero } });
  const readyMsZero = await waitReadyForBox();
  record("run1b: box became ready", readyMsZero >= 0, `${readyMsZero}ms`);

  const containerIdZero = boxContainerId();
  record("run1b: box container found", Boolean(containerIdZero));
  sh("docker", ["kill", "-s", "TERM", containerIdZero]);
  sh("docker", ["wait", containerIdZero]);
  const exitCodeZero = sh("docker", ["inspect", containerIdZero, "--format", "{{.State.ExitCode}}"]).stdout.trim();
  record("run1b: SIGTERM completed and exit code recorded (T03B-D1: a truly-untouched Loki exits 1, not 0 — informational, not asserted)", true, `exit=${exitCodeZero}`);
  record(
    "run1b: no marker written for a zero-ingest wake (shutdown.sh's own contract — the ledger, not this script, is what now treats this as clean)",
    !markerExists(wakeIdZero),
    `state/wakes/${wakeIdZero}/clean`,
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
  const killPushStart = Date.now();
  const killPushStatus = await pushLines("browser", [`roundtrip-kill-canary-${RUN_ID}`], { "hot.demo_id": "r-roundtrip" });
  record("run2: canary push accepted", killPushStatus === 204, `HTTP ${killPushStatus}`);
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

  // Data-loss proof: recreate the box and confirm the canary (pushed but
  // never index-uploaded, SIGKILLed mid-ingest) is genuinely gone — also
  // the negative control for the "restart" section's positive query above.
  console.log("\n== restart after SIGKILL (data-loss negative control) ==");
  const wakeIdAfterKill = `roundtrip-after-kill-${RUN_ID}`;
  sh("docker", [
    "compose", "-p", PROJECT, "-f", "compose.yml",
    "up", "-d", "--no-deps", "--force-recreate", "box",
  ], { env: { O11Y_WAKE_ID: wakeIdAfterKill } });
  const readyMs4 = await waitReadyForBox();
  record("run2 restart: box became ready", readyMs4 >= 0, `${readyMs4}ms`);
  const { status: killQueryStatus, lines: killQueryLines } = await queryLines("browser", "demos-authoring", killPushStart);
  record("run2 restart: browser query 200", killQueryStatus === 200, `HTTP ${killQueryStatus}`);
  record(
    "run2 restart: the SIGKILL'd canary line is genuinely lost (never uploaded)",
    !killQueryLines.includes(`roundtrip-kill-canary-${RUN_ID}`),
    `got ${JSON.stringify(killQueryLines)}`,
  );

  // ---- C1 negative control: a failed FINAL index upload writes no marker ----
  //
  // The bug this proves fixed: an earlier check only asked "does an
  // uploader-named index object exist?" — but the shipper also uploads
  // periodically while Loki runs, so an object can exist from an EARLIER
  // upload even if the LAST, shutdown-time one silently failed. Reproduces
  // that shape: seed a fake object, then run the box against a MinIO user
  // denied PutObject on `index/*` only, so the real shutdown-time upload
  // fails and no NEW uploader-named object appears.
  console.log("\n== C1 negative control: failed final index upload ==");
  const RESTRICTED_USER = `restricted-${RUN_ID}`;
  const RESTRICTED_PASSWORD = `restricted-pw-${RUN_ID}`;
  const RESTRICTED_POLICY = `deny-index-put-${RUN_ID}`;
  setupRestrictedMinioUser(RESTRICTED_USER, RESTRICTED_PASSWORD, RESTRICTED_POLICY);

  const wakeIdC1 = `roundtrip-c1-${RUN_ID}`;
  sh("docker", [
    "compose", "-p", PROJECT, "-f", "compose.yml",
    "up", "-d", "--no-deps", "--force-recreate", "box",
  ], {
    env: {
      O11Y_WAKE_ID: wakeIdC1,
      O11Y_LOKI_S3_ACCESS_KEY_ID: RESTRICTED_USER,
      O11Y_LOKI_S3_SECRET_ACCESS_KEY: RESTRICTED_PASSWORD,
    },
  });
  const readyMsC1 = await waitReadyForBox();
  record("C1: box (restricted S3 credential) became ready", readyMsC1 >= 0, `${readyMsC1}ms`);

  const containerIdC1 = boxContainerId();
  const uploaderName = sh("docker", [
    "exec", containerIdC1, "cat", "/loki/tsdb-index/uploader/name",
  ], { allowFail: true }).stdout.trim();
  record("C1: read this instance's uploader name", Boolean(uploaderName), uploaderName || "(empty)");

  // Seed a fake "earlier successful upload" using the ADMIN credential —
  // the restricted user could not have written this itself, standing in
  // for an upload before the pre-SIGTERM snapshot.
  const dayNow = Math.floor(Date.now() / 1000 / 86400);
  // Both index tables: `index/index/` (the original schema period) and
  // `index/index_` (the period that takes over; local runs write the old one
  // until its `from` date, so this seed is what covers the new prefix).
  const seededKeys = [
    `index/index/${dayNow}/9999999999-${uploaderName}-seeded.tsdb.gz`,
    `index/index_${dayNow}/9999999999-${uploaderName}-seeded.tsdb.gz`,
  ];
  for (const seededKey of seededKeys) {
    const seedRes = curlS3(["-o", "/dev/null", "-w", "%{http_code}", "-X", "PUT", "--data", "seed",
      `http://localhost:${MINIO_PORT}/loki/${seededKey}`]);
    record(`C1: seeded a pre-existing uploader-named index object under ${seededKey.split("/").slice(0, 2).join("/")}/ (admin credential)`, seedRes.stdout.trim() === "200", `HTTP ${seedRes.stdout.trim()} key=${seededKey}`);
  }

  await pushLines("browser", [`roundtrip-c1-line-${RUN_ID}`], { "hot.demo_id": "r-roundtrip" });
  await sleep(300);

  sh("docker", ["kill", "-s", "TERM", containerIdC1]);
  sh("docker", ["wait", containerIdC1]);
  const exitCodeC1 = sh("docker", ["inspect", containerIdC1, "--format", "{{.State.ExitCode}}"]).stdout.trim();
  record(
    "C1: no marker written when the final index upload is blocked, despite a pre-existing uploader-named object",
    !markerExists(wakeIdC1),
    `state/wakes/${wakeIdC1}/clean, box exit=${exitCodeC1}`,
  );
  // Confirm WHICH branch refused the marker, not just trust "no marker"
  // alone. Measured live: denying `s3:PutObject` on `index/*` also rejects
  // the ingester's own periodic CHUNK flush, which Loki retries in a
  // backoff loop past `STOP_GRACE_SECONDS`, so the branch actually observed
  // is shutdown.sh's grace-timeout log line, not a clean non-zero `wait`
  // exit. Accepts all three shapes a real run could produce (grace-timeout,
  // a clean non-zero exit, or a future Loki version's "not new" comparison)
  // rather than asserting only the one this run happened to take.
  const logsC1 = boxLogs(containerIdC1);
  const putBlockedEvidence = /loki did not exit within \d+s of SIGTERM/.test(logsC1)
    || /loki exited with code [1-9]\d*/.test(logsC1)
    || /is new since before SIGTERM/.test(logsC1);
  record(
    "C1: the log confirms the PUT-blocked scenario is what refused it (grace-timeout, a non-zero loki exit, or an explicit not-new comparison)",
    putBlockedEvidence,
    putBlockedEvidence ? "found" : "none of the expected log shapes found in supervisor log",
  );

  // ---- D1 negative control: a failed pre-SIGTERM LISTING (not a blocked
  // PUT) also writes no marker -------------------
  //
  // C1 above proves the PUT-blocked path. This proves the OTHER path:
  // `r2_list_prefix`'s own listing call fails (ListBucket denied), which
  // must make `snapshot_ok=0` and refuse the marker BEFORE any upload
  // confirmation is attempted.
  console.log("\n== D1 negative control (B-I2): a failed pre-SIGTERM listing writes no marker ==");
  const LIST_DENY_USER = `list-deny-${RUN_ID}`;
  const LIST_DENY_PASSWORD = `list-deny-pw-${RUN_ID}`;
  const LIST_DENY_POLICY = `deny-list-${RUN_ID}`;
  // ListBucket is evaluated against the BUCKET's own ARN, never `/*` — get
  // this wrong and the "negative control" would pass for testing nothing.
  setupRestrictedMinioUser(
    LIST_DENY_USER,
    LIST_DENY_PASSWORD,
    LIST_DENY_POLICY,
    { Effect: "Deny", Action: ["s3:ListBucket"], Resource: ["arn:aws:s3:::loki"] },
    "D1: restricted MinIO user/policy created (deny ListBucket on the bucket itself)",
  );

  const wakeIdD1 = `roundtrip-d1-${RUN_ID}`;
  sh("docker", [
    "compose", "-p", PROJECT, "-f", "compose.yml",
    "up", "-d", "--no-deps", "--force-recreate", "box",
  ], {
    env: {
      O11Y_WAKE_ID: wakeIdD1,
      O11Y_LOKI_S3_ACCESS_KEY_ID: LIST_DENY_USER,
      O11Y_LOKI_S3_SECRET_ACCESS_KEY: LIST_DENY_PASSWORD,
    },
  });
  const readyMsD1 = await waitReadyForBox();
  // Ready under a ListBucket-denied credential proves boot itself does not
  // need ListBucket, so a later "no marker" is attributable to shutdown-time listing.
  record("D1: box (ListBucket-denied credential) became ready — boot itself does not need ListBucket", readyMsD1 >= 0, `${readyMsD1}ms`);

  const containerIdD1 = boxContainerId();
  const pushStatusD1 = await pushLines("browser", [`roundtrip-d1-line-${RUN_ID}`], { "hot.demo_id": "r-roundtrip" });
  record("D1: push accepted under the ListBucket-denied credential — ingest itself does not need ListBucket either", pushStatusD1 === 204, `HTTP ${pushStatusD1}`);
  await sleep(300);

  sh("docker", ["kill", "-s", "TERM", containerIdD1]);
  sh("docker", ["wait", containerIdD1]);
  const exitCodeD1 = sh("docker", ["inspect", containerIdD1, "--format", "{{.State.ExitCode}}"]).stdout.trim();
  record(
    "D1: no marker written when the pre-SIGTERM index LISTING is blocked",
    !markerExists(wakeIdD1),
    `state/wakes/${wakeIdD1}/clean, box exit=${exitCodeD1}`,
  );
  const logsD1 = boxLogs(containerIdD1);
  record(
    "D1: the log confirms the LISTING-failure branch specifically refused it (shutdown.sh's own snapshot_ok gate)",
    /pre-SIGTERM index listing failed/.test(logsD1),
    logsD1.includes("pre-SIGTERM index listing failed") ? "found" : "not found in supervisor log",
  );

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;

  // Tear the stack down when done, so a run of this script never leaves
  // containers/networks for the operator to notice and clean up by hand.
  // Set O11Y_ROUNDTRIP_KEEP=1 to skip this while debugging a failure.
  if (process.env.O11Y_ROUNDTRIP_KEEP !== "1") {
    console.log("\n== tearing down (set O11Y_ROUNDTRIP_KEEP=1 to skip) ==");
    compose("down", "-v");
  } else {
    console.log("\nO11Y_ROUNDTRIP_KEEP=1 set — stack left running.");
  }

  async function waitReadyForBox() {
    return waitReady();
  }
}

// `denyStatement`: a single extra `Deny` statement layered on top of the
// same base `Allow s3:* on the whole bucket` every restricted user starts
// from. Defaults to C1's own PutObject-on-`index/*` deny so existing
// callers are unaffected.
function setupRestrictedMinioUser(
  user,
  password,
  policyName,
  denyStatement = { Effect: "Deny", Action: ["s3:PutObject"], Resource: ["arn:aws:s3:::loki/index/*"] },
  label = "restricted MinIO user/policy created (deny PutObject on index/*)",
) {
  const policy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: ["s3:*"], Resource: ["arn:aws:s3:::loki", "arn:aws:s3:::loki/*"] },
      denyStatement,
    ],
  });
  // quay.io/minio/mc is not pullable — the Bitnami `minio` image ships the
  // real `mc` binary INSIDE the container itself, so this execs into the
  // already-running service instead of `docker run`-ing a second image.
  // `-T`: spawnSync has no TTY, and `compose exec` defaults `-t` ON.
  const script = [
    `mc alias set c1 http://localhost:9000 "${MINIO_USER}" "${MINIO_PASSWORD}" >/dev/null`,
    `cat > /tmp/policy.json <<'EOF'\n${policy}\nEOF`,
    `mc admin policy create c1 ${policyName} /tmp/policy.json`,
    `mc admin user add c1 ${user} "${password}"`,
    `mc admin policy attach c1 ${policyName} --user ${user}`,
  ].join(" && ");
  // A transient failure here would otherwise print the FULL `mc admin ...`
  // command line unredacted (both root and restricted-user passwords).
  // Redacted rather than suppressed: `sh()` always scrubs MINIO_USER/
  // MINIO_PASSWORD; `redact: [password]` adds this call's own secret too.
  const res = compose("exec", "-T", "minio", "/bin/sh", "-c", script, { redact: [password] });
  record(label, res.status === 0, res.stdout.trim().split("\n").pop());
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
