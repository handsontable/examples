import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// T05 — API worker signals, error lines, the Sentry scope switch (ADR-0041
// §D, §E.1, §E.3; contract §2). Pins the exact config the ADR names, so a
// revert of any one value goes red rather than silently drifting: full-
// fidelity head sampling with invocation logs off (ADR §D — "answered by
// invocation_logs: false, the silent proxy path and the budget, not
// reversed"), the sampled 1% trace rate with no destination (ADR §C.4 — no
// trace is ever exported), the `o11y-logs` export destination, the `*/5`
// observability cron beside the unchanged nightly one, and `SERVICE_VERSION`
// wired into the deploy script.
//
// No JSON5 dependency is added for this (T00 owns new dependencies) — a
// small string-aware `//`-comment stripper is enough for this repo's actual
// `.jsonc` style (line comments only, no trailing commas).

function stripLineComments(text) {
  let out = "";
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      out += c;
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === "\"") inString = false;
      continue;
    }
    if (c === "\"") {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    out += c;
  }
  return out;
}

const workersApiDir = fileURLToPath(new URL("../workers/api/", import.meta.url));
const wranglerJsonc = fs.readFileSync(`${workersApiDir}wrangler.jsonc`, "utf8");
const wrangler = JSON.parse(stripLineComments(wranglerJsonc));
const pkg = JSON.parse(fs.readFileSync(`${workersApiDir}package.json`, "utf8"));

test("stripLineComments does not corrupt a string containing //", () => {
  // wrangler.jsonc's own vars carry URLs — a naive per-line stripper would
  // truncate them. Guards the parser this file's own assertions depend on.
  assert.equal(
    JSON.parse(stripLineComments('{"a": "https://example.com/x"}')).a,
    "https://example.com/x",
  );
});

test("observability.logs: full fidelity, invocation logs off, persisted, o11y-logs destination", () => {
  assert.deepEqual(wrangler.observability.logs, {
    enabled: true,
    head_sampling_rate: 1.0,
    invocation_logs: false,
    persist: true,
    destinations: ["o11y-logs"],
  });
});

test("observability.traces: 1% sampled, persisted, no destination (ADR §C.4 — no trace export)", () => {
  assert.deepEqual(wrangler.observability.traces, {
    enabled: true,
    head_sampling_rate: 0.01,
    persist: true,
  });
  assert.equal("destinations" in wrangler.observability.traces, false);
});

test("the */5 cron runs alongside the unchanged nightly one", () => {
  assert.deepEqual(wrangler.triggers.crons, ["17 4 * * *", "*/5 * * * *"]);
});

test("RUNNER_EVENTS and O11Y bindings are wired (not just declared)", () => {
  assert.equal(wrangler.analytics_engine_datasets[0].binding, "RUNNER_EVENTS");
  assert.equal(wrangler.analytics_engine_datasets[0].dataset, "runner_events");
  assert.equal(wrangler.services[0].binding, "O11Y");
  assert.equal(wrangler.services[0].service, "handsontable-demos-o11y");
});

// A-C1: without `entrypoint`, `env.O11Y` resolves to the o11y worker's
// *default* export (its public `fetch()` router), not the named
// `O11yHeartbeat` `WorkerEntrypoint` — the o11y worker's default export no
// longer answers `/_internal/heartbeat` at all (RPC-only, W1), so that
// binding shape is permanently, silently broken in production (the watchdog
// latches "stale" forever after its first false page). This test would have
// caught the regression on its own: `wrangler.services[0]` had no
// `entrypoint` key at all before this fix.
test("A-C1: the O11Y service binding targets the named O11yHeartbeat RPC entrypoint, not the o11y worker's default export", () => {
  assert.equal(
    wrangler.services[0].entrypoint,
    "O11yHeartbeat",
    "env.O11Y must bind to entrypoint: \"O11yHeartbeat\" — without it, env.O11Y resolves to the o11y " +
      "worker's default export, which no longer serves /_internal/heartbeat (RPC-only since W1)",
  );
});

// Structural cross-check (the fix the A-review asked for): every declared
// `entrypoint` on a service binding this Worker owns must be a real named
// export of the target worker's own `index.ts` — a config/code drift here
// is exactly what let A-C1 through (the binding and the RPC class it names
// were changed by two different tasks, in two different worktrees, and
// nothing re-verified the seam once both landed).
test("A-C1: every O11Y* service binding's declared entrypoint is a real named export of the o11y worker", () => {
  const o11yIndexPath = fileURLToPath(new URL("../workers/o11y/src/index.ts", import.meta.url));
  const o11yIndexSrc = fs.readFileSync(o11yIndexPath, "utf8");
  for (const svc of wrangler.services) {
    if (svc.service !== "handsontable-demos-o11y") continue;
    assert.ok(svc.entrypoint, `services[] entry for "${svc.service}" (binding ${svc.binding}) must declare an entrypoint`);
    const exportRe = new RegExp(`export\\s*\\{[^}]*\\b${svc.entrypoint}\\b[^}]*\\}|export\\s+class\\s+${svc.entrypoint}\\b`);
    assert.match(
      o11yIndexSrc,
      exportRe,
      `workers/o11y/src/index.ts does not export "${svc.entrypoint}", which ${svc.binding}'s entrypoint names`,
    );
  }
});

// A-C1: the watchdog must call the RPC method directly, never `.fetch()` on
// the binding — a `.fetch()` call would silently regress to the broken
// pre-fix shape (the o11y worker's default export no longer answers
// `/_internal/heartbeat` over HTTP at all).
test("A-C1: o11y-watchdog.ts calls the heartbeat() RPC method, never .fetch(), on the O11Y binding", () => {
  const watchdogPath = fileURLToPath(new URL("../workers/api/src/o11y-watchdog.ts", import.meta.url));
  const watchdogSrc = fs.readFileSync(watchdogPath, "utf8");
  assert.match(watchdogSrc, /\.heartbeat\(\)/, "o11y-watchdog.ts must call the named RPC method heartbeat()");
  assert.doesNotMatch(
    watchdogSrc,
    /o11y\.fetch\(/,
    "o11y-watchdog.ts must never call .fetch() on the O11Y binding — that path is RPC-only since W1",
  );
});

test("SENTRY_SCOPE defaults to full (contract §11)", () => {
  assert.equal(wrangler.vars.SENTRY_SCOPE, "full");
});

test("the deploy script sets SERVICE_VERSION from GITHUB_SHA, alongside every existing --routes flag", () => {
  const deploy = pkg.scripts.deploy;
  for (const route of [
    "*.demos.handsontable.com/*",
    "demos.handsontable.com/api/*",
    "demos.handsontable.com/d/*",
    "demos.handsontable.com/embed/*",
  ]) {
    assert.ok(deploy.includes(`--routes '${route}'`), `missing --routes '${route}'`);
  }
  assert.ok(deploy.includes("--var SENTRY_ENVIRONMENT:api-production"));
  assert.ok(deploy.includes("--var SERVICE_VERSION:$GITHUB_SHA"));
});
