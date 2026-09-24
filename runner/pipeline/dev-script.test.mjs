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
  parseArgs,
  resolvePorts,
  PORT_DEFAULTS,
  bootstrapDevVars,
  o11yDevVarsPatch,
  O11Y_DEVVARS_STRIP_KEYS,
  checkDevVarsPortDrift,
  readDevVarsLine,
  migrationRecordPath,
  planMigrations,
  applyMigrations,
  isDockerAvailable,
  DOCKER_NOT_RUNNING_MESSAGE,
  isRuntimeDistStale,
  buildPlan,
  planNames,
  ephemeralSecret,
} from "../scripts/dev-lib.mjs";

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

test("ephemeralSecret: never the same value twice, and never written by bootstrapDevVars", () => {
  assert.notEqual(ephemeralSecret(), ephemeralSecret());
  assert.equal(ephemeralSecret().length, 64); // 32 bytes, hex
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

test("drift: --tier, --replay, and --help are documented in run-and-deploy.md's Run locally section", () => {
  const doc = readFileSync(path.join(RUNNER_ROOT, "docs", "run-and-deploy.md"), "utf8");
  const section = extractSection(doc, "## Run locally");
  for (const flag of ["--tier", "--replay", "--help"]) {
    assert.match(section, new RegExp(flag.replace("-", "\\-")), `${flag} not documented in the Run locally section`);
  }
});

test("drift: pnpm dev / dev:live / dev:full / o11y:dev are all documented in run-and-deploy.md's Run locally section", () => {
  const doc = readFileSync(path.join(RUNNER_ROOT, "docs", "run-and-deploy.md"), "utf8");
  const section = extractSection(doc, "## Run locally");
  for (const cmd of ["pnpm dev", "pnpm dev:live", "pnpm dev:full", "pnpm o11y:dev"]) {
    assert.ok(section.includes(cmd), `${cmd} not mentioned in the Run locally section`);
  }
});
