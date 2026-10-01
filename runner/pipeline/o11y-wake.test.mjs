// GrafanaBox's wake/drain/stop orchestration (ADR-0041 §A) — driven through
// the real class. `schedule()` is monkey-patched per instance (the stub
// Container class has no scheduling machinery, and this suite only needs
// to prove what GrafanaBox schedules and when it decides to stop — not
// re-test Cloudflare's own alarm dispatch).
// Run: node --experimental-strip-types --test pipeline/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { hooks, defaultHooks } from "./fixtures/cloudflare-containers-stub.mjs";

register("./fixtures/o11y-worker-hooks.mjs", import.meta.url);

const { GrafanaBox } = await import("../workers/o11y/src/box.ts");
const { handleGrafana } = await import("../workers/o11y/src/grafana/proxy.ts");
const { wakingPageHtml } = await import("../workers/o11y/src/grafana/waking-page.ts");
const { AE_COLUMNS } = await import("@handsontable/demo-runtime/telemetry");

/** Reads a metric's `outcome` blob out of a fake AE point the way the real
 *  slot (`AE_COLUMNS.outcome`, e.g. `"blob8"`) addresses it — never a
 *  hardcoded array index, so a future contract slot renumbering cannot
 *  silently desync this test from what `toAePoint` actually wrote. */
function outcomeOf(point) {
  const slot = /^blob(\d+)$/.exec(AE_COLUMNS.outcome);
  return point.blobs[Number(slot[1]) - 1];
}

// Same pattern as outcomeOf, for the `reason` blob.
function reasonOf(point) {
  const slot = /^blob(\d+)$/.exec(AE_COLUMNS.reason);
  return point.blobs[Number(slot[1]) - 1];
}

// ---- fakes ------------------------------------------------------------

function makeStorage() {
  const map = new Map();
  return {
    async get(key) {
      return map.get(key);
    },
    async put(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      return map.delete(key);
    },
    _map: map,
  };
}

function makeInboxWriterStub(overrides = {}) {
  const calls = {
    resolveWakes: 0,
    markKeysProvisional: [],
    commitKeys: [],
    rejectKey: [],
    recordPartialReject: [],
    takeReopenedFlag: [],
    recordWakeReady: [],
  };
  return {
    async recordWake() {},
    // The box reports its wake-to-ready time on the first successful isReady().
    async recordWakeReady(wakeId, readyMs) {
      if (overrides.recordWakeReady) return overrides.recordWakeReady(wakeId, readyMs);
      calls.recordWakeReady.push({ wakeId, readyMs });
    },
    async resolveWakes() {
      calls.resolveWakes++;
    },
    // The o11y spend cap's pause flag, read at the top of every drainStep.
    async drainsPaused() {
      return overrides.drainsPaused ?? false;
    },
    async nextWrittenKeys(_limit, _excludeTenants, excludeKeys = []) {
      calls.nextWrittenKeys = (calls.nextWrittenKeys ?? 0) + 1;
      return (overrides.writtenKeys ?? []).filter((k) => !excludeKeys.includes(k));
    },
    // Defaults to "no reopened keys in this batch" — a test proving the
    // `reason: "reopen"` emission overrides this via `overrides.reopenedFlag`
    // (the same pattern `nextWrittenKeys` above uses).
    async takeReopenedFlag(inboxKeys) {
      calls.takeReopenedFlag.push(inboxKeys);
      return overrides.reopenedFlag ?? false;
    },
    async markKeysProvisional(wakeId, keys) {
      calls.markKeysProvisional.push({ wakeId, keys });
    },
    // See box.ts#drainStep and ledger.ts#commitKeys — a zero-bytes-pushed
    // key commits directly.
    async commitKeys(keys) {
      calls.commitKeys.push(keys);
    },
    async rejectKey(key, reason) {
      calls.rejectKey.push({ key, reason });
    },
    // Row 19 (drain partial-400 durability): a `provisional` outcome that
    // still carries a `reason` (drain.ts's partial-400 case) is logged here
    // — see box.ts#drainStep's own comment and ledger.ts#recordPartialReject.
    async recordPartialReject(key, reason) {
      calls.recordPartialReject.push({ key, reason });
    },
    calls,
  };
}

function makeEnv(overrides = {}) {
  const inboxWriterStub = overrides.inboxWriterStub ?? makeInboxWriterStub(overrides.inboxWriter);
  const inboxWriterNamespace = { jurisdiction: () => ({ getByName: () => inboxWriterStub }) };
  const r2Objects = overrides.r2Objects ?? new Map();
  const O11Y_INBOX = {
    async get(key) {
      const bytes = r2Objects.get(key);
      if (!bytes) return null;
      return { async arrayBuffer() { return bytes.buffer; } };
    },
  };
  const O11Y_MAPS = { async get() { return null; } };
  const ae = { points: [], writeDataPoint(p) { this.points.push(p); } };

  const env = {
    INBOX_WRITER: inboxWriterNamespace,
    GRAFANA_BOX: { jurisdiction: () => ({ getByName: () => ({}) }) },
    CLOUDFLARE_ACCOUNT_ID: "test-account-id",
    LOKI_S3_ACCESS_KEY_ID: "test-key-id",
    LOKI_S3_SECRET_ACCESS_KEY: "test-secret",
    AE_SQL_TOKEN: "test-ae-token",
    O11Y_ENV: "production",
    O11Y_INBOX,
    O11Y_MAPS,
    RUNNER_EVENTS: ae,
    ...overrides.env,
  };
  return { env, inboxWriterStub, ae };
}

function makeBox(overrides = {}) {
  const { env, inboxWriterStub, ae } = makeEnv(overrides);
  const ctx = { storage: makeStorage(), waitUntil: (p) => Promise.resolve(p).catch(() => {}) };
  const box = new GrafanaBox(ctx, env);
  const scheduled = [];
  box.schedule = async (when, callback, payload) => {
    scheduled.push({ when, callback, payload });
  };
  return { box, ctx, env, inboxWriterStub, ae, scheduled };
}

/** Routes the stub's `containerFetch` by port/path, the way a real box
 *  would: `/ready` (3100) and `/grafana/api/health` (3000) answer `isReady`;
 *  `/otlp/v1/logs` (3100) is the drain's own push, controllable per test. */
function installContainerFetchRouter({ otlp } = {}) {
  hooks.containerFetch = async (_self, requestOrUrl, portOrInit) => {
    const url = requestOrUrl instanceof Request ? requestOrUrl.url : String(requestOrUrl);
    const port = typeof portOrInit === "number" ? portOrInit : undefined;
    if (url.includes("/ready") || url.includes("/grafana/api/health")) {
      return new Response(null, { status: 200 });
    }
    if (url.includes("/otlp/v1/logs")) {
      return otlp ? otlp(requestOrUrl, port) : new Response(null, { status: 204 });
    }
    return new Response("unrouted", { status: 500 });
  };
}

test.beforeEach(() => {
  Object.assign(hooks, defaultHooks());
  // The stub's own default `start` hook only sets state — the real
  // `Container.start()` also calls `onStart()` (`blockConcurrencyWhile`),
  // which GrafanaBox relies on to kick off the drain. Every test below
  // needs that real contract, not just the stub's state-only default.
  hooks.start = async (self, _startOptions) => {
    self._state = { status: "running", lastChange: Date.now() };
    await self.onStart();
  };
});

// ---- onStart --------------------------------------------------------------

test("onStart schedules drainStep with the wake's own id", async () => {
  const { box, scheduled } = makeBox();
  await box.wake("backlog"); // -> start() -> hooks.start -> onStart(); #doWake also schedules the hard cap
  const wake = await box.ctx.storage.get("wake");
  const drainStepCalls = scheduled.filter((s) => s.callback === "drainStep");
  assert.equal(drainStepCalls.length, 1);
  assert.equal(drainStepCalls[0].payload.wakeId, wake.wakeId);
});

test("onStart also schedules the 4-hour hard cap, at wake time", async () => {
  const { box, scheduled } = makeBox();
  await box.wake("visit");
  const hardCap = scheduled.find((s) => s.callback === "hardCapStop");
  assert.ok(hardCap, "hardCapStop must be scheduled");
  const gapMs = hardCap.when.getTime() - Date.now();
  assert.ok(gapMs > 3.9 * 60 * 60 * 1000 && gapMs <= 4 * 60 * 60 * 1000 + 1000, `expected ~4h, got ${gapMs}ms`);
});

// ---- drainStep: readiness gate -------------------------------------------

test("drainStep reschedules itself, without touching InboxWriter, while the box is not yet HTTP-ready", async () => {
  const { box, inboxWriterStub, scheduled } = makeBox();
  await box.wake("backlog");
  hooks.containerFetch = async () => new Response(null, { status: 503 }); // not ready yet
  scheduled.length = 0;

  const wake = await box.ctx.storage.get("wake");
  await box.drainStep({ wakeId: wake.wakeId });

  assert.equal(inboxWriterStub.calls.resolveWakes, 0, "must not call the ledger before HTTP readiness");
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].callback, "drainStep");
});

// ---- drainStep: not-ready backoff and give-up ----------------------------

const MIN = 60 * 1000;

async function notReadyBox({ since, visitor = false, reason = "backlog" } = {}) {
  const made = makeBox();
  await made.box.wake(reason);
  hooks.containerFetch = async () => new Response(null, { status: 503 }); // Loki answers, never 200
  const wake = await made.box.ctx.storage.get("wake");
  if (since !== undefined) await made.box.ctx.storage.put("notReadySince", { wakeId: wake.wakeId, since: Date.now() - since });
  if (visitor) await made.box.noteVisitorActivity();
  let stopped = 0;
  hooks.stop = async (self) => {
    stopped++;
    self._state = { status: "stopped", lastChange: Date.now() };
  };
  made.scheduled.length = 0;
  return { ...made, wake, stops: () => stopped };
}

const drainErrorPoints = (ae) => ae.points.filter((p) => p.indexes?.[0] === "o11y.drain" && outcomeOf(p) === "error");
const gapOf = (entry) => entry.when.getTime() - Date.now();

test("drainStep backs off while the box stays not ready: 1 s, then 5 s, then 30 s", async () => {
  for (const [since, expectMs] of [[undefined, 1000], [40 * 1000, 5000], [3 * MIN, 30_000]]) {
    const { box, wake, scheduled } = await notReadyBox({ since });
    await box.drainStep({ wakeId: wake.wakeId });
    assert.equal(scheduled.length, 1, `since=${since}`);
    assert.equal(scheduled[0].callback, "drainStep");
    const gap = gapOf(scheduled[0]);
    assert.ok(gap > expectMs - 1500 && gap <= expectMs + 100, `since=${since}: expected ~${expectMs}ms, got ${gap}ms`);
    const record = await box.ctx.storage.get("notReadySince");
    assert.equal(record.wakeId, wake.wakeId);
  }
});

test("drainStep keeps the first not-ready time across steps and clears it once the box is ready", async () => {
  const { box, wake } = await notReadyBox();
  await box.drainStep({ wakeId: wake.wakeId });
  const first = (await box.ctx.storage.get("notReadySince")).since;
  await box.drainStep({ wakeId: wake.wakeId });
  assert.equal((await box.ctx.storage.get("notReadySince")).since, first, "the clock starts once");

  installContainerFetchRouter();
  await box.drainStep({ wakeId: wake.wakeId });
  assert.equal(await box.ctx.storage.get("notReadySince"), undefined, "ready resets it");
});

test("drainStep gives up after 10 minutes not ready: logs, writes a drain error point, stops a quiet box", async () => {
  const { box, wake, ae, scheduled, stops } = await notReadyBox({ since: 11 * MIN });
  await box.drainStep({ wakeId: wake.wakeId });
  assert.equal(stops(), 1, "a box nobody is looking at is stopped");
  assert.equal(scheduled.length, 0, "the chain ends; the next cron wake retries");
  assert.equal(drainErrorPoints(ae).length, 1);
  assert.equal(reasonOf(drainErrorPoints(ae)[0]), "backlog");
});

test("drainStep before the 10-minute threshold neither stops nor writes an error point", async () => {
  const { box, wake, ae, stops } = await notReadyBox({ since: 9 * MIN });
  await box.drainStep({ wakeId: wake.wakeId });
  assert.equal(stops(), 0);
  assert.equal(drainErrorPoints(ae).length, 0);
});

test("drainStep past the threshold leaves a box with a visitor running and reports once", async () => {
  const { box, wake, ae, scheduled, stops } = await notReadyBox({ since: 11 * MIN, visitor: true, reason: "visit" });
  await box.drainStep({ wakeId: wake.wakeId });
  await box.drainStep({ wakeId: wake.wakeId });
  assert.equal(stops(), 0, "never SIGTERM someone reading a dashboard");
  assert.equal(scheduled.length, 2, "still polling");
  assert.ok(gapOf(scheduled[1]) > 28_000, "at the slowest cadence");
  assert.equal(drainErrorPoints(ae).length, 1, "one point per wake, not one per step");
});

test("drainStep: a throw inside the not-ready path records an error point and runs the post-drain stop decision", async (t) => {
  t.mock.method(console, "error", () => {});
  const { box, wake, ae, scheduled, stops } = await notReadyBox({ since: 2 * MIN });
  const put = box.ctx.storage.put.bind(box.ctx.storage);
  box.ctx.storage.put = async (key, value) => {
    if (key === "notReadySince") throw new Error("storage unavailable");
    return put(key, value);
  };
  await box.drainStep({ wakeId: wake.wakeId });
  assert.equal(drainErrorPoints(ae).length, 1, "the throw is reported like any other drainStep error");
  assert.equal(stops(), 1, "a quiet box is stopped by the same fallback");
  assert.equal(scheduled.length, 0);
});

test("drainStep: when the not-ready path and its fallback both throw, it still reschedules", async (t) => {
  t.mock.method(console, "error", () => {});
  const { box, wake, scheduled } = await notReadyBox({ since: 2 * MIN });
  const put = box.ctx.storage.put.bind(box.ctx.storage);
  box.ctx.storage.put = async (key, value) => {
    if (key === "notReadySince") throw new Error("storage unavailable");
    return put(key, value);
  };
  hooks.stop = async () => {
    throw new Error("stop failed");
  };
  await box.drainStep({ wakeId: wake.wakeId });
  assert.deepEqual(scheduled.map((s) => s.callback), ["drainStep"]);
});

test("drainStep past the threshold does not give up on a wake whose stop is already in flight", async () => {
  const { box, wake, ae, scheduled, stops } = await notReadyBox({ since: 11 * MIN });
  await box.ctx.storage.put("stoppingFor", wake.wakeId);
  await box.drainStep({ wakeId: wake.wakeId });
  assert.equal(stops(), 0, "no second stop while one is in flight");
  assert.equal(drainErrorPoints(ae).length, 0, "and no give-up report for a box that is already going down");
  assert.deepEqual(scheduled.map((s) => s.callback), ["drainStep"], "the chain ends itself once the container is gone");
});

test("drainStep ends its chain when the container is no longer running", async () => {
  const { box, wake, scheduled } = await notReadyBox();
  box._state = { status: "stopped", lastChange: Date.now() };
  await box.drainStep({ wakeId: wake.wakeId });
  assert.equal(scheduled.length, 0, "a stopped box has nothing to wait for");
});

test("drainStep is a no-op once a newer wake has superseded the payload's wakeId", async () => {
  const { box, inboxWriterStub, scheduled } = makeBox();
  await box.wake("backlog");
  const staleWakeId = (await box.ctx.storage.get("wake")).wakeId;
  // Simulate the old wake having fully stopped by now (not merely
  // "running"/"healthy" mid-SIGTERM — wake() is idempotent during that
  // window; see box.ts's own comment) so the next wake() call actually
  // mints a fresh id, the real shape a superseded step sees in production.
  box._state = { status: "stopped", lastChange: Date.now() };
  await box.wake("backlog"); // a fresh wakeId now in storage
  scheduled.length = 0;

  await box.drainStep({ wakeId: staleWakeId });

  assert.equal(inboxWriterStub.calls.resolveWakes, 0);
  assert.equal(scheduled.length, 0, "a superseded step must not even reschedule itself");
});

// ---- drainStep: pushes and ledger updates --------------------------------

test("drainStep pushes drained records and marks the key provisional on 2xx", async () => {
  const key = "inbox/worker/2026-01-01/00/000000000000.ndjson.gz";
  const gz = await (async () => {
    const record = {
      resource: { attributes: [] },
      // The drain-time age filter drops anything older than ~7 days — a
      // recent timestamp here so this test still exercises a real push,
      // not a silently-filtered-to-nothing one.
      scopeLogs: [{ logRecords: [{ timeUnixNano: String(BigInt(Date.now()) * 1_000_000n), body: { stringValue: "hello" } }] }],
    };
    const ndjson = JSON.stringify(record) + "\n";
    const stream = new Blob([ndjson]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  })();
  const r2Objects = new Map([[key, gz]]);

  const { box, inboxWriterStub, ae } = makeBox({ inboxWriter: { writtenKeys: [key] }, r2Objects });
  await box.wake("backlog");
  installContainerFetchRouter({ otlp: () => new Response(null, { status: 204 }) });

  const wake = await box.ctx.storage.get("wake");
  await box.drainStep({ wakeId: wake.wakeId });

  assert.equal(inboxWriterStub.calls.markKeysProvisional.length, 1);
  assert.deepEqual(inboxWriterStub.calls.markKeysProvisional[0].keys, [key]);
  assert.ok(ae.points.some((p) => p.indexes?.[0] === "o11y.drain" || p.blobs), "an o11y.drain point should be written");
});

test("drainStep rejects a key on a 400 from Loki, with the message, and does not mark it provisional", async () => {
  const key = "inbox/worker/2026-01-01/00/000000000001.ndjson.gz";
  // An in-window record — the age filter must not remove it before the
  // (mocked) 400 has a chance to fire; this test is about a genuine
  // Loki-side rejection, not the 7-day age drop.
  const record = {
    resource: { attributes: [] },
    scopeLogs: [{ logRecords: [{ timeUnixNano: String(BigInt(Date.now()) * 1_000_000n), body: { stringValue: "x" } }] }],
  };
  const ndjson = JSON.stringify(record) + "\n";
  const stream = new Blob([ndjson]).stream().pipeThrough(new CompressionStream("gzip"));
  const gz = new Uint8Array(await new Response(stream).arrayBuffer());
  const r2Objects = new Map([[key, gz]]);

  const { box, inboxWriterStub } = makeBox({ inboxWriter: { writtenKeys: [key] }, r2Objects });
  await box.wake("backlog");
  installContainerFetchRouter({ otlp: () => new Response("too_far_behind", { status: 400 }) });

  const wake = await box.ctx.storage.get("wake");
  await box.drainStep({ wakeId: wake.wakeId });

  assert.equal(inboxWriterStub.calls.markKeysProvisional.length, 0);
  assert.equal(inboxWriterStub.calls.rejectKey.length, 1);
  assert.equal(inboxWriterStub.calls.rejectKey[0].key, key);
  assert.match(inboxWriterStub.calls.rejectKey[0].reason, /too_far_behind/);
});

// A key whose object splits into multiple ~1 MB Loki pushes (ADR §B.3's own
// per-request cap) can have one chunk permanently 400 while another lands
// 2xx. `drain.ts#drainKey` reclassifies this as `provisional`: its accepted
// content must still follow the normal §B.3 durability path, since an
// unclean stop before Loki's local flush triggers an automatic replay only
// for `provisional` keys, never `rejected` ones. `box.ts#drainStep` must
// route such an outcome through `markKeysProvisional` (not `rejectKey`)
// while still surfacing the permanent loss via `recordPartialReject`, so
// it stays operator-visible.
test("drainStep: a key with one accepted chunk and one permanently-400 chunk stays provisional AND logs a partial-reject event (row 19)", async () => {
  const key = "inbox/worker/2026-01-01/00/000000000002.ndjson.gz";
  const nowNano = String(BigInt(Date.now()) * 1_000_000n);
  const bigBody = "x".repeat(700_000);
  const records = [
    { resource: { attributes: [] }, scopeLogs: [{ logRecords: [{ timeUnixNano: nowNano, body: { stringValue: `${bigBody}-first` } }] }] },
    { resource: { attributes: [] }, scopeLogs: [{ logRecords: [{ timeUnixNano: nowNano, body: { stringValue: `${bigBody}-second` } }] }] },
  ];
  const ndjson = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const stream = new Blob([ndjson]).stream().pipeThrough(new CompressionStream("gzip"));
  const gz = new Uint8Array(await new Response(stream).arrayBuffer());
  const r2Objects = new Map([[key, gz]]);

  const { box, inboxWriterStub, ae } = makeBox({ inboxWriter: { writtenKeys: [key] }, r2Objects });
  await box.wake("backlog");
  installContainerFetchRouter({
    otlp: async (req) => {
      const gzBytes = new Uint8Array(await req.arrayBuffer());
      const stream = new Blob([gzBytes]).stream().pipeThrough(new DecompressionStream("gzip"));
      const body = await new Response(stream).text();
      if (body.includes("-first")) return new Response("too_far_behind", { status: 400 });
      return new Response(null, { status: 204 });
    },
  });

  const wake = await box.ctx.storage.get("wake");
  await box.drainStep({ wakeId: wake.wakeId });

  assert.equal(inboxWriterStub.calls.rejectKey.length, 0, "a key with an accepted chunk must never be rejectKey'd");
  assert.equal(inboxWriterStub.calls.markKeysProvisional.length, 1);
  assert.deepEqual(inboxWriterStub.calls.markKeysProvisional[0].keys, [key]);
  assert.equal(inboxWriterStub.calls.recordPartialReject.length, 1, "the permanent loss must still be logged");
  assert.equal(inboxWriterStub.calls.recordPartialReject[0].key, key);
  assert.match(inboxWriterStub.calls.recordPartialReject[0].reason, /too_far_behind/);

  // `rejectedKeys` alone misses this case (the key stays `provisional`,
  // never `rejected`), so the drain point must report `partial`, the same
  // outcome a fully-rejected key gets, never `ok`.
  const drainPoint = ae.points.find((p) => p.indexes?.[0] === "o11y.drain");
  assert.ok(drainPoint, "an o11y.drain point must be written");
  assert.equal(outcomeOf(drainPoint), "partial", "a partial-400 key must not report outcome: ok");
});

/** One real, in-window gzipped-ndjson inbox object — the same fixture
 *  shape `drainStep pushes drained records...` above builds inline,
 *  factored out so the tests below don't repeat it. */
async function makeInboxObjectGz() {
  const record = {
    resource: { attributes: [] },
    scopeLogs: [{ logRecords: [{ timeUnixNano: String(BigInt(Date.now()) * 1_000_000n), body: { stringValue: "hello" } }] }],
  };
  const ndjson = JSON.stringify(record) + "\n";
  const stream = new Blob([ndjson]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// `o11y.drain` must emit `reason: "reopen"` (already a contract-allowed
// value) when the batch it just pushed replayed reopened keys — instead of
// silently reporting the wake's own `backlog`/`visit` reason, which loses
// the fact entirely.
test("o11y.drain reports reason: \"reopen\" when the batch replays a reopened key, even on a backlog wake", async () => {
  const key = "inbox/worker/2026-01-01/00/000000000001.ndjson.gz";
  const r2Objects = new Map([[key, await makeInboxObjectGz()]]);
  const { box, inboxWriterStub, ae } = makeBox({
    inboxWriter: { writtenKeys: [key], reopenedFlag: true },
    r2Objects,
  });
  await box.wake("backlog");
  installContainerFetchRouter({ otlp: async () => new Response(null, { status: 204 }) });

  const wake = await box.ctx.storage.get("wake");
  await box.drainStep({ wakeId: wake.wakeId });

  assert.deepEqual(
    inboxWriterStub.calls.takeReopenedFlag,
    [[key]],
    "takeReopenedFlag must be called once per batch, with exactly the keys the batch is about to push",
  );
  const drainPoint = ae.points.find((p) => p.indexes?.[0] === "o11y.drain");
  assert.ok(drainPoint, "an o11y.drain point must be written");
  assert.equal(reasonOf(drainPoint), "reopen", "a batch replaying reopened keys must report reason: reopen, not the wake's own backlog/visit reason");
});

test("revert check / positive control: o11y.drain still reports the wake's own reason when nothing was reopened", async () => {
  const key = "inbox/worker/2026-01-01/00/000000000001.ndjson.gz";
  const r2Objects = new Map([[key, await makeInboxObjectGz()]]);
  const { box, ae } = makeBox({ inboxWriter: { writtenKeys: [key], reopenedFlag: false }, r2Objects });
  await box.wake("backlog");
  installContainerFetchRouter({ otlp: async () => new Response(null, { status: 204 }) });

  const wake = await box.ctx.storage.get("wake");
  await box.drainStep({ wakeId: wake.wakeId });

  const drainPoint = ae.points.find((p) => p.indexes?.[0] === "o11y.drain");
  assert.equal(reasonOf(drainPoint), "backlog");
});

// `takeReopenedFlag` consumes the reopen markers before `drainBatch` runs,
// so a batch that replays reopened keys and then throws must still report
// "reopen" on the `outcome: "error"` point — the same path as the drain
// error path `drainStep`'s outer catch takes, not the wake's own
// backlog/visit reason.
test('reopen reason on the drain error path: a batch that replays a reopened key and then throws still reports reason: "reopen" on the o11y.drain error point', async () => {
  const key = "inbox/worker/2026-01-01/00/000000000010.ndjson.gz";
  const r2Objects = new Map([[key, await makeInboxObjectGz()]]);
  const { box, inboxWriterStub, ae } = makeBox({
    inboxWriter: { writtenKeys: [key], reopenedFlag: true },
    r2Objects,
  });
  await box.wake("backlog");
  installContainerFetchRouter({ otlp: async () => new Response(null, { status: 204 }) });
  // The real batch pushes successfully (a real 204), then the step's own
  // bookkeeping RPC — called AFTER drainBatch, before the success point —
  // throws, landing in drainStep's outer catch.
  inboxWriterStub.markKeysProvisional = async () => {
    throw new Error("simulated markKeysProvisional RPC failure");
  };

  const wake = await box.ctx.storage.get("wake");
  await assert.doesNotReject(box.drainStep({ wakeId: wake.wakeId }), "a throw inside the drain must never escape drainStep");

  assert.deepEqual(inboxWriterStub.calls.takeReopenedFlag, [[key]]);
  const drainPoints = ae.points.filter((p) => p.indexes?.[0] === "o11y.drain");
  assert.equal(drainPoints.length, 1, "only the error point must be written — the batch never reached the success point");
  assert.equal(outcomeOf(drainPoints[0]), "error");
  assert.equal(
    reasonOf(drainPoints[0]),
    "reopen",
    "the reopen reason must survive to the error path, not fall back to the wake's own backlog/visit reason",
  );
});

// A key whose only record is too old (dropped by `dropOldRecords` before
// any push is even attempted) ends `provisional` with `bytesPushed: 0` —
// `drainKey`'s own zero-chunk case. Routing every `provisional` outcome
// through `markKeysProvisional` requires the wake's own Loki marker to
// resolve to `done:`; a wake whose only provisional keys are zero-byte
// never gets that marker, so `resolveOverWakes` bounces the key back to
// `written` — re-waking the box roughly every 10 minutes forever, even
// though nothing was at risk of being lost.
test("drainStep commits a zero-bytes-pushed key directly, never marking it provisional (no re-wake loop)", async () => {
  const key = "inbox/worker/2026-01-01/00/000000000003.ndjson.gz";
  // Older than Loki's `reject_old_samples_max_age` (7d) minus the drain's
  // own safety margin — `dropOldRecords` drops it before any push is
  // attempted, so `drainKey` never even calls `pushToLoki` for this key.
  const ancientNano = String(BigInt(Date.now() - 8 * 24 * 60 * 60 * 1000) * 1_000_000n);
  const record = {
    resource: { attributes: [] },
    scopeLogs: [{ logRecords: [{ timeUnixNano: ancientNano, body: { stringValue: "too old" } }] }],
  };
  const ndjson = JSON.stringify(record) + "\n";
  const stream = new Blob([ndjson]).stream().pipeThrough(new CompressionStream("gzip"));
  const gz = new Uint8Array(await new Response(stream).arrayBuffer());
  const r2Objects = new Map([[key, gz]]);

  const { box, inboxWriterStub } = makeBox({ inboxWriter: { writtenKeys: [key] }, r2Objects });
  await box.wake("backlog");
  installContainerFetchRouter({
    otlp: () => {
      throw new Error("pushToLoki must never be called for an all-dropped key");
    },
  });

  const wake = await box.ctx.storage.get("wake");
  await box.drainStep({ wakeId: wake.wakeId });

  assert.equal(inboxWriterStub.calls.markKeysProvisional.length, 0, "a zero-byte key must never enter provisional:<wakeId>");
  assert.equal(inboxWriterStub.calls.commitKeys.length, 1);
  assert.deepEqual(inboxWriterStub.calls.commitKeys[0], [key]);
  assert.equal(inboxWriterStub.calls.rejectKey.length, 0);
});

async function recentObject(bodyText) {
  const record = {
    resource: { attributes: [] },
    scopeLogs: [{ logRecords: [{ timeUnixNano: String(BigInt(Date.now()) * 1_000_000n), body: { stringValue: bodyText } }] }],
  };
  const stream = new Blob([JSON.stringify(record) + "\n"]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** An inbox bucket whose `get` throws for `failingKeys`, like an R2 read past
 *  the invocation's subrequest limit. */
function throwingInbox(r2Objects, failingKeys) {
  return {
    async get(key) {
      if (failingKeys.includes(key)) throw new Error("Too many subrequests.");
      const bytes = r2Objects.get(key);
      return bytes ? { async arrayBuffer() { return bytes.buffer; } } : null;
    },
  };
}

test("drainStep: an inbox read that throws on key 2 of 3 leaves only that key written; keys 1 and 3 go provisional and the drain continues", async () => {
  const keys = [0, 1, 2].map((i) => `inbox/worker/2026-01-01/00/00000000000${i}.ndjson.gz`);
  const r2Objects = new Map([
    [keys[0], await recentObject("first")],
    [keys[2], await recentObject("third")],
  ]);
  const { box, inboxWriterStub, ae, scheduled } = makeBox({
    inboxWriter: { writtenKeys: keys },
    env: { O11Y_INBOX: throwingInbox(r2Objects, [keys[1]]) },
  });
  await box.wake("backlog");
  installContainerFetchRouter({ otlp: () => new Response(null, { status: 204 }) });
  scheduled.length = 0;

  const wake = await box.ctx.storage.get("wake");
  await box.drainStep({ wakeId: wake.wakeId });

  assert.deepEqual(inboxWriterStub.calls.markKeysProvisional.map((c) => c.keys), [[keys[0], keys[2]]]);
  assert.equal(inboxWriterStub.calls.rejectKey.length, 0, "an unreadable object is not a rejection");
  assert.deepEqual(scheduled.map((s) => s.callback), ["drainStep"], "the drain goes on with the next step");
  assert.equal(outcomeOf(ae.points.find((p) => p.indexes?.[0] === "o11y.drain")), "error");
});

test("drainStep: a batch in which every inbox read throws excludes those keys, then ends the drain instead of repeating itself every step", async () => {
  const keys = [0, 1].map((i) => `inbox/worker/2026-01-01/00/00000000000${i}.ndjson.gz`);
  const { box, scheduled } = makeBox({
    inboxWriter: { writtenKeys: keys },
    env: { O11Y_INBOX: throwingInbox(new Map(), keys) },
  });
  await box.wake("backlog");
  installContainerFetchRouter();
  let stopped = false;
  hooks.stop = async (self) => {
    stopped = true;
    self._state = { status: "stopped", lastChange: Date.now() };
  };
  scheduled.length = 0;

  const wake = await box.ctx.storage.get("wake");
  await box.drainStep({ wakeId: wake.wakeId });
  assert.equal(scheduled.filter((s) => s.callback === "drainStep").length, 1, "the deferred keys are excluded, then the next step finds nothing");
  scheduled.length = 0;
  await box.drainStep({ wakeId: wake.wakeId });

  assert.equal(scheduled.filter((s) => s.callback === "drainStep").length, 0);
  assert.ok(stopped, "a quiet backlog wake stops once its drain has nothing it can make progress on");
});

test("drainStep: a stream-limited browser tenant is skipped for the rest of the wake, so every worker key commits and no browser key is rejected", async (t) => {
  const browser = Array.from({ length: 12 }, (_, i) => `inbox/browser/2026-01-01/00/${String(i).padStart(12, "0")}.ndjson.gz`);
  const worker = Array.from({ length: 3 }, (_, i) => `inbox/worker/2026-01-01/00/${String(i).padStart(12, "0")}.ndjson.gz`);
  const r2Objects = new Map();
  for (const k of [...browser, ...worker]) r2Objects.set(k, await recentObject(k));
  const written = new Set([...browser, ...worker]);
  const writer = makeInboxWriterStub();
  writer.nextWrittenKeys = async (limit, exclude = []) =>
    [...written].sort().filter((k) => !exclude.some((tenant) => k.startsWith(`inbox/${tenant}/`))).slice(0, limit);
  const settle = writer.markKeysProvisional;
  writer.markKeysProvisional = async (wakeId, keys) => {
    for (const k of keys) written.delete(k);
    return settle(wakeId, keys);
  };
  const browserReads = [];
  const inbox = {
    async get(key) {
      if (key.startsWith("inbox/browser/")) browserReads.push(key);
      const bytes = r2Objects.get(key);
      return bytes ? { async arrayBuffer() { return bytes.buffer; } } : null;
    },
  };
  const { box, inboxWriterStub, scheduled } = makeBox({ inboxWriterStub: writer, env: { O11Y_INBOX: inbox } });
  await box.wake("backlog");
  const limit = "Maximum active stream limit exceeded when trying to create stream {hot_outcome=\"x\"}";
  installContainerFetchRouter({
    otlp: (req) => (req.headers.get("X-Scope-OrgID") === "browser" ? new Response(limit, { status: 429 }) : new Response(null, { status: 204 })),
  });
  const warnings = [];
  t.mock.method(console, "warn", (line) => warnings.push(JSON.parse(line)));
  scheduled.length = 0;
  const wake = await box.ctx.storage.get("wake");

  for (let step = 0; step < 3; step++) await box.drainStep({ wakeId: wake.wakeId });

  assert.deepEqual(inboxWriterStub.calls.markKeysProvisional.flatMap((c) => c.keys), worker);
  assert.equal(inboxWriterStub.calls.rejectKey.length, 0);
  assert.equal(inboxWriterStub.calls.recordPartialReject.length, 0);
  assert.ok(browser.every((k) => written.has(k)), "every browser key stays written");
  assert.deepEqual(browserReads, [browser[0]], "only the key that met the limit was read");
  assert.deepEqual(
    warnings.filter((w) => w.event === "o11y.drain.stream_limit").map((w) => [w.tenant, w.message]),
    [["browser", limit]],
  );
  assert.equal(scheduled.filter((s) => s.callback === "drainStep").length, 2, "steps 1 and 2 reschedule; step 3 finds nothing and ends");
});

// `drainStep` needs a try/finally around its body — a throw from
// `InboxWriter.nextWrittenKeys` (or any other RPC, or `fetchObject`, or
// symbolication) must not propagate out of `drainStep` and silently end
// the drain for the rest of this wake: nothing would reschedule it, nothing
// would be recorded, and the box would sit there idle-timer-bound having
// quietly given up mid-drain.
test("drainStep records an o11y.drain error point and still runs the post-drain stop decision when a step throws", async () => {
  const inboxWriterStub = makeInboxWriterStub({ writtenKeys: ["inbox/worker/2026-01-01/00/000000000004.ndjson.gz"] });
  inboxWriterStub.nextWrittenKeys = async () => {
    throw new Error("simulated InboxWriter RPC failure");
  };
  const { box, ae } = makeBox({ inboxWriterStub });
  await box.wake("backlog");
  installContainerFetchRouter();
  let stopped = false;
  hooks.stop = async (self) => {
    stopped = true;
    self._state = { status: "stopped", lastChange: Date.now() }; // B-M5: real stop() does not set "stopping" (see box.ts)
  };

  const wake = await box.ctx.storage.get("wake");
  await assert.doesNotReject(box.drainStep({ wakeId: wake.wakeId }), "a throw inside the drain must never escape drainStep");

  const drainPoint = ae.points.find((p) => p.indexes?.[0] === "o11y.drain");
  assert.ok(drainPoint, "an o11y.drain point must still be written on a throw");
  assert.equal(outcomeOf(drainPoint), "error");
  assert.ok(stopped, "the post-drain stop decision must still run after a throw (idle backlog wake -> stop())");
});

// The catch handler's own work (`writeBoxPoint`, then `#finishDrain`) can
// itself throw — most plausibly the very same outage that took down
// `#drainStepBody` in the first place (a DO storage/RPC failure affects
// every call in the isolate, not just one). "always reschedule or finish"
// must hold even then.
test("drainStep falls back to a plain reschedule when the error-handling path ITSELF throws (#finishDrain failing too)", async () => {
  const inboxWriterStub = makeInboxWriterStub({ writtenKeys: ["inbox/worker/2026-01-01/00/000000000005.ndjson.gz"] });
  inboxWriterStub.nextWrittenKeys = async () => {
    throw new Error("simulated InboxWriter RPC failure");
  };
  const { box, scheduled } = makeBox({ inboxWriterStub });
  await box.wake("backlog");
  installContainerFetchRouter();
  // #finishDrain calls stop() (quiet, running, backlog wake with no
  // visitor) — make THAT throw too, simulating the outage taking down the
  // stop path as well as the drain itself.
  hooks.stop = async () => {
    throw new Error("simulated stop() failure");
  };
  scheduled.length = 0;

  const wake = await box.ctx.storage.get("wake");
  await assert.doesNotReject(
    box.drainStep({ wakeId: wake.wakeId }),
    "a throw from BOTH the drain body and the error-handling path must never escape drainStep",
  );

  const rescheduled = scheduled.filter((s) => s.callback === "drainStep");
  assert.equal(rescheduled.length, 1, "must fall back to rescheduling drainStep rather than silently stalling");
});

// ---- post-drain stop decision --------------------------------------------

test("an idle drain (no recent /grafana/* activity) stops right after finishing", async () => {
  const { box } = makeBox({ inboxWriter: { writtenKeys: [] } });
  await box.wake("backlog");
  installContainerFetchRouter();
  let stopped = false;
  hooks.stop = async (self) => {
    stopped = true;
    self._state = { status: "stopped", lastChange: Date.now() }; // B-M5: real stop() does not set "stopping" (see box.ts)
  };

  const wake = await box.ctx.storage.get("wake");
  await box.drainStep({ wakeId: wake.wakeId });

  assert.ok(stopped, "an idle backlog drain must call stop() right after finishing");
});

test("a fresh backlog wake with no visitors self-stops, even right after a PREVIOUS wake had a recent visitor", async () => {
  // Two consecutive wakes: wake 1 has a real visitor (noteVisitorActivity),
  // then fully stops; wake 2 is a fresh backlog-only wake with NO visitor
  // activity of its own. `LAST_GRAFANA_STORAGE_KEY` is not scoped by
  // wakeId, so without resetting it at the start of #doWake, wake 2's own
  // #finishDrain reads wake 1's still-recent timestamp and wrongly treats
  // itself as "not quiet," refusing to self-stop a backlog wake nobody is
  // visiting — exactly ADR §A's quiet-stop rule broken, and awake-time
  // wasted (exit criterion 7).
  const { box } = makeBox({ inboxWriter: { writtenKeys: [] } });
  installContainerFetchRouter();

  // Wake 1: a real visitor.
  await box.wake("visit");
  await box.noteVisitorActivity();
  const wake1 = await box.ctx.storage.get("wake");
  await box.drainStep({ wakeId: wake1.wakeId }); // drains (nothing to do), stays up (active visitor)
  assert.equal((await box.getState()).status, "healthy", "wake 1 must still be running (active visitor)");

  // Wake 1 fully stops (simulating its own eventual idle/hard-cap stop) —
  // not merely "running"/"healthy" mid-SIGTERM (which stays idempotent), so
  // wake() mints a genuinely new id next.
  box._state = { status: "stopped", lastChange: Date.now() };

  // Wake 2: backlog-triggered, no visitor of its own.
  await box.wake("backlog");
  const wake2 = await box.ctx.storage.get("wake");
  assert.notEqual(wake2.wakeId, wake1.wakeId, "wake 2 must be a genuinely new wake");

  let stopped = false;
  hooks.stop = async (self) => {
    stopped = true;
    self._state = { status: "stopped", lastChange: Date.now() }; // B-M5: real stop() does not set "stopping" (see box.ts)
  };

  await box.drainStep({ wakeId: wake2.wakeId });

  assert.ok(stopped, "a fresh backlog wake with no visitors of its own must self-stop, regardless of the PREVIOUS wake's visitor activity");
});

// ADR §G: "drains pause, visit wakes still work". A paused drainStep must
// push nothing, whatever woke the box.
test("drainStep pushes nothing while drainsPaused: a visit wake keeps serving (no stop), a quiet backlog wake stops", async () => {
  const key = "inbox/worker/2026-01-01/00/000000000007.ndjson.gz";
  for (const [reason, visitor, expectStop] of [["visit", true, false], ["backlog", false, true]]) {
    const { box, inboxWriterStub, ae } = makeBox({ inboxWriter: { writtenKeys: [key], drainsPaused: true } });
    await box.wake(reason);
    let pushes = 0;
    installContainerFetchRouter({ otlp: () => { pushes++; return new Response(null, { status: 204 }); } });
    if (visitor) await box.noteVisitorActivity();
    let stopped = false;
    hooks.stop = async (self) => {
      stopped = true;
      self._state = { status: "stopped", lastChange: Date.now() };
    };

    const wake = await box.ctx.storage.get("wake");
    await box.drainStep({ wakeId: wake.wakeId });

    assert.equal(pushes, 0, `${reason}: nothing may be pushed to Loki while paused`);
    assert.equal(inboxWriterStub.calls.nextWrittenKeys ?? 0, 0, `${reason}: no key may be taken for draining`);
    assert.equal(inboxWriterStub.calls.markKeysProvisional.length, 0, reason);
    assert.ok(!ae.points.some((p) => p.indexes?.[0] === "o11y.drain"), `${reason}: no o11y.drain point`);
    assert.equal(stopped, expectStop, reason);
  }
});

// A visit wake that outlives the spend-cap pause keeps serving; its drain chain
// must keep polling the flag at a slow cadence so clearing the cap resumes the drain.
test("drainStep while paused with a visitor present reschedules a slow recheck, and drains once the pause clears", async () => {
  const key = "inbox/worker/2026-01-01/00/000000000009.ndjson.gz";
  const inboxWriter = { writtenKeys: [key], drainsPaused: true };
  const { box, inboxWriterStub, scheduled } = makeBox({ inboxWriter });
  await box.wake("visit");
  installContainerFetchRouter();
  await box.noteVisitorActivity();
  let stopped = false;
  hooks.stop = async () => { stopped = true; };
  scheduled.length = 0;
  const wake = await box.ctx.storage.get("wake");

  await box.drainStep({ wakeId: wake.wakeId });

  assert.equal(stopped, false, "a visitor keeps the box up");
  assert.equal(scheduled.length, 1, "exactly one follow-up step, so the chain never forks");
  assert.equal(scheduled[0].callback, "drainStep");
  assert.deepEqual(scheduled[0].payload, { wakeId: wake.wakeId });
  const gapMs = scheduled[0].when.getTime() - Date.now();
  assert.ok(gapMs > 55_000 && gapMs <= 61_000, `expected a ~60 s recheck, got ${gapMs}ms`);
  assert.equal(inboxWriterStub.calls.nextWrittenKeys ?? 0, 0, "still paused: nothing taken");

  inboxWriter.drainsPaused = false; // the cap resolved
  await box.drainStep({ wakeId: wake.wakeId });
  assert.equal(inboxWriterStub.calls.nextWrittenKeys, 1, "the next step drains");
});

test("drainStep while paused ends the recheck chain once the visitor has gone quiet", async () => {
  const { box, scheduled } = makeBox({ inboxWriter: { drainsPaused: true } });
  await box.wake("visit");
  installContainerFetchRouter();
  await box.ctx.storage.put("lastGrafanaAt", Date.now() - 11 * 60 * 1000);
  let stopped = false;
  hooks.stop = async (self) => {
    stopped = true;
    self._state = { status: "stopped", lastChange: Date.now() };
  };
  scheduled.length = 0;
  const wake = await box.ctx.storage.get("wake");

  await box.drainStep({ wakeId: wake.wakeId });

  assert.equal(stopped, true);
  assert.equal(scheduled.length, 0, "a stopped box has no follow-up step");
});

test("drainStep drains normally once drainsPaused is cleared", async () => {
  const key = "inbox/worker/2026-01-01/00/000000000008.ndjson.gz";
  const { box, inboxWriterStub } = makeBox({ inboxWriter: { writtenKeys: [key], drainsPaused: false } });
  await box.wake("backlog");
  installContainerFetchRouter();
  const wake = await box.ctx.storage.get("wake");
  await box.drainStep({ wakeId: wake.wakeId });
  assert.equal(inboxWriterStub.calls.nextWrittenKeys, 1, "an unpaused step takes keys to drain");
});

test("a drain wake with an active Grafana user does not call stop()", async () => {
  const { box } = makeBox({ inboxWriter: { writtenKeys: [] } });
  await box.wake("visit");
  installContainerFetchRouter();
  await box.noteVisitorActivity(); // a real /grafana/* request just landed
  let stopped = false;
  hooks.stop = async () => { stopped = true; };

  const wake = await box.ctx.storage.get("wake");
  await box.drainStep({ wakeId: wake.wakeId });

  assert.equal(stopped, false, "an active Grafana user must not be SIGTERMed by a drain finishing");
});

// A visit wake with an empty backlog SIGTERMs itself ~20s after boot unless
// `handleGrafana` (grafana/proxy.ts) records activity for a request that
// only ever saw the waking page (the box was still booting). Driven
// through the real `handleGrafana` handler, not `box.noteVisitorActivity()`
// called directly, so the proxy-level ordering is actually exercised.
test("a waking-page request (box not yet ready) still counts as visitor activity, so an empty-backlog visit wake stays up past the first drain-finish", async () => {
  const { box, env, inboxWriterStub } = makeBox({ inboxWriter: { writtenKeys: [] }, env: { O11Y_ENV: "local", DEV_ADMIN: "dev@handsontable.com" } });
  // `getGrafanaBoxStub`/`inboxWriterStub` (box.ts) both resolve their
  // Durable Object namespace WITHOUT `.jurisdiction()` under O11Y_ENV=local
  // (see box.ts's own comment on why: `.jurisdiction()` throws under a
  // real local DO simulation) — reshape both env bindings to that flat
  // `getByName` surface, and point GRAFANA_BOX at THIS test's real box
  // instance so `handleGrafana` drives the real
  // wake/isReady/noteVisitorActivity/stop machinery, not a second fake.
  env.GRAFANA_BOX = { getByName: () => box };
  env.INBOX_WRITER = { getByName: () => inboxWriterStub };
  const req = new Request("https://o11y.example/grafana/d/abc");

  // The box is not yet ready (no container-fetch router installed) — this
  // is the browser's own meta-refresh poll landing while Loki/Grafana are
  // still booting.
  const wakingRes = await handleGrafana(req, env, {});
  assert.equal(await wakingRes.text(), wakingPageHtml());
  assert.notEqual(await box.lastGrafanaActivityMs(), null, "the waking-page request must have recorded visitor activity");

  // The box becomes ready; drainStep runs its one (empty-backlog) batch and
  // reaches the post-drain stop decision.
  installContainerFetchRouter();
  let stopped = false;
  hooks.stop = async () => {
    stopped = true;
  };
  const wake = await box.ctx.storage.get("wake");
  await box.drainStep({ wakeId: wake.wakeId });

  assert.equal(stopped, false, "a visit wake whose only activity was a waking-page poll must not self-stop on the first drain-finish");
});

// ---- every container response body is released -----------------------------
// `@cloudflare/containers` counts a `containerFetch` as in flight until its
// body is consumed or cancelled, and never runs `sleepAfter` while that
// count is above zero. The stub models that accounting
// (`cloudflare-containers-stub.mjs`); these tests answer with real bodies,
// as Loki and Grafana do — `installContainerFetchRouter`'s `null` bodies
// could never leak.

/** Lets the stub's `pipeTo(...).finally(decrementInflight)` chains run. */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

function installRealisticProbeBodies({ lokiStatus = 200, lokiBody = "ready\n", grafana = "ok", otlp } = {}) {
  hooks.containerFetch = async (_self, requestOrUrl, portOrInit) => {
    const url = requestOrUrl instanceof Request ? requestOrUrl.url : String(requestOrUrl);
    const port = typeof portOrInit === "number" ? portOrInit : undefined;
    if (url.endsWith("/ready")) return new Response(lokiBody, { status: lokiStatus });
    if (url.endsWith("/grafana/api/health")) {
      if (grafana === "throw") throw new Error("probe failed");
      return Response.json({ database: "ok", version: "11.4.0" }, { status: 200 });
    }
    if (url.includes("/otlp/v1/logs")) return otlp ? otlp(requestOrUrl, port) : new Response(null, { status: 204 });
    return new Response("unrouted", { status: 500 });
  };
}

test("isReady() releases both probe bodies, so the in-flight count returns to 0 and the idle stop can fire", async () => {
  const { box } = makeBox();
  await box.wake("visit");
  installRealisticProbeBodies();

  for (let i = 0; i < 3; i++) assert.equal(await box.isReady(), true);
  await settle();

  assert.equal(box.inflightRequests, 0, "every probe response must be consumed or cancelled");
  // 15 idle minutes later (the library's alarm loop asks exactly this).
  box.sleepAfterMs = Date.now() - 1;
  assert.equal(box.isActivityExpired(), true, "with nothing in flight the sleepAfter idle stop must be due");
});

test("a not-ready probe's body is released too (Loki answers 503 with a body while it boots)", async () => {
  const { box } = makeBox();
  await box.wake("visit");
  installRealisticProbeBodies({ lokiStatus: 503, lokiBody: "Ingester not ready: waiting for 15s after being ready\n" });

  assert.equal(await box.isReady(), false);
  await settle();
  assert.equal(box.inflightRequests, 0);
});

test("when one probe throws, the other probe's body is still released", async () => {
  const { box } = makeBox();
  await box.wake("visit");
  installRealisticProbeBodies({ grafana: "throw" });

  assert.equal(await box.isReady(), false);
  await settle();
  assert.equal(box.inflightRequests, 0, "the Loki probe's body must not leak because the Grafana probe threw");
});

test("drainStep's Loki push releases a 2xx response body (not only a >=400 one)", async () => {
  const key = "inbox/worker/2026-01-01/00/000000000009.ndjson.gz";
  const record = {
    resource: { attributes: [] },
    scopeLogs: [{ logRecords: [{ timeUnixNano: String(BigInt(Date.now()) * 1_000_000n), body: { stringValue: "hello" } }] }],
  };
  const stream = new Blob([JSON.stringify(record) + "\n"]).stream().pipeThrough(new CompressionStream("gzip"));
  const gz = new Uint8Array(await new Response(stream).arrayBuffer());

  const { box, inboxWriterStub } = makeBox({ inboxWriter: { writtenKeys: [key] }, r2Objects: new Map([[key, gz]]) });
  await box.wake("backlog");
  let pushes = 0;
  installRealisticProbeBodies({
    otlp: () => {
      pushes++;
      return Response.json({ partialSuccess: {} }, { status: 200 });
    },
  });

  const wake = await box.ctx.storage.get("wake");
  await box.drainStep({ wakeId: wake.wakeId });
  await settle();

  assert.ok(pushes > 0, "the drain must actually have pushed");
  assert.equal(inboxWriterStub.calls.markKeysProvisional.length, 1);
  assert.equal(box.inflightRequests, 0, "a 2xx push body must be released too");
});

// ---- wake-to-ready time -----------------------------------------------------

test("the first successful isReady() of a wake reports wake-to-ready, once", async () => {
  const { box, inboxWriterStub } = makeBox();
  await box.wake("visit");
  const wake = await box.ctx.storage.get("wake");
  // Pretend wake() minted this wake 42 s ago.
  await box.ctx.storage.put("wake", { ...wake, startedAt: Date.now() - 42_000 });

  installRealisticProbeBodies({ lokiStatus: 503, lokiBody: "not ready\n" });
  assert.equal(await box.isReady(), false);
  assert.equal(inboxWriterStub.calls.recordWakeReady.length, 0, "a not-ready probe reports nothing");

  installRealisticProbeBodies();
  assert.equal(await box.isReady(), true);
  assert.equal(await box.isReady(), true);

  assert.equal(inboxWriterStub.calls.recordWakeReady.length, 1, "only the FIRST successful probe reports");
  const [{ wakeId, readyMs }] = inboxWriterStub.calls.recordWakeReady;
  assert.equal(wakeId, wake.wakeId);
  assert.ok(readyMs >= 42_000 && readyMs < 43_000, `expected ~42000 ms, got ${readyMs}`);
});

test("a new wake reports its own wake-to-ready again", async () => {
  const { box, inboxWriterStub } = makeBox();
  installRealisticProbeBodies();
  await box.wake("visit");
  await box.isReady();
  box._state = { status: "stopped", lastChange: Date.now() };
  await box.wake("backlog");
  await box.isReady();

  const ids = inboxWriterStub.calls.recordWakeReady.map((c) => c.wakeId);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  assert.equal(ids[1], (await box.ctx.storage.get("wake")).wakeId);
});

test("a failing recordWakeReady never fails isReady(), and the next successful probe retries it", async () => {
  let attempts = 0;
  const { box } = makeBox({
    inboxWriter: {
      recordWakeReady: async () => {
        attempts++;
        if (attempts === 1) throw new Error("InboxWriter unavailable");
      },
    },
  });
  await box.wake("visit");
  installRealisticProbeBodies();

  assert.equal(await box.isReady(), true, "readiness must not depend on the bookkeeping RPC");
  assert.equal(await box.isReady(), true);
  assert.equal(await box.isReady(), true);
  assert.equal(attempts, 2, "retried once after the failure, then recorded for good");
});

// ---- hardCapStop ------------------------------------------------------

test("hardCapStop stops a still-running wake matching its own wakeId", async () => {
  const { box } = makeBox();
  await box.wake("visit");
  let stopped = false;
  hooks.stop = async (self) => {
    stopped = true;
    self._state = { status: "stopped", lastChange: Date.now() }; // B-M5: real stop() does not set "stopping" (see box.ts)
  };

  const wake = await box.ctx.storage.get("wake");
  await box.hardCapStop({ wakeId: wake.wakeId });

  assert.ok(stopped);
});

test("hardCapStop is a no-op once a newer wake has started", async () => {
  const { box } = makeBox();
  await box.wake("visit");
  const staleWakeId = (await box.ctx.storage.get("wake")).wakeId;
  box._state = { status: "stopped", lastChange: Date.now() };
  await box.wake("visit");
  let stopped = false;
  hooks.stop = async () => { stopped = true; };

  await box.hardCapStop({ wakeId: staleWakeId });

  assert.equal(stopped, false);
});

// ---- isAwake / noteVisitorActivity ---------------------------------------

test("isAwake reflects getState(): true while running/healthy, false otherwise", async () => {
  const { box } = makeBox();
  assert.equal(await box.isAwake(), false);
  await box.wake("backlog");
  assert.equal(await box.isAwake(), true);
});

test("noteVisitorActivity persists a timestamp lastGrafanaActivityMs reads back", async () => {
  const { box } = makeBox();
  await box.wake("visit");
  assert.equal(await box.lastGrafanaActivityMs(), null);
  const before = Date.now();
  await box.noteVisitorActivity();
  const after = await box.lastGrafanaActivityMs();
  assert.ok(after >= before);
});

// ---- no await on the container is unbounded ---------------------------------
// A SIGKILLed box container can leave the library's `start()` for the next
// wake never settling. `wake()` shares one in-flight promise between
// callers, so every later `/grafana/*` request and the cron's backlog wake
// would wait on it forever. Each test below races its subject against
// `within()`, which fails the test instead of letting it hang.

/** Rejects if `promise` has not settled within `ms`: a hang fails the test. */
function within(promise, ms, what) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms (hung)`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/** `hooks.start` for the observed wedge: the container is issued (state
 *  "running", as the library's `setRunning()` leaves it), then `start()`
 *  never returns, so `onStart()` never runs. */
function installWedgedStart() {
  let calls = 0;
  hooks.start = async (self) => {
    calls++;
    self._state = { status: "running", lastChange: Date.now() };
    await new Promise(() => {});
  };
  return () => calls;
}

test("a start() that never settles no longer pins every later wake() caller", async () => {
  const startCalls = installWedgedStart();
  const { box, inboxWriterStub } = makeBox();
  let recordWakeCalls = 0;
  inboxWriterStub.recordWake = async () => {
    recordWakeCalls++;
  };
  box.wakeWaitMs = 50;
  // Short, so the wedged start's own deadline does not keep the test
  // process alive for the production 180 s.
  box.startDeadlineMs = 300;
  box.ctx.abort = () => {};

  const first = box.wake("visit");
  const second = box.wake("visit");
  await assert.rejects(within(first, 2000, "first wake()"), /still in flight/);
  await assert.rejects(within(second, 2000, "second wake()"), /still in flight/);
  // A caller that timed out is not a new wake: the start stays single.
  await assert.rejects(within(box.wake("backlog"), 2000, "third wake()"), /still in flight/);
  assert.equal(startCalls(), 1, "one start() for the in-flight wake, however many callers gave up on it");
  assert.equal(recordWakeCalls, 1, "no second wakeId minted while the first start is still in flight");
});

test("a wedged start() resets the DO instance (ctx.abort) and still leaves the wake its 4-hour cap", async () => {
  installWedgedStart();
  const { box, scheduled } = makeBox();
  box.startDeadlineMs = 50;
  const aborts = [];
  box.ctx.abort = (reason) => aborts.push(reason);

  await assert.rejects(within(box.wake("visit"), 2000, "wake()"), /GrafanaBox\.start\(\): no answer within 50 ms/);

  assert.equal(aborts.length, 1, "the wedged instance must be reset so a fresh one can recover");
  const wake = await box.ctx.storage.get("wake");
  const hardCap = scheduled.find((s) => s.callback === "hardCapStop");
  assert.ok(hardCap, "the container may be running under this wakeId, so the cap must exist even though start() never returned");
  assert.equal(hardCap.payload.wakeId, wake.wakeId);
});

test("positive control: a start() that settles normally never resets the instance", async () => {
  const { box } = makeBox();
  box.startDeadlineMs = 50;
  const aborts = [];
  box.ctx.abort = (reason) => aborts.push(reason);
  await box.wake("visit");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(aborts.length, 0);
});

test("/grafana/* serves the waking page instead of hanging while the box's start is wedged", async () => {
  installWedgedStart();
  const { box, env, inboxWriterStub } = makeBox({ env: { O11Y_ENV: "local", DEV_ADMIN: "dev@handsontable.com" } });
  env.GRAFANA_BOX = { getByName: () => box };
  env.INBOX_WRITER = { getByName: () => inboxWriterStub };
  box.wakeWaitMs = 50;
  // Short, so the wedged start's own deadline does not keep the test
  // process alive for the production 180 s.
  box.startDeadlineMs = 300;
  box.ctx.abort = () => {};

  // The waking page's own meta-refresh (a document navigation) mints the wake.
  const nav = await within(handleGrafana(new Request("https://o11y.example/grafana/"), env, {}), 2000, "navigation");
  assert.equal(await nav.text(), wakingPageHtml());
  // An open dashboard's background request, the box now reading "running".
  const xhr = new Request("https://o11y.example/grafana/api/health", { headers: { "sec-fetch-dest": "empty" } });
  const bg = await within(handleGrafana(xhr, env, {}), 2000, "background request");
  assert.equal(await bg.text(), wakingPageHtml());
});

test("isReady() answers false within its deadline when a probe never answers, and releases a late answer", async () => {
  const { box } = makeBox();
  await box.wake("visit");
  box.readyProbeTimeoutMs = 50;
  let lateCancelled = false;
  const signals = [];
  hooks.containerFetch = async (_self, request) => {
    signals.push(request.signal);
    if (request.url.endsWith("/ready")) return new Response("ready\n", { status: 200 });
    // Grafana's port accepts and does not answer until well after the
    // deadline, ignoring the signal (the library's own pre-fetch start
    // machinery does not always honour it).
    await new Promise((resolve) => setTimeout(resolve, 200));
    const body = new ReadableStream({
      cancel() {
        lateCancelled = true;
      },
    });
    return new Response(body, { status: 200 });
  };

  const started = Date.now();
  assert.equal(await within(box.isReady(), 2000, "isReady()"), false);
  assert.ok(Date.now() - started < 1000, `isReady took ${Date.now() - started} ms`);
  assert.ok(
    signals.every((s) => s instanceof AbortSignal),
    "each probe must carry a signal that cancels the container request itself",
  );

  await new Promise((resolve) => setTimeout(resolve, 250));
  await settle();
  assert.equal(lateCancelled, true, "a probe answering after its deadline must still have its body released (F6)");
  assert.equal(box.inflightRequests, 0);
});

test("drainStep finishes when Loki's push port never answers, instead of freezing the alarm loop", async () => {
  const key = "inbox/worker/2026-01-01/00/000000000013.ndjson.gz";
  const record = {
    resource: { attributes: [] },
    scopeLogs: [{ logRecords: [{ timeUnixNano: String(BigInt(Date.now()) * 1_000_000n), body: { stringValue: "hello" } }] }],
  };
  const stream = new Blob([JSON.stringify(record) + "\n"]).stream().pipeThrough(new CompressionStream("gzip"));
  const gz = new Uint8Array(await new Response(stream).arrayBuffer());

  const { box, inboxWriterStub, ae } = makeBox({ inboxWriter: { writtenKeys: [key] }, r2Objects: new Map([[key, gz]]) });
  await box.wake("backlog");
  box.lokiPushTimeoutMs = 30;
  installRealisticProbeBodies({
    // The library answers an aborted container request with a 500; without
    // a signal the request would never settle at all.
    otlp: (request) =>
      new Promise((resolve) => {
        request.signal?.addEventListener("abort", () => resolve(new Response("aborted", { status: 500 })));
      }),
  });

  const wake = await box.ctx.storage.get("wake");
  await within(box.drainStep({ wakeId: wake.wakeId }), 10_000, "drainStep");

  assert.equal(inboxWriterStub.calls.markKeysProvisional.length, 0, "nothing reached Loki, so nothing may be provisional");
  const drainPoints = ae.points.filter((p) => p.indexes?.[0] === "o11y.drain");
  assert.equal(drainPoints.length, 1);
  assert.equal(outcomeOf(drainPoints[0]), "error", "the stalled push must be reported, and the key left for the next wake");
});

// The reload path: a fresh instance (hot reload, deploy or eviction while
// the container kept running) never calls start() itself, so only the
// probes can notice a wedged library start. Both probes here never settle.
function installSilentProbes() {
  hooks.containerFetch = () => new Promise(() => {});
}

test("probes that time out for startDeadlineMs reset the instance once (the reload path)", async () => {
  const { box } = makeBox();
  await box.wake("visit");
  box.readyProbeTimeoutMs = 10;
  box.startDeadlineMs = 60;
  const aborts = [];
  box.ctx.abort = (reason) => aborts.push(reason);
  installSilentProbes();

  assert.equal(await within(box.isReady(), 2000, "isReady()"), false);
  await settle();
  assert.equal(aborts.length, 0, "one timed-out probe round is not yet a wedge");

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(await within(box.isReady(), 2000, "isReady()"), false);
  await settle();
  assert.equal(aborts.length, 1, "probes stuck for longer than startDeadlineMs must reset the instance");

  assert.equal(await within(box.isReady(), 2000, "isReady()"), false);
  await settle();
  assert.equal(aborts.length, 1, "the clock restarts after a reset instead of aborting on every probe");
});

test("positive control: a probe that answers in between restarts the stuck clock", async () => {
  const { box } = makeBox();
  await box.wake("visit");
  box.readyProbeTimeoutMs = 10;
  box.startDeadlineMs = 60;
  const aborts = [];
  box.ctx.abort = (reason) => aborts.push(reason);

  installSilentProbes();
  await box.isReady();
  await new Promise((resolve) => setTimeout(resolve, 40));
  // Loki still booting: a real answer, just not a ready one.
  installRealisticProbeBodies({ lokiStatus: 503, lokiBody: "not ready\n" });
  assert.equal(await box.isReady(), false);
  await new Promise((resolve) => setTimeout(resolve, 40));
  installSilentProbes();
  await box.isReady();
  await settle();
  assert.equal(aborts.length, 0, "80 ms of timeouts, split by a settled probe, is never a 60 ms stuck window");
});

// ---- isReady() skips its probes while a stop is in flight (the
// SIGTERM->exit window `getState()` cannot see — see
// STOPPING_FOR_STORAGE_KEY's own doc comment in box.ts) ----------------------

test("item 2: isReady() skips its probes once THIS instance has requested a stop, even while getState() still reports running/healthy (the SIGTERM window)", async () => {
  const { box } = makeBox();
  await box.wake("visit");
  installRealisticProbeBodies();
  assert.equal(await box.isReady(), true, "sanity: probes work normally before any stop");

  let probeCalls = 0;
  hooks.containerFetch = async () => {
    probeCalls++;
    return new Response("ready\n", { status: 200 });
  };

  // The stub's default `hooks.stop` leaves `_state` untouched — mirrors the
  // real `@cloudflare/containers` library, whose `stop()` only signals the
  // process (SIGTERM) and never flips `getState()`'s status itself (see
  // `wake()`'s own doc comment on this exact gap).
  await box.stop();
  const stateAfterStop = await box.getState();
  assert.ok(
    stateAfterStop.status === "running" || stateAfterStop.status === "healthy",
    `state must still read running/healthy during the SIGTERM window (per the real library's own gap), got ${stateAfterStop.status}`,
  );

  assert.equal(await box.isReady(), false, "isReady must report not-ready once THIS instance has requested a stop");
  assert.equal(probeCalls, 0, "isReady must not issue any container probe (and so never trigger the library's own 'not listening' log) once a stop has been requested");
});

test("item 2: the same skip applies via the base class's own idle-timeout path (onActivityExpired -> stop())", async () => {
  const { box } = makeBox();
  await box.wake("visit");
  installRealisticProbeBodies();
  assert.equal(await box.isReady(), true, "sanity: probes work normally before any stop");

  let probeCalls = 0;
  hooks.containerFetch = async () => {
    probeCalls++;
    return new Response("ready\n", { status: 200 });
  };

  await box.onActivityExpired(); // base class default: this.stop() — must dispatch to GrafanaBox's own override

  assert.equal(await box.isReady(), false);
  assert.equal(probeCalls, 0);
});

test("item 2: a fresh wake after a full stop clears the previous wake's marker, so isReady() probes normally again", async () => {
  const { box } = makeBox();
  await box.wake("visit");
  await box.stop(); // requests a stop; state stays healthy/running (the same library gap)
  box._state = { status: "stopped", lastChange: Date.now() }; // the process has now actually exited
  await box.wake("backlog"); // a fresh wake, a new wakeId
  installRealisticProbeBodies();

  assert.equal(await box.isReady(), true, "a fresh wake must probe normally, not inherit the previous wake's stopping marker");
});

test("item 2 (revert-check shape): a stop() that itself throws clears the marker instead of leaving isReady() stuck false", async () => {
  const { box } = makeBox();
  await box.wake("visit");
  installRealisticProbeBodies();
  hooks.stop = async () => {
    throw new Error("simulated stop() failure");
  };

  await assert.rejects(box.stop(), /simulated stop\(\) failure/);

  // The container never actually stopped (the signal never went out) — a
  // failed stop() must not leave isReady() reporting not-ready for the rest
  // of a wake that is, in fact, still very much up.
  assert.equal(await box.isReady(), true);
});

// ---- drainStep: source-map listing and read failures ----------------------

const { inboxKey } = await import("@handsontable/demo-runtime/telemetry");

const ONE_MAPPING_MAP = JSON.stringify({ version: 3, sources: ["../../src/a.ts"], names: [], mappings: "AAAA" });

/** A gzipped inbox object holding one recent exception per `[version, filename]`. */
async function exceptionObject(entries) {
  const lines = entries.map(([version, filename]) =>
    JSON.stringify({
      resource: { attributes: [{ key: "service.version", value: { stringValue: version } }] },
      scopeLogs: [
        {
          logRecords: [
            {
              timeUnixNano: String(BigInt(Date.now()) * 1_000_000n),
              body: { stringValue: `TypeError: x\n    at f (${filename}:1:1)` },
              attributes: [{ key: "hot.kind", value: { stringValue: "exception" } }],
            },
          ],
        },
      ],
    }),
  );
  const stream = new Blob([lines.join("\n") + "\n"]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function pushedBodies(requests) {
  const bodies = [];
  for (const request of requests) {
    const text = await new Response(request.body.pipeThrough(new DecompressionStream("gzip"))).text();
    for (const rl of JSON.parse(text).resourceLogs) bodies.push(rl.scopeLogs[0].logRecords[0].body.stringValue);
  }
  return bodies;
}

test("drainStep lists the maps of each version through the R2 cursor, and a forged path is never read", async () => {
  const key = inboxKey("worker", new Date(), 0);
  const gz = await exceptionObject([
    ["forged", "https://demos.handsontable.com/assets/nope.js"],
    ["realsha", "https://demos.handsontable.com/assets/app.js"],
  ]);
  const gets = [];
  const lists = [];
  const stored = ["sourcemaps/realsha/assets/other.js.map", "sourcemaps/realsha/assets/app.js.map"];
  const O11Y_MAPS = {
    async get(k) {
      gets.push(k);
      return k === stored[1] ? { text: async () => ONE_MAPPING_MAP } : null;
    },
    // Two keys, one per page, so the cursor loop is what finds the second.
    async list({ prefix, cursor }) {
      lists.push({ prefix, cursor });
      const page = prefix === "sourcemaps/realsha/" ? (cursor === undefined ? 0 : 1) : null;
      if (page === null) return { objects: [], truncated: false };
      return { objects: [{ key: stored[page] }], truncated: page === 0, cursor: page === 0 ? "c1" : undefined };
    },
  };
  const { box, inboxWriterStub } = makeBox({ inboxWriter: { writtenKeys: [key] }, r2Objects: new Map([[key, gz]]), env: { O11Y_MAPS } });
  await box.wake("backlog");
  const requests = [];
  installContainerFetchRouter({ otlp: (request) => (requests.push(request), new Response(null, { status: 204 })) });

  const wake = await box.ctx.storage.get("wake");
  await box.drainStep({ wakeId: wake.wakeId });

  assert.deepEqual(lists, [
    { prefix: "sourcemaps/forged/", cursor: undefined },
    { prefix: "sourcemaps/realsha/", cursor: undefined },
    { prefix: "sourcemaps/realsha/", cursor: "c1" },
  ]);
  assert.deepEqual(gets, [stored[1]], "only the key the listing shows is read");
  const [forged, real] = await pushedBodies(requests);
  assert.match(forged, /assets\/nope\.js:1:1/);
  assert.match(real, /\(src\/a\.ts:1:1\)/);
  assert.equal(inboxWriterStub.calls.markKeysProvisional.length, 1);
});

test("drainStep: a map read that keeps failing leaves only that fresh key written and logs it; the other key still goes provisional", async (t) => {
  const keys = [inboxKey("worker", new Date(), 0), inboxKey("worker", new Date(), 1)];
  const r2Objects = new Map([
    [keys[0], await exceptionObject([["realsha", "https://demos.handsontable.com/assets/app.js"]])],
    [keys[1], await recentObject("plain")],
  ]);
  const errors = [];
  t.mock.method(console, "error", (line) => errors.push(JSON.parse(line)));
  const O11Y_MAPS = {
    async get() {
      throw new Error("R2 get timed out");
    },
    async list() {
      return { objects: [{ key: "sourcemaps/realsha/assets/app.js.map" }], truncated: false };
    },
  };
  const { box, inboxWriterStub, scheduled } = makeBox({ inboxWriter: { writtenKeys: keys }, r2Objects, env: { O11Y_MAPS } });
  await box.wake("backlog");
  const requests = [];
  installContainerFetchRouter({ otlp: (request) => (requests.push(request), new Response(null, { status: 204 })) });
  scheduled.length = 0;

  const wake = await box.ctx.storage.get("wake");
  await box.drainStep({ wakeId: wake.wakeId });

  assert.deepEqual(inboxWriterStub.calls.markKeysProvisional.map((c) => c.keys), [[keys[1]]]);
  assert.equal(inboxWriterStub.calls.rejectKey.length, 0);
  assert.deepEqual(await pushedBodies(requests), ["plain"]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].event, "o11y.drain.error");
  assert.equal(errors[0].key, keys[0]);
  assert.match(errors[0].message, /^map_fetch_error: /);
  assert.deepEqual(scheduled.map((s) => s.callback), ["drainStep"], "the drain goes on with the next step");
});
