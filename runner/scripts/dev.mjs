#!/usr/bin/env node
// One-command local dev for the runner (`pnpm dev` / `dev:live` / `dev:full`
// in runner/package.json, all three calling this one script with a
// different `--tier`). See docs/run-and-deploy.md's "Run locally" section
// for the user-facing walkthrough. Design rationale: wrangler's
// `.dev.vars` always wins over a `--var` of the same name, which is why
// `dev-lib.mjs`'s bootstrap/patch design writes non-secret defaults into
// `.dev.vars` up front rather than relying on `--var` to reach them.
//
// `pnpm o11y:dev` is a separate, standalone entry point (scripts/o11y-dev.mjs)
// for someone who only wants the o11y worker — it shares this file's
// dev-lib.mjs helpers rather than duplicating them.

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
  buildPlan,
  listRunningContainers,
  reportLeftoverContainers,
  SHUTDOWN_SIGNALS,
  redactArgsForLog,
  PORT_DEFAULTS,
} from "./dev-lib.mjs";
// dev-persist task's own additions — a separate import statement (rather
// than folded into the block above) so a parallel edit to that block's own
// import list merges cleanly.
import {
  composeDownArgs,
  o11yDevDataModeLine,
  resetO11yLocalState,
  detectO11yStateDivergence,
  formatO11yDivergenceWarning,
} from "./dev-lib.mjs";

const COLORS = {
  app: "\x1b[36m", // cyan
  api: "\x1b[33m", // yellow
  o11y: "\x1b[35m", // magenta
  compose: "\x1b[34m", // blue
  slack: "\x1b[32m", // green
  build: "\x1b[90m", // grey
  dev: "\x1b[97m", // bright white
};
const RESET = "\x1b[0m";

function prefixed(name) {
  const color = COLORS[name] ?? "";
  return (line) => `${color}[${name}]${RESET} ${line}`;
}

function log(name, line) {
  console.log(prefixed(name)(line));
}

function pipeLines(stream, name, sink = console.log) {
  let buf = "";
  stream.on("data", (chunk) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) sink(prefixed(name)(line));
  });
  stream.on("end", () => {
    if (buf) sink(prefixed(name)(buf));
  });
}

async function waitForServer(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fetch(url);
      return;
    } catch (err) {
      if (Date.now() > deadline) {
        throw new Error(`${label} on ${url} never came up within ${timeoutMs}ms: ${err}`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
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
  const { help, tier, replay, resetLocalDb, fresh, errors } = parseArgs(process.argv.slice(2));
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

  let ports;
  try {
    ports = resolvePorts(tier, process.env);
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }

  if (resetLocalDb) {
    resetLocalD1(path.join(RUNNER_ROOT, "workers", "api"), undefined, (line) => log("dev", line));
  }

  let containersBefore = new Set();
  if (tier === "2" || tier === "full") {
    if (!isDockerAvailable((cmd, args) => execFileSync(cmd, args, { stdio: "ignore" }))) {
      console.error(`error: ${DOCKER_NOT_RUNNING_MESSAGE}`);
      process.exit(1);
    }
    // Baseline for the leftover-container REPORT on shutdown (this run
    // never stops a container it cannot prove it started — see
    // dev-lib.mjs's module-level doc comment on `possiblyLeftoverContainers`
    // for why, NB2 in re-review 2).
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

    // PREVIEW_HOST port adoption: `.dev.vars` always wins over `--var` for a
    // key it declares, so when API_DEV_PORT was NOT explicitly set for this
    // run, a pre-existing `.dev.vars` pinning a different port is the port
    // that will actually be reached — adopt it (for the worker's own
    // `--port` and the vite proxy target) instead of starting pointed at a
    // port `.dev.vars` will silently override anyway. An EXPLICIT
    // API_DEV_PORT that conflicts still only warns (see
    // resolveDevVarsPortAdoption's doc comment).
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
      // Nothing has been spawned yet at this point in main() (this runs
      // before the long-running processes below, and before docker compose
      // for --tier=full), so exiting here leaves nothing running to clean up.
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
    // Measured for this task: Ctrl-C does not make wrangler's own Tier-2
    // Sandbox-container orchestration tear itself down synchronously — a
    // session's containers can still be `Up` several seconds after this
    // wrapper has already exited.
    //
    // Re-review 2, NB2: this step used to `docker stop` whatever
    // `possiblyLeftoverContainers` found. That heuristic ("new since this
    // run's own snapshot" + name match) cannot prove ownership — another
    // worktree's `wrangler dev`/Tier-2 session started at any point during
    // THIS run's (possibly hours-long) lifetime produces the identical
    // signal, and several worktrees running `wrangler dev` on this machine
    // at once is the NORMAL case, not an edge case. So this step never
    // stops anything anymore — it only PRINTS a report and the exact
    // manual `docker ps`/`docker stop` commands, so a developer can decide
    // by hand after confirming (e.g. `docker inspect`) what a container
    // actually is.
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
    const envLine = readDevVarsLine(devVarsPath, "O11Y_ENV");
    if (envLine !== "local") {
      console.error(`error: ${devVarsPath} must set O11Y_ENV=local — refusing to start against a non-local config`);
      process.exit(1);
    }
    // Same PREVIEW_HOST-style port adoption, for the one other port
    // `.dev.vars` pins here: workers/o11y/.dev.vars's SLACK_WEBHOOK_URL. It's
    // only ever out of sync on a PRE-EXISTING file (a fresh bootstrap above
    // already bakes in the current O11Y_SLACK_CAPTURE_PORT), e.g. a
    // developer changed the port env var after their file was bootstrapped.
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
    // NB8 (re-review 2): only fires for an EXISTING .dev.vars (a fresh one
    // just got DEV_ADMIN patched in and O11Y_SESSION_SECRET stripped, above)
    // — a stale pre-K1 file otherwise fails closed silently.
    for (const warning of checkO11yDevVarsStaleness(devVarsPath)) log("o11y", `warning: ${warning}`);

    const composeFile = path.join(RUNNER_ROOT, "containers", "o11y", "compose.yml");
    const composeProjectName = process.env.COMPOSE_PROJECT_NAME || "o11y-dev";
    const composeEnv = {
      ...process.env,
      COMPOSE_PROJECT_NAME: composeProjectName,
      O11Y_MINIO_PORT: String(ports.O11Y_MINIO_PORT),
      O11Y_MINIO_CONSOLE_PORT: String(ports.O11Y_MINIO_CONSOLE_PORT),
      O11Y_CLICKHOUSE_PORT: String(ports.O11Y_CLICKHOUSE_PORT),
      O11Y_CLICKHOUSE_NATIVE_PORT: String(ports.O11Y_CLICKHOUSE_NATIVE_PORT),
      AE_SQL_TOKEN: "local-dev-token",
    };

    // execFileSync wrapper for `resetO11yLocalState`'s injectable — always
    // runs from RUNNER_ROOT with the compose stack's own env, stdio
    // inherited (live `docker compose down -v` output), and lets a caller's
    // own `{ env }` win for the compose call specifically.
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
    execFileSync("docker", ["compose", "-f", composeFile, "up", "-d", "minio", "minio-init", "clickhouse"], {
      cwd: RUNNER_ROOT,
      env: composeEnv,
      stdio: "inherit",
    });
    teardownSteps.push(() => {
      log("compose", "tearing down minio + clickhouse (data kept — named volumes; use --fresh next run to wipe)");
      try {
        // Never `-v` here: Ctrl-C is the KEEP path — see composeDownArgs's
        // own doc comment and o11yDevDataModeLine above. --fresh's own wipe
        // (resetO11yLocalState) already ran, if at all, before this run's
        // compose stack was even started.
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

  function killAll(signal) {
    for (const child of children) {
      if (child.exited) continue;
      try {
        // `detached: true` (below) put each child in its own process
        // group — signal the whole group so wrangler's own child
        // (workerd, a container CLI invocation) is reached too, not just
        // the direct `node_modules/.bin/wrangler` process.
        process.kill(-child.pid, signal);
      } catch {
        // already gone
      }
    }
  }

  // Re-review 2, NB5: `cleanup()` (kill children + run teardown steps) is
  // split from `shutdown()` (cleanup, then `process.exit(0)`) so a STARTUP
  // failure (the readiness-wait `await` below throwing) can also run
  // cleanup without lying about the exit code — `shutdown()` always exits
  // 0, which is correct for an intentional SIGINT/SIGTERM/SIGHUP but wrong
  // for "we're crashing". Before this split, `main()`'s readiness timeout
  // threw straight past every teardown step (`main().catch` at the bottom
  // never calls `shutdown`/`cleanup`), leaving live `wrangler dev`/`vite`
  // children and any compose stack running — the next `pnpm dev` would
  // then fail on `--strictPort`, or silently fight the orphaned session
  // for the same ports.
  let shuttingDown = false;
  async function cleanup(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    log("dev", `${reason} — shutting down`);
    killAll("SIGINT");
    const deadline = Date.now() + 8000;
    // NOTE: `child.killed` (ChildProcess's own flag) only reflects whether
    // `.kill()` was CALLED, not whether the process actually exited — and
    // we signal the process GROUP via the top-level `process.kill(-pid,
    // ...)` above, which never touches that flag at all. Track real exits
    // ourselves (`child.exited`, set from the `exit` listener below)
    // instead, so this loop returns as soon as everything is actually
    // gone rather than always waiting out the full grace period.
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
  // SIGHUP (re-review 2, NB5): every child is spawned `detached: true`
  // (its own process group/session), so closing the terminal a `dev.mjs`
  // run is attached to sends SIGHUP to `dev.mjs` itself but NOT to the
  // detached children — without a handler here, `dev.mjs` used to die on
  // the default SIGHUP action (no cleanup at all) and leave every child
  // running.
  for (const sig of SHUTDOWN_SIGNALS) {
    process.on(sig, () => shutdown(sig));
  }

  for (const proc of plan) {
    const cwd = path.join(RUNNER_ROOT, proc.cwd);
    const env = { ...process.env, ...proc.env };
    if (wranglerRegistryPath && (proc.name === "api" || proc.name === "o11y")) {
      env.WRANGLER_REGISTRY_PATH = wranglerRegistryPath;
    }
    // NB6 (re-review 2): the real args (below, `spawn`) still carry the
    // ephemeral O11Y_SESSION_SECRET value in full — this only keeps it out
    // of dev.mjs's own printed log line.
    log(proc.name, `spawning: ${proc.bin} ${redactArgsForLog(proc.args).join(" ")}`);
    const child = spawn(proc.bin, proc.args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    pipeLines(child.stdout, proc.name);
    pipeLines(child.stderr, proc.name);
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
  // Re-review 2, NB5: wrapped so a readiness TIMEOUT (`waitForServer`
  // throwing) also runs `cleanup()` before this rejection reaches
  // `main().catch` at the bottom — see `cleanup`/`shutdown`'s own doc
  // comment above for the bug this closes.
  try {
    if (tier === "full") {
      log("dev", `waiting for o11y on http://localhost:${ports.O11Y_DEV_PORT} ...`);
      await waitForServer(`http://localhost:${ports.O11Y_DEV_PORT}`, 120_000, "o11y worker");
      log("dev", "o11y is up");
    }
    if (tier === "2" || tier === "full") {
      log("dev", `waiting for api on http://localhost:${ports.API_DEV_PORT} ...`);
      await waitForServer(`http://localhost:${ports.API_DEV_PORT}`, 120_000, "api worker");
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
