// Unit tests for `runner/scripts/dev-lib.mjs` (the shared logic behind
// `pnpm dev`/`dev:live`/`dev:full` and `pnpm o11y:dev`) plus a small
// CLI-level test for the Docker-missing failure path and a drift test
// pinning the script's own env-var/flag surface to
// docs/run-and-deploy.md's "Run locally" section.
//
// No real `wrangler`/`docker`/`vite` is spawned here — port resolution,
// bootstrap, and migration-tracking logic are exercised directly (with a
// real temp directory for file I/O, and injected stub functions for
// anything that would otherwise shell out), following this repo's own
// `pipeline/fixtures/stub-bin` pattern for the one place a real subprocess
// is worth spawning (the Docker-missing CLI message).
//
// Run: node --experimental-strip-types --test pipeline/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  HELP_TEXT,
  parseArgs,
  resolvePorts,
  PORT_DEFAULTS,
  assertNoPortCollisions,
  bootstrapDevVars,
  o11yDevVarsPatch,
  O11Y_DEVVARS_STRIP_KEYS,
  checkDevVarsPortDrift,
  resolveDevVarsPortAdoption,
  checkO11yDevVarsStaleness,
  readDevVarsLine,
  migrationRecordPath,
  planMigrations,
  applyMigrations,
  readAppliedMigrations,
  parseMigrationTargets,
  isMigrationAlreadyApplied,
  snapshotLocalSchema,
  MigrationError,
  formatMigrationError,
  resetLocalD1,
  isDockerAvailable,
  DOCKER_NOT_RUNNING_MESSAGE,
  isRuntimeDistStale,
  buildPlan,
  planNames,
  ephemeralSecret,
  redactArgsForLog,
  possiblyLeftoverContainers,
  reportLeftoverContainers,
  SHUTDOWN_SIGNALS,
  o11yLocalPublicOrigin,
} from "../scripts/dev-lib.mjs";
// dev-persist task's own additions — a separate import statement so a
// parallel edit to the block above merges cleanly.
import {
  composeDownArgs,
  o11yDevDataModeLine,
  resetO11yLocalState,
  o11yLedgerCommittedKeyCount,
  findComposeVolume,
  detectO11yStateDivergence,
  formatO11yDivergenceWarning,
} from "../scripts/dev-lib.mjs";
// dev-prepull task's own additions — a separate import statement so a
// parallel edit to the blocks above merges cleanly.
import {
  readContainerDockerfilePaths,
  parseDockerfileBaseImages,
  containerWranglerConfigsForTier,
  collectTierBaseImages,
  shouldCheckContainerImages,
  isImagePresent,
  pullImageWithRetry,
  ensureContainerImagesPresent,
  formatImagePullFailure,
} from "../scripts/dev-lib.mjs";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_ROOT = path.join(HERE, "..");

function withTmpDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "dev-script-test-"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  let result;
  try {
    result = fn(dir);
  } catch (err) {
    cleanup();
    throw err;
  }
  if (result && typeof result.then === "function") {
    // `fn` is async — cleanup must wait for it to settle, or the temp dir
    // gets deleted out from under a still-pending write (the `finally`
    // version of this helper deletes as soon as `fn(dir)` RETURNS a
    // promise, not once it resolves).
    return result.then(
      (value) => {
        cleanup();
        return value;
      },
      (err) => {
        cleanup();
        throw err;
      },
    );
  }
  cleanup();
  return result;
}

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------

test("parseArgs: --tier=1|2|full are accepted", () => {
  assert.equal(parseArgs(["--tier=1"]).tier, "1");
  assert.equal(parseArgs(["--tier=2"]).tier, "2");
  assert.equal(parseArgs(["--tier=full"]).tier, "full");
});

test("parseArgs: an invalid --tier value is a parse error, not a silent fallback", () => {
  const { tier, errors } = parseArgs(["--tier=3"]);
  assert.equal(tier, null);
  assert.ok(errors.some((e) => e.includes("--tier")));
});

test("parseArgs: --tier is required unless --help is passed", () => {
  const noTier = parseArgs([]);
  assert.ok(noTier.errors.some((e) => e.includes("required")));
  const help = parseArgs(["--help"]);
  assert.equal(help.help, true);
  assert.deepEqual(help.errors, []);
});

test("parseArgs: -h is recognized the same as --help", () => {
  assert.equal(parseArgs(["-h"]).help, true);
});

test("parseArgs: --replay is only valid with --tier=full", () => {
  assert.deepEqual(parseArgs(["--tier=full", "--replay"]).errors, []);
  const withTier1 = parseArgs(["--tier=1", "--replay"]);
  assert.ok(withTier1.errors.some((e) => e.includes("--replay")));
});

test("parseArgs: an unrecognized flag is an error", () => {
  const { errors } = parseArgs(["--tier=1", "--bogus"]);
  assert.ok(errors.some((e) => e.includes("--bogus")));
});

// ---------------------------------------------------------------------------
// port resolution
// ---------------------------------------------------------------------------

test("resolvePorts: tier=1 resolves only AUTHORING_DEV_PORT, at its documented default", () => {
  const ports = resolvePorts("1", {});
  assert.deepEqual(ports, { AUTHORING_DEV_PORT: PORT_DEFAULTS.AUTHORING_DEV_PORT });
});

test("resolvePorts: env overrides win over defaults", () => {
  const ports = resolvePorts("2", { API_DEV_PORT: "6250" });
  assert.equal(ports.API_DEV_PORT, 6250);
  assert.equal(ports.AUTHORING_DEV_PORT, PORT_DEFAULTS.AUTHORING_DEV_PORT);
});

test("resolvePorts: tier=full resolves a distinct inspector port for both api and o11y", () => {
  const ports = resolvePorts("full", {});
  assert.notEqual(ports.API_DEV_INSPECTOR_PORT, ports.O11Y_DEV_INSPECTOR_PORT);
  assert.notEqual(ports.API_DEV_INSPECTOR_PORT, ports.API_DEV_PORT);
  assert.notEqual(ports.O11Y_DEV_INSPECTOR_PORT, ports.O11Y_DEV_PORT);
});

test("resolvePorts: throws on a port collision (two keys resolving to the same number)", () => {
  assert.throws(
    () => resolvePorts("full", { API_DEV_PORT: "6200", O11Y_DEV_PORT: "6200" }),
    /collision/,
  );
});

test("resolvePorts: throws on a non-numeric port override", () => {
  assert.throws(() => resolvePorts("1", { AUTHORING_DEV_PORT: "not-a-port" }), /invalid port/);
});

// ---------------------------------------------------------------------------
// .dev.vars bootstrap
// ---------------------------------------------------------------------------

test("bootstrapDevVars: copies the example when .dev.vars is absent", () => {
  withTmpDir((dir) => {
    const examplePath = path.join(dir, ".dev.vars.example");
    const devVarsPath = path.join(dir, ".dev.vars");
    writeFileSync(examplePath, "DEV_AUTH_EMAIL=\"dev@handsontable.com\"\nPREVIEW_HOST=\"localhost:8787\"\n");
    const result = bootstrapDevVars({ examplePath, devVarsPath });
    assert.equal(result.created, true);
    assert.equal(readFileSync(devVarsPath, "utf8"), readFileSync(examplePath, "utf8"));
  });
});

test("bootstrapDevVars: never overwrites an existing .dev.vars", () => {
  withTmpDir((dir) => {
    const examplePath = path.join(dir, ".dev.vars.example");
    const devVarsPath = path.join(dir, ".dev.vars");
    writeFileSync(examplePath, "DEV_AUTH_EMAIL=\"dev@handsontable.com\"\n");
    writeFileSync(devVarsPath, "DEV_AUTH_EMAIL=\"someone-else@handsontable.com\"\n# my own edits\n");
    const result = bootstrapDevVars({ examplePath, devVarsPath });
    assert.equal(result.created, false);
    assert.equal(readFileSync(devVarsPath, "utf8"), "DEV_AUTH_EMAIL=\"someone-else@handsontable.com\"\n# my own edits\n");
  });
});

test("bootstrapDevVars: throws a clear error when the example itself is missing", () => {
  withTmpDir((dir) => {
    const examplePath = path.join(dir, ".dev.vars.example");
    const devVarsPath = path.join(dir, ".dev.vars");
    assert.throws(() => bootstrapDevVars({ examplePath, devVarsPath }), /missing/);
  });
});

test("bootstrapDevVars: patch fills in an empty placeholder line, only on fresh creation", () => {
  withTmpDir((dir) => {
    const examplePath = path.join(dir, ".dev.vars.example");
    const devVarsPath = path.join(dir, ".dev.vars");
    writeFileSync(examplePath, "DEV_ADMIN=\nO11Y_EXPORT_SECRET=\nO11Y_ENV=local\n");
    const result = bootstrapDevVars({
      examplePath,
      devVarsPath,
      patch: { DEV_ADMIN: "dev@handsontable.com" },
    });
    assert.equal(result.created, true);
    assert.deepEqual(result.patched, ["DEV_ADMIN"]);
    const text = readFileSync(devVarsPath, "utf8");
    assert.match(text, /^DEV_ADMIN=dev@handsontable\.com$/m);
    // A secret this task must never auto-create stays untouched (empty).
    assert.match(text, /^O11Y_EXPORT_SECRET=\s*$/m);
  });
});

test("bootstrapDevVars: patch never touches a NON-empty line (a real value already there)", () => {
  withTmpDir((dir) => {
    const examplePath = path.join(dir, ".dev.vars.example");
    const devVarsPath = path.join(dir, ".dev.vars");
    writeFileSync(examplePath, "DEV_ADMIN=someone@handsontable.com\n");
    const result = bootstrapDevVars({ examplePath, devVarsPath, patch: { DEV_ADMIN: "dev@handsontable.com" } });
    assert.deepEqual(result.patched, []);
    assert.match(readFileSync(devVarsPath, "utf8"), /^DEV_ADMIN=someone@handsontable\.com$/m);
  });
});

test("bootstrapDevVars: stripKeys removes an empty declared line so a later --var isn't silently shadowed", () => {
  withTmpDir((dir) => {
    const examplePath = path.join(dir, ".dev.vars.example");
    const devVarsPath = path.join(dir, ".dev.vars");
    writeFileSync(examplePath, "O11Y_SESSION_SECRET=\nO11Y_ENV=local\n");
    const result = bootstrapDevVars({ examplePath, devVarsPath, stripKeys: ["O11Y_SESSION_SECRET"] });
    assert.deepEqual(result.stripped, ["O11Y_SESSION_SECRET"]);
    const text = readFileSync(devVarsPath, "utf8");
    assert.doesNotMatch(text, /O11Y_SESSION_SECRET/);
    assert.match(text, /O11Y_ENV=local/);
  });
});

test("bootstrapDevVars: stripKeys is a no-op when the key isn't declared in the example at all", () => {
  withTmpDir((dir) => {
    const examplePath = path.join(dir, ".dev.vars.example");
    const devVarsPath = path.join(dir, ".dev.vars");
    writeFileSync(examplePath, "O11Y_ENV=local\n");
    const result = bootstrapDevVars({ examplePath, devVarsPath, stripKeys: ["O11Y_SESSION_SECRET"] });
    assert.deepEqual(result.stripped, []);
    assert.equal(readFileSync(devVarsPath, "utf8"), "O11Y_ENV=local\n");
  });
});

test("o11yDevVarsPatch: never includes O11Y_EXPORT_SECRET, SENTRY_HOOK_SECRET, or O11Y_SESSION_SECRET (never auto-create a real secret)", () => {
  const patch = o11yDevVarsPatch({ O11Y_SLACK_CAPTURE_PORT: 4210 });
  assert.equal("O11Y_EXPORT_SECRET" in patch, false);
  assert.equal("SENTRY_HOOK_SECRET" in patch, false);
  assert.equal("O11Y_SESSION_SECRET" in patch, false);
});

test("readDevVarsLine / checkDevVarsPortDrift: detects a port mismatch and reports none when it matches", () => {
  withTmpDir((dir) => {
    const devVarsPath = path.join(dir, ".dev.vars");
    writeFileSync(devVarsPath, 'PREVIEW_HOST="localhost:8787"\n');
    assert.equal(checkDevVarsPortDrift(devVarsPath, "PREVIEW_HOST", 8787), null);
    const drift = checkDevVarsPortDrift(devVarsPath, "PREVIEW_HOST", 6250);
    assert.match(drift, /8787/);
    assert.match(drift, /6250/);
  });
});

test("resolveDevVarsPortAdoption: PREVIEW_HOST port is ADOPTED when API_DEV_PORT was not explicitly set (bug 2's fix)", () => {
  withTmpDir((dir) => {
    const devVarsPath = path.join(dir, ".dev.vars");
    // The user's exact real .dev.vars: PREVIEW_HOST pinned to 8799 while
    // this run's own default/resolved port is 8787.
    writeFileSync(devVarsPath, 'PREVIEW_HOST="localhost:8799"\n');

    const adoption = resolveDevVarsPortAdoption({ devVarsPath, key: "PREVIEW_HOST", currentPort: 8787, explicit: false });
    assert.equal(adoption.port, 8799, "the .dev.vars port is adopted, since .dev.vars always wins anyway");
    assert.equal(adoption.adopted, true);
    assert.match(adoption.message, /8799/);
    assert.match(adoption.message, /adopting/);
  });
});

test("resolveDevVarsPortAdoption: WARNS instead (does not override) when API_DEV_PORT was explicitly set and conflicts", () => {
  withTmpDir((dir) => {
    const devVarsPath = path.join(dir, ".dev.vars");
    writeFileSync(devVarsPath, 'PREVIEW_HOST="localhost:8799"\n');

    const adoption = resolveDevVarsPortAdoption({ devVarsPath, key: "PREVIEW_HOST", currentPort: 6450, explicit: true });
    assert.equal(adoption.port, 6450, "an explicit override is never silently discarded");
    assert.equal(adoption.adopted, false);
    assert.match(adoption.message, /8799/);
    assert.match(adoption.message, /6450/);
  });
});

test("resolveDevVarsPortAdoption: no message and no change when the port already matches, or the key is undeclared", () => {
  withTmpDir((dir) => {
    const devVarsPath = path.join(dir, ".dev.vars");
    writeFileSync(devVarsPath, 'PREVIEW_HOST="localhost:8787"\n');
    assert.deepEqual(resolveDevVarsPortAdoption({ devVarsPath, key: "PREVIEW_HOST", currentPort: 8787, explicit: false }), {
      port: 8787,
      adopted: false,
      message: null,
    });
    assert.deepEqual(resolveDevVarsPortAdoption({ devVarsPath, key: "SLACK_WEBHOOK_URL", currentPort: 4210, explicit: false }), {
      port: 4210,
      adopted: false,
      message: null,
    });
  });
});

test("assertNoPortCollisions: throws for a duplicate port value, passes for all-distinct ports", () => {
  assert.doesNotThrow(() => assertNoPortCollisions({ A: 1, B: 2 }));
  assert.throws(() => assertNoPortCollisions({ A: 1, B: 1 }), /port collision/);
});

test("checkO11yDevVarsStaleness (NB8): warns when a pre-existing .dev.vars declares DEV_ADMIN or O11Y_SESSION_SECRET empty", () => {
  withTmpDir((dir) => {
    const devVarsPath = path.join(dir, ".dev.vars");

    // A healthy, freshly-bootstrapped file: no warnings.
    writeFileSync(devVarsPath, "O11Y_ENV=local\nDEV_ADMIN=dev@handsontable.com\n");
    assert.deepEqual(checkO11yDevVarsStaleness(devVarsPath), []);

    // The exact NB8 shape: an old .dev.vars from before this task's
    // DEV_ADMIN/O11Y_SESSION_SECRET handling existed, both declared empty.
    writeFileSync(devVarsPath, "O11Y_ENV=local\nDEV_ADMIN=\nO11Y_SESSION_SECRET=\n");
    const warnings = checkO11yDevVarsStaleness(devVarsPath);
    assert.equal(warnings.length, 2, "both the bypass and the secret must each get their own warning");
    assert.ok(warnings.some((w) => w.includes("DEV_ADMIN")));
    assert.ok(warnings.some((w) => w.includes("O11Y_SESSION_SECRET")));

    // O11Y_SESSION_SECRET simply ABSENT (the normal, freshly-stripped case)
    // must never warn — only DECLARED-but-empty is the problem.
    writeFileSync(devVarsPath, "O11Y_ENV=local\nDEV_ADMIN=dev@handsontable.com\n");
    assert.deepEqual(checkO11yDevVarsStaleness(devVarsPath), []);
  });
});

test("ephemeralSecret: never the same value twice, and never written by bootstrapDevVars", () => {
  assert.notEqual(ephemeralSecret(), ephemeralSecret());
  assert.equal(ephemeralSecret().length, 64); // 32 bytes, hex
});

test("redactArgsForLog (NB6): O11Y_SESSION_SECRET's --var value is redacted for dev.mjs's own log line", () => {
  const secret = ephemeralSecret();
  const args = [
    "dev",
    "--port",
    "4200",
    "--var",
    `O11Y_SESSION_SECRET:${secret}`,
    "--var",
    "O11Y_LOCAL_MINIO_PORT:9000",
  ];
  const redacted = redactArgsForLog(args);
  assert.ok(!redacted.join(" ").includes(secret), "the secret value must never appear in the redacted args");
  assert.deepEqual(redacted, ["dev", "--port", "4200", "--var", "O11Y_SESSION_SECRET:<redacted>", "--var", "O11Y_LOCAL_MINIO_PORT:9000"]);
  // The real spawn() args are untouched — only a copy for display is redacted.
  assert.ok(args.join(" ").includes(secret), "the original args array passed to spawn() must be unaffected");
});

// ---------------------------------------------------------------------------
// migration tracking
// ---------------------------------------------------------------------------

function makeMigrationsDir(dir, files) {
  const migrationsDir = path.join(dir, "migrations");
  mkdirSync(migrationsDir);
  for (const f of files) writeFileSync(path.join(migrationsDir, f), "-- sql\n");
  return migrationsDir;
}

test("planMigrations: with no record, every file on disk is pending", () => {
  withTmpDir((dir) => {
    const migrationsDir = makeMigrationsDir(dir, ["0001_init.sql", "0002_more.sql"]);
    const recordPath = path.join(dir, "record.json");
    const plan = planMigrations({ migrationsDir, recordPath });
    assert.deepEqual(plan.pending, ["0001_init.sql", "0002_more.sql"]);
  });
});

test("applyMigrations: a second run applies nothing once the first run recorded every file", async () => {
  await withTmpDir(async (dir) => {
    const migrationsDir = makeMigrationsDir(dir, ["0001_init.sql", "0002_more.sql", "0003_third.sql"]);
    const recordPath = migrationRecordPath(dir);
    const calls = [];
    const run = async (args) => {
      calls.push(args);
    };

    const first = await applyMigrations({ migrationsDir, recordPath, dbName: "handsontable-demos", run });
    assert.deepEqual(first.applied, ["0001_init.sql", "0002_more.sql", "0003_third.sql"]);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0], ["d1", "execute", "handsontable-demos", "--local", "--file=migrations/0001_init.sql", "-y"]);

    const second = await applyMigrations({ migrationsDir, recordPath, dbName: "handsontable-demos", run });
    assert.deepEqual(second.applied, []);
    assert.equal(calls.length, 3, "no new wrangler calls on the second run");
  });
});

test("applyMigrations: a new migration file added after the first run is the only one applied on the second run", async () => {
  await withTmpDir(async (dir) => {
    const migrationsDir = makeMigrationsDir(dir, ["0001_init.sql"]);
    const recordPath = migrationRecordPath(dir);
    const calls = [];
    const run = async (args) => {
      calls.push(args);
    };
    await applyMigrations({ migrationsDir, recordPath, dbName: "handsontable-demos", run });

    writeFileSync(path.join(migrationsDir, "0002_new.sql"), "-- sql\n");
    const second = await applyMigrations({ migrationsDir, recordPath, dbName: "handsontable-demos", run });
    assert.deepEqual(second.applied, ["0002_new.sql"]);
  });
});

test("applyMigrations: records each file as it succeeds, so a failure partway through doesn't lose earlier progress", async () => {
  await withTmpDir(async (dir) => {
    const migrationsDir = makeMigrationsDir(dir, ["0001_init.sql", "0002_boom.sql"]);
    const recordPath = migrationRecordPath(dir);
    const run = async (args) => {
      if (args.includes("--file=migrations/0002_boom.sql")) throw new Error("simulated d1 failure");
    };
    await assert.rejects(() => applyMigrations({ migrationsDir, recordPath, dbName: "handsontable-demos", run }));
    const plan = planMigrations({ migrationsDir, recordPath });
    assert.deepEqual(plan.applied, ["0001_init.sql"]);
    assert.deepEqual(plan.pending, ["0002_boom.sql"]);
  });
});

// ---------------------------------------------------------------------------
// migration schema probe — adopting a pre-existing local D1 with no record
// (the N1 bug: a hand-migrated local D1, no dev-migrations-applied.json,
// re-applying from 0001 dies on 0003's non-idempotent `ALTER TABLE ... ADD
// COLUMN` with a raw `duplicate column name` failure)
// ---------------------------------------------------------------------------

/** A stub `query` (the injectable `applyMigrations`/`snapshotLocalSchema`
 *  takes in place of a real `wrangler d1 execute ... --json`) backed by an
 *  in-memory {tables: Set<string>, indexes: Set<string>, columns: {[table]:
 *  Set<string>}} — enough to answer both queries `snapshotLocalSchema`
 *  issues (`sqlite_master`, and `PRAGMA table_info(<table>)`), shaped exactly
 *  like wrangler's own `--json` output (an array with one `{results}` entry). */
function stubD1Query(state) {
  return async (args) => {
    const command = args[args.indexOf("--command") + 1];
    if (command.includes("sqlite_master")) {
      const results = [
        ...[...state.tables].map((name) => ({ type: "table", name })),
        ...[...state.indexes].map((name) => ({ type: "index", name })),
      ];
      return JSON.stringify([{ results, success: true, meta: { duration: 0 } }]);
    }
    const m = /PRAGMA table_info\((\w+)\)/.exec(command);
    if (m) {
      const cols = state.columns[m[1]] ?? new Set();
      return JSON.stringify([{ results: [...cols].map((name) => ({ name })), success: true, meta: { duration: 0 } }]);
    }
    throw new Error(`stubD1Query: unrecognized --command: ${command}`);
  };
}

test("parseMigrationTargets: CREATE TABLE / CREATE INDEX / ALTER TABLE ADD COLUMN are checkable; any other statement makes the file non-checkable", () => {
  assert.deepEqual(parseMigrationTargets("CREATE TABLE IF NOT EXISTS demos (id TEXT);\nCREATE INDEX IF NOT EXISTS idx_x ON demos(id);"), {
    checkable: true,
    targets: [
      { type: "table", name: "demos" },
      { type: "index", name: "idx_x" },
    ],
  });
  assert.deepEqual(parseMigrationTargets("ALTER TABLE demos ADD COLUMN foo TEXT;"), {
    checkable: true,
    targets: [{ type: "column", table: "demos", name: "foo" }],
  });
  assert.deepEqual(parseMigrationTargets("ALTER TABLE demos ADD foo TEXT;"), {
    checkable: true,
    targets: [{ type: "column", table: "demos", name: "foo" }],
  });
  // DROP INDEX (0002_buildkey_nonunique.sql's real shape) is not a
  // recognized "additive, checkable" statement — the whole file must fall
  // through to "always run it" rather than risk skipping the DROP because
  // the CREATE INDEX that follows it happens to already exist.
  assert.deepEqual(parseMigrationTargets("DROP INDEX IF EXISTS idx_x;\nCREATE INDEX IF NOT EXISTS idx_x ON demos(id);"), {
    checkable: false,
    targets: [],
  });
  // Empty file: never a vacuous "already applied".
  assert.deepEqual(parseMigrationTargets("-- just a comment\n"), { checkable: false, targets: [] });
});

test("parseMigrationTargets: pinned against every real workers/api/migrations/*.sql file", () => {
  const migrationsDir = path.join(RUNNER_ROOT, "workers", "api", "migrations");
  const files = readFileSync(path.join(migrationsDir, "0001_init.sql"), "utf8"); // sanity: file exists
  assert.ok(files.length > 0);

  const read = (name) => readFileSync(path.join(migrationsDir, name), "utf8");
  assert.deepEqual(parseMigrationTargets(read("0001_init.sql")), {
    checkable: true,
    targets: [
      { type: "table", name: "demos" },
      { type: "index", name: "idx_demos_framework" },
      { type: "index", name: "idx_demos_created_by" },
      { type: "index", name: "idx_demos_forked_from" },
      { type: "index", name: "idx_demos_buildkey" },
      { type: "table", name: "build_cache" },
    ],
  });
  assert.equal(parseMigrationTargets(read("0002_buildkey_nonunique.sql")).checkable, false, "0002's DROP INDEX must not be treated as checkable");
  assert.deepEqual(parseMigrationTargets(read("0003_cost_ledger.sql")), {
    checkable: true,
    targets: [
      { type: "table", name: "cost_ledger" },
      { type: "index", name: "idx_cost_ledger_day" },
      { type: "table", name: "usage_daily" },
      { type: "index", name: "idx_usage_daily_day" },
      { type: "column", table: "demos", name: "artifacts_purged_at" },
    ],
  });
  assert.deepEqual(parseMigrationTargets(read("0007_build_status.sql")), {
    checkable: true,
    targets: [
      { type: "column", table: "demos", name: "build_status" },
      { type: "column", table: "demos", name: "build_error" },
    ],
  });
  // 0009_example_daily_downloaded.sql (R1-followups): the second real
  // ALTER TABLE ... ADD COLUMN file in this migrations dir (after 0003/0007,
  // both against `demos`) — pinned explicitly, not just swept into the
  // "checkable with >=1 target" loop below, because it is the one that
  // exercises a table OTHER than `demos` going through the same adoption
  // path (see the `applyMigrations` adoption test further down).
  assert.deepEqual(parseMigrationTargets(read("0009_example_daily_downloaded.sql")), {
    checkable: true,
    targets: [{ type: "column", table: "example_daily", name: "downloaded" }],
  });
  // Every file must at least parse without throwing and either be checkable
  // with >=1 target, or explicitly non-checkable — never checkable with zero
  // targets (that would be silently skippable).
  for (const name of ["0004_settings_and_analytics.sql", "0005_profiles.sql", "0006_api_tokens.sql", "0008_example_daily.sql"]) {
    const parsed = parseMigrationTargets(read(name));
    assert.ok(parsed.checkable, `${name} expected checkable`);
    assert.ok(parsed.targets.length > 0, `${name} expected at least one target`);
  }
});

test("isMigrationAlreadyApplied: true only when every target is present; false for an empty/unchecked target list", () => {
  const snapshot = { tableNames: new Set(["demos"]), indexNames: new Set(["idx_x"]), columns: { demos: new Set(["id", "artifacts_purged_at"]) } };
  assert.equal(isMigrationAlreadyApplied([{ type: "table", name: "demos" }], snapshot), true);
  assert.equal(isMigrationAlreadyApplied([{ type: "column", table: "demos", name: "artifacts_purged_at" }], snapshot), true);
  assert.equal(isMigrationAlreadyApplied([{ type: "column", table: "demos", name: "build_status" }], snapshot), false);
  assert.equal(isMigrationAlreadyApplied([{ type: "table", name: "demos" }, { type: "table", name: "nope" }], snapshot), false);
  assert.equal(isMigrationAlreadyApplied([], snapshot), false, "an empty target list must never read as already applied");
});

test("snapshotLocalSchema: one sqlite_master query plus one PRAGMA per requested table, parsed from wrangler --json shape", async () => {
  const calls = [];
  const query = async (args) => {
    calls.push(args);
    return stubD1Query({ tables: new Set(["demos"]), indexes: new Set(["idx_x"]), columns: { demos: new Set(["id", "artifacts_purged_at"]) } })(args);
  };
  const snapshot = await snapshotLocalSchema({ dbName: "handsontable-demos", tables: ["demos"], query });
  assert.deepEqual([...snapshot.tableNames], ["demos"]);
  assert.deepEqual([...snapshot.indexNames], ["idx_x"]);
  assert.deepEqual([...snapshot.columns.demos].sort(), ["artifacts_purged_at", "id"]);
  assert.equal(calls.length, 2, "one sqlite_master query + one PRAGMA for the one requested table");
});

test("applyMigrations: a hand-migrated local D1 with NO record — every pending file whose targets already exist is adopted, not re-applied (the N1 repro)", async () => {
  await withTmpDir(async (dir) => {
    const migrationsDir = path.join(dir, "migrations");
    mkdirSync(migrationsDir);
    writeFileSync(path.join(migrationsDir, "0001_init.sql"), "CREATE TABLE IF NOT EXISTS demos (id TEXT PRIMARY KEY);\n");
    writeFileSync(
      path.join(migrationsDir, "0003_cost_ledger.sql"),
      "CREATE TABLE IF NOT EXISTS cost_ledger (day TEXT);\nALTER TABLE demos ADD COLUMN artifacts_purged_at TEXT;\n",
    );
    writeFileSync(path.join(migrationsDir, "0007_build_status.sql"), "ALTER TABLE demos ADD COLUMN build_status TEXT;\n");
    const recordPath = migrationRecordPath(dir); // no record file at all — the exact bug precondition

    const state = {
      tables: new Set(["demos", "cost_ledger"]), // 0001, 0003's table: already there
      indexes: new Set(),
      columns: { demos: new Set(["id", "artifacts_purged_at"]) }, // 0003's column exists; 0007's build_status does NOT
    };
    const runCalls = [];
    const run = async (args) => {
      runCalls.push(args);
      // Applying 0007 for real adds the column this run's own snapshot didn't have yet.
      if (args.includes("--file=migrations/0007_build_status.sql")) state.columns.demos.add("build_status");
    };
    const query = stubD1Query(state);

    const result = await applyMigrations({ migrationsDir, recordPath, dbName: "handsontable-demos", run, query, log: () => {} });

    assert.deepEqual(result.adopted, ["0001_init.sql", "0003_cost_ledger.sql"], "both fully-pre-existing files are adopted, not re-run");
    assert.deepEqual(result.applied, ["0007_build_status.sql"], "the file whose column is genuinely missing still runs for real");
    assert.deepEqual(runCalls, [["d1", "execute", "handsontable-demos", "--local", "--file=migrations/0007_build_status.sql", "-y"]]);
    assert.deepEqual(readAppliedMigrations(recordPath), ["0001_init.sql", "0003_cost_ledger.sql", "0007_build_status.sql"].sort());
  });
});

// R1-followups: the same N1 adoption path, exercised against the real
// 0008/0009_example_daily_downloaded.sql pair — a table (`example_daily`)
// that is NOT `demos`, proving `applyMigrations`' `alterTables` derivation
// (COMMON.md's "verify with a test only" instruction for dev-lib.mjs's
// ADD COLUMN handling) is not hardcoded to the one table every earlier
// migration in this dir happens to alter.
test("applyMigrations: a local D1 that already has example_daily.downloaded (dev stack migrated by hand) adopts 0009 instead of re-running it", async () => {
  await withTmpDir(async (dir) => {
    const migrationsDir = path.join(dir, "migrations");
    mkdirSync(migrationsDir);
    const realMigrationsDir = path.join(RUNNER_ROOT, "workers", "api", "migrations");
    writeFileSync(
      path.join(migrationsDir, "0008_example_daily.sql"),
      readFileSync(path.join(realMigrationsDir, "0008_example_daily.sql"), "utf8"),
    );
    writeFileSync(
      path.join(migrationsDir, "0009_example_daily_downloaded.sql"),
      readFileSync(path.join(realMigrationsDir, "0009_example_daily_downloaded.sql"), "utf8"),
    );
    // 0008 was recorded as applied by an earlier run; 0009 is pending, and a
    // developer's local D1 already carries the `downloaded` column (e.g.
    // adopted by hand, or applied once before the applied-migrations record
    // existed — the same N1 class of drift the adjacent `demos` test above
    // covers).
    mkdirSync(path.dirname(migrationRecordPath(dir)), { recursive: true });
    writeFileSync(migrationRecordPath(dir), JSON.stringify(["0008_example_daily.sql"]));

    const state = {
      tables: new Set(["example_daily"]),
      indexes: new Set(["idx_example_daily_day"]),
      columns: { example_daily: new Set(["day", "kind", "ref", "area", "framework", "ht_major", "opens", "engaged", "forked", "saved", "shared", "downloaded"]) },
    };
    const runCalls = [];
    const run = async (args) => runCalls.push(args);
    const query = stubD1Query(state);

    const result = await applyMigrations({ migrationsDir, recordPath: migrationRecordPath(dir), dbName: "handsontable-demos", run, query, log: () => {} });

    assert.deepEqual(result.adopted, ["0009_example_daily_downloaded.sql"], "the column already exists — 0009 must be adopted, not re-run");
    assert.deepEqual(result.applied, [], "never a real d1 execute for a file whose only target is already present");
    assert.deepEqual(runCalls, [], "no wrangler d1 execute call at all — this is what avoids the 'duplicate column name' failure");
    assert.deepEqual(readAppliedMigrations(migrationRecordPath(dir)), ["0008_example_daily.sql", "0009_example_daily_downloaded.sql"].sort());
  });
});

test("applyMigrations: without `query`, behavior is unchanged — every pending file is always re-run (no probing)", async () => {
  await withTmpDir(async (dir) => {
    const migrationsDir = makeMigrationsDir(dir, ["0001_init.sql"]);
    const recordPath = migrationRecordPath(dir);
    const calls = [];
    const run = async (args) => calls.push(args);
    const result = await applyMigrations({ migrationsDir, recordPath, dbName: "handsontable-demos", run });
    assert.deepEqual(result.applied, ["0001_init.sql"]);
    assert.deepEqual(result.adopted, []);
    assert.equal(calls.length, 1);
  });
});

test("applyMigrations: a genuinely failing migration throws a MigrationError with the file and the SQLite message, never swallowed as adopted", async () => {
  await withTmpDir(async (dir) => {
    const migrationsDir = makeMigrationsDir(dir, ["0001_init.sql", "0002_boom.sql"]);
    const recordPath = migrationRecordPath(dir);
    // Shaped exactly like a real execFileSync failure: wrangler's ANSI-wrapped
    // "duplicate column name" text on stderr (captured against wrangler 4.108).
    const stderr = Buffer.from(
      "\u001b[31m✘ \u001b[41;31m[\u001b[41;97mERROR\u001b[41;31m]\u001b[0m \u001b[1mduplicate column name: artifacts_purged_at: SQLITE_ERROR\u001b[0m\n",
    );
    const run = async (args) => {
      if (args.includes("--file=migrations/0002_boom.sql")) {
        const err = new Error("Command failed");
        err.stderr = stderr;
        err.stdout = Buffer.from("");
        err.status = 1;
        throw err;
      }
    };
    await assert.rejects(
      () => applyMigrations({ migrationsDir, recordPath, dbName: "handsontable-demos", run, log: () => {} }),
      (err) => {
        assert.ok(err instanceof MigrationError);
        assert.equal(err.file, "0002_boom.sql");
        assert.equal(err.sqliteMessage, "duplicate column name: artifacts_purged_at: SQLITE_ERROR");
        assert.equal(err.recordPath, recordPath);
        return true;
      },
    );
    // Not swallowed: 0002 must NOT be recorded as applied/adopted.
    assert.deepEqual(readAppliedMigrations(recordPath), ["0001_init.sql"]);
  });
});

test("applyMigrations: a genuinely DIFFERENT SQL error is reported as itself, not misread as a duplicate-column adoption case", async () => {
  await withTmpDir(async (dir) => {
    const migrationsDir = makeMigrationsDir(dir, ["0001_typo.sql"]);
    const recordPath = migrationRecordPath(dir);
    const run = async () => {
      const err = new Error("Command failed");
      err.stderr = Buffer.from("\u001b[31m✘ \u001b[41;31m[\u001b[41;97mERROR\u001b[41;31m]\u001b[0m \u001b[1mno such table: nope: SQLITE_ERROR\u001b[0m\n");
      err.stdout = Buffer.from("");
      throw err;
    };
    await assert.rejects(
      () => applyMigrations({ migrationsDir, recordPath, dbName: "handsontable-demos", run, log: () => {} }),
      (err) => {
        assert.equal(err.sqliteMessage, "no such table: nope: SQLITE_ERROR");
        return true;
      },
    );
  });
});

test("formatMigrationError: one clean line naming the file, the SQLite message, the record path, and --reset-local-db — never a raw stack trace", () => {
  const err = new MigrationError({
    file: "0003_cost_ledger.sql",
    sqliteMessage: "duplicate column name: artifacts_purged_at: SQLITE_ERROR",
    recordPath: "/x/workers/api/.wrangler/state/dev-migrations-applied.json",
    action: "applying",
  });
  const formatted = formatMigrationError(err);
  assert.match(formatted, /^error:/);
  assert.match(formatted, /0003_cost_ledger\.sql/);
  assert.match(formatted, /duplicate column name: artifacts_purged_at: SQLITE_ERROR/);
  assert.match(formatted, /dev-migrations-applied\.json/);
  assert.match(formatted, /--reset-local-db/);
  assert.ok(!formatted.includes("\n    at "), "must not include a stack-trace-shaped line");
});

test("resetLocalD1: deletes local D1 state and the applied-migrations record, and logs what it deleted", () => {
  withTmpDir((dir) => {
    const apiDir = path.join(dir, "workers", "api");
    const stateDir = path.join(apiDir, ".wrangler", "state", "v3", "d1");
    const recordPath = migrationRecordPath(apiDir);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, "some.sqlite"), "fake");
    mkdirSync(path.dirname(recordPath), { recursive: true });
    writeFileSync(recordPath, "[]\n");

    const lines = [];
    resetLocalD1(apiDir, undefined, (l) => lines.push(l));

    assert.equal(existsSync(stateDir), false);
    assert.equal(existsSync(recordPath), false);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /--reset-local-db/);
    assert.match(lines[0], /deleted/);

    // Second call, nothing left: says so, doesn't throw.
    const lines2 = [];
    resetLocalD1(apiDir, undefined, (l) => lines2.push(l));
    assert.match(lines2[0], /nothing to delete/);
  });
});

// ---------------------------------------------------------------------------
// Docker
// ---------------------------------------------------------------------------

test("isDockerAvailable: true when `docker info` succeeds", () => {
  assert.equal(isDockerAvailable(() => {}), true);
});

test("isDockerAvailable: false when `docker info` throws", () => {
  assert.equal(
    isDockerAvailable(() => {
      throw new Error("Cannot connect to the Docker daemon");
    }),
    false,
  );
});

test("DOCKER_NOT_RUNNING_MESSAGE: names the fix (start Docker), not just the symptom", () => {
  assert.match(DOCKER_NOT_RUNNING_MESSAGE, /docker info/);
  assert.match(DOCKER_NOT_RUNNING_MESSAGE, /Start Docker/);
});

test("CLI: `dev.mjs --tier=2` fails fast with the Docker message when `docker info` fails, before spawning anything else", () => {
  const stubBinDir = path.join(HERE, "fixtures", "stub-bin");
  const devScript = path.join(RUNNER_ROOT, "scripts", "dev.mjs");
  const result = spawnSync(process.execPath, [devScript, "--tier=2"], {
    cwd: RUNNER_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${stubBinDir}:${process.env.PATH}`,
      STUB_DOCKER_MODE: "fail",
    },
  });
  assert.notEqual(result.status, 0);
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /docker info/);
  assert.match(output, /Start Docker/);
});

// ---------------------------------------------------------------------------
// Container base-image pre-pull (dev-prepull task)
// ---------------------------------------------------------------------------

test("parseDockerfileBaseImages: single-stage FROM", () => {
  const dockerfile = `FROM docker.io/cloudflare/sandbox:0.12.3\nWORKDIR /app\n`;
  assert.deepEqual(parseDockerfileBaseImages(dockerfile), ["docker.io/cloudflare/sandbox:0.12.3"]);
});

test("parseDockerfileBaseImages: multi-stage build — a later FROM referencing an earlier stage's alias is excluded", () => {
  const dockerfile = [
    "FROM golang:1.20 AS build",
    "RUN go build ./...",
    "FROM build AS test",
    "RUN go test ./...",
    "FROM alpine:3.19",
    "COPY --from=test /bin/app /app",
  ].join("\n");
  assert.deepEqual(parseDockerfileBaseImages(dockerfile), ["golang:1.20", "alpine:3.19"]);
});

test("parseDockerfileBaseImages: matches containers/o11y/Dockerfile's real shape — two real images, no stage-name leakage", () => {
  const dockerfile = ["FROM grafana/loki:3.3.2 AS loki", "FROM grafana/grafana:11.4.0", "COPY --from=loki /usr/bin/loki /usr/bin/loki"].join("\n");
  assert.deepEqual(parseDockerfileBaseImages(dockerfile), ["grafana/loki:3.3.2", "grafana/grafana:11.4.0"]);
});

test("parseDockerfileBaseImages: FROM scratch is excluded (never pulled)", () => {
  const dockerfile = ["FROM golang:1.20 AS build", "RUN go build -o /app", "FROM scratch", "COPY --from=build /app /app"].join("\n");
  assert.deepEqual(parseDockerfileBaseImages(dockerfile), ["golang:1.20"]);
});

test("parseDockerfileBaseImages: ARG-based FROM resolves against the ARG's own default", () => {
  const dockerfile = ["ARG BASE_IMAGE=alpine:3.19", "FROM ${BASE_IMAGE}", "RUN echo hi"].join("\n");
  assert.deepEqual(parseDockerfileBaseImages(dockerfile), ["alpine:3.19"]);
});

test("parseDockerfileBaseImages: dedupes an image reused across stages", () => {
  const dockerfile = ["FROM node:20 AS a", "FROM node:20 AS b", "FROM node:20"].join("\n");
  assert.deepEqual(parseDockerfileBaseImages(dockerfile), ["node:20"]);
});

test("containerWranglerConfigsForTier: tier=1 needs none, tier=2 needs only the API worker, tier=full needs API + o11y", () => {
  const root = "/runner";
  assert.deepEqual(containerWranglerConfigsForTier("1", root), []);
  assert.deepEqual(containerWranglerConfigsForTier("2", root), [path.join(root, "workers", "api", "wrangler.jsonc")]);
  assert.deepEqual(containerWranglerConfigsForTier("full", root), [
    path.join(root, "workers", "api", "wrangler.jsonc"),
    path.join(root, "workers", "o11y", "wrangler.jsonc"),
  ]);
});

test("readContainerDockerfilePaths: reads containers[].image from the real workers/api/wrangler.jsonc", () => {
  const paths = readContainerDockerfilePaths(path.join(RUNNER_ROOT, "workers", "api", "wrangler.jsonc"));
  assert.equal(paths.length, 2);
  assert.ok(paths.some((p) => p.endsWith(path.join("containers", "live", "Dockerfile"))));
  assert.ok(paths.some((p) => p.endsWith(path.join("containers", "builder", "Dockerfile"))));
  for (const p of paths) assert.equal(existsSync(p), true);
});

test("collectTierBaseImages: tier=2 against the real repo resolves the shared sandbox base image once", () => {
  const refs = collectTierBaseImages("2", RUNNER_ROOT);
  assert.deepEqual(refs, ["docker.io/cloudflare/sandbox:0.12.3"]);
});

test("collectTierBaseImages: tier=full also pulls in the o11y worker's two real base images", () => {
  const refs = collectTierBaseImages("full", RUNNER_ROOT);
  assert.deepEqual(refs, ["docker.io/cloudflare/sandbox:0.12.3", "grafana/loki:3.3.2", "grafana/grafana:11.4.0"]);
});

test("shouldCheckContainerImages: true for tier 2/full unless --skip-image-check; always false for tier 1", () => {
  assert.equal(shouldCheckContainerImages("2", false), true);
  assert.equal(shouldCheckContainerImages("full", false), true);
  assert.equal(shouldCheckContainerImages("2", true), false);
  assert.equal(shouldCheckContainerImages("full", true), false);
  assert.equal(shouldCheckContainerImages("1", false), false);
  assert.equal(shouldCheckContainerImages("1", true), false);
});

test("parseArgs: --skip-image-check is only valid with --tier=2 or --tier=full", () => {
  assert.equal(parseArgs(["--tier=2", "--skip-image-check"]).errors.length, 0);
  assert.equal(parseArgs(["--tier=2", "--skip-image-check"]).skipImageCheck, true);
  assert.equal(parseArgs(["--tier=full", "--skip-image-check"]).errors.length, 0);
  assert.equal(parseArgs(["--tier=1", "--skip-image-check"]).errors.length, 1);
  assert.equal(parseArgs(["--help", "--skip-image-check"]).errors.length, 0);
});

test("parseArgs: --skip-image-check defaults to false", () => {
  assert.equal(parseArgs(["--tier=2"]).skipImageCheck, false);
});

test("isImagePresent: true when `docker image inspect` succeeds", () => {
  assert.equal(
    isImagePresent("alpine:3.19", () => {}),
    true,
  );
});

test("isImagePresent: false when `docker image inspect` throws (image missing locally)", () => {
  assert.equal(
    isImagePresent("alpine:3.19", () => {
      throw new Error("No such image");
    }),
    false,
  );
});

test("ensureContainerImagesPresent: a PRESENT image is never pulled", async () => {
  const calls = [];
  const result = await ensureContainerImagesPresent({
    refs: ["alpine:3.19"],
    execFileSyncImpl: (cmd, args) => {
      calls.push(args);
      if (args[0] === "image" && args[1] === "inspect") return "ok";
      throw new Error(`unexpected call: docker ${args.join(" ")}`);
    },
    sleep: () => Promise.resolve(),
  });
  assert.equal(result.ok, true);
  assert.equal(
    calls.some((a) => a[0] === "pull"),
    false,
    "a present image must never trigger docker pull",
  );
});

test("ensureContainerImagesPresent: a MISSING image is pulled exactly once (succeeds first try)", async () => {
  const calls = [];
  const result = await ensureContainerImagesPresent({
    refs: ["alpine:3.19"],
    execFileSyncImpl: (cmd, args) => {
      calls.push(args);
      if (args[0] === "image" && args[1] === "inspect") throw new Error("No such image");
      if (args[0] === "pull") return "ok";
      throw new Error(`unexpected call: docker ${args.join(" ")}`);
    },
    sleep: () => Promise.resolve(),
  });
  assert.equal(result.ok, true);
  const pullCalls = calls.filter((a) => a[0] === "pull");
  assert.equal(pullCalls.length, 1);
  assert.deepEqual(pullCalls[0], ["pull", "alpine:3.19"]);
});

test("pullImageWithRetry: retries up to maxAttempts with backoff, then reports the last error line", async () => {
  let attempts = 0;
  const sleeps = [];
  const result = await pullImageWithRetry({
    ref: "alpine:3.19",
    execFileSyncImpl: () => {
      attempts += 1;
      const err = new Error("pull failed");
      err.stderr = Buffer.from(`Error response from daemon: Get "https://registry-1.docker.io/v2/": net/http: TLS handshake timeout\n`);
      throw err;
    },
    maxAttempts: 3,
    backoffMs: 10,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  assert.equal(attempts, 3);
  assert.equal(sleeps.length, 2); // no sleep after the last attempt
  assert.equal(result.ok, false);
  assert.match(result.lastErrorLine, /TLS handshake timeout/);
});

test("pullImageWithRetry: a real `docker pull` writes progress to stdout and the actual failure to stderr — the stderr line must win, not stdout's later one", async () => {
  const result = await pullImageWithRetry({
    ref: "docker.io/cloudflare/sandbox:0.12.3",
    execFileSyncImpl: () => {
      const err = new Error("pull failed");
      // Matches real `docker pull` output shape: per-layer progress on
      // stdout keeps writing lines AFTER stderr's own last write (the
      // process failing mid-pull, not at the very start) — a naive
      // "concat stdout after stderr, take the last line" extraction would
      // report the harmless stdout progress line instead of this error.
      err.stdout = Buffer.from("0.12.3: Pulling from cloudflare/sandbox\nabc123: Downloading  [==>  ]  12MB/48MB\n");
      err.stderr = Buffer.from("error pulling image configuration: download failed after attempts=6: context deadline exceeded\n");
      throw err;
    },
    maxAttempts: 1,
    sleep: () => Promise.resolve(),
  });
  assert.equal(result.ok, false);
  assert.match(result.lastErrorLine, /context deadline exceeded/);
  assert.doesNotMatch(result.lastErrorLine, /Downloading/);
});

test("ensureContainerImagesPresent: a pull that fails every attempt stops before checking any later ref", async () => {
  const calls = [];
  const result = await ensureContainerImagesPresent({
    refs: ["alpine:3.19", "busybox:1.36"],
    execFileSyncImpl: (cmd, args) => {
      calls.push(args);
      if (args[0] === "image" && args[1] === "inspect") throw new Error("No such image");
      if (args[0] === "pull") {
        const err = new Error("pull failed");
        err.stderr = Buffer.from("Error response from daemon: some network error\n");
        throw err;
      }
      throw new Error(`unexpected call: docker ${args.join(" ")}`);
    },
    maxAttempts: 3,
    backoffMs: 5,
    sleep: () => Promise.resolve(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.ref, "alpine:3.19");
  assert.match(result.lastErrorLine, /some network error/);
  assert.ok(
    calls.every((a) => a[a.length - 1] !== "busybox:1.36"),
    "the second ref must never be checked once the first one exhausts its retries",
  );
});

test("formatImagePullFailure: names the image, the last error line, the retry command, and the escape hatch", () => {
  const message = formatImagePullFailure({ ref: "docker.io/cloudflare/sandbox:0.12.3", lastErrorLine: "TLS handshake timeout" });
  assert.match(message, /docker\.io\/cloudflare\/sandbox:0\.12\.3/);
  assert.match(message, /TLS handshake timeout/);
  assert.match(message, /docker pull docker\.io\/cloudflare\/sandbox:0\.12\.3/);
  assert.match(message, /--skip-image-check/);
});

test("CLI: `dev.mjs --tier=2` stops before spawning any worker when a required base image fails to pull after every retry", () => {
  const stubBinDir = path.join(HERE, "fixtures", "stub-bin");
  const devScript = path.join(RUNNER_ROOT, "scripts", "dev.mjs");
  const result = spawnSync(process.execPath, [devScript, "--tier=2"], {
    cwd: RUNNER_ROOT,
    encoding: "utf8",
    timeout: 30000,
    env: {
      ...process.env,
      PATH: `${stubBinDir}:${process.env.PATH}`,
      STUB_DOCKER_MODE: "ok",
      STUB_DOCKER_IMAGE_PRESENT: "0",
      STUB_DOCKER_PULL_MODE: "fail",
    },
  });
  assert.notEqual(result.status, 0);
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /could not pull required container base image/);
  assert.match(output, /docker pull docker\.io\/cloudflare\/sandbox:0\.12\.3/);
  assert.match(output, /attempt 3\/3/, "the bounded retry must actually run through the real CLI, not just report ok:false");
  assert.doesNotMatch(output, /spawning:/, "no worker should ever be spawned once the image pull gate fails");
  // The stub docker has no "ps" handler (the very next docker call after
  // the image gate, listing containers) — its catch-all reply is "stub
  // docker: unsupported subcommand ps". Its ABSENCE here is what actually
  // proves this run stopped at the image gate and never reached that next
  // step, not merely that it exited non-zero for some other reason.
  assert.doesNotMatch(output, /unsupported subcommand/, "the run must stop at the image gate, never reaching the next docker call (docker ps)");
});

test("CLI: `dev.mjs --tier=2 --skip-image-check` never calls `docker image inspect`/`pull` even when they'd fail", () => {
  const stubBinDir = path.join(HERE, "fixtures", "stub-bin");
  const devScript = path.join(RUNNER_ROOT, "scripts", "dev.mjs");
  // `docker info` (the tier's own Docker-availability check, ahead of the
  // image gate this test targets) succeeds via STUB_DOCKER_MODE=ok. The
  // stub doesn't implement `docker ps` (the leftover-container baseline
  // that runs right after the image gate), so this run dies there — fine,
  // and fast: everything this test needs to observe (the skip line, and
  // the absence of any image inspect/pull attempt) has already happened by
  // then, and it proves nothing past the gate got anywhere near a real
  // `wrangler`/pnpm build.
  const result = spawnSync(process.execPath, [devScript, "--tier=2", "--skip-image-check"], {
    cwd: RUNNER_ROOT,
    encoding: "utf8",
    timeout: 10000,
    env: {
      ...process.env,
      PATH: `${stubBinDir}:${process.env.PATH}`,
      STUB_DOCKER_MODE: "ok",
      STUB_DOCKER_IMAGE_PRESENT: "0",
      STUB_DOCKER_PULL_MODE: "fail",
    },
  });
  const output = `${result.stdout}${result.stderr}`;
  assert.doesNotMatch(output, /could not pull required container base image/);
  assert.match(output, /--skip-image-check: skipping/);
  // Proves this run DID proceed past the (skipped) gate, all the way to
  // the next docker call the stub doesn't implement (`docker ps`) — the
  // control for the test above: same env (a pull would fail if attempted),
  // but with --skip-image-check the run gets past the gate instead of
  // stopping at it.
  assert.match(output, /unsupported subcommand/, "the run must proceed past the (skipped) gate to the next docker call");
});

// ---------------------------------------------------------------------------
// runtime staleness
// ---------------------------------------------------------------------------

test("isRuntimeDistStale: true when dist/ is missing", () => {
  withTmpDir((dir) => {
    mkdirSync(path.join(dir, "src"));
    writeFileSync(path.join(dir, "src", "index.ts"), "export {}\n");
    assert.equal(isRuntimeDistStale(dir), true);
  });
});

test("isRuntimeDistStale: false when dist/ is newer than every src file", async () => {
  await withTmpDir(async (dir) => {
    mkdirSync(path.join(dir, "src"));
    mkdirSync(path.join(dir, "dist"));
    writeFileSync(path.join(dir, "src", "index.ts"), "export {}\n");
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(path.join(dir, "dist", "index.js"), "export {};\n");
    assert.equal(isRuntimeDistStale(dir), false);
  });
});

test("isRuntimeDistStale: true when a src file was edited after the last dist build", async () => {
  await withTmpDir(async (dir) => {
    mkdirSync(path.join(dir, "src"));
    mkdirSync(path.join(dir, "dist"));
    writeFileSync(path.join(dir, "dist", "index.js"), "export {};\n");
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(path.join(dir, "src", "index.ts"), "export {}\n");
    assert.equal(isRuntimeDistStale(dir), true);
  });
});

// ---------------------------------------------------------------------------
// spawn plan
// ---------------------------------------------------------------------------

test("buildPlan: tier=1 spawns only the authoring app", () => {
  const ports = resolvePorts("1", {});
  assert.deepEqual(planNames("1", ports), ["app"]);
});

test("buildPlan: tier=2 spawns the authoring app and the api worker, in that order", () => {
  const ports = resolvePorts("2", {});
  assert.deepEqual(planNames("2", ports), ["app", "api"]);
});

test("buildPlan: tier=full spawns app, api, o11y, and the local Slack capture server", () => {
  const ports = resolvePorts("full", {});
  assert.deepEqual(planNames("full", ports), ["app", "api", "o11y", "slack"]);
});

test("buildPlan: api and o11y each get their own, distinct --port and --inspector-port flags", () => {
  const ports = resolvePorts("full", {});
  const plan = buildPlan("full", ports);
  const api = plan.find((p) => p.name === "api");
  const o11y = plan.find((p) => p.name === "o11y");
  const flagValue = (args, flag) => args[args.indexOf(flag) + 1];
  assert.equal(flagValue(api.args, "--port"), String(ports.API_DEV_PORT));
  assert.equal(flagValue(api.args, "--inspector-port"), String(ports.API_DEV_INSPECTOR_PORT));
  assert.equal(flagValue(o11y.args, "--port"), String(ports.O11Y_DEV_PORT));
  assert.equal(flagValue(o11y.args, "--inspector-port"), String(ports.O11Y_DEV_INSPECTOR_PORT));
  assert.notEqual(flagValue(api.args, "--inspector-port"), flagValue(o11y.args, "--inspector-port"));
});

test("buildPlan: o11y's spawn injects O11Y_SESSION_SECRET via --var, not a fixed/predictable value", () => {
  const ports = resolvePorts("full", {});
  const planA = buildPlan("full", ports);
  const planB = buildPlan("full", ports);
  const secretArg = (plan) => {
    const o11y = plan.find((p) => p.name === "o11y");
    const idx = o11y.args.indexOf("--var");
    for (let i = idx; i < o11y.args.length; i += 2) {
      if (o11y.args[i] === "--var" && o11y.args[i + 1].startsWith("O11Y_SESSION_SECRET:")) return o11y.args[i + 1];
    }
    return undefined;
  };
  const a = secretArg(planA);
  const b = secretArg(planB);
  assert.ok(a && a.startsWith("O11Y_SESSION_SECRET:"));
  assert.notEqual(a, b, "each build gets a fresh ephemeral secret unless one is pinned via opts.sessionSecret");
});

test("buildPlan: tier=1's app process gets no VITE_DEV_USER/VITE_API_BASE (no API worker running to point at)", () => {
  const ports = resolvePorts("1", {});
  const app = buildPlan("1", ports).find((p) => p.name === "app");
  assert.equal(app.env.VITE_DEV_USER, undefined);
  assert.equal(app.env.VITE_API_BASE, undefined);
});

test("buildPlan: tier=2/full inject VITE_DEV_USER/VITE_API_BASE as env (never written to a file) for the app process", () => {
  for (const tier of ["2", "full"]) {
    const ports = resolvePorts(tier, {});
    const app = buildPlan(tier, ports).find((p) => p.name === "app");
    assert.equal(app.env.VITE_DEV_USER, "dev@handsontable.com");
    assert.equal(app.env.VITE_API_BASE, `http://localhost:${ports.AUTHORING_DEV_PORT}`);
  }
});

test("buildPlan: tier=full additionally injects VITE_TELEMETRY_LOCAL=1 for the app process", () => {
  const ports = resolvePorts("full", {});
  const app = buildPlan("full", ports).find((p) => p.name === "app");
  assert.equal(app.env.VITE_TELEMETRY_LOCAL, "1");
  const tier2App = buildPlan("2", resolvePorts("2", {})).find((p) => p.name === "app");
  assert.equal(tier2App.env.VITE_TELEMETRY_LOCAL, undefined);
});

test("buildPlan: never spawns wrangler via npx (spawns node_modules/.bin/wrangler directly)", () => {
  const ports = resolvePorts("full", {});
  for (const proc of buildPlan("full", ports)) {
    assert.notEqual(proc.bin, "npx");
    assert.doesNotMatch(proc.bin, /^npx\b/);
  }
});

// ---------------------------------------------------------------------------
// container REPORTING, never stopping (re-review 2, NB2: Ctrl-C does not
// make wrangler's own Sandbox-container orchestration tear itself down
// synchronously, and several worktrees running `wrangler dev` on this same
// machine at once is the NORMAL case — a "new since my own snapshot" +
// name-match container can just as easily be ANOTHER worktree's session as
// this run's own, so this module must never `docker stop` one on a guess.)
// ---------------------------------------------------------------------------

test("possiblyLeftoverContainers: only a container absent from `before` AND matching this run's own worker names counts", () => {
  const before = new Set(["existing-1"]);
  const after = [
    { id: "existing-1", name: "workerd-handsontable-demos-api-Sandbox-xyz-proxy" }, // pre-existing — not a candidate
    { id: "new-1", name: "workerd-handsontable-demos-api-Sandbox-abc-proxy" }, // new + matches — a candidate
    { id: "new-2", name: "workerd-handsontable-demos-o11y-GrafanaBox-def-proxy" }, // new + matches — a candidate
    { id: "new-3", name: "some-unrelated-container" }, // new but does not match — never a candidate
  ];
  const candidates = possiblyLeftoverContainers(before, after);
  assert.deepEqual(
    candidates.map((c) => c.id).sort(),
    ["new-1", "new-2"],
  );
});

test("possiblyLeftoverContainers: empty when nothing new appeared", () => {
  const before = new Set(["a", "b"]);
  const after = [
    { id: "a", name: "workerd-handsontable-demos-api-Sandbox-1-proxy" },
    { id: "b", name: "workerd-handsontable-demos-api-Sandbox-2-proxy" },
  ];
  assert.deepEqual(possiblyLeftoverContainers(before, after), []);
});

test("possiblyLeftoverContainers: never flags an unrelated container even if it's new (backend-postgres, mongodb, another worktree's own service)", () => {
  const before = new Set();
  const after = [
    { id: "x", name: "backend-postgres-1" },
    { id: "y", name: "myhandsontable-mongodb" },
  ];
  assert.deepEqual(possiblyLeftoverContainers(before, after), []);
});

test("reportLeftoverContainers (NB2, the required stubbed-docker test): a foreign container that appears new during the session, matching this run's own worker-name pattern, is REPORTED but never stopped", () => {
  // Simulates the exact false-positive re-review 2 describes: worktree B
  // starts its own `wrangler dev`/Tier-2 session partway through worktree
  // A's (this run's) session. B's `workerd-handsontable-demos-api-Sandbox-*`
  // container is "new since A's snapshot" and matches the name pattern —
  // indistinguishable, by this signal alone, from a container A actually
  // started itself.
  const before = new Set(["existing-1"]);
  const dockerCalls = [];
  const execFileSyncImpl = (cmd, args) => {
    dockerCalls.push([cmd, ...args]);
    if (cmd !== "docker") throw new Error(`unexpected command: ${cmd}`);
    if (args[0] === "stop") {
      // The exact regression this test guards against: NB2's old code
      // ran `docker stop` on a container it could not prove was its own.
      throw new Error("docker stop must NEVER be called by reportLeftoverContainers — NB2 regression");
    }
    if (args[0] === "ps") {
      return [
        "existing-1\tworkerd-handsontable-demos-api-Sandbox-preexisting-proxy",
        "foreign-1\tworkerd-handsontable-demos-api-Sandbox-foreign-worktree-proxy",
      ].join("\n");
    }
    throw new Error(`unexpected docker subcommand: ${args.join(" ")}`);
  };
  const logLines = [];
  const candidates = reportLeftoverContainers(before, execFileSyncImpl, (msg) => logLines.push(msg));

  assert.deepEqual(candidates.map((c) => c.id), ["foreign-1"], "the foreign container is still correctly IDENTIFIED as a candidate");
  assert.ok(
    !dockerCalls.some(([, sub]) => sub === "stop"),
    "docker stop must never be invoked, even for a container that looks exactly like this run's own",
  );
  assert.equal(logLines.length, 1, "exactly one informational log line, no automatic action");
  assert.match(logLines[0], /NOT stopping/);
  assert.match(logLines[0], /docker stop foreign-1/, "the manual cleanup command is printed for a human to run");
});

test("SHUTDOWN_SIGNALS (NB5): includes SIGHUP alongside SIGINT/SIGTERM, so closing the terminal a detached session was started from still triggers cleanup", () => {
  assert.deepEqual([...SHUTDOWN_SIGNALS].sort(), ["SIGHUP", "SIGINT", "SIGTERM"]);
});

// ---------------------------------------------------------------------------
// o11yLocalPublicOrigin
// ---------------------------------------------------------------------------

test("o11yLocalPublicOrigin: tracks O11Y_DEV_PORT, not AUTHORING_DEV_PORT — Grafana is served from the o11y worker's own origin", () => {
  assert.equal(o11yLocalPublicOrigin({ O11Y_DEV_PORT: 4200, AUTHORING_DEV_PORT: 5173 }), "http://localhost:4200");
  assert.equal(o11yLocalPublicOrigin({ O11Y_DEV_PORT: 6223, AUTHORING_DEV_PORT: 6220 }), "http://localhost:6223");
});

test("buildPlan: tier=full's o11y spawn injects O11Y_LOCAL_PUBLIC_ORIGIN matching the resolved O11Y_DEV_PORT", () => {
  const ports = resolvePorts("full", { O11Y_DEV_PORT: "6223" });
  const o11y = buildPlan("full", ports).find((p) => p.name === "o11y");
  assert.ok(o11y.args.includes("O11Y_LOCAL_PUBLIC_ORIGIN:http://localhost:6223"));
});

// ---------------------------------------------------------------------------
// --fresh (dev-persist task): compose.yml's minio/clickhouse now use named
// volumes; --fresh wipes them + workers/o11y/.wrangler/state together.
// ---------------------------------------------------------------------------

test("parseArgs: --fresh is only valid with --tier=full", () => {
  assert.equal(parseArgs(["--tier=full", "--fresh"]).errors.length, 0);
  assert.equal(parseArgs(["--tier=full", "--fresh"]).fresh, true);
  assert.equal(parseArgs(["--tier=1", "--fresh"]).errors.length, 1);
  assert.equal(parseArgs(["--tier=2", "--fresh"]).errors.length, 1);
  // Allowed with --help and no --tier (mirrors --replay/--reset-local-db).
  assert.equal(parseArgs(["--help", "--fresh"]).errors.length, 0);
});

test("parseArgs: --fresh defaults to false", () => {
  assert.equal(parseArgs(["--tier=full"]).fresh, false);
});

test("composeDownArgs: no -v by default (the Ctrl-C/kept-data path); -v only when fresh", () => {
  const plain = composeDownArgs("/x/compose.yml");
  assert.deepEqual(plain, ["compose", "-f", "/x/compose.yml", "down"]);
  assert.ok(!plain.includes("-v"));

  const fresh = composeDownArgs("/x/compose.yml", { fresh: true });
  assert.deepEqual(fresh, ["compose", "-f", "/x/compose.yml", "down", "-v"]);
});

test("o11yDevDataModeLine: exact startup mode line for both cases", () => {
  assert.equal(o11yDevDataModeLine(false), "o11y local data: kept (MinIO/ClickHouse volumes + o11y worker state)");
  assert.equal(o11yDevDataModeLine(true), "o11y local data: fresh");
});

test("resetO11yLocalState: runs `docker compose down -v` scoped to the given project, and removes only <o11yDir>/.wrangler/state", () => {
  withTmpDir((dir) => {
    const o11yDir = path.join(dir, "workers", "o11y");
    const otherDir = path.join(dir, "workers", "api"); // must never be touched
    mkdirSync(path.join(o11yDir, ".wrangler", "state", "v3", "do"), { recursive: true });
    writeFileSync(path.join(o11yDir, ".wrangler", "state", "v3", "do", "marker.txt"), "x");
    // A file directly under o11yDir (a sibling of .wrangler/, not under it)
    // — this is what actually catches a rm-path widened to o11yDir itself
    // (or to `dir`): the `.wrangler/state` assertion below stays trivially
    // true either way (a deleted parent takes every child path down with
    // it), this one does not.
    writeFileSync(path.join(o11yDir, ".dev.vars"), "O11Y_ENV=local\n");
    mkdirSync(path.join(otherDir, ".wrangler", "state"), { recursive: true });
    writeFileSync(path.join(otherDir, ".wrangler", "state", "keep-me.txt"), "x");

    const calls = [];
    const execFileSyncImpl = (cmd, args, opts) => calls.push({ cmd, args, opts });
    const composeFile = "/x/compose.yml";
    const composeEnv = { COMPOSE_PROJECT_NAME: "o11y-q1-test" };

    const result = resetO11yLocalState({ o11yDir, composeFile, composeEnv, execFileSyncImpl });

    assert.equal(calls.length, 1, "exactly one docker invocation");
    assert.equal(calls[0].cmd, "docker");
    assert.ok(calls[0].args.includes("-v"), "down -v (the whole point of --fresh)");
    assert.deepEqual(calls[0].args, ["compose", "-f", composeFile, "down", "-v"]);
    assert.equal(calls[0].opts.env.COMPOSE_PROJECT_NAME, "o11y-q1-test", "scoped to the right project only");

    assert.equal(result.composeDownRan, true);
    assert.equal(result.stateDirRemoved, true);
    assert.equal(existsSync(path.join(o11yDir, ".wrangler", "state")), false, "o11y worker state dir removed");
    assert.equal(existsSync(path.join(o11yDir, ".dev.vars")), true, "rm scoped to .wrangler/state, not all of o11yDir");
    assert.equal(existsSync(path.join(otherDir, ".wrangler", "state", "keep-me.txt")), true, "workers/api's own state untouched");
  });
});

test("resetO11yLocalState: without composeFile/composeEnv (o11y:dev's own --fresh), no docker call is made at all", () => {
  withTmpDir((dir) => {
    const o11yDir = path.join(dir, "workers", "o11y");
    mkdirSync(path.join(o11yDir, ".wrangler", "state"), { recursive: true });
    const execFileSyncImpl = () => {
      throw new Error("must not be called — o11y:dev never runs docker compose");
    };
    const result = resetO11yLocalState({ o11yDir, execFileSyncImpl });
    assert.equal(result.composeDownRan, false);
    assert.equal(result.stateDirRemoved, true);
    assert.equal(existsSync(path.join(o11yDir, ".wrangler", "state")), false);
  });
});

test("resetO11yLocalState: logs 'nothing to delete' when there is no o11y worker state at all (never throws)", () => {
  withTmpDir((dir) => {
    const o11yDir = path.join(dir, "workers", "o11y");
    const lines = [];
    const result = resetO11yLocalState({ o11yDir, log: (l) => lines.push(l) });
    assert.equal(result.stateDirRemoved, false);
    assert.ok(lines.some((l) => l.includes("nothing to delete")));
  });
});

// Revert evidence for the two tests above: dropping the `-v` push in
// `composeDownArgs({ fresh: true })`'s branch makes the first assertion in
// "runs `docker compose down -v` scoped..." fail (`args.includes("-v")` is
// false); widening `resetO11yLocalState`'s rm target from
// `path.join(o11yDir, ".wrangler", "state")` to `o11yDir` itself (or to
// `dir`) makes "workers/api's own state untouched" fail, since `otherDir`
// sits next to `o11yDir` under the same tmp root.

test("o11yLedgerCommittedKeyCount: counts only 'done:' keys in the InboxWriter DO's real SQLite storage, across multiple .sqlite files", async () => {
  await withTmpDir(async (dir) => {
    const o11yDir = path.join(dir, "workers", "o11y");
    const inboxDir = path.join(o11yDir, ".wrangler", "state", "v3", "do", "handsontable-demos-o11y-InboxWriter");
    mkdirSync(inboxDir, { recursive: true });

    function makeKvSqlite(fileName, rows) {
      const db = new DatabaseSync(path.join(inboxDir, fileName));
      db.exec("CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID");
      for (const key of rows) db.prepare("INSERT INTO _cf_KV (key, value) VALUES (?, ?)").run(key, Buffer.from("1"));
      db.close();
    }
    makeKvSqlite("aaa.sqlite", ["done:inbox/tenant/2026-09-24/one", "done:inbox/tenant/2026-09-24/two", "hash:20260924:abc", "wake:xyz"]);
    makeKvSqlite("bbb.sqlite", ["done:inbox/tenant/2026-09-24/three"]);
    // metadata.sqlite (real wrangler layout) never has a _cf_KV table — must
    // be skipped, not counted as an error.
    const metaDb = new DatabaseSync(path.join(inboxDir, "metadata.sqlite"));
    metaDb.exec("CREATE TABLE something_else (id INTEGER)");
    metaDb.close();

    const count = await o11yLedgerCommittedKeyCount(o11yDir);
    assert.equal(count, 3);
  });
});

test("o11yLedgerCommittedKeyCount: 0 (never throws) when there's no o11y worker state yet", async () => {
  await withTmpDir(async (dir) => {
    const count = await o11yLedgerCommittedKeyCount(path.join(dir, "workers", "o11y"));
    assert.equal(count, 0);
  });
});

test("findComposeVolume: null when docker finds nothing for that project+key; the resolved name otherwise", () => {
  const found = findComposeVolume({
    composeProjectName: "o11y-q1",
    volumeKey: "minio-data",
    execFileSyncImpl: () => "o11y-q1_minio-data\n",
  });
  assert.equal(found, "o11y-q1_minio-data");

  const missing = findComposeVolume({
    composeProjectName: "o11y-q1",
    volumeKey: "minio-data",
    execFileSyncImpl: () => "",
  });
  assert.equal(missing, null);
});

test("detectO11yStateDivergence: never touches docker when the ledger has zero committed keys (cheap path first)", async () => {
  const result = await detectO11yStateDivergence({
    composeProjectName: "o11y-q1",
    o11yDir: "/does/not/matter",
    execFileSyncImpl: () => {
      throw new Error("must not be called — nothing to warn about");
    },
    countCommittedLedgerKeys: async () => 0,
  });
  assert.deepEqual(result, { divergent: false, committedCount: 0 });
});

test("detectO11yStateDivergence: divergent when the ledger has committed keys but the MinIO volume is gone (the warning fires)", async () => {
  const result = await detectO11yStateDivergence({
    composeProjectName: "o11y-q1",
    o11yDir: "/does/not/matter",
    execFileSyncImpl: () => "", // docker volume ls -q finds nothing
    countCommittedLedgerKeys: async () => 7,
  });
  assert.equal(result.divergent, true);
  assert.equal(result.committedCount, 7);
  assert.match(formatO11yDivergenceWarning(result.committedCount), /--fresh/);
  assert.match(formatO11yDivergenceWarning(result.committedCount), /7/);
});

test("detectO11yStateDivergence: NOT divergent when committed keys exist but the MinIO volume also exists (normal case, not just fewer bytes)", async () => {
  const result = await detectO11yStateDivergence({
    composeProjectName: "o11y-q1",
    o11yDir: "/does/not/matter",
    execFileSyncImpl: () => "o11y-q1_minio-data\n",
    countCommittedLedgerKeys: async () => 7,
  });
  assert.equal(result.divergent, false);
});

// ---------------------------------------------------------------------------
// drift: every env var / flag the script reads is documented
// ---------------------------------------------------------------------------

function envVarNames(src) {
  const names = new Set();
  const re = /process\.env\.([A-Z][A-Z0-9_]*)/g;
  let m;
  while ((m = re.exec(src))) names.add(m[1]);
  return names;
}

function extractSection(doc, heading) {
  const start = doc.indexOf(heading);
  assert.notEqual(start, -1, `heading not found: ${heading}`);
  const rest = doc.slice(start + heading.length);
  const next = rest.search(/\n## /);
  return next === -1 ? rest : rest.slice(0, next);
}

test("drift: every env var read by dev.mjs/dev-lib.mjs/o11y-dev.mjs is documented in run-and-deploy.md's Run locally section", () => {
  const devLibSrc = readFileSync(path.join(RUNNER_ROOT, "scripts", "dev-lib.mjs"), "utf8");
  const devSrc = readFileSync(path.join(RUNNER_ROOT, "scripts", "dev.mjs"), "utf8");
  const o11yDevSrc = readFileSync(path.join(RUNNER_ROOT, "scripts", "o11y-dev.mjs"), "utf8");
  const doc = readFileSync(path.join(RUNNER_ROOT, "docs", "run-and-deploy.md"), "utf8");
  const section = extractSection(doc, "## Run locally");

  const names = new Set([
    ...envVarNames(devLibSrc),
    ...envVarNames(devSrc),
    ...envVarNames(o11yDevSrc),
    ...Object.keys(PORT_DEFAULTS),
  ]);
  assert.ok(names.size >= 10, `expected a real set of env var names, got ${names.size}`);

  const missing = [...names].filter((name) => !section.includes(`\`${name}\``));
  assert.deepEqual(missing, [], `env var(s) not documented (as a backtick-wrapped name) in run-and-deploy.md's Run locally section: ${missing.join(", ")}`);
});

test("drift: --tier, --replay, --fresh, and --help are documented in run-and-deploy.md's Run locally section", () => {
  const doc = readFileSync(path.join(RUNNER_ROOT, "docs", "run-and-deploy.md"), "utf8");
  const section = extractSection(doc, "## Run locally");
  for (const flag of ["--tier", "--replay", "--fresh", "--help"]) {
    assert.match(section, new RegExp(flag.replace("-", "\\-")), `${flag} not documented in the Run locally section`);
  }
});

test("drift: --fresh is documented in dev.mjs --help (HELP_TEXT)", () => {
  assert.match(HELP_TEXT, /--fresh/);
});

test("drift: pnpm dev / dev:live / dev:full / o11y:dev are all documented in run-and-deploy.md's Run locally section", () => {
  const doc = readFileSync(path.join(RUNNER_ROOT, "docs", "run-and-deploy.md"), "utf8");
  const section = extractSection(doc, "## Run locally");
  for (const cmd of ["pnpm dev", "pnpm dev:live", "pnpm dev:full", "pnpm o11y:dev"]) {
    assert.ok(section.includes(cmd), `${cmd} not mentioned in the Run locally section`);
  }
});
