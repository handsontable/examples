// T11 regression test — found live while running this task's own required
// local walkthrough (not by reading source): `index.ts#cors()`'s
// `Access-Control-Allow-Headers` list (`Content-Type, Authorization`) never
// grew to include `x-hot-session`, the header `apps/authoring/src/telemetry/
// index.ts#apiHeaders()` now sets on nearly every fetch call site
// (T05/T06's rollout, ADR-0041 contract §6's session join). Production and
// the vite dev proxy are both same-origin, so no browser ever preflights
// this — a genuinely cross-origin local dev setup (`VITE_API_BASE` pointed
// straight at the API worker, the same shape `e2e/telemetry-metrics.spec.ts`
// and this task's own `e2e/o11y-local.spec.ts` use) is the only place a
// missing header here is visible at all, and it fails CLOSED (the browser
// refuses the request before it is ever sent) — see the T11 report for the
// live symptom (a real Fork+Save flow never navigated, because the CORS
// preflight for the save request failed silently in the console).
//
// Driven through the REAL router (`workers/api/src/index.ts`'s default
// export), not a re-declared copy of the header list — the #201 lesson
// `token-routes.test.mjs`'s own header names.
//
// Run: node --experimental-strip-types --test pipeline/api-cors.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { ctx, makeEnv } from "./fixtures/worker-harness.mjs";

register("./fixtures/worker-hooks.mjs", import.meta.url);

const { default: worker } = await import("../workers/api/src/index.ts");

function req(method, path, init = {}) {
  return new Request(`https://demos.handsontable.com${path}`, { method, ...init });
}

test("an OPTIONS preflight allows x-hot-session, the telemetry session-join header", async () => {
  const env = makeEnv();
  const res = await worker.fetch(req("OPTIONS", "/api/versions"), env, ctx);
  assert.equal(res.status, 204);
  const allowed = res.headers.get("Access-Control-Allow-Headers") ?? "";
  assert.ok(
    allowed.split(",").map((s) => s.trim().toLowerCase()).includes("x-hot-session"),
    `expected "x-hot-session" in Access-Control-Allow-Headers, got: "${allowed}"`,
  );
});

test("a real GET response also carries x-hot-session in Access-Control-Allow-Headers", async () => {
  const env = makeEnv();
  const res = await worker.fetch(req("GET", "/api/versions"), env, ctx);
  const allowed = res.headers.get("Access-Control-Allow-Headers") ?? "";
  assert.ok(
    allowed.split(",").map((s) => s.trim().toLowerCase()).includes("x-hot-session"),
    `expected "x-hot-session" in Access-Control-Allow-Headers, got: "${allowed}"`,
  );
});
