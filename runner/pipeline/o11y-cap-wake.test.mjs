// ADR-0041 §G's "crossing the cap stops backlog wakes; a Grafana visit
// still wakes the box". Drives the real merged `scheduled()` handler
// (`workers/o11y/src/index.ts`) and the real `handleGrafana`
// (`grafana/proxy.ts`) against a real `InboxWriter` Durable Object, so
// `drainsPaused` really is read from the same storage
// `alerts/index.ts#o11yCapRule` writes to via `InboxWriter.setDrainsPaused`
// — not a fake that could silently drift from the real RPC surface.
// Run: node --experimental-strip-types --test pipeline/o11y-cap-wake.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

import { hooks, defaultHooks } from "./fixtures/cloudflare-containers-stub.mjs";

register("./fixtures/o11y-worker-hooks.mjs", import.meta.url);

const { default: worker, InboxWriter } = await import("../workers/o11y/src/index.ts");
const { GrafanaBox } = await import("../workers/o11y/src/box.ts");
const { handleGrafana } = await import("../workers/o11y/src/grafana/proxy.ts");
const { makeEnv, ctx } = await import("./fixtures/o11y-harness.mjs");
const { inboxKeyStorageKey } = await import("@handsontable/demo-runtime/telemetry");

/** A minimal `.list()`-capable R2 fake — `InboxWriter.backlog()`
 *  (`ledger.ts#computeBacklog`) reads `{ key, size, uploaded }` per object;
 *  `o11y-harness.mjs#makeR2Bucket` doesn't implement `list()`, so this
 *  stays local rather than growing that shared fixture for one caller. */
function makeListableR2(objects) {
  return {
    async list({ prefix } = {}) {
      const filtered = objects.filter((o) => !prefix || o.key.startsWith(prefix));
      return { objects: filtered, truncated: false };
    },
  };
}

function makeGrafanaBoxRecorder(overrides = {}) {
  const calls = [];
  const stub = {
    async wake(reason) {
      calls.push(reason);
    },
    async isReady() {
      return overrides.ready ?? true;
    },
    async noteVisitorActivity() {},
    // `/grafana/*` proxies through the DO's `fetch()` handler (never
    // the `containerFetch` RPC method — see grafana/proxy.ts).
    async fetch() {
      return new Response("grafana-body", { status: 200 });
    },
  };
  const namespace = { jurisdiction() { return this; }, getByName() { return stub; } };
  return { calls, namespace };
}

test("backlog wake: refused while drainsPaused; the SAME backlog wakes the box once cleared", async () => {
  // `worker.scheduled()` also runs `runAlerts` (the merged handler wires
  // all three: heartbeat stamp, backlog wake, alert evaluation — see
  // index.ts). Left at the harness's default `O11Y_ENV: "production"`,
  // `runAlerts`'s 7 AE-query rules would each attempt a REAL fetch to
  // Cloudflare's Analytics Engine SQL API — slow and non-hermetic in a
  // suite that must run offline. `O11Y_ENV: "local"` plus an
  // immediately-refusing loopback URL (matches `o11y-alerts.test.mjs`'s
  // own "runAlerts: a real query failure" test) makes every one of those
  // queries fail fast instead; `runAlerts` already swallows a per-rule
  // failure into its own `errors` map rather than
  // throwing, so this has no effect on the wake behaviour under test here.
  const { env, doStorage } = makeEnv(InboxWriter, {
    env: { O11Y_ENV: "local", RUNNER_EVENTS_CLICKHOUSE_URL: "http://127.0.0.1:1" },
  });

  // A backlog old enough to trigger a wake attempt on its own merits (> 1h).
  const objectKey = "inbox/worker/2026-09-01/00/000000000001.ndjson.gz";
  env.O11Y_INBOX = makeListableR2([
    { key: objectKey, size: 1024, uploaded: new Date(Date.now() - 2 * 60 * 60 * 1000) },
  ]);
  await doStorage.put({ [inboxKeyStorageKey(objectKey)]: "written" });

  const grafanaBox = makeGrafanaBoxRecorder();
  env.GRAFANA_BOX = grafanaBox.namespace;

  const writer = env.INBOX_WRITER.jurisdiction("eu").get();
  assert.equal(await writer.drainsPaused(), false, "sanity: not paused yet");

  // The o11y spend cap fires (alerts/index.ts#runAlerts, on a real spend-cap
  // crossing) and pauses drains through the exact same RPC method this test
  // now drives directly.
  await writer.setDrainsPaused(true);

  await worker.scheduled({ cron: "*/10 * * * *" }, env, ctx);
  await ctx.drain();
  assert.deepEqual(grafanaBox.calls, [], "a backlog wake must be refused while drainsPaused");

  // Resolve the cap (a raised budget, or month rollover) — the identical
  // backlog now wakes the box; nothing else about the backlog changed.
  await writer.setDrainsPaused(false);
  await worker.scheduled({ cron: "*/10 * * * *" }, env, ctx);
  await ctx.drain();
  assert.deepEqual(grafanaBox.calls, ["backlog"], "once resolved, the same backlog wakes the box");
});

test("Grafana visit wake: unaffected by drainsPaused (still wakes the box)", async () => {
  const { env } = makeEnv(InboxWriter);
  const grafanaBox = makeGrafanaBoxRecorder();
  env.GRAFANA_BOX = grafanaBox.namespace;
  env.DEV_ADMIN = "dev@handsontable.com"; // local session bypass, K1 (O11Y_ENV is "production" in this harness by default)
  env.O11Y_ENV = "local";

  const writer = env.INBOX_WRITER.jurisdiction("eu").get();
  await writer.setDrainsPaused(true);
  assert.equal(await writer.drainsPaused(), true, "sanity: the cap is active for this request");

  const req = new Request("https://demos.handsontable.com/grafana/d/abc");
  const res = await handleGrafana(req, env, ctx);

  assert.equal(res.status, 200);
  assert.equal(await res.text(), "grafana-body", "the box answered — the visit wake was not refused");
  assert.deepEqual(grafanaBox.calls, ["visit"], "ADR §G: 'visit wakes still work' — drainsPaused must never gate this path");
});

// With the budget overridden to $0.10 and the spend at $0.32, the same
// tick that fires o11y-spend-cap must still wake the box for the backlog:
// `scheduled()` runs the backlog wake beside `runAlerts`, so it reads
// `drainsPaused` before this tick's spend-cap result sets it. This drives
// the real `scheduled()` with the spend coming from the API binding (the
// value the admin override feeds), not a hand-set flag.
test("the tick whose spend-cap fires wakes nothing for the backlog; the tick after the cap resolves unpauses and wakes", async () => {
  let spend = { spendUsd: 0.32, capUsd: 0.1 }; // the Round 10 override
  const { env, doStorage } = makeEnv(InboxWriter, {
    env: {
      O11Y_ENV: "local",
      RUNNER_EVENTS_CLICKHOUSE_URL: "http://127.0.0.1:1",
      API: { fetch: async () => new Response(null, { status: 204 }), o11ySpend: async () => spend },
    },
  });
  const objectKey = "inbox/worker/2026-09-01/00/000000000002.ndjson.gz";
  env.O11Y_INBOX = makeListableR2([
    { key: objectKey, size: 1024, uploaded: new Date(Date.now() - 2 * 60 * 60 * 1000) },
  ]);
  await doStorage.put({ [inboxKeyStorageKey(objectKey)]: "written" });
  const grafanaBox = makeGrafanaBoxRecorder();
  env.GRAFANA_BOX = grafanaBox.namespace;
  const writer = env.INBOX_WRITER.jurisdiction("eu").get();
  assert.equal(await writer.drainsPaused(), false, "precondition: not paused before the tick");

  await worker.scheduled({ cron: "*/10 * * * *" }, env, ctx);
  await ctx.drain();
  assert.equal(await writer.drainsPaused(), true, "the tick that fires the cap pauses drains");
  assert.deepEqual(grafanaBox.calls, [], "and the same tick must not wake the box for the backlog");

  spend = { spendUsd: 0.32, capUsd: 15 }; // override removed, back to the default budget
  await worker.scheduled({ cron: "*/10 * * * *" }, env, ctx);
  await ctx.drain();
  assert.equal(await writer.drainsPaused(), false, "the next tick after the cap resolves unpauses");
  assert.deepEqual(grafanaBox.calls, ["backlog"], "and wakes the box for the waiting backlog");
});

function makeMapStorage() {
  const map = new Map();
  return { get: async (k) => map.get(k), put: async (k, v) => void map.set(k, v), delete: async (k) => map.delete(k) };
}

// The real InboxWriter flag and the real GrafanaBox: a visit wake that is still
// being served when the cap pauses drains must resume draining on its own once
// the cron clears the pause, with no new wake.
test("an awake box paused by the cap resumes draining after the cron clears the pause", async () => {
  Object.assign(hooks, defaultHooks());
  hooks.start = async (self) => {
    self._state = { status: "running", lastChange: Date.now() };
    await self.onStart();
  };
  hooks.containerFetch = async () => new Response(null, { status: 200 });

  let spend = { spendUsd: 0.32, capUsd: 0.1 };
  const { env, doStorage } = makeEnv(InboxWriter, {
    env: {
      O11Y_ENV: "local",
      RUNNER_EVENTS_CLICKHOUSE_URL: "http://127.0.0.1:1",
      API: { fetch: async () => new Response(null, { status: 204 }), o11ySpend: async () => spend },
    },
  });
  const objectKey = "inbox/worker/2026-09-01/00/000000000003.ndjson.gz";
  env.O11Y_INBOX = {
    ...makeListableR2([{ key: objectKey, size: 1024, uploaded: new Date(Date.now() - 60 * 1000) }]),
    get: async () => null,
  };
  await doStorage.put({ [inboxKeyStorageKey(objectKey)]: "written" });
  const realWriter = env.INBOX_WRITER.jurisdiction("eu").get();

  let takes = 0;
  const writerForBox = new Proxy(realWriter, {
    get(target, prop) {
      if (prop === "nextWrittenKeys") return async (...a) => (takes++, target.nextWrittenKeys(...a));
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const boxEnv = { ...env, INBOX_WRITER: { getByName: () => writerForBox } };
  const boxCtx = { storage: makeMapStorage(), waitUntil: (p) => Promise.resolve(p).catch(() => {}) };
  const box = new GrafanaBox(boxCtx, boxEnv);
  const scheduled = [];
  box.schedule = async (when, callback, payload) => void scheduled.push({ when, callback, payload });
  // The cron reads the real box's awake state, as production does.
  env.GRAFANA_BOX = {
    jurisdiction() { return this; },
    getByName: () => ({ isAwake: () => box.isAwake(), wake: async () => {} }),
  };
  await box.wake("visit");
  await box.noteVisitorActivity();
  const wake = await boxCtx.storage.get("wake");

  // The tick that fires the cap pauses drains while the box is awake.
  await worker.scheduled({ cron: "*/10 * * * *" }, env, ctx);
  await ctx.drain();
  assert.equal(await realWriter.drainsPaused(), true, "precondition: the cap paused drains");

  scheduled.length = 0;
  await box.drainStep({ wakeId: wake.wakeId });
  assert.equal(takes, 0, "paused: nothing taken");
  assert.equal(scheduled.filter((s) => s.callback === "drainStep").length, 1, "the chain keeps a slow recheck");

  spend = { spendUsd: 0.32, capUsd: 15 };
  await worker.scheduled({ cron: "*/10 * * * *" }, env, ctx);
  await ctx.drain();
  assert.equal(await realWriter.drainsPaused(), false, "precondition: the cron cleared the pause");

  await box.drainStep({ wakeId: wake.wakeId });
  assert.ok(takes >= 1, "the rescheduled step drains again without a new wake");
});
