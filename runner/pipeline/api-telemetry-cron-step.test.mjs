import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// T05 fix round (controller review): `cronStep` (`workers/api/src/telemetry/
// cron-step.ts`, T05-D8) had no direct test — the explicit, ungated
// `Sentry.captureException` it adds for a failed cron step (measured live to
// be necessary: a throw inside `ctx.waitUntil(...)` is invisible to
// `Sentry.withSentry`'s own `scheduled` auto-capture) was only exercised
// through a live `wrangler dev` probe, never a pipeline test.
//
// `cron-step.ts` is a leaf on purpose (only `lines.ts` -> `resource.ts`, plus
// the real `@sentry/cloudflare` package) so it can be copied the same way
// `api-telemetry-diagnostic.test.mjs` copies `diagnostic.ts`'s chain — see
// that file's header comment for why the copy lands inside `workers/api/`
// rather than the OS temp dir (the bare `@sentry/cloudflare` specifier needs
// `workers/api/node_modules` in its resolution ancestry).
//
// `cronStep` takes an injectable `capture` function (fix round addition) —
// the test below passes a recorder instead of the real `@sentry/cloudflare`
// call.

const workersApiDir = join(import.meta.dirname, "..", "workers/api");
const telemetrySrc = join(workersApiDir, "src/telemetry");
const envSrc = join(workersApiDir, "src/env.ts");
const dir = mkdtempSync(join(workersApiDir, ".hot-cron-step-"));
for (const file of ["cron-step.ts", "lines.ts", "resource.ts"]) {
  writeFileSync(join(dir, file), readFileSync(join(telemetrySrc, file), "utf8").replaceAll('.js"', '.ts"'));
}
writeFileSync(join(dir, "env.ts"), readFileSync(envSrc, "utf8"));
const { cronStep } = await import(join(dir, "cron-step.ts"));
rmSync(dir, { recursive: true, force: true });

const ENV = { PREVIEW_HOST: "demos.handsontable.com" };

function recorder() {
  const calls = [];
  const capture = (err, context) => calls.push({ err, context });
  return { calls, capture };
}

test("cronStep: a throwing step is captured, and the step's own error is swallowed (does not rethrow)", async () => {
  const { calls, capture } = recorder();
  const err = new Error("cron step failed");
  await assert.doesNotReject(() => cronStep(ENV, "cron:test-step", () => { throw err; }, capture));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].err, err);
  assert.deepEqual(calls[0].context, { tags: { context: "cron:test-step" } });
});

test("cronStep: a succeeding step never calls capture", async () => {
  const { calls, capture } = recorder();
  await cronStep(ENV, "cron:test-step", async () => { /* ok */ }, capture);
  assert.equal(calls.length, 0);
});

test("cronStep: an async rejection is captured the same way a sync throw is", async () => {
  const { calls, capture } = recorder();
  await cronStep(ENV, "cron:test-step", () => Promise.reject(new Error("async boom")), capture);
  assert.equal(calls.length, 1);
});

test("cronStep: with no capture argument, does not throw (falls back to the real Sentry call, inert with no client configured)", async () => {
  await assert.doesNotReject(() => cronStep(ENV, "cron:test-step", () => { throw new Error("boom"); }));
});
