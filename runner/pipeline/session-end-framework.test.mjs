// `session.end` must not be emitted with `framework: ""`:
// `teardownLiveSession` and `sessionSubrouteGuard` only ever have a
// `sessionId`, never the framework a session was created with, so the
// `tier2-sessions` dashboard panel ("session.end awake seconds, p95 by
// reason") — which filters `blob6 IN (${framework:sqlstring})` — would stay
// permanently empty, the same failure shape as `container.boot_ms`'s.
//
// The fix carries the framework on the per-session KV meter
// (`workers/api/src/budget.ts#SessionMeter.framework`, set by
// `startSessionMeter` at create) and reads it back through
// `meterSession`'s return value at teardown, before the `final: true`
// flush deletes the KV entry it lives in. This file pins that round trip
// through the real `POST /api/session` -> `DELETE /api/session/:id` route
// pair, using the same harness
// `pipeline/session-create-container-starting.test.mjs` and
// `pipeline/container-boot-ms.test.mjs` use.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

import { ctx, makeEnv } from "./fixtures/worker-harness.mjs";
import { setSandboxFactory } from "./fixtures/cloudflare-sandbox-stub.mjs";

register("./fixtures/worker-hooks.mjs", import.meta.url);

const { default: worker } = await import("../workers/api/src/index.ts");

const FILES = { "package.json": JSON.stringify({ name: "demo" }) };

const sessionRequest = (body) =>
  new Request("https://demos.handsontable.com/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const deleteRequest = (id) =>
  new Request(`https://demos.handsontable.com/api/session/${id}`, { method: "DELETE" });

/** See `pipeline/lite-inject.test.mjs#makeCountingEnv` / `container-boot-ms
 *  .test.mjs#countingEnv`: flips `getSink()` to its `bindingSink` branch (a
 *  real `RUNNER_EVENTS` fake) instead of the local-mode ClickHouse HTTP
 *  fetch, which has nothing to talk to in this sandbox. */
function countingEnv() {
  const { env } = makeEnv();
  const points = [];
  env.RUNNER_EVENTS = { writeDataPoint: (p) => points.push(p) };
  env.PREVIEW_HOST = "demos.handsontable.com";
  return { env, points };
}

const endPoints = (points) => points.filter((p) => p.indexes[0] === "session.end");

function fakeSandbox({ destroyError } = {}) {
  return {
    async mkdir() {},
    async writeFile() {},
    deleteFile: async () => {},
    exec: async () => ({ success: true, stdout: "", stderr: "" }),
    async startProcess() {},
    async exposePort() {
      return { url: "https://preview.test/session" };
    },
    async setFramework() {},
    async destroy() {
      if (destroyError) throw destroyError;
    },
  };
}

test("a clean pagehide teardown carries the session's own framework, not ''", async () => {
  const { env, points } = countingEnv();
  const sandbox = fakeSandbox();
  setSandboxFactory(() => sandbox);

  const createRes = await worker.fetch(sessionRequest({ framework: "angular", files: FILES }), env, ctx);
  const { sessionId } = await createRes.json();
  assert.ok(sessionId, "expected a sessionId from the create");

  const deleteRes = await worker.fetch(deleteRequest(sessionId), env, ctx);
  assert.equal(deleteRes.status, 204);

  const ends = endPoints(points);
  assert.equal(ends.length, 1, "expected exactly one session.end point");
  assert.equal(ends[0].blobs[8], "pagehide", "blob9 reason");
  assert.equal(
    ends[0].blobs[5],
    "angular",
    "blob6 framework — what the tier2-sessions panel's session.end filter reads",
  );
});

test("a declined destroy() still carries the framework on its teardown_failed point", async () => {
  const { env, points } = countingEnv();
  // "The container service is unreachable" — one of `isExpectedTeardownFailure`'s
  // recognised platform messages (session-lifecycle.ts), so `destroy()`'s
  // throw degrades to `teardown_failed` instead of escaping.
  const sandbox = fakeSandbox({ destroyError: new Error("The container service is unreachable, try again later") });
  setSandboxFactory(() => sandbox);

  const createRes = await worker.fetch(sessionRequest({ framework: "vue", files: FILES }), env, ctx);
  const { sessionId } = await createRes.json();

  const deleteRes = await worker.fetch(deleteRequest(sessionId), env, ctx);
  assert.equal(deleteRes.status, 204, "a declined destroy still answers the fire-and-forget keepalive with 204");

  const ends = endPoints(points);
  assert.equal(ends.length, 1);
  assert.equal(ends[0].blobs[8], "teardown_failed");
  assert.equal(ends[0].blobs[5], "vue", "framework must survive onto the teardown_failed point too");
});

test("a session id that was never created still tears down (no meter) with an empty framework — no throw", async () => {
  const { env, points } = countingEnv();
  const sandbox = fakeSandbox();
  setSandboxFactory(() => sandbox);

  // No POST /api/session first — this id has no KV meter at all, the
  // "an id someone invented" case `hasSessionMeter`'s own doc describes.
  const deleteRes = await worker.fetch(deleteRequest("react-js-invented-id"), env, ctx);
  assert.equal(deleteRes.status, 204);

  const ends = endPoints(points);
  assert.equal(ends.length, 1);
  assert.equal(ends[0].blobs[8], "pagehide");
  assert.equal(ends[0].blobs[5], "", "no meter ever existed, so this degrades to today's framework-less point");
});

// ---- `session.end` value: booked awake seconds (contract §5, double3) ----------

/** Runs `fn` with `Date.now()` shifted forward by `ms`, restoring it after. */
async function withClockAhead(ms, fn) {
  const real = Date.now;
  Date.now = () => real() + ms;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

/** double3 is the `value` slot of `session.end` (`metrics.ts`: doubles [count, value]). */
const awakeOf = (point) => point.doubles[2];

test("a clean teardown reports the seconds the session was awake as session.end's value", async () => {
  const { env, points } = countingEnv();
  setSandboxFactory(() => fakeSandbox());

  const createRes = await worker.fetch(sessionRequest({ framework: "angular", files: FILES }), env, ctx);
  const { sessionId } = await createRes.json();

  await withClockAhead(90_000, () => worker.fetch(deleteRequest(sessionId), env, ctx));

  const ends = endPoints(points);
  assert.equal(ends.length, 1);
  const awake = awakeOf(ends[0]);
  assert.ok(awake >= 90 && awake <= 95, `expected ~90 awake seconds in double3, got ${awake}`);
});

test("an abandoned session is credited at most one awake window, not the hours until a late teardown", async () => {
  const { env, points } = countingEnv();
  setSandboxFactory(() => fakeSandbox());

  const createRes = await worker.fetch(sessionRequest({ framework: "vue", files: FILES }), env, ctx);
  const { sessionId } = await createRes.json();

  await withClockAhead(3 * 3600_000, () => worker.fetch(deleteRequest(sessionId), env, ctx));

  assert.equal(awakeOf(endPoints(points)[0]), 300, "capped at AWAKE_WINDOW_SECONDS");
});

test("awake seconds already booked by keepalive pings are not lost from the final figure", async () => {
  const { env, points } = countingEnv();
  setSandboxFactory(() => fakeSandbox());

  const createRes = await worker.fetch(sessionRequest({ framework: "vue", files: FILES }), env, ctx);
  const { sessionId } = await createRes.json();

  await withClockAhead(200_000, async () => {
    await worker.fetch(new Request(`https://demos.handsontable.com/api/session/${sessionId}/status`), env, ctx);
    // The tick runs under ctx.waitUntil; let its KV writes land before the clock moves on.
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  await withClockAhead(250_000, () => worker.fetch(deleteRequest(sessionId), env, ctx));

  const awake = awakeOf(endPoints(points)[0]);
  assert.ok(awake >= 250 && awake <= 255, `expected ~250 awake seconds (200 ticked + 50 final), got ${awake}`);
});

test("a declined destroy() still reports the awake seconds on teardown_failed", async () => {
  const { env, points } = countingEnv();
  setSandboxFactory(() =>
    fakeSandbox({ destroyError: new Error("The container service is unreachable, try again later") }),
  );

  const createRes = await worker.fetch(sessionRequest({ framework: "vue", files: FILES }), env, ctx);
  const { sessionId } = await createRes.json();

  await withClockAhead(60_000, () => worker.fetch(deleteRequest(sessionId), env, ctx));

  const ends = endPoints(points);
  assert.equal(ends[0].blobs[8], "teardown_failed");
  const awake = awakeOf(ends[0]);
  assert.ok(awake >= 60 && awake <= 65, `expected ~60 awake seconds, got ${awake}`);
});

test("a session with no meter reports no awake seconds instead of a fabricated 0", async () => {
  const { env, points } = countingEnv();
  setSandboxFactory(() => fakeSandbox());

  await worker.fetch(deleteRequest("react-js-invented-id"), env, ctx);

  const ends = endPoints(points);
  assert.equal(ends.length, 1);
  assert.ok(!(awakeOf(ends[0]) > 0), "no meter means no value");
});

test("budget_closed reports the awake seconds of the session it closes", async () => {
  const { env, points } = countingEnv();
  setSandboxFactory(() => fakeSandbox());

  const createRes = await worker.fetch(sessionRequest({ framework: "angular", files: FILES }), env, ctx);
  const { sessionId } = await createRes.json();

  // The ceiling state the subroute guard reads from KV.
  await env.CACHE.put(
    "budget:state",
    JSON.stringify({
      tier: "closed",
      spendUsd: 100,
      limitUsd: 50,
      pct: 2,
      reconciled: true,
      enforced: true,
      settings: {},
      asOf: Date.now(),
    }),
  );

  const res = await withClockAhead(120_000, () =>
    worker.fetch(
      new Request(`https://demos.handsontable.com/api/session/${sessionId}/file`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "a.txt", contents: "x" }),
      }),
      env,
      ctx,
    ),
  );
  assert.equal(res.status, 410);

  const ends = endPoints(points);
  assert.equal(ends.length, 1);
  assert.equal(ends[0].blobs[8], "budget_closed");
  const awake = awakeOf(ends[0]);
  assert.ok(awake >= 120 && awake <= 125, `expected ~120 awake seconds, got ${awake}`);
});
