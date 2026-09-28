import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// API worker signals, error lines, the Sentry scope switch (ADR-0041 §D,
// §E.1, §E.3; contract §2). Pins the exact config the ADR names, so a
// revert of any one value goes red: full-fidelity head sampling with
// invocation logs off, the sampled 1% trace rate with no destination (no
// trace is ever exported), the `o11y-logs` export destination, the `*/5`
// observability cron beside the unchanged nightly one, and
// `SERVICE_VERSION` wired into the deploy script.
//
// No JSON5 dependency: a small string-aware `//`-comment stripper is
// enough for this repo's actual `.jsonc` style (line comments only, no
// trailing commas).

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

// `env.O11Y` must bind to the named `O11yHeartbeat` RPC entrypoint, not the
// o11y worker's default export, which has no HTTP route for this report.
// Also checks every o11y-service binding's declared entrypoint is a real
// named export of the target worker's `index.ts`.
test("every o11y service binding declares a real entrypoint, and O11Y's is O11yHeartbeat", () => {
  const o11yIndexPath = fileURLToPath(new URL("../workers/o11y/src/index.ts", import.meta.url));
  const o11yIndexSrc = fs.readFileSync(o11yIndexPath, "utf8");
  const o11y = wrangler.services.find((svc) => svc.binding === "O11Y");
  assert.equal(
    o11y?.entrypoint,
    "O11yHeartbeat",
    "env.O11Y must bind to entrypoint: \"O11yHeartbeat\" — without it, env.O11Y resolves to the o11y " +
      "worker's default export, which has no HTTP route for the heartbeat report",
  );
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
