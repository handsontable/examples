// Fix round R4, "serve.share": `GET /api/demos/:id` used to emit a §5
// `serve.share` point unconditionally on every 2xx/4xx answer — but that
// route is the metadata load for THREE different callers (App.tsx's
// edit/share loader in EITHER mode, `FullMode`'s own fetch, and any ad hoc
// `GET /api/demos/<id>`), not the share-page document view. Round-4 count
// reconciliation: "60 points for 11 share views", and
// `GET /api/demos/<missing-id>` (an existence-check-shaped JSON call, not a
// page view) was itself recorded as a `serve.share` 4xx.
//
// The fix: `App.tsx`'s share-mode loader appends `?view=share` on this one
// fetch only, and the server only counts a point when that marker is
// present — never for an edit-mode load, a `FullMode` load, or an unmarked
// probe.
//
// Build prerequisite: `pnpm --filter @handsontable/demo-runtime build`.
// Run: node --experimental-strip-types --test pipeline/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { ctx, makeEnv, demoRow } from "./fixtures/worker-harness.mjs";

register("./fixtures/worker-hooks.mjs", import.meta.url);

const { default: worker } = await import("../workers/api/src/index.ts");

/** Same `bindingSink`-routing idiom as `lite-inject.test.mjs`/
 *  `session-end-framework.test.mjs`'s own `countingEnv()`. */
function countingEnv(seedRows = []) {
  const { env } = makeEnv(seedRows);
  const points = [];
  env.RUNNER_EVENTS = { writeDataPoint: (p) => points.push(p) };
  env.PREVIEW_HOST = "demos.handsontable.com";
  return { env, points };
}

const sharePoints = (points) => points.filter((p) => p.indexes[0] === "serve.share");
const metaRequest = (id, { share = false } = {}) =>
  new Request(`https://demos.handsontable.com/api/demos/${id}${share ? "?view=share" : ""}`);

// blob/double slot positions (§4, AE_COLUMNS): outcome=blob8 (index 7),
// demo_id=blob12 (index 11), count=double1 (index 0).
const OUTCOME_SLOT = 7;
const DEMO_ID_SLOT = 11;
const COUNT_SLOT = 0;

test("GET /api/demos/:id WITHOUT ?view=share (the edit-page/FullMode shape) answers 200 but emits NO serve.share point", async () => {
  const { env, points } = countingEnv([demoRow({ id: "abc123" })]);
  const res = await worker.fetch(metaRequest("abc123"), env, ctx);
  assert.equal(res.status, 200);
  assert.equal(sharePoints(points).length, 0, "an unmarked metadata fetch must never count as a share view");
});

test("GET /api/demos/:id?view=share (the actual share-page load) emits exactly one serve.share 2xx point", async () => {
  const { env, points } = countingEnv([demoRow({ id: "abc123" })]);
  const res = await worker.fetch(metaRequest("abc123", { share: true }), env, ctx);
  assert.equal(res.status, 200);
  const sb = sharePoints(points);
  assert.equal(sb.length, 1, `expected exactly 1 serve.share point, got ${sb.length}`);
  assert.equal(sb[0].blobs[OUTCOME_SLOT], "2xx");
  assert.equal(sb[0].blobs[DEMO_ID_SLOT], "abc123");
  assert.equal(sb[0].doubles[COUNT_SLOT], 1);
});

test("GET /api/demos/<missing-id> WITHOUT ?view=share (an ad hoc existence-check probe, the F20 finding's own repro) answers 404 and emits NO serve.share point", async () => {
  const { env, points } = countingEnv([]);
  const res = await worker.fetch(metaRequest("does-not-exist"), env, ctx);
  assert.equal(res.status, 404);
  assert.equal(sharePoints(points).length, 0, "an unmarked 404 must never inflate the share 4xx rate");
});

test("GET /api/demos/<missing-id>?view=share (a genuinely broken share link) still counts as a real serve.share 4xx", async () => {
  const { env, points } = countingEnv([]);
  const res = await worker.fetch(metaRequest("does-not-exist", { share: true }), env, ctx);
  assert.equal(res.status, 404);
  const sb = sharePoints(points);
  assert.equal(sb.length, 1);
  assert.equal(sb[0].blobs[OUTCOME_SLOT], "4xx");
});

test("GET /api/demos/:id?view=share on a revoked demo answers 410 and emits one serve.share 4xx point", async () => {
  const { env, points } = countingEnv([demoRow({ id: "abc123", revoked: 1 })]);
  const res = await worker.fetch(metaRequest("abc123", { share: true }), env, ctx);
  assert.equal(res.status, 410);
  const sb = sharePoints(points);
  assert.equal(sb.length, 1);
  assert.equal(sb[0].blobs[OUTCOME_SLOT], "4xx");
});

test("GET /api/demos/:id?view=share on a revoked demo WITHOUT the marker emits nothing (same rule, revoked branch)", async () => {
  const { env, points } = countingEnv([demoRow({ id: "abc123", revoked: 1 })]);
  const res = await worker.fetch(metaRequest("abc123"), env, ctx);
  assert.equal(res.status, 410);
  assert.equal(sharePoints(points).length, 0);
});
