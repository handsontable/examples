// Shared logic for `runner/scripts/dev.mjs` (`pnpm dev`/`dev:live`/`dev:full`)
// and `runner/scripts/o11y-dev.mjs` (`pnpm o11y:dev`, the standalone o11y-only
// entry point — see that file for why it still exists as its own command).
//
// Every function here is pure or takes its side effects (fs, exec, spawn) as
// injectable parameters, so `pipeline/dev-script.test.mjs` can exercise the
// real logic with stub binaries instead of spawning `wrangler`/`docker`/`vite`
// for real. See `runner/docs/run-and-deploy.md`'s "Run locally" section for
// the user-facing walkthrough this module implements, and
// `.superpowers/sdd/README/final/dev-stack-research.md` for the design this
// was built from.
//
// Env vars this module reads (kept in sync with docs/run-and-deploy.md by
// `pipeline/dev-script.test.mjs`'s drift test — grep this file for `env.` if
// you add one, and add it to the doc in the same commit):
//   AUTHORING_DEV_PORT, API_DEV_PORT, API_DEV_INSPECTOR_PORT,
//   O11Y_DEV_PORT, O11Y_DEV_INSPECTOR_PORT, O11Y_MINIO_PORT,
//   O11Y_MINIO_CONSOLE_PORT, O11Y_CLICKHOUSE_PORT, O11Y_CLICKHOUSE_NATIVE_PORT,
//   O11Y_SLACK_CAPTURE_PORT, COMPOSE_PROJECT_NAME, WRANGLER_REGISTRY_PATH

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export const RUNNER_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

// ---------------------------------------------------------------------------
// Help / arg parsing
// ---------------------------------------------------------------------------

export const HELP_TEXT = `Usage: node scripts/dev.mjs --tier=1|2|full [options]

Tiers:
  --tier=1     Authoring app only (builds @handsontable/demo-runtime if its
               dist is stale, then runs vite for apps/authoring).
  --tier=2     Tier 1 + the API worker (wrangler dev, Docker containers,
               local D1 migrations).
  --tier=full  Tier 2 + the o11y worker, docker compose (minio/clickhouse —
               the box itself runs through wrangler dev's own container
               orchestration), telemetry wiring, and the local Slack capture
               server.

Options:
  --replay     (--tier=full only) run the OTLP/Faro fixture replay once,
               after the o11y worker reports ready. Without this flag,
               dev.mjs just prints the replay command.
  -h, --help   Print this help and exit 0.

Port overrides (env vars — defaults match the ones documented in
docs/run-and-deploy.md's "Run locally" section):
  AUTHORING_DEV_PORT          default 5173
  API_DEV_PORT                default 8787
  API_DEV_INSPECTOR_PORT      default 9230
  O11Y_DEV_PORT                default 4200
  O11Y_DEV_INSPECTOR_PORT      default 4201
  O11Y_MINIO_PORT              default 9000
  O11Y_MINIO_CONSOLE_PORT      default 9001
  O11Y_CLICKHOUSE_PORT         default 8123
  O11Y_CLICKHOUSE_NATIVE_PORT  default 9009
  O11Y_SLACK_CAPTURE_PORT      default 4210

Other env vars read:
  COMPOSE_PROJECT_NAME   docker compose project name for --tier=full's
                          minio/clickhouse stack (default "o11y-dev").
  WRANGLER_REGISTRY_PATH forwarded as-is to every spawned wrangler dev (see
                          docs/run-and-deploy.md) — set it to isolate this
                          run's service-binding registry from another
                          worktree's.
`;

/**
 * @param {string[]} argv (e.g. process.argv.slice(2))
 * @returns {{ help: boolean, tier: "1"|"2"|"full"|null, replay: boolean, errors: string[] }}
 */
export function parseArgs(argv) {
  const errors = [];
  let tier = null;
  let replay = false;
  let help = false;
  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      help = true;
    } else if (arg === "--replay") {
      replay = true;
    } else if (arg.startsWith("--tier=")) {
      const value = arg.slice("--tier=".length);
      if (value !== "1" && value !== "2" && value !== "full") {
        errors.push(`--tier must be one of 1, 2, full (got "${value}")`);
      } else {
        tier = value;
      }
    } else {
      errors.push(`unrecognized argument: ${arg}`);
    }
  }
  if (!help && tier === null) {
    errors.push("--tier=1|2|full is required");
  }
  if (replay && tier !== "full" && tier !== null) {
    errors.push("--replay is only valid with --tier=full");
  }
  return { help, tier, replay, errors };
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export const PORT_DEFAULTS = {
  AUTHORING_DEV_PORT: 5173,
  API_DEV_PORT: 8787,
  API_DEV_INSPECTOR_PORT: 9230,
  O11Y_DEV_PORT: 4200,
  O11Y_DEV_INSPECTOR_PORT: 4201,
  O11Y_MINIO_PORT: 9000,
  O11Y_MINIO_CONSOLE_PORT: 9001,
  O11Y_CLICKHOUSE_PORT: 8123,
  O11Y_CLICKHOUSE_NATIVE_PORT: 9009,
  O11Y_SLACK_CAPTURE_PORT: 4210,
};

const PORT_KEYS_BY_TIER = {
  "1": ["AUTHORING_DEV_PORT"],
  "2": ["AUTHORING_DEV_PORT", "API_DEV_PORT", "API_DEV_INSPECTOR_PORT"],
  full: [
    "AUTHORING_DEV_PORT",
    "API_DEV_PORT",
    "API_DEV_INSPECTOR_PORT",
    "O11Y_DEV_PORT",
    "O11Y_DEV_INSPECTOR_PORT",
    "O11Y_MINIO_PORT",
    "O11Y_MINIO_CONSOLE_PORT",
    "O11Y_CLICKHOUSE_PORT",
    "O11Y_CLICKHOUSE_NATIVE_PORT",
    "O11Y_SLACK_CAPTURE_PORT",
  ],
  // Not a CLI `--tier` value — used only by `scripts/o11y-dev.mjs` (the
  // standalone `pnpm o11y:dev` entry point), which needs just these two
  // ports resolved the same way `--tier=full` resolves them.
  "o11y-only": ["O11Y_DEV_PORT", "O11Y_DEV_INSPECTOR_PORT"],
};

/**
 * Resolves every port this tier needs from env overrides (falling back to
 * PORT_DEFAULTS), and throws if any two resolve to the same number — this is
 * what guarantees api/o11y (and their inspector ports) never collide.
 * @param {"1"|"2"|"full"} tier
 * @param {NodeJS.ProcessEnv} env
 */
export function resolvePorts(tier, env = process.env) {
  const keys = PORT_KEYS_BY_TIER[tier];
  if (!keys) throw new Error(`resolvePorts: unknown tier "${tier}"`);
  const resolved = {};
  for (const key of keys) {
    const raw = env[key];
    const value = raw !== undefined && raw !== "" ? Number(raw) : PORT_DEFAULTS[key];
    if (!Number.isInteger(value) || value <= 0 || value > 65535) {
      throw new Error(`invalid port for ${key}: "${raw}"`);
    }
    resolved[key] = value;
  }
  const byPort = new Map();
  for (const [key, value] of Object.entries(resolved)) {
    if (byPort.has(value)) {
      throw new Error(`port collision: ${key} and ${byPort.get(value)} both resolve to ${value}`);
    }
    byPort.set(value, key);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// .dev.vars bootstrap
// ---------------------------------------------------------------------------

const defaultFs = { existsSync, readFileSync, writeFileSync, mkdirSync };

/**
 * Copies `examplePath` to `devVarsPath` ONLY when `devVarsPath` does not
 * already exist — an existing `.dev.vars` (a developer's own edits, real
 * secret values they pasted in) is never touched or overwritten.
 *
 * On a fresh copy only:
 *  - `patch` fills in KNOWN-inert local placeholder lines (present in the
 *    example as an empty `KEY=`) with a real, non-secret local-dev value —
 *    e.g. DEV_ADMIN, or AE_SQL_TOKEN/LOKI_S3_* matching the exact defaults
 *    `containers/o11y/compose.yml` already documents as its own local
 *    fallbacks. A key is only patched if the example declared it EMPTY;
 *    never overwrites a non-empty line.
 *  - `stripKeys` removes an empty `KEY=` line entirely from the freshly
 *    copied file, for a key the caller intends to inject per-run via
 *    `--var` (an ephemeral secret — see `dev.mjs`'s O11Y_SESSION_SECRET
 *    handling). This is required because wrangler's `.dev.vars` always
 *    wins over a same-named `--var`, even when the `.dev.vars` value is
 *    empty (confirmed against wrangler 4.108's `getVarsForDev`, which
 *    unconditionally overwrites `result[key]` for every entry actually
 *    present in `.dev.vars`) — so a declared-but-empty key would silently
 *    swallow the `--var` override. Stripping the line makes the key
 *    undeclared, restoring `--var` as the only source. This function never
 *    writes an actual secret value to disk for a stripped key.
 *
 * @returns {{ created: boolean, patched: string[], stripped: string[] }}
 */
export function bootstrapDevVars({ examplePath, devVarsPath, patch = {}, stripKeys = [], fs = defaultFs }) {
  if (fs.existsSync(devVarsPath)) {
    return { created: false, patched: [], stripped: [] };
  }
  if (!fs.existsSync(examplePath)) {
    throw new Error(`missing ${examplePath} — cannot bootstrap ${devVarsPath}`);
  }
  let text = fs.readFileSync(examplePath, "utf8");
  const patched = [];
  for (const [key, value] of Object.entries(patch)) {
    const re = new RegExp(`^${key}=(?:"")?[ \\t]*$`, "m");
    if (re.test(text)) {
      text = text.replace(re, `${key}=${value}`);
      patched.push(key);
    }
  }
  const stripped = [];
  for (const key of stripKeys) {
    const re = new RegExp(`^${key}=(?:"")?[ \\t]*\\n?`, "m");
    if (re.test(text)) {
      text = text.replace(re, "");
      stripped.push(key);
    }
  }
  const dir = path.dirname(devVarsPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(devVarsPath, text);
  return { created: true, patched, stripped };
}

/**
 * `workers/o11y/.dev.vars.example`'s inert local placeholders, patched to a
 * real non-secret local-dev value ONLY on first bootstrap (see
 * `bootstrapDevVars`'s doc comment). `SLACK_WEBHOOK_URL` is baked at
 * PORT_DEFAULTS.O11Y_SLACK_CAPTURE_PORT (not injected via `--var`, which
 * would be silently overridden by this same declared-but-empty line — see
 * `bootstrapDevVars`'s stripKeys doc comment for the precedence rule this
 * works around); `checkDevVarsPortDrift` warns if a run overrides that port.
 * `O11Y_EXPORT_SECRET`/`SENTRY_HOOK_SECRET` are deliberately NOT here — the
 * task's own design point: never auto-create anything that carries a real
 * secret. Those stay empty; the routes they gate (`/telemetry/v1/logs`,
 * the Sentry webhook) fail closed until a developer pastes a real value in.
 */
export function o11yDevVarsPatch(ports) {
  return {
    DEV_ADMIN: "dev@handsontable.com",
    AE_SQL_TOKEN: "local-dev-token",
    LOKI_S3_ACCESS_KEY_ID: "minioadmin",
    LOKI_S3_SECRET_ACCESS_KEY: "minioadmin",
    SLACK_WEBHOOK_URL: `http://localhost:${ports.O11Y_SLACK_CAPTURE_PORT}/slack`,
  };
}

/** A key this run injects via `--var` that `bootstrapDevVars` must strip
 *  (if freshly created) from `workers/o11y/.dev.vars` — see that function's
 *  doc comment. Applies even when the key does not exist yet on this branch
 *  (K1's O11Y_SESSION_SECRET addition, still unmerged as of this task) —
 *  stripping a line that isn't there is a no-op. */
export const O11Y_DEVVARS_STRIP_KEYS = ["O11Y_SESSION_SECRET"];

/**
 * Warns (does not throw — this is advisory, not fatal) when a `.dev.vars`
 * value baked in at bootstrap time (a `localhost:<port>`-shaped default)
 * disagrees with the port this run actually resolved — the situation where
 * a developer set a port-override env var AFTER their `.dev.vars` was
 * already bootstrapped with the old default, and `.dev.vars` silently wins
 * over any `--var` this run would otherwise pass for the same key.
 * @returns {string|null} a warning line, or null if there's no drift to report
 */
export function checkDevVarsPortDrift(devVarsPath, key, expectedPort, fs = defaultFs) {
  const value = readDevVarsLine(devVarsPath, key, fs);
  if (value === undefined) return null;
  const m = /:(\d+)(?:\/|$)/.exec(value);
  if (!m) return null;
  const declaredPort = Number(m[1]);
  if (declaredPort === expectedPort) return null;
  return (
    `${devVarsPath} declares ${key}=${value} (port ${declaredPort}), but this run resolved port ` +
    `${expectedPort} — .dev.vars always wins over this script's own port choice for a key it declares. ` +
    `Edit ${devVarsPath} by hand, or delete it and re-run to get a fresh bootstrap at the new port.`
  );
}

/** Reads one `KEY=value` line out of a `.dev.vars`-shaped file (quotes
 *  stripped), or `undefined` if absent/the file doesn't exist. Used for the
 *  O11Y_ENV=local sanity check (o11y) and the PREVIEW_HOST port-drift
 *  warning (api) — never for reading an actual secret value into a log. */
export function readDevVarsLine(devVarsPath, key, fs = defaultFs) {
  if (!fs.existsSync(devVarsPath)) return undefined;
  const text = fs.readFileSync(devVarsPath, "utf8");
  const m = new RegExp(`^${key}=(.*)$`, "m").exec(text);
  if (!m) return undefined;
  return m[1].trim().replace(/^"(.*)"$/, "$1");
}

/** Ephemeral, never-persisted hex secret for O11Y_SESSION_SECRET (or any
 *  other run-scoped local secret) — a fresh value every process start,
 *  injected only via `--var`/env, never written to a file. */
export function ephemeralSecret(bytes = 32) {
  return randomBytes(bytes).toString("hex");
}

// ---------------------------------------------------------------------------
// Migrations (workers/api)
// ---------------------------------------------------------------------------

/** Kept under the worker's own `.wrangler/` state dir (gitignored) so
 *  wiping local D1 state (`rm -rf workers/api/.wrangler/state`) also wipes
 *  the applied-migrations record — the two can never drift apart into
 *  "recorded applied, but the local DB is actually empty". */
export function migrationRecordPath(workerDir) {
  return path.join(workerDir, ".wrangler", "state", "dev-migrations-applied.json");
}

export function readAppliedMigrations(recordPath, fs = defaultFs) {
  if (!fs.existsSync(recordPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAppliedMigrations(recordPath, files, fs) {
  const dir = path.dirname(recordPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(recordPath, JSON.stringify([...files].sort(), null, 2) + "\n");
}

const defaultFsWithReaddir = { ...defaultFs, readdirSync, statSync };

/** Every `NNNN_*.sql` file on disk, sorted, split into already-applied
 *  (per the record) and pending. Pure — takes no action. */
export function planMigrations({ migrationsDir, recordPath, fs = defaultFsWithReaddir }) {
  const applied = new Set(readAppliedMigrations(recordPath, fs));
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  const pending = files.filter((f) => !applied.has(f));
  return { files, applied: [...applied], pending };
}

/**
 * Applies every pending migration, one `wrangler d1 execute --local --file=`
 * call per file (never `migrations apply --local` — see
 * docs/run-and-deploy.md for why 0003_cost_ledger.sql's bare `ALTER TABLE`
 * makes that unsafe against local bookkeeping that starts empty). Records
 * each file as applied immediately after its own call succeeds, not in one
 * batch at the end, so a failure partway through never re-applies a file
 * that already landed.
 *
 * @param {object} opts
 * @param {string} opts.migrationsDir
 * @param {string} opts.recordPath
 * @param {string} opts.dbName
 * @param {string} opts.cwd
 * @param {(args: string[]) => Promise<void>|void} opts.run injectable —
 *   real callers pass a `node_modules/.bin/wrangler d1 execute ...` runner;
 *   tests pass a stub that just records calls.
 * @param {(line: string) => void} [opts.log]
 */
export async function applyMigrations({ migrationsDir, recordPath, dbName, run, fs = defaultFsWithReaddir, log = () => {} }) {
  const { pending } = planMigrations({ migrationsDir, recordPath, fs });
  if (pending.length === 0) {
    log("migrations: nothing to apply (all recorded as already applied)");
    return { applied: [] };
  }
  const appliedThisRun = [];
  for (const file of pending) {
    log(`applying migration ${file}`);
    await run(["d1", "execute", dbName, "--local", `--file=migrations/${file}`, "-y"]);
    appliedThisRun.push(file);
    const already = readAppliedMigrations(recordPath, fs);
    writeAppliedMigrations(recordPath, [...already, file], fs);
  }
  return { applied: appliedThisRun };
}

// ---------------------------------------------------------------------------
// Docker
// ---------------------------------------------------------------------------

export const DOCKER_NOT_RUNNING_MESSAGE =
  "Docker does not appear to be running (`docker info` failed). This tier needs Docker " +
  "for the Tier-2 session containers" +
  " (and, for --tier=full, the o11y box's own container orchestration under wrangler dev). " +
  "Start Docker Desktop (or your Docker daemon) and try again.";

/** @param {(cmd: string, args: string[]) => void} execFileSyncImpl throws on
 *  a non-zero exit, like node:child_process's execFileSync with no
 *  `stdio: "ignore"` swallow — callers pass that in for real use, and a stub
 *  that throws/doesn't in tests. */
export function isDockerAvailable(execFileSyncImpl) {
  try {
    execFileSyncImpl("docker", ["info"]);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Runtime staleness (packages/runtime dist vs src)
// ---------------------------------------------------------------------------

/** True when `dist/` is missing, or any file under `src/` is newer than the
 *  newest file under `dist/` — the same "rebuild if stale" rule `pnpm dev`
 *  documents. Injectable fs for tests (a real run uses node:fs). */
export function isRuntimeDistStale(runtimeDir, fs = defaultFsWithReaddir) {
  const distDir = path.join(runtimeDir, "dist");
  if (!fs.existsSync(distDir)) return true;
  const srcDir = path.join(runtimeDir, "src");
  const newestUnder = (dir) => {
    let newest = 0;
    const walk = (d) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else {
          const mtime = fs.statSync(full).mtimeMs;
          if (mtime > newest) newest = mtime;
        }
      }
    };
    walk(dir);
    return newest;
  };
  return newestUnder(srcDir) > newestUnder(distDir);
}

// ---------------------------------------------------------------------------
// Spawn plan
// ---------------------------------------------------------------------------

/**
 * The set of long-running, log-prefixed, SIGINT-forwarded child processes
 * for a tier — NOT one-shot setup steps (Docker check, migrations, docker
 * compose up/down, the runtime build), which run before/after this plan.
 *
 * @param {"1"|"2"|"full"} tier
 * @param {ReturnType<typeof resolvePorts>} ports
 * @param {{ replay?: boolean, sessionSecret?: string }} [opts]
 * @returns {{ name: string, bin: string, args: string[], cwd: string, env: Record<string,string> }[]}
 */
export function buildPlan(tier, ports, opts = {}) {
  const plan = [];
  // Env injection, not a written `.env.local` (research doc §5, and the
  // exact pattern `e2e/o11y-local.spec.ts` already proves for a build):
  // nothing lands on disk, so nothing can leak the dev-login bypass into a
  // later "real" build the way a forgotten `.env.local` can. `VITE_API_BASE`
  // points at THIS dev server (not directly at the API worker) so
  // `vite.config.ts`'s own `/api`/`/d`/`/embed` proxy is what actually talks
  // to the API worker — required for `?mode=full`'s single-origin framing
  // rule (AGENTS.md).
  const appEnv = {};
  if (tier === "2" || tier === "full") {
    appEnv.VITE_API_BASE = `http://localhost:${ports.AUTHORING_DEV_PORT}`;
    appEnv.VITE_DEV_USER = "dev@handsontable.com";
    appEnv.API_DEV_PORT = String(ports.API_DEV_PORT);
  }
  if (tier === "full") {
    appEnv.VITE_TELEMETRY_LOCAL = "1";
    appEnv.O11Y_DEV_PORT = String(ports.O11Y_DEV_PORT);
  }
  plan.push({
    name: "app",
    bin: "node_modules/.bin/vite",
    args: ["--port", String(ports.AUTHORING_DEV_PORT), "--strictPort"],
    cwd: "apps/authoring",
    env: appEnv,
  });
  if (tier === "2" || tier === "full") {
    const apiVars = [];
    if (tier === "full") {
      apiVars.push(
        "--var",
        `RUNNER_EVENTS_CLICKHOUSE_URL:http://localhost:${ports.O11Y_CLICKHOUSE_PORT}`,
        "--var",
        "AE_SQL_TOKEN:local-dev-token",
      );
    }
    plan.push({
      name: "api",
      bin: "node_modules/.bin/wrangler",
      args: ["dev", "--port", String(ports.API_DEV_PORT), "--inspector-port", String(ports.API_DEV_INSPECTOR_PORT), ...apiVars],
      cwd: "workers/api",
      env: {},
    });
  }
  if (tier === "full") {
    const sessionSecret = opts.sessionSecret ?? ephemeralSecret();
    plan.push({
      name: "o11y",
      bin: "node_modules/.bin/wrangler",
      args: [
        "dev",
        "--port",
        String(ports.O11Y_DEV_PORT),
        "--inspector-port",
        String(ports.O11Y_DEV_INSPECTOR_PORT),
        "--var",
        `O11Y_SESSION_SECRET:${sessionSecret}`,
        "--var",
        `O11Y_LOCAL_MINIO_PORT:${ports.O11Y_MINIO_PORT}`,
        "--var",
        `O11Y_LOCAL_CLICKHOUSE_PORT:${ports.O11Y_CLICKHOUSE_PORT}`,
        "--var",
        `RUNNER_EVENTS_CLICKHOUSE_URL:http://localhost:${ports.O11Y_CLICKHOUSE_PORT}`,
      ],
      cwd: "workers/o11y",
      env: {},
    });
    plan.push({
      name: "slack",
      bin: process.execPath,
      args: ["scripts/o11y-slack-capture.mjs", "--port", String(ports.O11Y_SLACK_CAPTURE_PORT)],
      cwd: ".",
      env: {},
    });
  }
  return plan;
}

/** Names only, in spawn order — what `pipeline/dev-script.test.mjs` asserts
 *  the plan for each tier is built from. */
export function planNames(tier, ports) {
  return buildPlan(tier, ports).map((p) => p.name);
}
