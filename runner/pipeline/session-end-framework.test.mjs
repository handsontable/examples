// W-triage, the note adjacent to F14: `session.end` was always emitted with
// `framework: ""` (`index.ts:503, 508, 722` at the triage's pinned commit) —
// `teardownLiveSession` and `sessionSubrouteGuard` only ever have a
// `sessionId`, never the framework a session was created with. The
// `tier2-sessions` dashboard panel ("session.end awake seconds, p95 by
// reason") filters `blob6 IN (${framework:sqlstring})`, so it was
// permanently empty, the same failure shape as F14's `container.boot_ms`.
//
// The fix carries the framework on the per-session KV meter
// (`workers/api/src/budget.ts#SessionMeter.framework`, set by
// `startSessionMeter` at create) and reads it back through `meterSession`'s
// return value at teardown, before the `final: true` flush deletes the KV
// entry it lives in. This file pins that round trip through the real
// `POST /api/session` -> `DELETE /api/session/:id` route pair, using the same
// harness `pipeline/session-create-container-starting.test.mjs` and
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
