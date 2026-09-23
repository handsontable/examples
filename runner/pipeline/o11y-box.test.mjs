// Route-level proof for `GrafanaBox` (workers/o11y/src/box.ts, ADR-0041 §A),
// driven through the REAL class — not a re-declared copy of its checks.
// `@cloudflare/containers` is stubbed (cloudflare-containers-stub.mjs, via
// o11y-worker-hooks.mjs) since the real package only loads inside workerd;
// `InboxWriter` is an in-memory fake recording every `recordWake` call.
//
// Run: node --experimental-strip-types --test pipeline/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { hooks, defaultHooks } from "./fixtures/cloudflare-containers-stub.mjs";

register("./fixtures/o11y-worker-hooks.mjs", import.meta.url);

const { GrafanaBox } = await import("../workers/o11y/src/box.ts");

// --- fakes -------------------------------------------------------------

function makeStorage() {
  const map = new Map();
  return {
    async get(key) {
      return map.get(key);
    },
    async put(key, value) {
      map.set(key, value);
    },
    _map: map,
  };
}

function makeInboxWriter({ throwOn } = {}) {
  const calls = [];
  const stub = {
    async recordWake(wakeId, reason) {
      calls.push({ wakeId, reason });
      if (throwOn) throw new Error(throwOn);
    },
  };
  const namespace = {
    jurisdiction(j) {
      assert.equal(j, "eu", "InboxWriter must be addressed with .jurisdiction(\"eu\")");
      return {
        getByName(name) {
          assert.equal(name, "main", "InboxWriter must be addressed as the \"main\" instance");
          return stub;
        },
      };
    },
  };
  return { namespace, calls };
}

function makeEnv(overrides = {}) {
  const { namespace: inboxWriterNamespace, calls: inboxWriterCalls } = makeInboxWriter(overrides.inboxWriter);
  const env = {
    INBOX_WRITER: inboxWriterNamespace,
    GRAFANA_BOX: { jurisdiction: () => ({ getByName: () => ({}) }) },
    CLOUDFLARE_ACCOUNT_ID: "test-account-id",
    LOKI_S3_ACCESS_KEY_ID: "test-key-id",
    LOKI_S3_SECRET_ACCESS_KEY: "test-secret",
    AE_SQL_TOKEN: "test-ae-token",
    SLACK_WEBHOOK_URL: "https://hooks.slack.example/should-never-appear",
    O11Y_ENV: "production",
    ...overrides.env,
  };
  return { env, inboxWriterCalls };
}

function makeBox(envOverrides = {}) {
  const { env, inboxWriterCalls } = makeEnv(envOverrides);
  const ctx = { storage: makeStorage() };
  const box = new GrafanaBox(ctx, env);
  return { box, ctx, env, inboxWriterCalls };
}

test.beforeEach(() => {
  Object.assign(hooks, defaultHooks());
});

// --- wake() --------------------------------------------------------------

test("wake(): consecutive wakes (after a stop) mint distinct ids, and start() always carries the NEW id", async () => {
  const { box, inboxWriterCalls } = makeBox();
  const startedEnvVars = [];
  hooks.start = async (self, startOptions) => {
    startedEnvVars.push(startOptions.envVars);
    self._state = { status: "running", lastChange: Date.now() };
  };

  const first = await box.wake("visit");
  // Simulate the container having fully stopped since (a fresh wake cycle):
  // record what onStop would, and put the stub's own state back to
  // "stopped" the way a real container exit does.
  await box.onStop({ exitCode: 0, reason: "exit" });
  box._state = { status: "stopped", lastChange: Date.now() };

  const second = await box.wake("visit");

  assert.notEqual(first.wakeId, second.wakeId, "each wake mints a fresh id");
  assert.equal(startedEnvVars.length, 2);
  assert.equal(startedEnvVars[0].WAKE_ID, first.wakeId);
  assert.equal(startedEnvVars[1].WAKE_ID, second.wakeId);
  assert.notEqual(startedEnvVars[1].WAKE_ID, first.wakeId, "the second start never carries the first wake's id");
  assert.deepEqual(inboxWriterCalls, [
    { wakeId: first.wakeId, reason: "visit" },
    { wakeId: second.wakeId, reason: "visit" },
  ]);
});

test("wake(): idempotent while already running/healthy — no second recordWake, no second start()", async () => {
  const { box, inboxWriterCalls } = makeBox();
  let startCalls = 0;
  hooks.start = async (self) => {
    startCalls++;
    self._state = { status: "running", lastChange: Date.now() };
  };

  const first = await box.wake("backlog");
  const second = await box.wake("backlog");

  assert.equal(second.wakeId, first.wakeId, "the already-running wake's id is returned, not a new one");
  assert.equal(startCalls, 1, "start() is called exactly once");
  assert.equal(inboxWriterCalls.length, 1, "recordWake is called exactly once");
});

test("wake(): concurrent calls on a stopped box collapse into ONE start (in-flight promise)", async () => {
  const { box, inboxWriterCalls } = makeBox();
  let startCalls = 0;
  let resolveStart;
  hooks.start = async (self) => {
    startCalls++;
    await new Promise((resolve) => {
      resolveStart = resolve;
    });
    self._state = { status: "running", lastChange: Date.now() };
  };

  const p1 = box.wake("visit");
  const p2 = box.wake("visit");
  // Let both callers reach the in-flight await before resolving start().
  await new Promise((resolve) => setTimeout(resolve, 10));
  resolveStart();
  const [r1, r2] = await Promise.all([p1, p2]);

  assert.equal(r1.wakeId, r2.wakeId);
  assert.equal(startCalls, 1);
  assert.equal(inboxWriterCalls.length, 1);
});

test("wake(): recordWake rejecting means start() is never called (fail closed)", async () => {
  const { box, inboxWriterCalls } = makeBox({ inboxWriter: { throwOn: "InboxWriter unavailable" } });
  let startCalls = 0;
  hooks.start = async (self) => {
    startCalls++;
    self._state = { status: "running", lastChange: Date.now() };
  };

  await assert.rejects(() => box.wake("visit"), /InboxWriter unavailable/);
  assert.equal(startCalls, 0, "start() must not be called when recordWake rejects");
  assert.equal(inboxWriterCalls.length, 1, "recordWake was attempted exactly once");
});

test("wake(): missing LOKI_S3_* credentials refuses to start, and never calls recordWake with a doomed wakeId first turning into a started container", async () => {
  const { box } = makeBox({ env: { LOKI_S3_ACCESS_KEY_ID: undefined } });
  let startCalls = 0;
  hooks.start = async () => {
    startCalls++;
  };
  await assert.rejects(() => box.wake("visit"), /LOKI_S3_ACCESS_KEY_ID/);
  assert.equal(startCalls, 0);
});

test("wake(): envVars never include SLACK_WEBHOOK_URL, and the only GF_* key is GF_SERVER_ROOT_URL", async () => {
  const { box } = makeBox();
  let envVars;
  hooks.start = async (self, startOptions) => {
    envVars = startOptions.envVars;
    self._state = { status: "running", lastChange: Date.now() };
  };
  await box.wake("visit");

  assert.ok(envVars, "start() was called with envVars");
  assert.ok(!("SLACK_WEBHOOK_URL" in envVars), "SLACK_WEBHOOK_URL must never reach the container");
  assert.ok(
    !JSON.stringify(envVars).includes("hooks.slack.example"),
    "the Slack webhook value must not leak into any envVar",
  );
  const gfKeys = Object.keys(envVars).filter((k) => k.startsWith("GF_"));
  assert.deepEqual(gfKeys, ["GF_SERVER_ROOT_URL"]);
});

test("wake(): production ClickHouse envVars use the single Authorization: Bearer header shape", async () => {
  const { box } = makeBox();
  let envVars;
  hooks.start = async (self, startOptions) => {
    envVars = startOptions.envVars;
    self._state = { status: "running", lastChange: Date.now() };
  };
  await box.wake("visit");

  assert.equal(envVars.O11Y_CLICKHOUSE_HEADER1_NAME, "Authorization");
  assert.equal(envVars.O11Y_CLICKHOUSE_HEADER1_VALUE, "Bearer test-ae-token");
  assert.match(envVars.O11Y_CLICKHOUSE_URL, /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/.+\/analytics_engine\/sql$/);
  assert.match(envVars.LOKI_S3_ENDPOINT, /\.eu\.r2\.cloudflarestorage\.com$/);
  assert.equal(envVars.LOKI_S3_INSECURE, "false", "production R2 is always real TLS");
});

// --- containerFetch(): the live block and the no-auto-start gate ---------

test("containerFetch(): /grafana/api/live/ws is refused with 404 without starting the container", async () => {
  const { box } = makeBox();
  let containerFetchCalls = 0;
  hooks.containerFetch = async () => {
    containerFetchCalls++;
    return new Response("should not be reached", { status: 200 });
  };

  const res = await box.containerFetch(new Request("https://box.example/grafana/api/live/ws"));
  assert.equal(res.status, 404);
  assert.equal(containerFetchCalls, 0, "the block happens before the container is ever touched");
  assert.equal((await box.getState()).status, "stopped", "checking the live path must not start the container");
});

test("containerFetch(): bare /api/live/ and a percent-encoded variant are also refused", async () => {
  const { box } = makeBox();
  hooks.containerFetch = async () => new Response("should not be reached", { status: 200 });

  for (const path of ["/api/live/ws", "/grafana/api/%6Cive/ws", "//grafana//api//live//ws"]) {
    const res = await box.containerFetch(new Request(`https://box.example${path}`));
    assert.equal(res.status, 404, `expected 404 for ${path}`);
  }
});

test("containerFetch(): any websocket Upgrade request is refused regardless of path", async () => {
  const { box } = makeBox();
  hooks.containerFetch = async () => new Response("should not be reached", { status: 200 });

  const res = await box.containerFetch(
    new Request("https://box.example/grafana/", { headers: { upgrade: "websocket" } }),
  );
  assert.equal(res.status, 404);
});

test("containerFetch(): a non-live path still reaches the container once it is running", async () => {
  const { box } = makeBox();
  hooks.start = async (self) => {
    self._state = { status: "running", lastChange: Date.now() };
  };
  hooks.containerFetch = async () => new Response("ok", { status: 200 });
  await box.wake("visit");

  const res = await box.containerFetch(new Request("https://box.example/grafana/"));
  assert.equal(res.status, 200);
});

test("containerFetch(): refuses with 503 and never auto-starts when the box is stopped", async () => {
  const { box } = makeBox();
  let startCalls = 0;
  let containerFetchCalls = 0;
  hooks.start = async () => {
    startCalls++;
  };
  hooks.containerFetch = async () => {
    containerFetchCalls++;
    return new Response("ok", { status: 200 });
  };

  const res = await box.containerFetch(new Request("https://box.example/grafana/"));
  assert.equal(res.status, 503);
  assert.equal(startCalls, 0, "an unrelated request must never trigger a wake");
  assert.equal(containerFetchCalls, 0);
});

// --- onStop(): records what it was told, nothing more ---------------------

test("onStop(): records exactly what it received, tagged with the wake it was tracking", async () => {
  const { box } = makeBox();
  hooks.start = async (self) => {
    self._state = { status: "running", lastChange: Date.now() };
  };
  const { wakeId } = await box.wake("visit");

  await box.onStop({ exitCode: 0, reason: "exit" });
  const recorded = await box.lastStop();

  assert.equal(recorded.wakeId, wakeId);
  assert.equal(recorded.exitCode, 0);
  assert.equal(recorded.reason, "exit");
  assert.ok(typeof recorded.at === "number");
});

test("onStop(): a host loss and a clean stop() report identically — onStop cannot and does not distinguish them", async () => {
  const { box } = makeBox();
  hooks.start = async (self) => {
    self._state = { status: "running", lastChange: Date.now() };
  };
  await box.wake("visit");

  // ADR-0041 §A: onStop reports { exitCode: 0, reason: "exit" } for BOTH a
  // Worker-initiated stop() and an unobserved host loss.
  await box.onStop({ exitCode: 0, reason: "exit" });
  const recorded = await box.lastStop();
  assert.equal(recorded.exitCode, 0);
  assert.equal(recorded.reason, "exit");
  // onStop's job is only to record this — nothing here claims the stop was
  // clean. The marker in the Loki bucket is the only thing that claim rests
  // on (T03's ledger), never this record.
});
