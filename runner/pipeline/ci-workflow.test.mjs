// Structural pins for minor triage item 5 (C-M7/D-M8) in `ci.yml`'s
// `e2e-telemetry` job: the telemetry leak checks and actionlint used to run
// ONLY post-merge (master.yml, after production already shipped) — this
// file pins that they now also run in PR CI, plus the negative control that
// proves `check:telemetry-leak` can actually fail. Same rationale/pattern as
// `pipeline/master-workflow.test.mjs`'s structural pins on `master.yml`.
//
// Run: node --experimental-strip-types --test pipeline/ci-workflow.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const workflowPath = join(__dirname, "..", "..", ".github", "workflows", "ci.yml");
const source = readFileSync(workflowPath, "utf8");

function jobBody(name) {
  const start = source.indexOf(`\n  ${name}:`);
  assert.ok(start > -1, `the ${name} job must exist`);
  // Next top-level job starts at a line beginning with exactly two spaces
  // then a word then ':' — find the next such line after this job's header.
  const rest = source.slice(start + 1);
  const nextMatch = /\n  [a-zA-Z0-9_-]+:\n/.exec(rest.slice(1));
  return nextMatch ? rest.slice(0, nextMatch.index + 1) : rest;
}

const e2eTelemetry = jobBody("e2e-telemetry");

test("ci.yml: e2e-telemetry runs actionlint", () => {
  assert.match(e2eTelemetry, /actionlint/i, "the job must run actionlint somewhere in its steps");
});

test("ci.yml: e2e-telemetry builds a production-mode bundle and runs both leak checks against it, before building the flag bundle", () => {
  const prodBuildIdx = e2eTelemetry.indexOf("Build authoring in production mode");
  assert.ok(prodBuildIdx > -1, "a production-mode build step must exist");

  const devBypassIdx = e2eTelemetry.indexOf("dev-login bypass must not reach the production bundle");
  assert.ok(devBypassIdx > prodBuildIdx, "the AGENTS.md dev-bypass leak check must run after the production build");

  const telemetryLeakIdx = e2eTelemetry.indexOf("pnpm check:telemetry-leak");
  assert.ok(telemetryLeakIdx > prodBuildIdx, "check:telemetry-leak must run against the production build");

  const flagBuildIdx = e2eTelemetry.indexOf("VITE_TELEMETRY_LOCAL: '1'");
  assert.ok(flagBuildIdx > telemetryLeakIdx, "the flag build must come after the production-mode leak checks");
});

test("ci.yml: e2e-telemetry has a negative control asserting check:telemetry-leak FAILS against the flag build", () => {
  const flagBuildIdx = e2eTelemetry.indexOf("VITE_TELEMETRY_LOCAL: '1'");
  const negativeControlIdx = e2eTelemetry.indexOf("Leak check negative control");
  assert.ok(negativeControlIdx > flagBuildIdx, "the negative control step must run after the flag build");

  const stepEnd = e2eTelemetry.indexOf("\n      - name:", negativeControlIdx + 1);
  const step = e2eTelemetry.slice(negativeControlIdx, stepEnd > -1 ? stepEnd : undefined);
  assert.match(
    step,
    /if pnpm check:telemetry-leak; then[\s\S]*exit 1/,
    "the negative control must fail the job (exit 1) if check:telemetry-leak PASSES against the flag build",
  );
});
