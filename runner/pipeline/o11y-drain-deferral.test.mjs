// Deferred keys (a source map or inbox read that keeps failing) are skipped for
// the rest of the wake, so they neither starve the batch nor end the drain.
// Real GrafanaBox over a real InboxWriter; only R2 and the Loki push are faked.
// Run: node --experimental-strip-types --test pipeline/o11y-drain-deferral.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

import { hooks, defaultHooks } from "./fixtures/cloudflare-containers-stub.mjs";

register("./fixtures/o11y-worker-hooks.mjs", import.meta.url);

const { InboxWriter } = await import("../workers/o11y/src/index.ts");
const { GrafanaBox } = await import("../workers/o11y/src/box.ts");
const { makeEnv } = await import("./fixtures/o11y-harness.mjs");
const { inboxKey, inboxKeyStorageKey } = await import("@handsontable/demo-runtime/telemetry");

const PAUSED_RECHECK_MS = 60_000;

async function gzip(lines) {
  const stream = new Blob([lines.join("\n") + "\n"]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const nowNano = () => String(BigInt(Date.now()) * 1_000_000n);

/** One recent exception whose frame needs a source map. */
const exceptionObject = () =>
  gzip([
    JSON.stringify({
      resource: { attributes: [{ key: "service.version", value: { stringValue: "realsha" } }] },
      scopeLogs: [
        {
          logRecords: [
            {
              timeUnixNano: nowNano(),
              body: { stringValue: "TypeError: x\n    at f (https://demos.handsontable.com/assets/app.js:1:1)" },
              attributes: [{ key: "hot.kind", value: { stringValue: "exception" } }],
            },
          ],
        },
      ],
    }),
  ]);

const plainObject = (text) =>
  gzip([
    JSON.stringify({
      resource: { attributes: [] },
      scopeLogs: [{ logRecords: [{ timeUnixNano: nowNano(), body: { stringValue: text } }] }],
    }),
  ]);

function mapStorage() {
  const map = new Map();
  return { get: async (k) => map.get(k), put: async (k, v) => void map.set(k, v), delete: async (k) => map.delete(k) };
}

/** `deferredCount` browser keys whose map read throws, then `plainCount` worker keys. */
async function setup({ deferredCount, plainCount = 1, visitor = false, failMode = "map", deferredKeysMax }) {
  Object.assign(hooks, defaultHooks());
  hooks.start = async (self) => {
    self._state = { status: "running", lastChange: Date.now() };
  };
  let stops = 0;
  hooks.stop = async (self) => {
    stops++;
    self._state = { status: "stopped", lastChange: Date.now() };
  };
  const pushed = [];
  hooks.containerFetch = async (_self, requestOrUrl) => {
    const request = requestOrUrl instanceof Request ? requestOrUrl : null;
    if (request && request.url.includes("/otlp/v1/logs")) {
      pushed.push(request);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 200 });
  };

  const { env, doStorage } = makeEnv(InboxWriter);
  const deferredKeys = [];
  const plainKeys = [];
  const objects = new Map();
  for (let i = 0; i < deferredCount; i++) {
    const key = inboxKey("browser", new Date(), i);
    deferredKeys.push(key);
    objects.set(key, await exceptionObject());
    await doStorage.put({ [inboxKeyStorageKey(key)]: "written" });
  }
  for (let i = 0; i < plainCount; i++) {
    const key = inboxKey("worker", new Date(), i);
    plainKeys.push(key);
    objects.set(key, await plainObject(`plain-${i}`));
    await doStorage.put({ [inboxKeyStorageKey(key)]: "written" });
  }
  const failingInboxReads = failMode === "inbox";
  const counts = { mapGets: 0, inboxGets: 0 };
  env.O11Y_INBOX = {
    async get(key) {
      counts.inboxGets++;
      if (failingInboxReads && deferredKeys.includes(key)) throw new Error("R2 get timed out");
      const bytes = objects.get(key);
      return bytes ? { async arrayBuffer() { return bytes.buffer; } } : null;
    },
  };
  env.O11Y_MAPS = {
    async get() {
      counts.mapGets++;
      throw new Error("R2 get timed out");
    },
    async list() {
      return { objects: [{ key: "sourcemaps/realsha/assets/app.js.map" }], truncated: false };
    },
  };

  const writer = env.INBOX_WRITER.jurisdiction("eu").get();
  const boxEnv = {
    ...env,
    CLOUDFLARE_ACCOUNT_ID: "test-account-id",
    LOKI_S3_ACCESS_KEY_ID: "test-key-id",
    LOKI_S3_SECRET_ACCESS_KEY: "test-secret",
    GRAFANA_BOX: { jurisdiction: () => ({ getByName: () => ({}) }) },
    INBOX_WRITER: { jurisdiction: () => ({ getByName: () => writer }), getByName: () => writer },
  };
  const ctx = { storage: mapStorage(), waitUntil: (p) => Promise.resolve(p).catch(() => {}) };
  const box = new GrafanaBox(ctx, boxEnv);
  if (deferredKeysMax !== undefined) box.deferredKeysMax = deferredKeysMax;
  // The writer's wake resolution asks the box whether it is awake.
  env.GRAFANA_BOX = { jurisdiction() { return this; }, getByName: () => ({ isAwake: () => box.isAwake() }) };
  const scheduled = [];
  box.schedule = async (when, callback, payload) => void scheduled.push({ when, callback, payload });
  await box.wake(visitor ? "visit" : "backlog");
  if (visitor) await box.noteVisitorActivity();
  const wake = await ctx.storage.get("wake");
  scheduled.length = 0;

  /** Runs drainStep until it schedules nothing or the next step is the slow recheck. */
  async function runSteps(max = 20) {
    let steps = 0;
    while (steps < max) {
      scheduled.length = 0;
      await box.drainStep({ wakeId: wake.wakeId });
      steps++;
      const next = scheduled.find((s) => s.callback === "drainStep");
      if (!next || next.when.getTime() - Date.now() >= PAUSED_RECHECK_MS - 5000) break;
    }
    return steps;
  }
  return { box, writer, scheduled, wake, runSteps, deferredKeys, plainKeys, counts, pushed, stops: () => stops };
}

for (const failMode of ["map", "inbox"]) {
  test(`${failMode} deferral: ten deferred browser keys do not block the worker key behind them`, async (t) => {
    t.mock.method(console, "error", () => {});
    const s = await setup({ deferredCount: 10, failMode });
    await s.runSteps();

    assert.deepEqual(await s.writer.nextWrittenKeys(100), s.deferredKeys, "only the deferred keys remain written");
    assert.equal(s.pushed.length, 1, "the worker key reached Loki");
  });
}

test("deferred keys are read once per wake, not again on every later step", async (t) => {
  t.mock.method(console, "error", () => {});
  const s = await setup({ deferredCount: 3, plainCount: 25 });
  await s.runSteps(1);
  const afterFirst = s.counts.inboxGets;
  await s.runSteps();

  assert.deepEqual(await s.writer.nextWrittenKeys(100), s.deferredKeys);
  const laterReads = s.counts.inboxGets - afterFirst;
  assert.ok(laterReads <= 25, `later steps read only the not-yet-drained keys, got ${laterReads}`);
});

test("everything left deferred with a visitor present schedules a slow recheck that retries the deferred keys", async (t) => {
  t.mock.method(console, "error", () => {});
  const s = await setup({ deferredCount: 10, visitor: true });
  await s.runSteps();

  const recheck = s.scheduled.find((c) => c.callback === "drainStep");
  assert.ok(recheck, "the chain continues while a visitor holds the box");
  assert.ok(recheck.when.getTime() - Date.now() >= PAUSED_RECHECK_MS - 5000, "as a slow recheck");
  const readsBefore = s.counts.mapGets;

  s.scheduled.length = 0;
  await s.box.drainStep({ wakeId: s.wake.wakeId });
  assert.ok(s.counts.mapGets > readsBefore, "the recheck retries the deferred keys");
});

test("everything left deferred with no visitor ends the chain and stops the box", async (t) => {
  t.mock.method(console, "error", () => {});
  const s = await setup({ deferredCount: 10, visitor: false });
  await s.runSteps();

  assert.equal(s.scheduled.filter((c) => c.callback === "drainStep").length, 0);
  assert.equal(s.stops(), 1);
});

test("a visitor-held box still rechecks when the deferred set is full and a whole batch defers", async (t) => {
  t.mock.method(console, "error", () => {});
  const s = await setup({ deferredCount: 10, visitor: true, deferredKeysMax: 3 });
  await s.runSteps();

  const recheck = s.scheduled.find((c) => c.callback === "drainStep");
  assert.ok(recheck, "the chain continues while a visitor holds the box");
  assert.ok(recheck.when.getTime() - Date.now() >= PAUSED_RECHECK_MS - 5000, "as a slow recheck");
});
