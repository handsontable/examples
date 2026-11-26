// A live-preview container that sits idle for `sleepAfter` is stopped by the
// SDK, and any later sandbox RPC under that id would boot an empty container
// that can never serve the old preview URL. The Durable Object's idle stop must
// end the session: one `session.end` with reason `sleep_after`, a tombstone the
// session gate reads, and no sandbox RPC for any later `/api/session/:id/*`
// request.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

import { ctx, makeEnv } from "./fixtures/worker-harness.mjs";
import { setSandboxFactory } from "./fixtures/cloudflare-sandbox-stub.mjs";

register("./fixtures/worker-hooks.mjs", import.meta.url);

const workerModule = await import("../workers/api/src/index.ts");
const { default: worker, Sandbox } = workerModule;

const FILES = { "package.json": JSON.stringify({ name: "demo" }) };

const sessionRequest = (body) =>
  new Request("https://demos.handsontable.com/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const statusRequest = (id) =>
  new Request(`https://demos.handsontable.com/api/session/${id}/status?port=4200`);

const deleteRequest = (id) =>
  new Request(`https://demos.handsontable.com/api/session/${id}`, { method: "DELETE" });

function countingEnv() {
  const { env } = makeEnv();
  const points = [];
  env.RUNNER_EVENTS = { writeDataPoint: (p) => points.push(p) };
  env.PREVIEW_HOST = "demos.handsontable.com";
  return { env, points };
}

const endPoints = (points) => points.filter((p) => p.indexes[0] === "session.end");

/** Records every sandbox RPC and remembers what the create handed to the DO. */
function recordingSandbox() {
  const rpcs = [];
  const handoff = {};
  const sandbox = {
    async mkdir() { rpcs.push("mkdir"); },
    async writeFile() { rpcs.push("writeFile"); },
    async deleteFile() { rpcs.push("deleteFile"); },
    async exec() { rpcs.push("exec"); return { success: true, stdout: "", stderr: "" }; },
    async startProcess() { rpcs.push("startProcess"); },
    async exposePort() { rpcs.push("exposePort"); return { url: "https://preview.test/session" }; },
    async setFramework(framework, sessionId) { Object.assign(handoff, { framework, sessionId }); },
    async destroy() { rpcs.push("destroy"); },
  };
  return { sandbox, rpcs, handoff };
}

/** The live-preview Durable Object, with the SDK base's idle stop recorded. */
function liveObject(env) {
  const stored = new Map();
  const state = {
    storage: {
      get: async (key) => stored.get(key),
      put: async (key, value) => { stored.set(key, value); },
    },
  };
  return new Sandbox(state, env);
}

async function createSession(env, framework = "angular") {
  const recorder = recordingSandbox();
  setSandboxFactory(() => recorder.sandbox);
  const res = await worker.fetch(sessionRequest({ framework, files: FILES }), env, ctx);
  const { sessionId } = await res.json();
  assert.ok(sessionId, "expected a sessionId from the create");
  assert.equal(recorder.handoff.sessionId, sessionId, "the create hands the session id to the Durable Object");
  return { sessionId, ...recorder };
}

test("an idle stop ends the session once, as sleep_after, with its framework", async () => {
  const { env, points } = countingEnv();
  const { sessionId, handoff } = await createSession(env, "nuxt");

  const object = liveObject(env);
  await object.setFramework(handoff.framework, handoff.sessionId);
  await object.onActivityExpired();

  const ends = endPoints(points);
  assert.equal(ends.length, 1, "exactly one session.end");
  assert.equal(ends[0].blobs[8], "sleep_after", "blob9 reason");
  assert.equal(ends[0].blobs[5], "nuxt", "blob6 framework");
  assert.equal(await env.CACHE.get(`session-tombstone:${sessionId}`), "slept");

  await object.onActivityExpired();
  assert.equal(endPoints(points).length, 1, "a repeated idle stop does not end the session twice");
  assert.equal(object.idleStops, 2, "the SDK's own stop still runs every time");
});

test("after an idle stop the keepalive gets 410 session_slept and reaches no sandbox", async () => {
  const { env } = countingEnv();
  const { sessionId, handoff, rpcs } = await createSession(env);

  const object = liveObject(env);
  await object.setFramework(handoff.framework, handoff.sessionId);
  await object.onActivityExpired();

  rpcs.length = 0;
  const res = await worker.fetch(statusRequest(sessionId), env, ctx);
  assert.equal(res.status, 410);
  const body = await res.json();
  assert.equal(body.error, "session_slept");
  assert.match(body.message, /Restart the preview/);
  assert.doesNotMatch(body.message, /fetch|session start failed/i, "must not trip App.tsx's local-dev heuristic");
  assert.deepEqual(rpcs, [], "no sandbox RPC, so no empty container is booted under the old id");
});

test("closing the tab after an idle stop does not end the session a second time", async () => {
  const { env, points } = countingEnv();
  const { sessionId, handoff, rpcs } = await createSession(env);

  const object = liveObject(env);
  await object.setFramework(handoff.framework, handoff.sessionId);
  await object.onActivityExpired();

  rpcs.length = 0;
  const res = await worker.fetch(deleteRequest(sessionId), env, ctx);
  assert.equal(res.status, 204);
  assert.equal(endPoints(points).length, 1, "only the sleep_after point");
  assert.deepEqual(rpcs, [], "the stopped container needs no destroy() RPC");
  assert.equal(await env.CACHE.get(`session-tombstone:${sessionId}`), "slept", "the marker keeps its reason and its long TTL");
});

test("an idle stop on a session already torn down emits nothing", async () => {
  const { env, points } = countingEnv();
  const { sessionId, handoff } = await createSession(env);

  await worker.fetch(deleteRequest(sessionId), env, ctx);
  const before = endPoints(points).length;

  const object = liveObject(env);
  await object.setFramework(handoff.framework, handoff.sessionId);
  await object.onActivityExpired();
  assert.equal(endPoints(points).length, before, "the pagehide point is the only end");
});
