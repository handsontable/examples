// Structural pins for the API worker's cron wiring
// (`workers/api/src/index.ts`). `runNightlyCron`/`runFiveMinuteCron` are
// private to that file and pull in the whole Worker's dependency graph
// (D1/KV/Sandbox/Sentry bindings), so — same rationale as
// `pipeline/master-workflow.test.mjs`'s structural pins on `master.yml` —
// these read the source as text and assert its exact shape rather than
// importing and executing it.
// Run: node --experimental-strip-types --test pipeline/api-cron-wiring.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexPath = join(__dirname, "..", "workers/api/src/index.ts");
const source = readFileSync(indexPath, "utf8");

function bodyOf(fnName) {
  const start = source.indexOf(`async function ${fnName}(`);
  assert.ok(start > -1, `${fnName} must exist in index.ts`);
  const braceStart = source.indexOf("{", start);
  // Find the matching closing brace by depth-counting — the bodies below
  // never contain a template literal with an unbalanced `{`, so this is safe.
  let depth = 0;
  let i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.slice(braceStart, i + 1);
}

// `rollupExampleDaily` must run under its own `cronStep` call, outside the
// billing chain's callback body — inside the same
// `cronStep(env, "cron:nightly", ...)` chain, an upstream throw (e.g.
// `reconcileBilling`) would skip it for the whole night.
test("index.ts: the nightly example_daily rollup has its own independent cronStep, not nested in the billing chain", () => {
  const nightlyBody = bodyOf("runNightlyCron");

  const billingStart = nightlyBody.indexOf('cronStep(env, "cron:nightly",');
  assert.ok(billingStart > -1, "the billing cronStep call must exist");
  const billingCallbackStart = nightlyBody.indexOf("{", nightlyBody.indexOf("=>", billingStart));
  let depth = 0;
  let i = billingCallbackStart;
  for (; i < nightlyBody.length; i++) {
    if (nightlyBody[i] === "{") depth++;
    else if (nightlyBody[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  const billingCallbackBody = nightlyBody.slice(billingCallbackStart, i + 1);

  assert.doesNotMatch(
    billingCallbackBody,
    /rollupExampleDaily/,
    "rollupExampleDaily must NOT be called inside the billing chain's cronStep callback",
  );
  assert.match(
    nightlyBody.slice(i + 1),
    /await cronStep\(env, "cron:nightly:rollup", async \(\) => \{\s*await rollupExampleDaily\(env\);\s*\}\);/,
    "rollupExampleDaily must run under its own cronStep call, after the billing chain's cronStep has returned",
  );
});

// The API worker's own `*/5` cron must write one structured
// `log.kind: "cron.tick"` line (via `telemetry/lines.ts`'s shared helper)
// so o11y's `heartbeat.lastIngest` watchdog check is a true end-to-end
// signal, not just "did the ingest pipeline exist".
test("index.ts: the five-minute cron writes a cron.tick line through logCronTickLine", () => {
  const fiveMinuteBody = bodyOf("runFiveMinuteCron");
  assert.match(
    fiveMinuteBody,
    /await cronStep\(env, "cron:five-minute:tick", \(\) => \{\s*logCronTickLine\(env\);/,
    "runFiveMinuteCron must call logCronTickLine(env) under its own cronStep",
  );
  assert.match(
    source,
    /\blogCronTickLine\b/,
    "logCronTickLine must be imported from telemetry/index.js",
  );
});
