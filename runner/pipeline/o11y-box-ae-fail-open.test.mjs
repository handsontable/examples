// wake() must not depend on the ae.internal interception: the SDK's start()
// throws when the interception setup fails, and the box (Grafana, Loki, the
// drain) has to come up without the ClickHouse route instead of staying down.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { hooks, defaultHooks } from "./fixtures/cloudflare-containers-stub.mjs";
register("./fixtures/o11y-worker-hooks.mjs", import.meta.url);
const { GrafanaBox } = await import("../workers/o11y/src/box.ts");
const { AE_COLUMNS } = await import("@handsontable/demo-runtime/telemetry");

function makeBox(container) {
  const map = new Map();
  const ae = { points: [], writeDataPoint(p) { this.points.push(p); } };
  const ctx = { ...(container ? { container } : {}), waitUntil: (p) => Promise.resolve(p).catch(() => {}), storage: { get: async (k) => map.get(k), put: async (k, v) => void map.set(k, v), delete: async (k) => map.delete(k) } };
  const env = {
    INBOX_WRITER: { jurisdiction: () => ({ getByName: () => ({ recordWake: async () => {} }) }) },
    GRAFANA_BOX: {}, CLOUDFLARE_ACCOUNT_ID: "acct", LOKI_S3_ACCESS_KEY_ID: "k", LOKI_S3_SECRET_ACCESS_KEY: "s",
    AE_SQL_TOKEN: "t", O11Y_ENV: "production", RUNNER_EVENTS: ae,
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

/** The `o11y.ae_degraded` points the box wrote to its (fake) AE binding. */
function degradedPoints(box) {
  const slot = (name) => Number(/^blob(\d+)$/.exec(AE_COLUMNS[name])[1]) - 1;
  const dslot = Number(/^double(\d+)$/.exec(AE_COLUMNS.count)[1]) - 1;
  return box.env.RUNNER_EVENTS.points
    .filter((p) => p.indexes[0] === "o11y.ae_degraded")
    .map((p) => ({ metric: p.indexes[0], reason: p.blobs[slot("reason")], count: p.doubles[dslot] }));
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
      assert.deepEqual(degradedPoints(box), [{ metric: "o11y.ae_degraded", reason: "start", count: 1 }], "one alertable point");
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

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

function captureUnhandled() {
  const seen = [];
  const onUnhandled = (reason) => seen.push(reason);
  process.on("unhandledRejection", onUnhandled);
  return { seen, stop: () => process.off("unhandledRejection", onUnhandled) };
}

test("a rejected constructor-time interception refresh is logged, not an unhandled rejection", async () => {
  hooks.applyOutboundInterception = async () => {
    throw new Error("ctx.exports.ContainerProxy is undefined");
  };
  const unhandled = captureUnhandled();
  const logs = captureErrors();
  try {
    const box = makeBox({ running: true });
    await settle();
    assert.deepEqual(degradedPoints(box), [{ metric: "o11y.ae_degraded", reason: "reload", count: 1 }]);
    assert.deepEqual(unhandled.seen, [], "nothing escapes as an unhandled rejection");
    const events = logs.out.map((s) => JSON.parse(s)).filter((e) => e.event === "o11y.ae_outbound.degraded");
    assert.equal(events.length, 1);
    assert.match(events[0].message, /ContainerProxy is undefined/);
  } finally {
    unhandled.stop();
    logs.restore();
  }
});

test("the refresh still rejects for its awaiting caller and the start path logs the failure once", async () => {
  trace("interceptOutboundHttp rejected");
  const logs = captureErrors();
  try {
    const box = makeBox();
    await assert.rejects(box.refreshOutboundInterception(), /interceptOutboundHttp rejected/);
    const rec = await box.wake("visit");
    assert.ok(rec.wakeId);
    const degraded = logs.out.map((s) => JSON.parse(s)).filter((e) => e.event === "o11y.ae_outbound.degraded");
    // one from the direct refresh above, one from the wake's fail-open start
    assert.equal(degraded.length, 2);
    assert.equal(degraded.filter((e) => e.wakeId === rec.wakeId).length, 1, "the wake's start logs once, not twice");
  } finally {
    logs.restore();
  }
});

test("the SDK still has the unawaited constructor call and the private method the override relies on", () => {
  const sdk = new URL("../workers/o11y/node_modules/@cloudflare/containers/dist/lib/container.js", import.meta.url);
  const src = readFileSync(sdk, "utf8");
  assert.match(src, /^\s*async applyOutboundInterception\(\) \{/m);
  assert.match(src, /this\.applyOutboundInterceptionPromise = this\.applyOutboundInterception\(\);/);
  assert.ok(Object.hasOwn(GrafanaBox.prototype, "applyOutboundInterception"), "GrafanaBox overrides it");
});
