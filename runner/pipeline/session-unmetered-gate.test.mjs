// DEV-3147. A `/api/session/:id/status` call that arrives after the session's
// tombstone has expired (600 s) used to boot a container again — the SDK
// auto-boots on any RPC — and that container was never metered, so the cost
// guardrails could not see it. The resurrection gate now also refuses an id with
// no meter (written at create, deleted at teardown).
//
// Driven through the real router. `makeEnv()` gives `Sandbox: {}`, so any sandbox
// RPC that slips past the gate throws and surfaces as a non-410 answer: a 410
// here is proof that no container was asked for.
// Run: node --experimental-strip-types --test pipeline/session-unmetered-gate.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { ctx, makeEnv } from "./fixtures/worker-harness.mjs";

register("./fixtures/worker-hooks.mjs", import.meta.url);

const { default: worker } = await import("../workers/api/src/index.ts");

const HOST = "https://demos.handsontable.com";
const METER = (id) => `session-meter:${id}`;

function envWithPointCapture() {
  const made = makeEnv();
  made.env.RUNNER_EVENTS = { writeDataPoint() {} };
  made.env.PREVIEW_HOST = "demos.handsontable.com";
  return made;
}

const call = (env, method, path, body) =>
  worker.fetch(
    new Request(`${HOST}${path}`, {
      method,
      ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    }),
    env,
    ctx,
  );

test("status for an id with no meter and no tombstone is refused, not booted", async () => {
  const { env } = envWithPointCapture();
  const res = await call(env, "GET", "/api/session/react-18-gone/status?port=5173");
  assert.equal(res.status, 410);
  assert.equal((await res.json()).error, "session closed");
});

test("a file write to such an id is refused too", async () => {
  const { env } = envWithPointCapture();
  const res = await call(env, "POST", "/api/session/react-18-gone/file", { path: "/app/a.js", contents: "x" });
  assert.equal(res.status, 410);
});

test("a file delete against such an id is a satisfied no-op", async () => {
  const { env } = envWithPointCapture();
  const res = await call(env, "DELETE", "/api/session/react-18-gone/file?path=a.js");
  assert.equal(res.status, 204);
});

test("a tombstoned id is still refused even though its meter is gone", async () => {
  const { env } = envWithPointCapture();
  await env.CACHE.put("session-tombstone:react-18-dead", "destroyed");
  const res = await call(env, "GET", "/api/session/react-18-dead/status?port=5173");
  assert.equal(res.status, 410);
});

test("a metered session passes the gate", async () => {
  const { env } = envWithPointCapture();
  await env.CACHE.put(
    METER("react-18-live"),
    JSON.stringify({ startedAt: Date.now(), meteredThrough: Date.now(), instanceType: "standard-3" }),
  );
  const res = await call(env, "GET", "/api/session/react-18-live/status?port=5173");
  assert.equal(res.status, 500, "reached the sandbox stub, which the harness makes throw");
});

test("a tombstoned id is refused even while a meter is still on record", async () => {
  const { env } = envWithPointCapture();
  await env.CACHE.put("session-tombstone:react-18-both", "1");
  await env.CACHE.put(METER("react-18-both"), JSON.stringify({ startedAt: 1, meteredThrough: 1, instanceType: "standard-3" }));
  const res = await call(env, "GET", "/api/session/react-18-both/status?port=5173");
  assert.equal(res.status, 410);
});

test("a KV read failure fails open: the session is not refused", async () => {
  const { env } = envWithPointCapture();
  const get = env.CACHE.get.bind(env.CACHE);
  env.CACHE.get = async (key, ...rest) => {
    if (key.startsWith("session-meter:")) throw new Error("KV unavailable");
    return get(key, ...rest);
  };
  const res = await call(env, "GET", "/api/session/react-18-kv/status?port=5173");
  assert.equal(res.status, 500, "reached the sandbox stub, which the harness makes throw");
});

test("at new_blocked an unknown id still gets the budget's own answer, not the generic 410", async () => {
  const { env } = envWithPointCapture();
  await env.CACHE.put("budget:state", JSON.stringify({ enforced: true, tier: "new_blocked", settings: {}, asOf: Date.now() }));
  const res = await call(env, "GET", "/api/session/react-18-gone/status?port=5173");
  assert.ok([401, 503].includes(res.status), `got ${res.status}`);
});
