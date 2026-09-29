// wake() must not depend on the ae.internal interception: the SDK's start()
// throws when the interception setup fails, and the box (Grafana, Loki, the
// drain) has to come up without the ClickHouse route instead of staying down.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { hooks, defaultHooks } from "./fixtures/cloudflare-containers-stub.mjs";
register("./fixtures/o11y-worker-hooks.mjs", import.meta.url);
const { GrafanaBox } = await import("../workers/o11y/src/box.ts");

function makeBox() {
  const map = new Map();
  const ctx = { storage: { get: async (k) => map.get(k), put: async (k, v) => void map.set(k, v), delete: async (k) => map.delete(k) } };
  const env = {
    INBOX_WRITER: { jurisdiction: () => ({ getByName: () => ({ recordWake: async () => {} }) }) },
    GRAFANA_BOX: {}, CLOUDFLARE_ACCOUNT_ID: "acct", LOKI_S3_ACCESS_KEY_ID: "k", LOKI_S3_SECRET_ACCESS_KEY: "s",
    AE_SQL_TOKEN: "t", O11Y_ENV: "production",
  };
  return new GrafanaBox(ctx, env);
}

/** Records `usingInterception` at each interception attempt and container start. */
function trace(interceptionFailure) {
  const calls = { intercept: [], start: [] };
  hooks.applyOutboundInterception = async (self) => {
    calls.intercept.push(self.usingInterception);
    if (interceptionFailure) throw new Error(interceptionFailure);
  };
  const realStart = hooks.start;
  hooks.start = async (self, ...rest) => {
    calls.start.push(self.usingInterception);
    return realStart(self, ...rest);
  };
  return calls;
}

function captureErrors() {
  const out = [];
  const original = console.error;
  console.error = (m) => out.push(String(m));
  return { out, restore: () => (console.error = original) };
}

test.beforeEach(() => Object.assign(hooks, defaultHooks()));

for (const failure of [
  "ctx.exports.ContainerProxy is undefined, export ContainerProxy from the containers package in your worker entrypoint",
  "interceptOutboundHttp rejected",
]) {
  test(`wake() still starts the box when the interception setup fails (${failure.slice(0, 30)})`, async () => {
    const box = makeBox();
    assert.equal(box.usingInterception, true, "the stub arms interception for a class with outboundByHost, as the SDK does");
    const calls = trace(failure);
    const logs = captureErrors();
    try {
      const rec = await box.wake("visit");
      assert.ok(rec.wakeId);
      assert.deepEqual(calls.intercept, [true], "interception attempted once, on the first start only");
      assert.deepEqual(calls.start, [false], "the container start ran with interception off");
      assert.equal(box.usingInterception, true, "interception re-armed for the next wake");
      const ev = logs.out.map((s) => JSON.parse(s)).find((e) => e.event === "o11y.ae_outbound.degraded");
      assert.ok(ev, "degraded event logged");
      assert.equal(ev.wakeId, rec.wakeId);
      assert.match(ev.message, new RegExp(failure.slice(0, 20)));
    } finally {
      logs.restore();
    }
  });
}

test("a healthy interception setup starts once with interception on and logs nothing", async () => {
  const box = makeBox();
  const calls = trace(null);
  const logs = captureErrors();
  try {
    await box.wake("visit");
    assert.deepEqual(calls.intercept, [true]);
    assert.deepEqual(calls.start, [true]);
    assert.equal(logs.out.filter((s) => s.includes("ae_outbound")).length, 0);
  } finally {
    logs.restore();
  }
});

test("a start failure with the container already up is not retried or swallowed", async () => {
  const box = makeBox();
  let calls = 0;
  hooks.start = async (self) => {
    calls++;
    self._state = { status: "running", lastChange: Date.now() };
    throw new Error("port never opened");
  };
  await assert.rejects(box.wake("visit"), /port never opened/);
  assert.equal(calls, 1);
});

test("a start failure with interception unused is not retried", async () => {
  const box = makeBox();
  box.usingInterception = false;
  let calls = 0;
  hooks.start = async () => {
    calls++;
    throw new Error("image pull failed");
  };
  await assert.rejects(box.wake("visit"), /image pull failed/);
  assert.equal(calls, 1);
});

test("if the retry also fails, wake() rejects with the retry's error and interception is re-armed", async () => {
  const box = makeBox();
  trace("interception down");
  let n = 0;
  hooks.start = async () => {
    throw new Error(`fail ${++n}`);
  };
  const logs = captureErrors();
  try {
    await assert.rejects(box.wake("visit"), /fail 1/);
    assert.equal(box.usingInterception, true);
  } finally {
    logs.restore();
  }
});
