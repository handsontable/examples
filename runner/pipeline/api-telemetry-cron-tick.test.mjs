// Minor triage item 2 (C-M2): `telemetry/lines.ts#logCronTickLine` — the one
// structured line the API worker's `*/5` cron writes so o11y's
// `heartbeat.lastIngest` watchdog check is a true end-to-end signal, even
// during a real quiet period with no user traffic. See `lines.ts`'s own doc
// comment on the function for why `normalise/otlp.ts` (a different task's
// file) needed no change for this line to still count as an ingest event.
//
// `lines.ts` imports `./resource.js` relatively — the loader hook below
// remaps that to `resource.ts` on disk, the same way every other spec that
// imports straight from `workers/api/src/` does (see
// `pipeline/fixtures/worker-hooks.mjs`'s own header comment).
//
// Run: node --experimental-strip-types --test pipeline/api-telemetry-cron-tick.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./fixtures/worker-hooks.mjs", import.meta.url);

const { logCronTickLine } = await import("../workers/api/src/telemetry/lines.ts");

function captureConsoleLog(fn) {
  const original = console.log;
  const lines = [];
  console.log = (line) => lines.push(line);
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

test("logCronTickLine: emits exactly one console.log line shaped log.kind=cron.tick", () => {
  const lines = captureConsoleLog(() => logCronTickLine({ SERVICE_VERSION: "abc123" }));
  assert.equal(lines.length, 1, "must write exactly one line per call");
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed["log.kind"], "cron.tick");
  assert.equal(parsed["service.version"], "abc123");
});

test("logCronTickLine: falls back to the same service.version resolution every other line uses", () => {
  const lines = captureConsoleLog(() => logCronTickLine({}));
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed["service.version"], "dev", "matches resource.ts#serviceVersion's own documented fallback");
});
