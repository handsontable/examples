// Shared logic for `runner/scripts/dev.mjs` (`pnpm dev`/`dev:live`/`dev:full`)
// and `runner/scripts/o11y-dev.mjs` (`pnpm o11y:dev`, the standalone o11y-only
// entry point — see that file for why it still exists as its own command).
//
// Every function here is pure or takes its side effects (fs, exec, spawn) as
// injectable parameters, so `pipeline/dev-script.test.mjs` can exercise the
// real logic with stub binaries instead of spawning `wrangler`/`docker`/`vite`
// for real. See `runner/docs/run-and-deploy.md`'s "Run locally" section for
// the user-facing walkthrough this module implements.
//
// Env vars this module reads (kept in sync with docs/run-and-deploy.md by
// `pipeline/dev-script.test.mjs`'s drift test — grep this file for `env.` if
// you add one, and add it to the doc in the same commit):
//   AUTHORING_DEV_PORT, API_DEV_PORT, API_DEV_INSPECTOR_PORT,
//   O11Y_DEV_PORT, O11Y_DEV_INSPECTOR_PORT, O11Y_MINIO_PORT,
//   O11Y_MINIO_CONSOLE_PORT, O11Y_CLICKHOUSE_PORT, O11Y_CLICKHOUSE_NATIVE_PORT,
//   O11Y_SLACK_CAPTURE_PORT, COMPOSE_PROJECT_NAME, WRANGLER_REGISTRY_PATH

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from "node:fs";
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
  --replay          (--tier=full only) run the OTLP/Faro fixture replay once,
                    after the o11y worker reports ready. Without this flag,
                    dev.mjs just prints the replay command.
  --reset-local-db  (--tier=2 or --tier=full only) delete workers/api's local
                    D1 state (workers/api/.wrangler/state/v3/d1) and the
                    applied-migrations record before starting, then run every
                    migration fresh. Passing this flag IS the confirmation —
                    it prints what it deleted and does not prompt.
  --fresh           (--tier=full only) wipe ALL local o11y state together
                    before starting: docker compose ... down -v for this
                    project's minio/clickhouse (named volumes — logs and
                    runner_events) AND workers/o11y/.wrangler/state (the
                    InboxWriter ledger, dedupe hashes, local R2 inbox
                    objects). Without --fresh, both are KEPT across a
                    restart on purpose — see docs/run-and-deploy.md's "Run
                    locally" section for why they must be wiped together,
                    never separately (the API worker's D1 is untouched
                    either way; that's --reset-local-db). Prints exactly
                    what it removed. pnpm o11y:dev also accepts --fresh,
                    for just the workers/o11y/.wrangler/state half (it never
                    runs docker compose itself — see that command's own
                    startup log for the divergence risk if you've also got
                    a dev:full compose stack's volumes still holding data
                    from before).
  --skip-image-check
                    (--tier=2 or --tier=full only) skip the pre-flight check
                    that every container base image (read from each
                    wrangler.jsonc's own containers[].image Dockerfile,
                    e.g. cloudflare/sandbox:0.12.3) is present locally,
                    pulling any that's missing before starting a worker.
                    Escape hatch for offline use when the images are
                    already built.
  -h, --help        Print this help and exit 0.

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
 * @returns {{ help: boolean, tier: "1"|"2"|"full"|null, replay: boolean, resetLocalDb: boolean, fresh: boolean, skipImageCheck: boolean, errors: string[] }}
 */
export function parseArgs(argv) {
  const errors = [];
  let tier = null;
  let replay = false;
  let resetLocalDb = false;
  let fresh = false;
  let skipImageCheck = false;
  let help = false;
  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      help = true;
    } else if (arg === "--replay") {
      replay = true;
    } else if (arg === "--reset-local-db") {
      resetLocalDb = true;
    } else if (arg === "--fresh") {
      fresh = true;
    } else if (arg === "--skip-image-check") {
      skipImageCheck = true;
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
  if (resetLocalDb && tier !== "2" && tier !== "full" && tier !== null) {
    errors.push("--reset-local-db is only valid with --tier=2 or --tier=full");
  }
  if (fresh && tier !== "full" && tier !== null) {
    errors.push("--fresh is only valid with --tier=full");
  }
  if (skipImageCheck && tier !== "2" && tier !== "full" && tier !== null) {
    errors.push("--skip-image-check is only valid with --tier=2 or --tier=full");
  }
  return { help, tier, replay, resetLocalDb, fresh, skipImageCheck, errors };
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
  assertNoPortCollisions(resolved);
  return resolved;
}

/** Throws if any two of `resolved`'s own port values collide. Exported so a
 *  caller that MUTATES an already-resolved ports object after the fact (e.g.
 *  `dev.mjs` adopting a `.dev.vars`-pinned port — see
 *  `resolveDevVarsPortAdoption`) can re-run the same check `resolvePorts`
 *  itself runs, rather than silently allowing the adopted port to collide
 *  with another already-resolved one. */
export function assertNoPortCollisions(resolved) {
  const byPort = new Map();
  for (const [key, value] of Object.entries(resolved)) {
    if (byPort.has(value)) {
      throw new Error(`port collision: ${key} and ${byPort.get(value)} both resolve to ${value}`);
    }
    byPort.set(value, key);
  }
}

// ---------------------------------------------------------------------------
// .dev.vars bootstrap
// ---------------------------------------------------------------------------

const defaultFs = { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync };

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
 * Resolves a `.dev.vars` key that pins a `host:port` value (`PREVIEW_HOST`,
 * `SLACK_WEBHOOK_URL`) against the port this run otherwise resolved.
 * Wrangler's `.dev.vars` always wins over `--var` for a key it declares (see
 * this file's module doc comment), so when the declared port disagrees with
 * this run's resolved port, the `.dev.vars` value is the one that will
 * actually be reached regardless of what this script decided — a bare
 * warning that leaves the script pointed at the WRONG port (e.g. the vite
 * proxy's `API_DEV_PORT`) is what produced the original port-drift bug.
 *
 * `explicit` says whether the developer explicitly overrode this port's env
 * var for THIS run (e.g. `API_DEV_PORT` set in the environment):
 *  - `explicit: false` (the common case — no override) ADOPTS the
 *    `.dev.vars`-declared port: `.dev.vars` was already going to win, so
 *    matching it is what makes every OTHER piece this script controls (the
 *    worker's own `--port`, the vite proxy target, the printed URLs) agree
 *    with reality instead of silently disagreeing with it.
 *  - `explicit: true` WARNS instead and leaves `currentPort` alone — an
 *    explicit override is the developer's deliberate choice; silently
 *    discarding it in favor of the file would be the surprising direction.
 *
 * @returns {{ port: number, adopted: boolean, message: string|null }}
 */
export function resolveDevVarsPortAdoption({ devVarsPath, key, currentPort, explicit, fs = defaultFs }) {
  const value = readDevVarsLine(devVarsPath, key, fs);
  if (value === undefined) return { port: currentPort, adopted: false, message: null };
  const m = /:(\d+)(?:\/|$)/.exec(value);
  if (!m) return { port: currentPort, adopted: false, message: null };
  const declaredPort = Number(m[1]);
  if (declaredPort === currentPort) return { port: currentPort, adopted: false, message: null };
  if (explicit) {
    return {
      port: currentPort,
      adopted: false,
      message:
        `${devVarsPath} declares ${key}=${value} (port ${declaredPort}), but this run resolved port ` +
        `${currentPort} — .dev.vars always wins over this script's own port choice for a key it declares. ` +
        `Edit ${devVarsPath} by hand, or delete it and re-run to get a fresh bootstrap at the new port.`,
    };
  }
  return {
    port: declaredPort,
    adopted: true,
    message:
      `${devVarsPath} declares ${key}=${value} (port ${declaredPort}) — adopting it for this run since no ` +
      `explicit port override was set; .dev.vars always wins over this script's own port choice for a key it declares.`,
  };
}

/**
 * Warns (does not throw — this is advisory, not fatal) when a `.dev.vars`
 * value baked in at bootstrap time (a `localhost:<port>`-shaped default)
 * disagrees with the port this run actually resolved AND that port was
 * explicitly requested (`resolveDevVarsPortAdoption`'s `explicit: true`
 * branch) — the situation where a developer set a port-override env var
 * AFTER their `.dev.vars` was already bootstrapped with the old default.
 * @returns {string|null} a warning line, or null if there's no drift to report
 */
export function checkDevVarsPortDrift(devVarsPath, key, expectedPort, fs = defaultFs) {
  return resolveDevVarsPortAdoption({ devVarsPath, key, currentPort: expectedPort, explicit: true, fs }).message;
}

/**
 * Re-review 2, NB8: an `workers/o11y/.dev.vars` bootstrapped BEFORE this
 * task's `DEV_ADMIN`/`O11Y_SESSION_SECRET` handling existed (e.g. by the old
 * standalone `o11y-dev.mjs`, which copied `.dev.vars.example` verbatim) has
 * both declared EMPTY: `DEV_ADMIN=` and `O11Y_SESSION_SECRET=`. Neither
 * `bootstrapDevVars` (only acts on a FRESH file) nor the `O11Y_ENV=local`
 * check above catches this — the run starts, looks normal, and then
 * `/grafana/_o11y/login` answers 500 (the declared-but-empty
 * `O11Y_SESSION_SECRET` line silently wins over this run's own `--var`, the
 * same `.dev.vars`-always-wins quirk `checkDevVarsPortDrift` guards
 * elsewhere) with the local session bypass ALSO off (`DEV_ADMIN` empty).
 * Warns for either case; does not fix the file itself — same "advisory, not
 * fatal" posture as `checkDevVarsPortDrift`.
 *
 * P1-logs: the exact same stale-bootstrap shape breaks two more keys, found
 * while wiring up the Logs dashboard's live verification — an old
 * `.dev.vars` from before `o11yDevVarsPatch` grew `SLACK_WEBHOOK_URL`/
 * `AE_SQL_TOKEN` (both still declared empty in
 * `workers/o11y/.dev.vars.example`, same as `DEV_ADMIN`/`O11Y_SESSION_SECRET`)
 * has `SLACK_WEBHOOK_URL=` (the local Slack-capture warning webhook,
 * `o11y-slack-capture.mjs`) and/or `AE_SQL_TOKEN=` (the local ClickHouse
 * auth token the Logs/Runner-overview/Observability-self dashboards' AE
 * queries depend on) declared but empty — same silent-string-wins-over-`
 * --var`-like failure mode, just surfacing as a broken local Slack capture
 * and a 401/empty ClickHouse panel instead of a 500. On a genuinely FRESH
 * bootstrap neither key is ever left empty: `o11yDevVarsPatch` (used as
 * `bootstrapDevVars`'s `patch` argument by both `dev.mjs` and
 * `o11y-dev.mjs`) already fills both with a real local-dev value the same
 * pass that fills `DEV_ADMIN` — this function only ever fires for the STALE
 * case, an existing file this run's bootstrap never touches.
 * @returns {string[]} zero or more warning lines
 */
export function checkO11yDevVarsStaleness(devVarsPath, fs = defaultFs) {
  const warnings = [];
  const devAdmin = readDevVarsLine(devVarsPath, "DEV_ADMIN", fs);
  if (devAdmin === "") {
    warnings.push(
      `${devVarsPath} declares DEV_ADMIN= (empty) — the local session bypass is OFF. ` +
        `Edit the file to set DEV_ADMIN=dev@handsontable.com, or delete it and re-run for a fresh bootstrap.`,
    );
  }
  const sessionSecret = readDevVarsLine(devVarsPath, "O11Y_SESSION_SECRET", fs);
  if (sessionSecret === "") {
    warnings.push(
      `${devVarsPath} declares O11Y_SESSION_SECRET= (empty) — this silently overrides this run's own ephemeral ` +
        `--var (wrangler: .dev.vars always wins), so /grafana/_o11y/login will answer 500. Remove that line from ` +
        `${devVarsPath}, or delete the file and re-run for a fresh bootstrap.`,
    );
  }
  const slackWebhookUrl = readDevVarsLine(devVarsPath, "SLACK_WEBHOOK_URL", fs);
  if (slackWebhookUrl === "") {
    warnings.push(
      `${devVarsPath} declares SLACK_WEBHOOK_URL= (empty) — local Slack alert capture is OFF (an alert fires but ` +
        `nothing is written for o11y-slack-capture.mjs to read). Edit the file to point it at the local capture ` +
        `port, or delete it and re-run for a fresh bootstrap.`,
    );
  }
  const aeSqlToken = readDevVarsLine(devVarsPath, "AE_SQL_TOKEN", fs);
  if (aeSqlToken === "") {
    warnings.push(
      `${devVarsPath} declares AE_SQL_TOKEN= (empty) — the local ClickHouse token is OFF, so every Analytics ` +
        `Engine panel (Runner overview, Observability self, the Logs dashboard) will 401/render empty. Edit the ` +
        `file to set a token matching compose.yml's local default, or delete it and re-run for a fresh bootstrap.`,
    );
  }
  return warnings;
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

/**
 * The origin `gates/session.ts#publicOrigin`/`grafana/login.ts` build the
 * broker `return_to` against, and the `aud` every locally-minted session
 * token is bound to (K1: `O11Y_ENV === "local"` only — see that file's own
 * doc comment). Grafana is served from the o11y worker's OWN origin
 * (`/grafana/*`, not proxied through the authoring app), so this must track
 * `O11Y_DEV_PORT`, not `AUTHORING_DEV_PORT` — on a non-default o11y port,
 * `publicOrigin`'s own fallback (`http://localhost:4200`) would otherwise
 * be silently wrong and every locally-minted token would fail its own
 * `aud` check.
 */
export function o11yLocalPublicOrigin(ports) {
  return `http://localhost:${ports.O11Y_DEV_PORT}`;
}

/** Ephemeral, never-persisted hex secret for O11Y_SESSION_SECRET (or any
 *  other run-scoped local secret) — a fresh value every process start,
 *  injected only via `--var`/env, never written to a file. */
export function ephemeralSecret(bytes = 32) {
  return randomBytes(bytes).toString("hex");
}

/** `--var NAME:value` argument names whose value must never be echoed back
 *  to the log line `dev.mjs` prints for each spawned child (re-review 2,
 *  NB6) — this run's own ephemeral `O11Y_SESSION_SECRET` is the only one
 *  today, but a future ephemeral local secret should be added here rather
 *  than growing a second ad hoc check. Does not (and cannot, from here)
 *  keep the value out of `ps` output — an argv is visible to any local
 *  process by nature — only out of dev.mjs's own terminal/log line. */
const REDACT_VAR_NAMES = ["O11Y_SESSION_SECRET"];

/** Returns `args` with the value half of every `--var NAME:value` pair
 *  named in {@link REDACT_VAR_NAMES} replaced by `<redacted>`, for
 *  `dev.mjs`'s own "spawning: ..." log line only — the real `args` array
 *  passed to `spawn()` is never touched, only a copy built for display. */
export function redactArgsForLog(args) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (args[i - 1] === "--var" && typeof arg === "string") {
      const [name] = arg.split(":", 1);
      if (REDACT_VAR_NAMES.includes(name)) {
        out.push(`${name}:<redacted>`);
        continue;
      }
    }
    out.push(arg);
  }
  return out;
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

function recordMigrationApplied(recordPath, file, fs) {
  const already = readAppliedMigrations(recordPath, fs);
  writeAppliedMigrations(recordPath, [...already, file], fs);
}

const defaultFsWithReaddir = { ...defaultFs, readdirSync, statSync };

// ---------------------------------------------------------------------------
// Migration schema probe — adopts a local D1 that was migrated before this
// script's applied-migrations record existed (or by hand, matching the exact
// bug this fixes: a developer's pre-existing local D1 re-applied from 0001,
// where 0003_cost_ledger.sql's bare `ALTER TABLE demos ADD COLUMN
// artifacts_purged_at` — no `IF NOT EXISTS`, SQLite has no such clause for a
// column — died with `duplicate column name`).
// ---------------------------------------------------------------------------

/** Strips `--` line comments, then splits on `;` into individual statements.
 *  Good enough for this repo's own migrations (never a `;` inside a string
 *  literal or a trigger body) — not a general SQL parser. */
function splitStatements(sql) {
  return sql
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Extracts a migration file's "checkable, additive" targets: `CREATE TABLE`,
 * `CREATE [UNIQUE] INDEX`, and `ALTER TABLE ... ADD [COLUMN] ...` — the
 * shapes whose effect can be checked generically against a schema snapshot
 * (`snapshotLocalSchema`/`isMigrationAlreadyApplied` below).
 *
 * Deliberately conservative: an empty file, or a file containing ANY other
 * statement shape (e.g. `DROP INDEX`, a bare `UPDATE`/`INSERT`, a table
 * `RENAME`), is marked `checkable: false` — this migrations dir has exactly
 * one such file, 0002_buildkey_nonunique.sql, whose `DROP INDEX
 * idx_demos_buildkey` exists precisely to fix a design error (a UNIQUE index
 * that should not have been unique); a name-only probe would see the OLD
 * unique index and wrongly report the file's target as "already exists",
 * skipping the very fix it exists to apply. 0002 is fully idempotent on its
 * own (`IF EXISTS`/`IF NOT EXISTS` throughout), so simply running it again is
 * correct and safe — `checkable: false` just means "don't try to skip it".
 *
 * @returns {{ checkable: boolean, targets: Array<
 *   {type:'table', name:string} | {type:'index', name:string} |
 *   {type:'column', table:string, name:string}
 * > }}
 */
export function parseMigrationTargets(sql) {
  const statements = splitStatements(sql);
  if (statements.length === 0) return { checkable: false, targets: [] };
  const targets = [];
  for (const stmt of statements) {
    let m;
    if ((m = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?(\w+)["`\]]?/i.exec(stmt))) {
      targets.push({ type: "table", name: m[1] });
      continue;
    }
    if ((m = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?(\w+)["`\]]?/i.exec(stmt))) {
      targets.push({ type: "index", name: m[1] });
      continue;
    }
    if ((m = /^ALTER\s+TABLE\s+["`[]?(\w+)["`\]]?\s+ADD\s+(?:COLUMN\s+)?["`[]?(\w+)["`\]]?/i.exec(stmt))) {
      targets.push({ type: "column", table: m[1], name: m[2] });
      continue;
    }
    // Any other statement shape — this file's effect can't be probed
    // generically, so it's never a candidate for "adopt without running".
    return { checkable: false, targets: [] };
  }
  return { checkable: true, targets };
}

async function queryD1Json(query, args) {
  const raw = await query(args);
  const parsed = JSON.parse(raw);
  return parsed[0]?.results ?? [];
}

/**
 * One schema snapshot of the local D1: every table/index name in
 * `sqlite_master`, plus the column list (`PRAGMA table_info`) for each table
 * in `tables` — one `wrangler d1 execute --json` round trip per query, not
 * per target (a `wrangler` spawn costs real wall-clock seconds, and a
 * migrations dir touches only a handful of distinct tables via `ALTER TABLE`
 * — `demos` is the only one today).
 * @param {(args: string[]) => Promise<string>|string} query injectable —
 *   real callers run `wrangler d1 execute <db> --local --json --command=...`
 *   and return raw stdout; tests stub it.
 */
export async function snapshotLocalSchema({ dbName, tables, query }) {
  const objects = await queryD1Json(query, [
    "d1",
    "execute",
    dbName,
    "--local",
    "--json",
    "--command",
    "SELECT type, name FROM sqlite_master WHERE type IN ('table','index')",
  ]);
  const tableNames = new Set(objects.filter((r) => r.type === "table").map((r) => r.name));
  const indexNames = new Set(objects.filter((r) => r.type === "index").map((r) => r.name));
  const columns = {};
  for (const table of tables) {
    if (!tableNames.has(table)) {
      columns[table] = new Set();
      continue;
    }
    const rows = await queryD1Json(query, ["d1", "execute", dbName, "--local", "--json", "--command", `PRAGMA table_info(${table})`]);
    columns[table] = new Set(rows.map((r) => r.name));
  }
  return { tableNames, indexNames, columns };
}

/** True when EVERY target a migration file declares (per `parseMigrationTargets`)
 *  already exists in `snapshot` — the condition for adopting the file as
 *  already-applied instead of running it. A file with zero targets (e.g.
 *  `checkable: false`, or a genuinely empty file) is never adopted — that
 *  would be vacuously "true" for a file whose effect was never checked. */
export function isMigrationAlreadyApplied(targets, snapshot) {
  if (targets.length === 0) return false;
  return targets.every((t) => {
    if (t.type === "table") return snapshot.tableNames.has(t.name);
    if (t.type === "index") return snapshot.indexNames.has(t.name);
    if (t.type === "column") return snapshot.columns[t.table]?.has(t.name) ?? false;
    return false;
  });
}

/** Typed error `applyMigrations` throws on any failure (a real `d1 execute`
 *  failure, or a schema-probe query failure) — carries what `dev.mjs` needs
 *  to print ONE clean line instead of letting a raw `execFileSync` stack
 *  trace reach the top-level `main().catch`. `file` is `null` for a
 *  probe-query failure (not tied to one specific migration file). */
export class MigrationError extends Error {
  constructor({ file, sqliteMessage, recordPath, action }) {
    const where = file ? `migration ${file}` : "the local D1 schema probe";
    super(`${action} ${where} failed: ${sqliteMessage}`);
    this.name = "MigrationError";
    this.file = file;
    this.sqliteMessage = sqliteMessage;
    this.recordPath = recordPath;
  }
}

/** Pulls the actual SQLite error text out of a failed `wrangler` invocation
 *  (an `execFileSync`-shaped error, with `.stderr`/`.stdout` Buffers or
 *  strings) — wrangler prints `✘ [ERROR] <message>` to stderr wrapped in ANSI
 *  color codes (confirmed against wrangler 4.108's own output for a real
 *  `duplicate column name` failure). Falls back to the last non-empty line
 *  of whatever output is available, then to the raw error's own `.message`,
 *  so this never throws trying to format another error. */
function extractSqliteMessage(err) {
  const chunk = (v) => (v === undefined || v === null ? "" : v.toString("utf8"));
  const raw = chunk(err.stderr) + chunk(err.stdout);
  const clean = raw.replace(/\x1b\[[0-9;]*m/g, "");
  const m = /✘\s*\[ERROR\]\s*(.+)/.exec(clean);
  if (m) return m[1].trim();
  const lastLine = clean
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  return lastLine || err.message || String(err);
}

function toMigrationError({ file, recordPath, cause, action }) {
  if (cause instanceof MigrationError) return cause;
  return new MigrationError({ file, sqliteMessage: extractSqliteMessage(cause), recordPath, action });
}

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
 * Before running any file, if `query` is given, takes a schema snapshot of
 * the local D1 (`snapshotLocalSchema`) and adopts (records as applied,
 * without running) any pending file whose targets ALL already exist there
 * (`isMigrationAlreadyApplied`) — this is what safely absorbs a local D1
 * that was migrated (by hand, or by `dev.mjs` itself before this task) with
 * no applied-migrations record: re-running a file that already landed used
 * to fail on its first non-idempotent statement (0003/0007's bare
 * `ALTER TABLE ... ADD COLUMN`) with a raw `duplicate column name` error.
 * Re-snapshots after every file that actually runs, so a later file's probe
 * sees that file's own effect. `query` is optional — omitting it (as every
 * existing caller/test here does) skips probing entirely and always runs
 * every pending file, unchanged from this function's original behavior.
 *
 * Any failure — a real `d1 execute` failure, or (when `query` is given) a
 * probe-query failure — throws a {@link MigrationError} naming the file (or
 * `null` for a probe failure), the SQLite message, and `recordPath`, instead
 * of letting a raw `execFileSync` error (a stack trace) escape. Genuinely
 * different errors are never swallowed as "already applied" — only a file
 * whose targets the probe actually found already present is skipped;
 * anything else still runs and can still fail loudly.
 *
 * @param {object} opts
 * @param {string} opts.migrationsDir
 * @param {string} opts.recordPath
 * @param {string} opts.dbName
 * @param {(args: string[]) => Promise<void>|void} opts.run injectable —
 *   real callers pass a `node_modules/.bin/wrangler d1 execute ...` runner
 *   (stdio inherited, for live output); tests pass a stub that just records
 *   calls (or throws an `execFileSync`-shaped error to simulate a failure).
 * @param {(args: string[]) => Promise<string>|string} [opts.query] injectable
 *   — real callers run `wrangler d1 execute ... --json` and return raw
 *   stdout; omit to skip the schema probe entirely.
 * @param {(line: string) => void} [opts.log]
 * @returns {Promise<{ applied: string[], adopted: string[] }>} `applied` is
 *   every file this run actually ran; `adopted` is every file this run
 *   recorded as applied WITHOUT running it (the probe's skip list).
 */
export async function applyMigrations({ migrationsDir, recordPath, dbName, run, query, fs = defaultFsWithReaddir, log = () => {} }) {
  const { pending } = planMigrations({ migrationsDir, recordPath, fs });
  if (pending.length === 0) {
    log("migrations: nothing to apply (all recorded as already applied)");
    return { applied: [], adopted: [] };
  }

  const parsed = pending.map((file) => {
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    return { file, ...parseMigrationTargets(sql) };
  });
  const alterTables = [...new Set(parsed.flatMap((p) => p.targets.filter((t) => t.type === "column").map((t) => t.table)))];

  async function takeSnapshot() {
    try {
      return await snapshotLocalSchema({ dbName, tables: alterTables, query });
    } catch (cause) {
      throw toMigrationError({ file: null, recordPath, cause, action: "probing" });
    }
  }

  let snapshot = query ? await takeSnapshot() : null;
  const appliedThisRun = [];
  const adoptedThisRun = [];
  for (const { file, checkable, targets } of parsed) {
    if (snapshot && checkable && isMigrationAlreadyApplied(targets, snapshot)) {
      log(`migration ${file}: every target already exists in the local D1 — adopting it as already applied (not running it)`);
      adoptedThisRun.push(file);
      recordMigrationApplied(recordPath, file, fs);
      continue;
    }
    log(`applying migration ${file}`);
    try {
      await run(["d1", "execute", dbName, "--local", `--file=migrations/${file}`, "-y"]);
    } catch (cause) {
      throw toMigrationError({ file, recordPath, cause, action: "applying" });
    }
    appliedThisRun.push(file);
    recordMigrationApplied(recordPath, file, fs);
    if (query && alterTables.length > 0) snapshot = await takeSnapshot();
  }
  return { applied: appliedThisRun, adopted: adoptedThisRun };
}

/** Formats a caught {@link MigrationError} (or any other error) as ONE clean
 *  line for `dev.mjs`'s own top-level catch — never a raw stack trace — plus
 *  a recovery line naming the applied-migrations record and, if the caller
 *  passed `mentionReset`, the `--reset-local-db` flag. */
export function formatMigrationError(err, { mentionReset = true } = {}) {
  if (err instanceof MigrationError) {
    const resetHint = mentionReset ? ", or wipe local D1 state and start over with `--reset-local-db`" : "";
    return (
      `error: ${err.message}\n` +
      `  Recovery: inspect/edit the applied-migrations record at ${err.recordPath}${resetHint}.`
    );
  }
  return `error: migrations failed: ${err.message ?? err}`;
}

/** Deletes workers/api's local D1 state (`.wrangler/state/v3/d1`) and the
 *  applied-migrations record (`migrationRecordPath`) — the two `dev-lib.mjs`
 *  otherwise keeps in lockstep (see `migrationRecordPath`'s own doc comment).
 *  Passing `--reset-local-db` on the CLI IS the confirmation (no interactive
 *  prompt from a script that's meant to run unattended); this function just
 *  logs exactly what it found and deleted, so the action is never silent. */
export function resetLocalD1(apiDir, fs = defaultFs, log = () => {}) {
  const stateDir = path.join(apiDir, ".wrangler", "state", "v3", "d1");
  const recordPath = migrationRecordPath(apiDir);
  const hadState = fs.existsSync(stateDir);
  const hadRecord = fs.existsSync(recordPath);
  if (hadState) fs.rmSync(stateDir, { recursive: true, force: true });
  if (hadRecord) fs.rmSync(recordPath, { force: true });
  if (hadState || hadRecord) {
    log(`--reset-local-db: deleted ${hadState ? stateDir : ""}${hadState && hadRecord ? " and " : ""}${hadRecord ? recordPath : ""}`);
  } else {
    log("--reset-local-db: no local D1 state or applied-migrations record found — nothing to delete");
  }
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

/**
 * Measured empirically for this task: Ctrl-C on `dev.mjs` does NOT make
 * wrangler's own Sandbox-container orchestration tear itself down
 * synchronously — a Tier-2 session's `workerd-handsontable-demos-api-
 * Sandbox-*`(-proxy) containers were both still `Up` several seconds after
 * the wrapper process itself had already exited.
 *
 * Re-review 2, NB2: this used to also `docker stop` every container that
 * was new since this run started AND matched a name pattern
 * (`/handsontable-demos-(api|o11y)/`). That is NOT a safe ownership proof —
 * several worktrees on this machine routinely run `wrangler dev` at once
 * (the whole reason `WRANGLER_REGISTRY_PATH`/port-block conventions exist),
 * and "new since my snapshot" is a race over this run's ENTIRE session
 * (potentially hours for `dev:live`/`dev:full`), not a narrow few-second
 * window: worktree B starting its own Tier-2 session or `wrangler dev` at
 * any point while worktree A is still up produces a same-named container
 * that is "new" relative to A's snapshot too. Stopping it silently kills
 * B's session. Neither `wrangler dev`'s local container runtime nor the
 * Sandbox SDK stamps a per-run/per-worktree Docker label this codebase
 * could use to tell "mine" from "someone else's" apart (checked wrangler's
 * own bundled JS for a `--label`/`Labels` it sets when building or running
 * a local dev container: none found — the actual `docker run` for a woken
 * Sandbox happens inside workerd's own native container runtime, which is
 * opaque to a static check like this one).
 *
 * So this module NEVER runs `docker stop` on a container it cannot prove it
 * started. `listRunningContainers`/`possiblyLeftoverContainers` below are
 * used only to PRINT a report and a manual cleanup command — see
 * `dev.mjs`'s teardown step, which decides whether to act (never) and what
 * to print.
 */
export function listRunningContainers(execFileSyncImpl) {
  const out = execFileSyncImpl("docker", ["ps", "--format", "{{.ID}}\t{{.Names}}"]).toString();
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, ...rest] = line.split("\t");
      return { id, name: rest.join("\t") };
    });
}

export const LEFTOVER_CONTAINER_NAME_RE = /handsontable-demos-(api|o11y)/;

/** `before`: a Set of container ids running when this run started (from
 *  `listRunningContainers` at that point, ids only). `after`:
 *  `listRunningContainers()`'s result now. Returns the ones that are both
 *  new since `before` AND look like a `handsontable-demos-*` worker
 *  container — a REPORTING signal only (see this file's module-level doc
 *  comment above): `dev.mjs` prints these, it never stops them, because
 *  "new since my own snapshot" cannot distinguish this run's own container
 *  from one a concurrent, unrelated `wrangler dev` session (another
 *  worktree) started in the same window. */
export function possiblyLeftoverContainers(before, after) {
  return after.filter((c) => !before.has(c.id) && LEFTOVER_CONTAINER_NAME_RE.test(c.name));
}

/** The exact `docker ps` filter and manual `docker stop` command to print
 *  for the containers `possiblyLeftoverContainers` found — so a developer
 *  who recognizes them as genuinely this run's own can clean them up by
 *  hand, after confirming (e.g. `docker inspect` the ports/mounts) that
 *  they are not another worktree's session. */
export function describeLeftoverContainersForOperator(candidates) {
  const ids = candidates.map((c) => c.id).join(" ");
  const names = candidates.map((c) => c.name).join(", ");
  return (
    `${candidates.length} container(s) look like this run's own worker containers ` +
    `(new since startup, name matches ${LEFTOVER_CONTAINER_NAME_RE}) but this cannot be proven — ` +
    `another worktree's concurrent \`wrangler dev\` session can produce the exact same signal. ` +
    `NOT stopping them automatically. Names: ${names}. ` +
    `Inspect first (e.g. \`docker inspect ${candidates[0]?.id ?? "<id>"}\` for its ports/mounts), ` +
    `list candidates with \`docker ps --filter "name=handsontable-demos-"\`, ` +
    `and if you're sure they're yours: \`docker stop ${ids}\`.`
  );
}

/** The whole leftover-container REPORT step `dev.mjs`'s teardown runs —
 *  factored out here (rather than left inline in `dev.mjs`) so it is
 *  directly unit-testable with a stubbed `execFileSyncImpl`, the same way
 *  every other side-effecting piece of this module is. Re-review 2, NB2:
 *  this function calls `docker` only to LIST containers (`docker ps`, via
 *  `listRunningContainers`) — it never calls `docker stop`, no matter what
 *  it finds. Returns the candidates found (possibly empty) so a caller can
 *  assert on them without re-parsing the log line. */
export function reportLeftoverContainers(before, execFileSyncImpl, logImpl) {
  const after = listRunningContainers(execFileSyncImpl);
  const candidates = possiblyLeftoverContainers(before, after);
  if (candidates.length > 0) logImpl(describeLeftoverContainersForOperator(candidates));
  return candidates;
}

/** Signals `dev.mjs` treats as "shut everything down cleanly". Re-review 2,
 *  NB5: SIGHUP is included because every child is spawned `detached: true`
 *  (its own process group/session) — closing the terminal `dev.mjs` runs
 *  in sends SIGHUP to `dev.mjs` itself but not to those detached children,
 *  so without a handler here `dev.mjs` used to die via the default SIGHUP
 *  action (immediate exit, no cleanup) and leave every child running. */
export const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

// ---------------------------------------------------------------------------
// Container base-image pre-pull (dev-prepull task)
//
// Self-contained on purpose (a separate section, its own local helpers, no
// changes to anything above) so a parallel edit elsewhere in this file
// merges cleanly. What broke before this existed: `wrangler dev`'s own
// local container build silently races a missing base image against Docker
// Hub — if `docker pull` for e.g. `cloudflare/sandbox:0.12.3` times out
// during the build, wrangler keeps running anyway and a Tier-2 session then
// fails opaquely at container-start time ("No such image available").
// This section checks every base image a tier's Dockerfiles need is
// present BEFORE any worker is spawned, pulling what's missing with a
// bounded retry, and fails fast with one clear message (not a live-but-
// broken dev session) if a pull still doesn't land.
// ---------------------------------------------------------------------------

/**
 * Minimal string-aware JSONC comment stripper (line comments and block
 * comments, respecting quoted strings/escapes) — same zero-dependency
 * approach `pipeline/o11y-box-config.test.mjs` already uses for the same
 * reason: `wrangler.jsonc` is JSONC, not plain JSON, and T00 owns adding
 * any parsing dependency. Kept as this section's own private copy rather
 * than a shared export, so this section stays self-contained.
 */
function stripJsonCommentsForContainerConfig(text) {
  let result = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      if (c === "\n") {
        inLineComment = false;
        result += c;
      }
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      result += c;
      if (c === "\\") {
        result += next;
        i++;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      result += c;
      continue;
    }
    if (c === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    result += c;
  }
  return result;
}

/**
 * Reads a worker's `wrangler.jsonc` `containers[].image` paths — Dockerfile
 * paths relative to `wranglerJsoncPath`'s own directory (this repo's own
 * config already names them; this never hardcodes a second copy) —
 * resolved to absolute paths. Returns `[]` when the config has no
 * `containers` block.
 * @param {string} wranglerJsoncPath
 * @param {typeof defaultFs} [fs]
 * @returns {string[]}
 */
export function readContainerDockerfilePaths(wranglerJsoncPath, fs = defaultFs) {
  const raw = fs.readFileSync(wranglerJsoncPath, "utf8");
  const config = JSON.parse(stripJsonCommentsForContainerConfig(raw));
  const containers = config.containers ?? [];
  const dir = path.dirname(wranglerJsoncPath);
  return containers.map((c) => path.resolve(dir, c.image));
}

/**
 * Extracts every base image a Dockerfile's `FROM` instructions need pulled
 * from a registry — i.e. what `docker build` needs present locally before
 * it can even start. Handles:
 *  - multi-stage builds: one entry per `FROM`, in order, deduped;
 *  - stage aliases (`FROM <image> AS <name>`) and a LATER `FROM <name>`
 *    that references an earlier stage by that alias — excluded, since it
 *    resolves to a previously built stage, not a registry pull;
 *  - `ARG`-declared build args used in `FROM $ARG`/`FROM ${ARG}` — resolved
 *    using the Dockerfile's own default (`ARG NAME=default`, declared
 *    before the first `FROM`, i.e. a global build arg per Docker's own
 *    scoping rule) since `docker build` without an explicit `--build-arg`
 *    uses that default; left unresolved (and so excluded from the "safe to
 *    pull" set — callers see the literal placeholder, which
 *    `docker image inspect`/`pull` will just fail on visibly) if the ARG
 *    has no default;
 *  - `FROM scratch` — the empty pseudo-image, never pulled, excluded;
 *  - an optional `--platform=...` flag between `FROM` and the image ref.
 * @param {string} dockerfileText
 * @returns {string[]} base image refs, in FROM order, deduped
 */
export function parseDockerfileBaseImages(dockerfileText) {
  const globalArgs = new Map();
  const stageNames = new Set();
  const seen = new Set();
  const images = [];
  let sawFrom = false;
  for (const rawLine of dockerfileText.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    let m;
    if (!sawFrom && (m = /^ARG\s+([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/.exec(line))) {
      let value = m[2];
      if (value !== undefined) {
        value = value.trim();
        const q = /^"(.*)"$|^'(.*)'$/.exec(value);
        if (q) value = q[1] ?? q[2];
      }
      globalArgs.set(m[1], value);
      continue;
    }
    if ((m = /^FROM\s+(.+)$/i.exec(line))) {
      sawFrom = true;
      const parts = m[1].trim().split(/\s+/);
      let idx = 0;
      while (parts[idx]?.startsWith("--")) idx++;
      let ref = parts[idx];
      let alias;
      const asIdx = parts.findIndex((p, i) => i > idx && /^as$/i.test(p));
      if (asIdx !== -1) alias = parts[asIdx + 1];
      ref = ref.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (whole, name) => {
        const resolved = globalArgs.get(name);
        return globalArgs.has(name) && resolved !== undefined ? resolved : whole;
      });
      const referencesEarlierStage = stageNames.has(ref);
      if (alias) stageNames.add(alias);
      if (ref.toLowerCase() === "scratch") continue;
      if (referencesEarlierStage) continue;
      if (!seen.has(ref)) {
        seen.add(ref);
        images.push(ref);
      }
    }
  }
  return images;
}

/**
 * Maps a `dev.mjs` tier to the `wrangler.jsonc`(s) whose `containers[].image`
 * Dockerfiles that tier's workers actually start. Tier "1" needs none — no
 * worker with a container starts. Read from this repo's own config
 * (requirement: derive from `containers[].image`, never hardcode the
 * Dockerfile paths a second time).
 * @param {"1"|"2"|"full"} tier
 * @param {string} runnerRoot
 * @returns {string[]}
 */
export function containerWranglerConfigsForTier(tier, runnerRoot) {
  if (tier === "1") return [];
  const apiConfig = path.join(runnerRoot, "workers", "api", "wrangler.jsonc");
  if (tier === "2") return [apiConfig];
  if (tier === "full") return [apiConfig, path.join(runnerRoot, "workers", "o11y", "wrangler.jsonc")];
  throw new Error(`containerWranglerConfigsForTier: unknown tier "${tier}"`);
}

/**
 * Every distinct base image ref this tier's Dockerfiles declare, across
 * every `wrangler.jsonc` `containers[].image` Dockerfile the tier needs —
 * deduped, first-seen order. Throws a clear error (not a raw `ENOENT`) if a
 * `containers[].image` path doesn't exist on disk.
 * @param {"1"|"2"|"full"} tier
 * @param {string} runnerRoot
 * @param {typeof defaultFs} [fs]
 * @returns {string[]}
 */
export function collectTierBaseImages(tier, runnerRoot, fs = defaultFs) {
  const refs = [];
  const seen = new Set();
  for (const wranglerJsoncPath of containerWranglerConfigsForTier(tier, runnerRoot)) {
    for (const dockerfilePath of readContainerDockerfilePaths(wranglerJsoncPath, fs)) {
      if (!fs.existsSync(dockerfilePath)) {
        throw new Error(`containers[].image path not found: ${dockerfilePath} (declared in ${wranglerJsoncPath})`);
      }
      const text = fs.readFileSync(dockerfilePath, "utf8");
      for (const ref of parseDockerfileBaseImages(text)) {
        if (!seen.has(ref)) {
          seen.add(ref);
          refs.push(ref);
        }
      }
    }
  }
  return refs;
}

/** True when `--skip-image-check` was not passed and this tier actually
 *  needs container images checked (tier "1" never does). Factored out as
 *  its own pure function so the CLI wiring is directly unit-testable
 *  without spawning `dev.mjs` for every tier/flag combination. */
export function shouldCheckContainerImages(tier, skipImageCheck) {
  return (tier === "2" || tier === "full") && !skipImageCheck;
}

/** True if `docker image inspect <ref>` succeeds — the image already exists
 *  locally. Read-only, no network; never itself triggers a pull.
 * @param {string} ref
 * @param {(cmd: string, args: string[]) => void} execFileSyncImpl throws on
 *  a non-zero exit (a real `execFileSync` for real use; a stub for tests).
 */
export function isImagePresent(ref, execFileSyncImpl) {
  try {
    execFileSyncImpl("docker", ["image", "inspect", ref]);
    return true;
  } catch {
    return false;
  }
}

/** Pulls the last non-empty line of a failed `execFileSync`-shaped error's
 *  OWN error output (ANSI stripped) — stderr first, falling back to stdout
 *  only when stderr is empty, then to `err.message`. stderr-first matters
 *  for a real `docker pull`: it writes its per-layer progress ("Pulling
 *  from ...", "Downloading", ...) to STDOUT and the actual failure (e.g.
 *  "... DeadlineExceeded") to STDERR — concatenating the two and taking the
 *  last line (this section's earlier approach) would report a harmless
 *  progress line instead of the real error whenever stdout had output after
 *  stderr's own last write. This section's own copy of the same "last
 *  line" idea `extractSqliteMessage` uses for a migration failure (that one
 *  is stderr-only, wrangler's own shape), kept private here so this section
 *  never depends on that one changing shape. */
function lastErrorLine(err) {
  const chunk = (v) => (v === undefined || v === null ? "" : v.toString("utf8"));
  const lastNonEmptyLine = (text) =>
    text
      .replace(/\x1b\[[0-9;]*m/g, "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop();
  const stderrLine = lastNonEmptyLine(chunk(err?.stderr));
  if (stderrLine) return stderrLine;
  const stdoutLine = lastNonEmptyLine(chunk(err?.stdout));
  if (stdoutLine) return stdoutLine;
  return err?.message || String(err);
}

/**
 * Pulls `ref` with up to `maxAttempts` tries (default 3) and a short
 * backoff between attempts, printing one plain progress line per attempt
 * via `log` (the caller — `dev.mjs` — prefixes it `[images]`, matching this
 * repo's own per-subsystem log convention). Never throws: returns
 * `{ ok: true }` on the first successful pull, or
 * `{ ok: false, lastErrorLine }` (the failing pull's last output line) once
 * every attempt is exhausted.
 * @param {object} opts
 * @param {string} opts.ref
 * @param {(cmd: string, args: string[]) => void} opts.execFileSyncImpl
 * @param {number} [opts.maxAttempts]
 * @param {number} [opts.backoffMs] base backoff; attempt N waits `backoffMs * N`
 * @param {(line: string) => void} [opts.log]
 * @param {(ms: number) => Promise<void>} [opts.sleep] injectable so tests
 *  run instantly instead of waiting out a real backoff
 * @returns {Promise<{ ok: true } | { ok: false, lastErrorLine: string }>}
 */
export async function pullImageWithRetry({
  ref,
  execFileSyncImpl,
  maxAttempts = 3,
  backoffMs = 500,
  log = () => {},
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  let lastErr = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(`pulling ${ref} (attempt ${attempt}/${maxAttempts})...`);
    try {
      execFileSyncImpl("docker", ["pull", ref]);
      log(`pulled ${ref}`);
      return { ok: true };
    } catch (err) {
      lastErr = lastErrorLine(err);
      log(`pull failed for ${ref} (attempt ${attempt}/${maxAttempts}): ${lastErr}`);
      if (attempt < maxAttempts) await sleep(backoffMs * attempt);
    }
  }
  return { ok: false, lastErrorLine: lastErr };
}

/**
 * The whole pre-pull gate: for each ref in `refs` (in order), checks
 * `isImagePresent` and, if missing, pulls it (`pullImageWithRetry`).
 * Stops at the FIRST ref that cannot be pulled after every retry — no later
 * ref is even checked — and returns which one failed, so the caller can
 * print one clear message and exit before starting any worker. Never
 * throws.
 * @param {object} opts
 * @param {string[]} opts.refs
 * @param {(cmd: string, args: string[]) => void} opts.execFileSyncImpl
 * @param {(line: string) => void} [opts.log]
 * @param {number} [opts.maxAttempts]
 * @param {number} [opts.backoffMs]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @returns {Promise<{ ok: true } | { ok: false, ref: string, lastErrorLine: string }>}
 */
export async function ensureContainerImagesPresent({ refs, execFileSyncImpl, log = () => {}, maxAttempts = 3, backoffMs = 500, sleep }) {
  for (const ref of refs) {
    if (isImagePresent(ref, execFileSyncImpl)) {
      log(`${ref} already present`);
      continue;
    }
    log(`${ref} missing locally`);
    const result = await pullImageWithRetry({ ref, execFileSyncImpl, maxAttempts, backoffMs, log, sleep });
    if (!result.ok) {
      return { ok: false, ref, lastErrorLine: result.lastErrorLine };
    }
  }
  return { ok: true };
}

/** The one clean, actionable message `dev.mjs` prints (never a raw
 *  `execFileSync` stack trace) when {@link ensureContainerImagesPresent}
 *  stops on a ref it could not pull: which image, the Docker error's last
 *  line, and the exact `docker pull ...` command to retry by hand — plus
 *  the `--skip-image-check` escape hatch, for offline use when the images
 *  are already built. */
export function formatImagePullFailure({ ref, lastErrorLine: line }) {
  return (
    `error: could not pull required container base image ${ref}: ${line}\n` +
    `  Retry by hand: docker pull ${ref}\n` +
    `  Or skip this check entirely (e.g. offline, images already built): pass --skip-image-check.`
  );
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
        "--var",
        `O11Y_LOCAL_PUBLIC_ORIGIN:${o11yLocalPublicOrigin(ports)}`,
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

// ---------------------------------------------------------------------------
// --fresh (dev-persist task): compose.yml's minio/clickhouse now use named
// volumes (see that file's own header comment) so a plain restart KEEPS
// logs/metrics — but `workers/o11y/.wrangler/state` (the InboxWriter
// ledger/dedupe hashes/local R2 inbox) was ALREADY persisted across a
// restart before this task. `--fresh` is what wipes both together, so they
// can never diverge into "ledger says committed, but the data it points at
// is gone" (a committed key is never re-drained; a dedupe hash blocks a
// fixture replay from ever refilling the now-empty stores). See
// `resetO11yLocalState` and `detectO11yStateDivergence` below.
// ---------------------------------------------------------------------------

/** The exact `docker compose ... down` argv, with `-v` appended only when
 *  `fresh` — factored out so `dev.mjs`'s normal (kept-data) Ctrl-C teardown
 *  and `resetO11yLocalState`'s `--fresh` wipe are provably running the same
 *  command shape with only the one intentional difference, instead of two
 *  independently-typed argv literals that could silently drift apart. */
export function composeDownArgs(composeFile, { fresh = false } = {}) {
  const args = ["compose", "-f", composeFile, "down"];
  if (fresh) args.push("-v");
  return args;
}

/** One line, printed once at startup for `--tier=full` (`dev.mjs`) — the
 *  point-3 "startup mode line" the task/report needs to be able to point at
 *  verbatim. */
export function o11yDevDataModeLine(fresh) {
  return fresh ? "o11y local data: fresh" : "o11y local data: kept (MinIO/ClickHouse volumes + o11y worker state)";
}

/**
 * `--fresh`'s whole job: wipe compose's named volumes (minio/clickhouse —
 * only when `composeFile`/`composeEnv` are given) AND
 * `workers/o11y/.wrangler/state` (the InboxWriter ledger, dedupe hashes,
 * local R2 inbox objects) TOGETHER, so the two local stores this repo now
 * persists across a restart never diverge (see this section's header
 * comment). Leaves the API worker's local D1 (`workers/api/.wrangler/state`)
 * completely alone — that is `--reset-local-db`'s job, a different flag for
 * a different store.
 *
 * `composeFile`/`composeEnv` are optional: `scripts/o11y-dev.mjs` never runs
 * `docker compose` itself (see that file's own doc comment — it starts only
 * the o11y worker, not compose's minio/clickhouse), so its own `--fresh`
 * omits both and this wipes ONLY the o11y worker state. Passing them scopes
 * the `down -v` to exactly `composeEnv.COMPOSE_PROJECT_NAME` — the same
 * project-isolation every other compose call in this module already relies
 * on (compose itself enforces it; this never touches another project's, or
 * another worktree's, volumes) — and never any other compose project.
 *
 * `o11yDir` is a worktree-local path (derived from `RUNNER_ROOT`, which is
 * resolved from THIS script's own file location — see the top of this
 * module), so the state-dir removal can never reach another worktree's
 * `workers/o11y/.wrangler/state` either.
 *
 * @param {object} opts
 * @param {string} opts.o11yDir
 * @param {string} [opts.composeFile]
 * @param {NodeJS.ProcessEnv} [opts.composeEnv]
 * @param {(cmd: string, args: string[], opts?: object) => void} opts.execFileSyncImpl
 *   real callers pass `(cmd, args, o) => execFileSync(cmd, args, { cwd: RUNNER_ROOT, env: composeEnv, stdio: "inherit", ...o })`
 * @param {typeof defaultFs} [opts.fs]
 * @param {(line: string) => void} [opts.log]
 * @returns {{ composeDownRan: boolean, stateDirRemoved: boolean, stateDir: string }}
 */
export function resetO11yLocalState({ o11yDir, composeFile, composeEnv, execFileSyncImpl, fs = defaultFs, log = () => {} }) {
  let composeDownRan = false;
  if (composeFile) {
    log(`--fresh: docker compose down -v (project ${composeEnv?.COMPOSE_PROJECT_NAME ?? "?"})`);
    execFileSyncImpl("docker", composeDownArgs(composeFile, { fresh: true }), { env: composeEnv });
    composeDownRan = true;
  }
  const stateDir = path.join(o11yDir, ".wrangler", "state");
  const stateDirRemoved = fs.existsSync(stateDir);
  if (stateDirRemoved) {
    fs.rmSync(stateDir, { recursive: true, force: true });
    log(`--fresh: deleted ${stateDir} (InboxWriter ledger, dedupe hashes, local R2 inbox objects)`);
  } else {
    log(`--fresh: no ${stateDir} found — nothing to delete there`);
  }
  return { composeDownRan, stateDirRemoved, stateDir };
}

/**
 * B-I2: brings up `minio`/`clickhouse` via `docker compose ... up -d --wait`
 * for `dev.mjs --tier=full`, and — if that call itself throws — tears the
 * SAME compose project back down (`down`, never `-v`: this is a startup
 * FAILURE, not `--fresh`'s deliberate wipe, so any data either service did
 * manage to write stays) before rethrowing, instead of leaving whichever of
 * the two DID start orphaned with no teardown ever invoked.
 *
 * Why this needs its own function/test rather than just a try/catch inline
 * in `dev.mjs`: `--wait` (T1) made the `up` call genuinely able to throw on
 * a real condition (a named service's healthcheck never going green) —
 * before T1's `--wait`, the old `up -d` call essentially never threw here,
 * so nothing exercised the "up failed, orphaning containers" path. A throw
 * from `up` happens BEFORE `dev.mjs`'s own `teardownSteps.push(...)` for
 * this compose stack is ever reached (`main()`'s SIGINT/SIGTERM teardown,
 * `cleanup()`), and it propagates straight past the try/catch around the
 * readiness wait further down to `main().catch`, which only logs and
 * `process.exit(1)`s — no cleanup at all. Injectable `execFileSyncImpl`
 * mirrors {@link resetO11yLocalState}'s own pattern, so this is
 * unit-testable with a stub instead of a real `docker compose` (and,
 * before this extraction, the only way to exercise `dev.mjs`'s own
 * try/catch was a slow CLI-level `spawnSync` test that ran real `wrangler`
 * D1 migrations to get there — see `pipeline/dev-script.test.mjs`'s own
 * test for this).
 *
 * @param {object} opts
 * @param {string} opts.composeFile
 * @param {NodeJS.ProcessEnv} opts.composeEnv
 * @param {(cmd: string, args: string[], opts?: object) => void} opts.execFileSyncImpl
 *   real callers pass `(cmd, args, o) => execFileSync(cmd, args, { cwd: RUNNER_ROOT, stdio: "inherit", ...o })`
 * @param {(line: string) => void} [opts.log]
 */
export function bringUpO11yCompose({ composeFile, composeEnv, execFileSyncImpl, log = () => {} }) {
  try {
    execFileSyncImpl("docker", ["compose", "-f", composeFile, "up", "-d", "--wait", "minio", "clickhouse"], { env: composeEnv });
  } catch (err) {
    log(`startup failed (${err.message}) — tearing down minio + clickhouse (data kept)`);
    try {
      execFileSyncImpl("docker", composeDownArgs(composeFile), { env: composeEnv });
    } catch (downErr) {
      log(`teardown after startup failure also failed: ${downErr.message}`);
    }
    throw err;
  }
}

/**
 * Reads the committed-key count straight out of the InboxWriter DO's local
 * SQLite storage (wrangler's local dev backing store — confirmed against a
 * real dev session: `workers/o11y/.wrangler/state/v3/do/<name-containing-InboxWriter>/<id>.sqlite`,
 * table `_cf_KV(key, value)`, one row per DO storage key). A `done:<key>`
 * entry (`ledger.ts`'s `DONE_PREFIX`) is a key already resolved as
 * COMMITTED — the ledger considers it drained and will never look at it
 * again on its own (only a manual `POST /grafana/_o11y/reopen` moves it back
 * — see `ledger.ts`'s "Manual reopen" section). If the data those keys point
 * at (Loki chunks in MinIO) is gone, this count is exactly what makes that
 * silent — nothing else ever re-checks a `done:` key.
 *
 * Best-effort by design: this is a startup convenience check, not a
 * correctness gate. Returns 0 (never throws) if `node:sqlite` isn't
 * available, the state dir doesn't exist, or a `.sqlite` file can't be
 * opened (e.g. locked by a `wrangler dev` still shutting down) — a false
 * "0" just means the divergence warning below doesn't fire, which is the
 * safe direction to fail in for a warning-only check.
 *
 * @param {string} o11yDir
 * @param {typeof defaultFsWithReaddir} [fs]
 * @returns {Promise<number>}
 */
export async function o11yLedgerCommittedKeyCount(o11yDir, fs = defaultFsWithReaddir) {
  const doDir = path.join(o11yDir, ".wrangler", "state", "v3", "do");
  if (!fs.existsSync(doDir)) return 0;
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return 0;
  }
  let entries;
  try {
    entries = fs.readdirSync(doDir);
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries.filter((name) => name.includes("InboxWriter"))) {
    const dir = path.join(doDir, entry);
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".sqlite") || file === "metadata.sqlite") continue;
      let db;
      try {
        db = new DatabaseSync(path.join(dir, file), { readOnly: true });
        const row = db.prepare(`SELECT count(*) as c FROM _cf_KV WHERE key LIKE '${DONE_PREFIX_SQL_LIKE}'`).get();
        total += Number(row?.c ?? 0);
      } catch {
        // Not this DO's storage shape, or the file is locked/corrupt —
        // best-effort, skip it.
      } finally {
        try {
          db?.close();
        } catch {
          // already closed/never opened
        }
      }
    }
  }
  return total;
}

/** `ledger.ts`'s `DONE_PREFIX` ("done:"), as a SQL `LIKE` pattern — kept as
 *  its own named constant (rather than string-building `"done:" + "%"`
 *  inline) so it reads as the same contract value that file documents, not
 *  an ad hoc string. */
const DONE_PREFIX_SQL_LIKE = "done:%";

/** Finds the real docker volume name compose created for `volumeKey` (a
 *  short key in compose.yml's top-level `volumes:` block, e.g.
 *  `"minio-data"`) under project `composeProjectName` — via compose's own
 *  `com.docker.compose.project`/`com.docker.compose.volume` labels, never by
 *  guessing compose's own project-name sanitization/prefixing rule (which
 *  compose.yml deliberately does NOT pin down with an explicit `name:` — see
 *  that file's header comment). Returns `null` if no such volume exists
 *  (never created yet, or removed by `docker compose down -v` / a manual
 *  `docker volume rm`) — every caller here treats that the same as "no
 *  data", not as an error.
 * @param {(cmd: string, args: string[]) => Buffer|string} execFileSyncImpl
 */
export function findComposeVolume({ composeProjectName, volumeKey, execFileSyncImpl }) {
  const out = execFileSyncImpl("docker", [
    "volume",
    "ls",
    "-q",
    "--filter",
    `label=com.docker.compose.project=${composeProjectName}`,
    "--filter",
    `label=com.docker.compose.volume=${volumeKey}`,
  ])
    .toString()
    .trim();
  if (!out) return null;
  return out.split("\n")[0].trim();
}

/**
 * The divergent case the task calls out: named volumes empty (or gone —
 * `docker volume rm`, a manual `docker compose down -v` outside `--fresh`,
 * a volume that was simply never created yet) while the o11y worker's own
 * ledger still has `done:` (committed) keys pointing at data that isn't
 * there anymore. Checked in this order (cheapest first): the ledger read is
 * a local file read, so a worktree with no o11y worker state yet (the
 * common case — nothing to warn about) never touches `docker` at all.
 *
 * Deliberately checks MinIO only, not ClickHouse: `runner_events` (the
 * Analytics Engine stand-in) is written directly by the worker via
 * `RUNNER_EVENTS_CLICKHOUSE_URL` — outside the inbox ledger entirely (see
 * `normalise/points.ts#aeSink`) — so nothing about a `done:` ledger key ever
 * points at ClickHouse. MinIO is what the ledger's `done:` keys are actually
 * about: they mark an R2 inbox object as already drained into Loki, whose
 * chunks/index live in MinIO (`containers/o11y/compose.yml`'s own header
 * comment). Existence, not "is it empty", is the check: MinIO's own
 * entrypoint (MINIO_DEFAULT_BUCKETS, T1 — replaced the old `minio-init`
 * one-shot container) creates the bucket as part of every successful `up`,
 * so a volume that exists has necessarily been used — the divergent case this warns about is
 * specifically the volume being GONE while the ledger thinks otherwise, not
 * a volume that merely has less in it than the ledger expects.
 *
 * Chose "warn and point at --fresh" over an automatic ledger reopen
 * (`POST /grafana/_o11y/reopen`, `ledger.ts`'s own escape hatch) here on
 * purpose: this check runs from `dev.mjs`'s `main()` BEFORE the o11y worker
 * is even started (it decides whether to start compose first), so an
 * automatic reopen would need its own separate post-startup step, an HTTP
 * round trip, and a guessed reopen window — real complexity for a dev
 * convenience script. `--fresh` is a one-flag fix that's already needed for
 * the "someone ran `docker volume rm` by hand" case this same check exists
 * to catch; the warning below also names the manual `/grafana/_o11y/reopen`
 * route as a lighter-weight alternative once the worker is up, for anyone
 * who'd rather keep what's still in R2 (7-day retention) than start over.
 *
 * @param {object} opts
 * @param {string} opts.composeProjectName
 * @param {string} opts.o11yDir
 * @param {(cmd: string, args: string[]) => Buffer|string} opts.execFileSyncImpl
 * @param {typeof defaultFsWithReaddir} [opts.fs]
 * @param {(o11yDir: string, fs: typeof defaultFsWithReaddir) => Promise<number>} [opts.countCommittedLedgerKeys]
 * @returns {Promise<{ divergent: boolean, committedCount: number }>}
 */
export async function detectO11yStateDivergence({
  composeProjectName,
  o11yDir,
  execFileSyncImpl,
  fs = defaultFsWithReaddir,
  countCommittedLedgerKeys = o11yLedgerCommittedKeyCount,
}) {
  const committedCount = await countCommittedLedgerKeys(o11yDir, fs);
  if (committedCount === 0) return { divergent: false, committedCount: 0 };
  const minioVolume = findComposeVolume({ composeProjectName, volumeKey: "minio-data", execFileSyncImpl });
  return { divergent: minioVolume === null, committedCount };
}

/** The warning line `dev.mjs` prints when {@link detectO11yStateDivergence}
 *  finds the divergent case. */
export function formatO11yDivergenceWarning(committedCount) {
  return (
    `warning: workers/o11y's local ledger has ${committedCount} committed key(s) marking data as already drained, ` +
    `but this project's MinIO volume doesn't exist (removed by hand, e.g. \`docker volume rm\`?) — that data is gone ` +
    `and these keys will NEVER be re-drained on their own. Run \`node scripts/dev.mjs --tier=full --fresh\` to wipe ` +
    `the o11y worker state too so both stores agree again, or — to keep what R2 still has (7-day retention) instead ` +
    `of starting over — once the worker is up: POST /grafana/_o11y/reopen for the affected time window.`
  );
}
