#!/usr/bin/env node
// containers/o11y/local/stop-roundtrip.mjs
//
// Proves ADR-0041 exit criterion 1 and 2 against a REAL docker compose
// stack, not a mock: push OTLP lines to both Loki tenants, SIGTERM the box,
// confirm the clean-shutdown marker, force-recreate the box container (a
// genuinely fresh container — MinIO/ClickHouse now use named volumes
// (dev-persist task), so `main()` runs its own `down -v` up front to
// guarantee a genuinely empty start regardless of what a prior run left
// behind) and confirm every line is still queryable. Then the negative
// control: SIGKILL a second wake and confirm NO marker is written.
//
// Zero npm dependencies (T00 owns adding any); shells out to `docker
// compose` and `curl --aws-sigv4` (same technique as
// containers/o11y/supervisor/lib.sh) for the S3-signed marker check, and
// uses Node's built-in fetch for everything else.
//
// Usage: node containers/o11y/local/stop-roundtrip.mjs
// Exit code 0 = every check passed. Non-zero = at least one failed; see the
// FAIL lines. Run through `rtk proxy` — judge by exit code, not rtk's summary.

import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { scrubSecrets } from "./redact.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const O11Y_DIR = join(__dirname, "..");

// A-M1: this script's own up-front `down -v` (below) wipes whatever project
// name it resolves to, INCLUDING the named volumes dev-persist relies on
// (minio-data/clickhouse-data). The default used to be "o11y-t01" — the
// same name compose.yml's own header comment recommends for a T01
// developer's persistent manual/dev stack — so running this script with no
// override could silently wipe that stack's data. The default here must
// never collide with a persistent stack's own default or documented
// convention: `dev.mjs`/`dev-lib.mjs` default to "o11y-dev", and
// compose.yml's header comment's example uses "o11y-t01" — this script gets
// a name distinct from both.
//
// A distinct DEFAULT alone is not enough, though: if a developer has
// `COMPOSE_PROJECT_NAME=o11y-dev` exported in their shell (e.g. left over
// from working on the dev stack directly) when they run this script, the
// env var wins over the default the same way it always does, and the `down
// -v` below would still wipe the real dev stack. "Never reuse the dev
// stack's [project name]" therefore has to be a hard refusal, not just a
// differing default.
const DEV_STACK_DEFAULT_PROJECT = "o11y-dev";
const REQUESTED_PROJECT = process.env.COMPOSE_PROJECT_NAME || "o11y-stop-roundtrip";
if (REQUESTED_PROJECT === DEV_STACK_DEFAULT_PROJECT) {
  console.error(
    `error: COMPOSE_PROJECT_NAME="${DEV_STACK_DEFAULT_PROJECT}" is dev.mjs's own persistent dev-stack project name ` +
      `(scripts/dev-lib.mjs's default) — this script's own \`down -v\` would wipe its named volumes ` +
      `(minio-data/clickhouse-data). Refusing to run under this project name; set COMPOSE_PROJECT_NAME to ` +
      `something else (or unset it to use this script's own "o11y-stop-roundtrip" default).`,
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

// A-I1: MINIO_USER/MINIO_PASSWORD (root creds) are always scrubbed from a
// failure log, regardless of caller — `opts.redact` lets a specific call
// site (e.g. `setupRestrictedMinioUser`) add its own per-run secrets (a
// restricted user's generated password) to the same scrub pass, since `sh`
// has no way to know about those on its own. The task asked for output to
// be redacted, not suppressed: a failure here still prints (developers need
// the diagnostic — this is a local/CI test-only script), it just never
// prints a real credential. `scrubSecrets` lives in `./redact.mjs` so it is
// unit-testable in isolation (this file runs `main()` unconditionally at
// module scope, so it cannot itself be imported from a test).
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

// A-I1 / regression from removing `allowFail`: `compose(...)` used to take
// only positional docker-compose args, with no way for a caller to pass
// `{ allowFail: true }` (or `redact`) through to `sh()` — the pre-T1 code
// called `sh(...)` directly with `{ allowFail: true }` for exactly this
// exec-into-minio path. A trailing plain-object argument is now treated as
// options for `sh()` and popped off before building the compose args, so
// every existing call site (which only ever passes strings) is unaffected.
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

/** The supervisor's own stdout log lines for a container (B-I2, second
 *  wave) — used to confirm which branch of `run_stop_protocol` actually
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

  // dev-persist task: compose.yml's minio/clickhouse now use named volumes
  // (so a plain `dev.mjs`/`pnpm dev:full` restart keeps its logs/metrics),
  // which means a PRIOR run of this script that crashed before reaching its
  // own `down -v` at the bottom (O11Y_ROUNDTRIP_KEEP unset) would otherwise
  // leave this fixed `PROJECT` name's volumes around for THIS run's `up` to
  // silently reuse — this script's own header comment ("no volume on Loki's
  // data dir, so nothing survives") used to be true by construction; this
  // `down -v` up front is what keeps it true now that the volumes persist
  // by default. Harmless (a no-op) when nothing is left over.
  compose("down", "-v");

  console.log("\n== bring up minio + clickhouse ==");
  // T1: `minio-init` (a one-shot `mc mb` container) is gone along with
  // quay.io/minio/mc — Bitnami's `minio` image creates the `loki` bucket
  // itself via MINIO_DEFAULT_BUCKETS (compose.yml) before its healthcheck
  // goes green, so `--wait` (blocks until every started service is
  // healthy/running) replaces the old poll-for-minio-init-exit-code loop.
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

  // I1 (fix round 1): behavioural check that [live] max_connections=0
  // actually turns Live off for Grafana's own frontend — `liveEnabled` in
  // /api/frontend/settings is what the shipped Grafana UI reads before ever
  // opening a socket. This does NOT check the raw /api/live/ws endpoint
  // itself (that remains reachable — see grafana.ini's T01-D1 note); it
  // checks the one surface the product actually consults.
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

  // ---- run 1b: zero-ingest wake (T03B, F3) -------------------------------
  //
  // T03-D2's other finding: a wake that pushes NOTHING to Loki never
  // produces a new uploader-named index object, so shutdown.sh (correctly,
  // UNCHANGED by F3) writes no marker for it. The fix for "every such wake
  // was counted unclean" lives entirely on the Worker side
  // (workers/o11y/src/inbox/ledger.ts#resolveOverWakes: a wake with zero
  // provisional keys resolves clean without needing the marker at all) —
  // this container-level script has no Worker/ledger in the loop, so what
  // it can and must pin is the half of the contract the ledger fix
  // actually depends on: a zero-ingest wake never writes a marker (nothing
  // was uploaded — the ledger's "clean" here comes from having nothing
  // provisional to lose, never from a marker that doesn't exist).
  //
  // T03B-D1: measured here for the first time — a Loki that never received
  // ANY write this wake (no stream, no WAL segment at all) exits 1 on
  // SIGTERM, not 0 (every OTHER run in this script pushes at least one
  // line first, and exits 0). shutdown.sh already only checks the upload
  // when `loki_exit -eq 0` (so a truly-empty Loki takes the SAME
  // no-marker path as a failed upload, just via a different branch), and
  // box.ts's `onStop` records whatever exit code the platform reports
  // purely for bookkeeping — the ledger never reads it, only the marker
  // and the provisional-key count — so this does not change F3's
  // correctness. Recorded as evidence, not asserted to be 0.
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

  // Data-loss proof: recreate the box (a fresh container, nothing local
  // survives) and confirm the canary — pushed but never index-uploaded
  // because it was SIGKILLed mid-ingest — is genuinely gone. This is also
  // the negative control for the "restart" section's positive query above:
  // if a stale in-memory cache or a leftover local volume were serving that
  // query instead of R2, this line would still show up.
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
  // The bug this proves fixed: the pre-fix-round-1 check only asked "does an
  // uploader-named index object exist after Loki exits?" — but the shipper
  // also uploads on its own ~15-minute schedule while Loki is still running,
  // so on any wake at least that long, an object can already exist from an
  // EARLIER, successful mid-wake upload. That check would then pass even if
  // the LAST, shutdown-time upload silently failed. This test reproduces
  // exactly that shape: seed a fake uploader-named object under today's
  // table (standing in for an earlier successful periodic upload), then run
  // the box against a MinIO user whose policy denies PutObject on `index/*`
  // only (`state/*`, `browser/*`, `worker/*` stay writable — the production
  // credential is scoped to the Loki bucket as a whole, ADR-0041 exit
  // criterion 1, and this narrows it further to isolate just the index
  // write). SIGTERM: Loki's real shutdown-time upload attempt now fails, so
  // no NEW uploader-named object appears — the fixed check (which diffs
  // against a snapshot taken before SIGTERM) must refuse the marker.
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

  // Seed a fake "earlier successful upload" using the ADMIN credential
  // (curlS3 signs with MINIO_USER/MINIO_PASSWORD, not the box's restricted
  // pair) — the restricted user could not have written this itself, which
  // is exactly the point: it stands in for an upload that happened before
  // the restriction (or, in the real check's terms, before the pre-SIGTERM
  // snapshot) rather than one this test is trying to produce.
  const dayNow = Math.floor(Date.now() / 1000 / 86400);
  const seededKey = `index/index/${dayNow}/9999999999-${uploaderName}-seeded.tsdb.gz`;
  const seedRes = curlS3(["-o", "/dev/null", "-w", "%{http_code}", "-X", "PUT", "--data", "seed",
    `http://localhost:${MINIO_PORT}/loki/${seededKey}`]);
  record("C1: seeded a pre-existing uploader-named index object (admin credential)", seedRes.stdout.trim() === "200", `HTTP ${seedRes.stdout.trim()} key=${seededKey}`);

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
  // B-I2 (second wave): confirm WHICH branch refused the marker, rather than
  // trusting "no marker" alone (several different branches produce that
  // identically). Measured live against a real Loki 3.3.2 + MinIO (not
  // assumed, debugged with a temporary log dump before landing this
  // assertion): denying `s3:PutObject` on `index/*` does not merely make
  // the FINAL upload confirmation fail while Loki exits cleanly — the
  // restricted credential also rejects the ingester's own periodic CHUNK
  // flush ("failed to flush chunks: ... InvalidAccessKeyId"), which Loki
  // retries in a backoff loop on shutdown rather than giving up promptly.
  // That backoff can run past `STOP_GRACE_SECONDS` (30s default), so the
  // branch actually observed here is shutdown.sh's OWN grace-timeout log
  // line ("loki did not exit within ...s of SIGTERM; giving up on a clean
  // marker"), not a clean non-zero `wait` exit. `run_stop_protocol`'s
  // upload-check block is gated on `loki_exit -eq 0` either way, so it is
  // never reached from this scenario — accepts all three shapes a real run
  // could produce (grace-timeout, a clean non-zero exit, or — a future Loki
  // version that manages a clean 0 exit despite the flush failures — the
  // "not new" comparison) rather than asserting only the one this run
  // happened to take.
  const logsC1 = boxLogs(containerIdC1);
  const putBlockedEvidence = /loki did not exit within \d+s of SIGTERM/.test(logsC1)
    || /loki exited with code [1-9]\d*/.test(logsC1)
    || /is new since before SIGTERM/.test(logsC1);
  record(
    "C1: the log confirms the PUT-blocked scenario is what refused it (grace-timeout, a non-zero loki exit, or an explicit not-new comparison)",
    putBlockedEvidence,
    putBlockedEvidence ? "found" : "none of the expected log shapes found in supervisor log",
  );

  // ---- D1 negative control (B-I2, second wave): a failed pre-SIGTERM
  // LISTING (not a blocked PUT) also writes no marker -------------------
  //
  // C1 above proves the PUT-blocked path. This proves the OTHER path the
  // rereview asked for: `r2_list_prefix`'s own listing call itself fails
  // (ListBucket denied), which must make `snapshot_ok=0` and refuse the
  // marker BEFORE any upload confirmation is even attempted — the exact
  // shape `pipeline/o11y-shutdown-snapshot.test.mjs`'s "B-I2, second wave"
  // tests prove at the shell-function level with a stubbed curl; this is
  // the same shape against a REAL MinIO ListBucket denial and a real Loki.
  console.log("\n== D1 negative control (B-I2): a failed pre-SIGTERM listing writes no marker ==");
  const LIST_DENY_USER = `list-deny-${RUN_ID}`;
  const LIST_DENY_PASSWORD = `list-deny-pw-${RUN_ID}`;
  const LIST_DENY_POLICY = `deny-list-${RUN_ID}`;
  // ListBucket is evaluated against the BUCKET's own ARN, never `/*` (which
  // only ever matches object-level actions) — get this wrong and the deny
  // silently does nothing, and the "negative control" would pass for
  // having tested nothing.
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
  // Ready under a ListBucket-denied credential proves Loki's own boot path
  // does not itself need ListBucket — so a later "no marker" is
  // attributable to the shutdown-time listing this test targets, not to a
  // boot-time side effect of the same denied permission.
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

  // Revert evidence lives in the T01 report (fix round 1): the same
  // seed-then-SIGTERM sequence run against the pre-fix "does one exist"
  // check (no before/after snapshot) DOES write a marker here — that run is
  // done by hand against a temporarily reverted shutdown.sh, not by this
  // script, so a passing check above is never silently the only evidence.

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;

  // M13 (fix round 1): tear the stack down when done, so a run of this
  // script never leaves containers/networks for the operator to notice and
  // clean up by hand. Set O11Y_ROUNDTRIP_KEEP=1 to skip this while
  // debugging a failure.
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

// `denyStatement` (B-I2's D1 negative control, second wave, added alongside
// C1's original PutObject-deny): a single extra `Deny` statement layered
// on top of the same base `Allow s3:* on the whole bucket` every restricted
// user starts from. Defaults to C1's own PutObject-on-`index/*` deny so
// existing callers are unaffected.
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
  // T1: quay.io/minio/mc is gone (same outage as its sibling quay.io/minio/minio
  // image, both replaced in compose.yml) — the Bitnami `minio` image ships the real `mc`
  // binary INSIDE the container itself (PATH includes
  // /opt/bitnami/minio-client/bin, confirmed via `docker inspect`), so this
  // execs into the already-running `minio` service instead of `docker run`-
  // ing a second, separate mc image against the compose network. `-T`:
  // spawnSync has no TTY, so `exec` must not try to allocate one (`docker
  // exec` defaults to `-t` off, but `compose exec` defaults it ON and fails
  // without `-T` in a non-interactive shell — verified below).
  const script = [
    `mc alias set c1 http://localhost:9000 "${MINIO_USER}" "${MINIO_PASSWORD}" >/dev/null`,
    `cat > /tmp/policy.json <<'EOF'\n${policy}\nEOF`,
    `mc admin policy create c1 ${policyName} /tmp/policy.json`,
    `mc admin user add c1 ${user} "${password}"`,
    `mc admin policy attach c1 ${policyName} --user ${user}`,
  ].join(" && ");
  // A-I1: this call used to go through `sh(..., { allowFail: true })`
  // directly (pre-T1), silently swallowing any failure here with no log at
  // all. T1's replacement (`compose("exec", ...)`) dropped `allowFail`
  // through `compose()`'s then-options-less signature, so a transient
  // failure (stale RUN_ID collision, docker exec hiccup, MinIO not yet
  // warmed) printed the FULL `mc admin ...` command line unredacted —
  // embedding both the root MINIO_PASSWORD and this restricted user's
  // `password` in plain text. Fixed here by redacting rather than
  // suppressing: `sh()` (now, always) scrubs MINIO_USER/MINIO_PASSWORD from
  // any failure it does print; `redact: [password]` adds this call's own
  // per-run secret to that same pass, so a genuine failure still surfaces a
  // useful diagnostic (the developer needs to see it — this is a
  // local/CI-only test script) with no credential in it.
  const res = compose("exec", "-T", "minio", "/bin/sh", "-c", script, { redact: [password] });
  record(label, res.status === 0, res.stdout.trim().split("\n").pop());
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
