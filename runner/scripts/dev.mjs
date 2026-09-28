#!/usr/bin/env node
// One-command local dev for the runner (`pnpm dev`/`dev:live`/`dev:full`).
// See docs/run-and-deploy.md's "Run locally" section for the walkthrough.
// wrangler's `.dev.vars` always wins over `--var`, which is why
// `dev-lib.mjs`'s bootstrap/patch writes non-secret defaults into
// `.dev.vars` up front. `pnpm o11y:dev` (scripts/o11y-dev.mjs) shares this
// file's dev-lib.mjs helpers for the o11y-only entry point.

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  RUNNER_ROOT,
  HELP_TEXT,
  parseArgs,
  resolvePorts,
  assertNoPortCollisions,
  bootstrapDevVars,
  o11yDevVarsPatch,
  O11Y_DEVVARS_STRIP_KEYS,
  fillEmptyDevVarsSecrets,
  O11Y_DEVVARS_AUTOFILL_SECRET_KEYS,
  resolveDevVarsPortAdoption,
  checkO11yDevVarsStaleness,
  readDevVarsLine,
  ephemeralSecret,
  migrationRecordPath,
  applyMigrations,
  formatMigrationError,
  resetLocalD1,
  DOCKER_NOT_RUNNING_MESSAGE,
  isDockerAvailable,
  isRuntimeDistStale,
  isPnpmInstallNeeded,
  PNPM_INSTALL_NEEDED_MESSAGE,
  wranglerBuildErrorLine,
  waitForServer,
  buildPlan,
  listRunningContainers,
  reportLeftoverContainers,
  SHUTDOWN_SIGNALS,
  redactArgsForLog,
  PORT_DEFAULTS,
} from "./dev-lib.mjs";
import { shouldCheckContainerImages, collectTierBaseImages, ensureContainerImagesPresent, formatImagePullFailure } from "./dev-lib.mjs";
import {
  composeDownArgs,
  o11yDevDataModeLine,
  resetO11yLocalState,
  detectO11yStateDivergence,
  formatO11yDivergenceWarning,
  bringUpO11yCompose,
  resolveComposeProjectName,
} from "./dev-lib.mjs";

const COLORS = {
  app: "\x1b[36m", // cyan
  api: "\x1b[33m", // yellow
  o11y: "\x1b[35m", // magenta
  compose: "\x1b[34m", // blue
  slack: "\x1b[32m", // green
  build: "\x1b[90m", // grey
  dev: "\x1b[97m", // bright white
  images: "\x1b[96m", // bright cyan
};
const RESET = "\x1b[0m";

function prefixed(name) {
  const color = COLORS[name] ?? "";
  return (line) => `${color}[${name}]${RESET} ${line}`;
}

function log(name, line) {
  console.log(prefixed(name)(line));
}

// `onLine`: lets the caller watch each raw line (before the `[name]`
// prefix) for a wrangler build-error marker, reported immediately instead
// of waiting out the full readiness timeout. Optional.
function pipeLines(stream, name, sink = console.log, onLine = () => {}) {
  let buf = "";
  stream.on("data", (chunk) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      sink(prefixed(name)(line));
      onLine(line);
    }
  });
  stream.on("end", () => {
    if (buf) {
      sink(prefixed(name)(buf));
      onLine(buf);
    }
  });
}

function runWrangler(cwd, args) {
  execFileSync(path.join(cwd, "node_modules", ".bin", "wrangler"), args, {
    cwd,
    stdio: "inherit",
  });
}

/** Same binary, but stdio is captured (not inherited) and returned as a
 *  string — used only for the migration schema probe's read-only
 *  `d1 execute ... --json` queries, whose JSON output on stdout must be
 *  parsed rather than printed. A real apply (`runWrangler`, above) keeps
 *  inheriting stdio so its output stays visible live. */
function runWranglerCapture(cwd, args) {
  return execFileSync(path.join(cwd, "node_modules", ".bin", "wrangler"), args, {
    cwd,
    encoding: "utf8",
  });
}

async function main() {
  const { help, tier, replay, resetLocalDb, fresh, skipImageCheck, errors } = parseArgs(process.argv.slice(2));
  if (help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }
  if (errors.length > 0) {
    console.error(errors.map((e) => `error: ${e}`).join("\n"));
    console.error("");
    console.error(HELP_TEXT);
    process.exit(1);
  }

  // A pull that adds a dependency with node_modules never reinstalled
  // would otherwise run to the full 120s readiness timeout before a
  // generic "worker never came up", burying the real wrangler error.
  if (isPnpmInstallNeeded()) {
    console.error(`error: ${PNPM_INSTALL_NEEDED_MESSAGE}`);
    process.exit(1);
  }

  let ports;
  try {
    ports = resolvePorts(tier, process.env);
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }

  // Checked BEFORE --reset-local-db: reversed, a run with Docker not
  // running would delete workers/api's local D1 state and then
  // immediately exit on the Docker error — a surprising side effect for a
  // run that otherwise did nothing.
  let containersBefore = new Set();
  if (tier === "2" || tier === "full") {
    if (!isDockerAvailable((cmd, args) => execFileSync(cmd, args, { stdio: "ignore" }))) {
      console.error(`error: ${DOCKER_NOT_RUNNING_MESSAGE}`);
      process.exit(1);
    }
  }

  if (resetLocalDb) {
    resetLocalD1(path.join(RUNNER_ROOT, "workers", "api"), undefined, (line) => log("dev", line));
  }

  if (tier === "2" || tier === "full") {
    // Pre-pull gate: every base image this tier's Dockerfiles need must be
    // present BEFORE any worker starts, or `wrangler dev`'s container build
    // fails silently and only surfaces later, opaquely, at session start.
    if (shouldCheckContainerImages(tier, skipImageCheck)) {
      const refs = collectTierBaseImages(tier, RUNNER_ROOT);
      if (refs.length > 0) {
        log("images", `checking ${refs.length} base image(s) needed for --tier=${tier}`);
        const dockerExec = (cmd, args) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
        const result = await ensureContainerImagesPresent({
          refs,
          execFileSyncImpl: dockerExec,
          log: (line) => log("images", line),
        });
        if (!result.ok) {
          console.error(formatImagePullFailure(result));
          process.exit(1);
        }
      }
    } else if (skipImageCheck) {
      log("images", "--skip-image-check: skipping the container base-image pre-pull check");
    }

    // Baseline for the leftover-container REPORT on shutdown (this run
    // never stops a container it cannot prove it started — see
    // dev-lib.mjs's module-level doc comment on `possiblyLeftoverContainers`
    // for why).
    containersBefore = new Set(listRunningContainers((cmd, args) => execFileSync(cmd, args)).map((c) => c.id));
  }

  // ---- runtime build (blocking, all tiers) --------------------------------
  const runtimeDir = path.join(RUNNER_ROOT, "packages", "runtime");
  if (isRuntimeDistStale(runtimeDir)) {
    log("build", "packages/runtime/dist is stale (or missing) — building @handsontable/demo-runtime first");
    execFileSync("pnpm", ["--filter", "@handsontable/demo-runtime", "build"], {
      cwd: RUNNER_ROOT,
      stdio: "inherit",
    });
  } else {
    log("build", "packages/runtime/dist is up to date — skipping rebuild");
  }

  // ---- workers/api setup (tier 2 + full) ----------------------------------
  const apiDir = path.join(RUNNER_ROOT, "workers", "api");
  if (tier === "2" || tier === "full") {
    const devVarsPath = path.join(apiDir, ".dev.vars");
    const examplePath = path.join(apiDir, ".dev.vars.example");
    const { created } = bootstrapDevVars({ examplePath, devVarsPath });
    if (created) log("api", `created ${path.relative(RUNNER_ROOT, devVarsPath)} from .dev.vars.example`);

    // PREVIEW_HOST port adoption: `.dev.vars` always wins over `--var`, so
    // adopt a pre-existing file's declared port instead of starting
    // pointed at a port `.dev.vars` will silently override anyway.
    const apiPortExplicit = process.env.API_DEV_PORT !== undefined && process.env.API_DEV_PORT !== "";
    const apiPortAdoption = resolveDevVarsPortAdoption({
      devVarsPath,
      key: "PREVIEW_HOST",
      currentPort: ports.API_DEV_PORT,
      explicit: apiPortExplicit,
    });
    if (apiPortAdoption.message) log("api", `${apiPortAdoption.adopted ? "info" : "warning"}: ${apiPortAdoption.message}`);
    if (apiPortAdoption.adopted) {
      ports.API_DEV_PORT = apiPortAdoption.port;
      try {
        assertNoPortCollisions(ports);
      } catch (err) {
        console.error(`error: ${err.message}`);
        process.exit(1);
      }
    }

    const recordPath = migrationRecordPath(apiDir);
    let migrations;
    try {
      migrations = await applyMigrations({
        migrationsDir: path.join(apiDir, "migrations"),
        recordPath,
        dbName: "handsontable-demos",
        run: (args) => runWrangler(apiDir, args),
        query: (args) => runWranglerCapture(apiDir, args),
        log: (line) => log("api", line),
      });
    } catch (err) {
      // Clean, single-line failure — never a raw execFileSync stack trace.
      // Nothing has been spawned yet, so exiting here leaves nothing to clean up.
      console.error(formatMigrationError(err));
      process.exit(1);
    }
    if (migrations.applied.length > 0) log("api", `applied ${migrations.applied.length} migration(s): ${migrations.applied.join(", ")}`);
    if (migrations.adopted.length > 0) {
      log(
        "api",
        `adopted ${migrations.adopted.length} pre-existing migration(s) without running them (local D1 already matched): ${migrations.adopted.join(", ")}`,
      );
    }
  }

  // ---- workers/o11y + compose setup (full only) ---------------------------
  const o11yDir = path.join(RUNNER_ROOT, "workers", "o11y");
  const teardownSteps = [];
  if (tier === "2" || tier === "full") {
    // Ctrl-C does not make wrangler's own Tier-2 Sandbox-container
    // orchestration tear itself down synchronously — a session's
    // containers can still be `Up` several seconds after this wrapper has
    // already exited. This step never `docker stop`s a container it cannot
    // prove it started (see dev-lib.mjs's `possiblyLeftoverContainers` doc
    // comment: several worktrees running `wrangler dev` at once is the
    // NORMAL case) — it only PRINTS a report and the exact manual
    // `docker ps`/`docker stop` commands, so a developer can decide by hand
    // after confirming (e.g. `docker inspect`) what a container actually is.
    teardownSteps.push(() => {
      reportLeftoverContainers(containersBefore, (cmd, args) => execFileSync(cmd, args), (msg) => log("dev", msg));
    });
  }
  if (tier === "full") {
    const devVarsPath = path.join(o11yDir, ".dev.vars");
    const examplePath = path.join(o11yDir, ".dev.vars.example");
    const { created, patched, stripped } = bootstrapDevVars({
      examplePath,
      devVarsPath,
      patch: o11yDevVarsPatch(ports),
      stripKeys: O11Y_DEVVARS_STRIP_KEYS,
    });
    if (created) {
      log("o11y", `created ${path.relative(RUNNER_ROOT, devVarsPath)} from .dev.vars.example`);
      if (patched.length) log("o11y", `filled in local-dev defaults for: ${patched.join(", ")}`);
      if (stripped.length) log("o11y", `left ${stripped.join(", ")} undeclared so this run's own ephemeral --var takes effect`);
    }
    // Runs on EVERY invocation, not only a fresh bootstrap — a
    // pre-existing `.dev.vars` needs these two filled too. Only the key
    // NAME is logged, never the generated value.
    const { filled } = fillEmptyDevVarsSecrets({ devVarsPath, keys: O11Y_DEVVARS_AUTOFILL_SECRET_KEYS });
    if (filled.length) {
      log("o11y", `filled in ephemeral local-dev values for: ${filled.join(", ")} (values never logged)`);
    }
    const envLine = readDevVarsLine(devVarsPath, "O11Y_ENV");
    if (envLine !== "local") {
      console.error(`error: ${devVarsPath} must set O11Y_ENV=local — refusing to start against a non-local config`);
      process.exit(1);
    }
    // Same PREVIEW_HOST-style port adoption, for SLACK_WEBHOOK_URL — only
    // out of sync on a pre-existing file with a since-changed port env var.
    const slackPortExplicit = process.env.O11Y_SLACK_CAPTURE_PORT !== undefined && process.env.O11Y_SLACK_CAPTURE_PORT !== "";
    const slackAdoption = resolveDevVarsPortAdoption({
      devVarsPath,
      key: "SLACK_WEBHOOK_URL",
      currentPort: ports.O11Y_SLACK_CAPTURE_PORT,
      explicit: slackPortExplicit,
    });
    if (slackAdoption.message) log("o11y", `${slackAdoption.adopted ? "info" : "warning"}: ${slackAdoption.message}`);
    if (slackAdoption.adopted) {
      ports.O11Y_SLACK_CAPTURE_PORT = slackAdoption.port;
      try {
        assertNoPortCollisions(ports);
      } catch (err) {
        console.error(`error: ${err.message}`);
        process.exit(1);
      }
    }
    // Only fires for an EXISTING .dev.vars (a fresh one just got DEV_ADMIN
    // patched in and O11Y_SESSION_SECRET stripped, above) — a stale file
    // otherwise fails closed silently.
    for (const warning of checkO11yDevVarsStaleness(devVarsPath)) log("o11y", `warning: ${warning}`);

    const composeFile = path.join(RUNNER_ROOT, "containers", "o11y", "compose.yml");
    // Per-worktree default (an explicit COMPOSE_PROJECT_NAME still wins) —
    // see resolveComposeProjectName's own doc comment in
    // dev-lib.mjs for why a single fixed default collided across worktrees.
    const composeProjectName = resolveComposeProjectName(process.env);
    const composeEnv = {
      ...process.env,
      COMPOSE_PROJECT_NAME: composeProjectName,
      O11Y_MINIO_PORT: String(ports.O11Y_MINIO_PORT),
      O11Y_MINIO_CONSOLE_PORT: String(ports.O11Y_MINIO_CONSOLE_PORT),
      O11Y_CLICKHOUSE_PORT: String(ports.O11Y_CLICKHOUSE_PORT),
      O11Y_CLICKHOUSE_NATIVE_PORT: String(ports.O11Y_CLICKHOUSE_NATIVE_PORT),
      AE_SQL_TOKEN: "local-dev-token",
    };

    // execFileSync wrapper for `resetO11yLocalState`'s injectable — runs
    // from RUNNER_ROOT with the compose stack's own env, stdio inherited.
    const runDocker = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: RUNNER_ROOT, stdio: "inherit", ...opts });

    if (fresh) {
      resetO11yLocalState({
        o11yDir,
        composeFile,
        composeEnv,
        execFileSyncImpl: runDocker,
        log: (line) => log("dev", line),
      });
    } else {
      // Cheap (local file read) unless there's actually something to warn
      // about — see detectO11yStateDivergence's own doc comment for why
      // MinIO (not ClickHouse) is the volume this checks.
      const divergence = await detectO11yStateDivergence({
        composeProjectName,
        o11yDir,
        execFileSyncImpl: (cmd, args) => execFileSync(cmd, args),
      });
      if (divergence.divergent) log("dev", formatO11yDivergenceWarning(divergence.committedCount));
    }
    log("dev", o11yDevDataModeLine(fresh));

    log("compose", `starting minio + clickhouse (project ${composeProjectName})`);
    // `minio-init` is not used — quay.io/minio/mc is not pullable.
    // compose.yml's `minio` creates its bucket via MINIO_DEFAULT_BUCKETS
    // before its healthcheck goes green, so `--wait` is sufficient.
    //
    // If `up` itself throws, tears the SAME project back down (no `-v`,
    // data kept) before rethrowing — see `bringUpO11yCompose`'s own doc
    // comment in dev-lib.mjs for why this had to be pulled out of `main()`.
    bringUpO11yCompose({
      composeFile,
      composeEnv,
      execFileSyncImpl: (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: RUNNER_ROOT, stdio: "inherit", ...opts }),
      log: (line) => log("compose", line),
    });
    teardownSteps.push(() => {
      log("compose", "tearing down minio + clickhouse (data kept — named volumes; use --fresh next run to wipe)");
      try {
        // Never `-v` here: Ctrl-C is the KEEP path. --fresh's own wipe
        // already ran, if at all, before this compose stack even started.
        execFileSync("docker", composeDownArgs(composeFile), {
          cwd: RUNNER_ROOT,
          env: composeEnv,
          stdio: "inherit",
        });
      } catch (err) {
        log("compose", `teardown failed: ${err.message}`);
      }
    });
  }

  // ---- spawn the long-running processes -----------------------------------
  const sessionSecret = tier === "full" ? ephemeralSecret() : undefined;
  const plan = buildPlan(tier, ports, { sessionSecret });
  const wranglerRegistryPath = process.env.WRANGLER_REGISTRY_PATH;
  const children = [];
  // The first wrangler build-error line seen from each `wrangler dev`
  // child, fed to that worker's readiness wait so a build failure is
  // reported immediately instead of after the full timeout.
  const buildErrorLines = new Map();

  function killAll(signal) {
    for (const child of children) {
      if (child.exited) continue;
      try {
        // `detached: true` puts each child in its own process group —
        // signal the whole group so wrangler's own child processes are reached too.
        process.kill(-child.pid, signal);
      } catch {
        // already gone
      }
    }
  }

  // `cleanup()` (kill children + teardown) is split from `shutdown()`
  // (cleanup, then exit 0) so a STARTUP failure can also run cleanup
  // without lying about the exit code. Without this split, a readiness
  // timeout would throw straight past every teardown step, leaving live
  // children and any compose stack running.
  let shuttingDown = false;
  async function cleanup(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    log("dev", `${reason} — shutting down`);
    killAll("SIGINT");
    const deadline = Date.now() + 8000;
    // `child.killed` only reflects whether `.kill()` was called, not
    // whether the process exited, and we signal the process GROUP, which
    // never touches that flag. Track real exits via `child.exited` instead.
    while (children.some((c) => !c.exited) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (children.some((c) => !c.exited)) {
      log("dev", "escalating to SIGKILL for any process still up after 8s");
      killAll("SIGKILL");
    }
    for (const step of teardownSteps) {
      try {
        await step();
      } catch (err) {
        log("dev", `teardown step failed: ${err.message}`);
      }
    }
  }
  async function shutdown(signal) {
    if (shuttingDown) return;
    await cleanup(`${signal} received`);
    process.exit(0);
  }
  // SIGHUP: every child is `detached: true`, so closing the terminal
  // sends SIGHUP to dev.mjs but not the children — handle it or they'd leak.
  for (const sig of SHUTDOWN_SIGNALS) {
    process.on(sig, () => shutdown(sig));
  }

  for (const proc of plan) {
    const cwd = path.join(RUNNER_ROOT, proc.cwd);
    const env = { ...process.env, ...proc.env };
    if (wranglerRegistryPath && (proc.name === "api" || proc.name === "o11y")) {
      env.WRANGLER_REGISTRY_PATH = wranglerRegistryPath;
    }
    // The real args (below, `spawn`) still carry the ephemeral
    // O11Y_SESSION_SECRET value in full — this only keeps it out of
    // dev.mjs's own printed log line.
    log(proc.name, `spawning: ${proc.bin} ${redactArgsForLog(proc.args).join(" ")}`);
    const child = spawn(proc.bin, proc.args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    // Only the two `wrangler dev` children ever get a `waitForServer` call
    // below — no need to scan vite's or the Slack capture server's own
    // output for a marker nothing ever reads.
    const onLine =
      proc.name === "api" || proc.name === "o11y"
        ? (line) => {
            if (buildErrorLines.has(proc.name)) return; // first one wins
            const errLine = wranglerBuildErrorLine(line);
            if (errLine) buildErrorLines.set(proc.name, errLine);
          }
        : undefined;
    pipeLines(child.stdout, proc.name, console.log, onLine);
    pipeLines(child.stderr, proc.name, console.log, onLine);
    child.exited = false;
    child.on("exit", (code, signal) => {
      child.exited = true;
      if (!shuttingDown) {
        log(proc.name, `exited unexpectedly (code=${code} signal=${signal}) — tearing everything else down`);
        shutdown("SIGTERM");
      }
    });
    children.push(child);
  }

  // ---- readiness ------------------------------------------------------
  // Wrapped so a readiness TIMEOUT also runs `cleanup()` before reaching
  // `main().catch` — see `cleanup`/`shutdown`'s own doc comment above.
  try {
    if (tier === "full") {
      log("dev", `waiting for o11y on http://localhost:${ports.O11Y_DEV_PORT} ...`);
      await waitForServer(`http://localhost:${ports.O11Y_DEV_PORT}`, 120_000, "o11y worker", {
        getEarlyFailure: () => buildErrorLines.get("o11y"),
      });
      log("dev", "o11y is up");
    }
    if (tier === "2" || tier === "full") {
      log("dev", `waiting for api on http://localhost:${ports.API_DEV_PORT} ...`);
      await waitForServer(`http://localhost:${ports.API_DEV_PORT}`, 120_000, "api worker", {
        getEarlyFailure: () => buildErrorLines.get("api"),
      });
      log("dev", "api is up");
    }
  } catch (err) {
    await cleanup(`startup failed: ${err.message}`);
    throw err;
  }

  if (tier === "full") {
    const replayCmd = `node scripts/o11y-replay-fixtures.mjs --base http://localhost:${ports.O11Y_DEV_PORT}`;
    if (replay) {
      log("dev", `--replay: running fixture replay now (${replayCmd})`);
      try {
        execFileSync("node", ["scripts/o11y-replay-fixtures.mjs", "--base", `http://localhost:${ports.O11Y_DEV_PORT}`], {
          cwd: RUNNER_ROOT,
          stdio: "inherit",
        });
      } catch (err) {
        log("dev", `fixture replay exited non-zero: ${err.message}`);
      }
    } else {
      log("dev", `once you want fixture data, run: ${replayCmd}`);
    }
    log(
      "dev",
      `Grafana (local DEV_ADMIN bypass): http://localhost:${ports.O11Y_DEV_PORT}/grafana/ — Slack alerts land at ` +
        `http://localhost:${ports.O11Y_SLACK_CAPTURE_PORT}/_captured`,
    );
    log("dev", `to trigger the */10 alert cron by hand: curl "http://localhost:${ports.O11Y_DEV_PORT}/cdn-cgi/local/scheduled"`);
  }

  log("dev", `authoring app: http://localhost:${ports.AUTHORING_DEV_PORT}`);
  log("dev", "ready. Press Ctrl-C to stop everything.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
