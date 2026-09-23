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
