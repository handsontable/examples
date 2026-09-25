// GrafanaBox's T03 additions (wake/drain/stop orchestration, ADR-0041 §A) —
// driven through the REAL class, same pattern `o11y-box.test.mjs` (T01) uses.
// `schedule()` is monkey-patched per instance (the stub Container class has
// no scheduling machinery at all, and this suite only needs to prove WHAT
// GrafanaBox schedules and WHEN it decides to stop — not re-test
// Cloudflare's own alarm dispatch).
//
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

// Fix round (finding B-M5): same pattern as outcomeOf, for the `reason` blob.
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
    // F8: the box reports its wake-to-ready time on the first successful isReady().
    async recordWakeReady(wakeId, readyMs) {
      if (overrides.recordWakeReady) return overrides.recordWakeReady(wakeId, readyMs);
      calls.recordWakeReady.push({ wakeId, readyMs });
    },
    async resolveWakes() {
      calls.resolveWakes++;
    },
    async nextWrittenKeys() {
      return overrides.writtenKeys ?? [];
    },
    // Fix round (finding B-M5): defaults to "no reopened keys in this
    // batch" — a test proving the `reason: "reopen"` emission overrides
    // this via `overrides.reopenedFlag` (or its own `inboxWriterStub`
    // override, the same pattern `nextWrittenKeys` above uses).
    async takeReopenedFlag(inboxKeys) {
      calls.takeReopenedFlag.push(inboxKeys);
      return overrides.reopenedFlag ?? false;
    },
    async markKeysProvisional(wakeId, keys) {
      calls.markKeysProvisional.push({ wakeId, keys });
    },
    // B-M4 fix (minor triage item 3): see box.ts#drainStep and
    // ledger.ts#commitKeys — a zero-bytes-pushed key commits directly.
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
  // which GrafanaBox's own T03 addition relies on to kick off the drain.
  // Every test below needs that real contract, not just the stub's
  // state-only default.
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

test("drainStep is a no-op once a newer wake has superseded the payload's wakeId", async () => {
  const { box, inboxWriterStub, scheduled } = makeBox();
  await box.wake("backlog");
  const staleWakeId = (await box.ctx.storage.get("wake")).wakeId;
  // Simulate the OLD wake having fully stopped by now (not merely
  // "running"/"healthy" mid-SIGTERM — wake() is idempotent during THAT
  // window, C1, fix round B-M5: see box.ts's own comment on the deleted
  // "stopping" branch) so the next wake() call actually mints a fresh id,
  // the real shape a superseded step sees in production.
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
      // F1's drain-time age filter drops anything older than ~7 days — a
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
  // An IN-WINDOW record — F1's own age filter must not remove it before the
  // (mocked) 400 has a chance to fire; this test is about a genuine
  // Loki-side rejection, not F1's 7-day age drop.
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

// Row 19 (drain partial-400 durability, final review rereview.md): a key
// whose object splits into multiple ~1 MB Loki pushes (ADR §B.3's own
// per-request cap) can have ONE chunk permanently 400 while another lands
// 2xx. `drain.ts#drainKey` reclassifies this as `provisional` (its accepted
// content must still follow the normal §B.3 durability path — an unclean
// stop before Loki's local flush must still trigger an automatic replay,
// which only happens for `provisional` keys, never `rejected` ones). This
// proves the WIRING: `box.ts#drainStep` must route such an outcome through
// `markKeysProvisional` (not `rejectKey`) while STILL surfacing the
// permanent loss via `recordPartialReject`, so it stays operator-visible.
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

  // NB4 (re-review 2): `rejectedKeys` alone missed this case entirely
  // (the key stays `provisional`, never `rejected`), so the drain point
  // used to report `outcome: "ok"` even though a chunk was permanently
  // lost. Must be `partial`, the same outcome a fully-rejected key gets.
  const drainPoint = ae.points.find((p) => p.indexes?.[0] === "o11y.drain");
  assert.ok(drainPoint, "an o11y.drain point must be written");
  assert.equal(outcomeOf(drainPoint), "partial", "a partial-400 key must not report outcome: ok");
});

/** One real, in-window (F1's age filter) gzipped-ndjson inbox object — the
 *  same fixture shape `drainStep pushes drained records...` above builds
 *  inline, factored out so the two B-M5 tests below don't repeat it. */
async function makeInboxObjectGz() {
  const record = {
    resource: { attributes: [] },
    scopeLogs: [{ logRecords: [{ timeUnixNano: String(BigInt(Date.now()) * 1_000_000n), body: { stringValue: "hello" } }] }],
  };
  const ndjson = JSON.stringify(record) + "\n";
  const stream = new Blob([ndjson]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Fix round (finding B-M5): `o11y.drain` must emit `reason: "reopen"`
// (already a contract-allowed value) when the batch it just pushed replayed
// reopened keys — instead of silently reporting the wake's own
// `backlog`/`visit` reason, which loses the fact entirely. Fails without
// the fix: reverting box.ts's `replayedReopenedKeys` read (or its use in
// the point below) leaves `reasonOf(drainPoint)` as `"backlog"`.
test("B-M5: o11y.drain reports reason: \"reopen\" when the batch replays a reopened key, even on a backlog wake", async () => {
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

test("B-M5 (revert check / positive control): o11y.drain still reports the wake's own reason when nothing was reopened", async () => {
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

// B-M4 fix (minor triage item 3): a key whose only record is too old
// (dropped by F1's `dropOldRecords` before any push is even attempted) ends
// `provisional` with `bytesPushed: 0` — `drainKey`'s own zero-chunk case.
// Before this fix, `drainStep` routed EVERY `provisional` outcome through
// `markKeysProvisional`, which requires the wake's own Loki marker to ever
// resolve to `done:`. A wake whose only provisional keys are all zero-byte
// never gets that marker (nothing was pushed), so `resolveOverWakes` reads
// it as unclean and bounces the key back to `written` — re-adding it to the
// backlog and re-waking the box roughly every 10 minutes, forever, even
// though nothing was ever at risk of being lost. Reverting the `zeroByteKeys`
// split in box.ts (routing this case back through `markKeysProvisional`
// alone) makes this test fail: `commitKeys` would never be called and
// `markKeysProvisional` would be called instead.
test("drainStep commits a zero-bytes-pushed key directly, never marking it provisional (no re-wake loop)", async () => {
  const key = "inbox/worker/2026-01-01/00/000000000003.ndjson.gz";
  // Older than Loki's `reject_old_samples_max_age` (7d) minus the drain's
  // own safety margin — F1's `dropOldRecords` drops it before any push is
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

// B-M2 fix (minor triage item 4): before this fix, `drainStep` had no
// try/finally around its body — a throw from `InboxWriter.nextWrittenKeys`
// (or any other RPC, or `fetchObject`, or symbolication) propagated straight
// out of `drainStep`, silently ending the drain for the rest of this wake:
// nothing rescheduled it, nothing was recorded, and the box just sat there
// idle-timer-bound having quietly given up mid-drain. Reverting the
// try/catch in box.ts (back to calling `#drainStepBody`'s logic inline, with
// no handler) makes this test fail: the `await box.drainStep(...)` call
// itself rejects instead of resolving.
test("drainStep records an o11y.drain error point and still runs the post-drain stop decision when a step throws (B-M2)", async () => {
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

// Advisor follow-up on B-M2: the catch handler's OWN work (`writeBoxPoint`,
// then `#finishDrain`) can itself throw — most plausibly the very same
// outage that took down `#drainStepBody` in the first place (a DO
// storage/RPC failure affects every call in the isolate, not just one).
// "always reschedule or finish" must hold even then. Reverting the nested
// try/catch in `drainStep` (back to calling `#finishDrain` unguarded inside
// the outer catch) makes this test fail: `drainStep` itself would reject.
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

test("fix round I1: a fresh backlog wake with no visitors self-stops, even right after a PREVIOUS wake had a recent visitor", async () => {
  // Two consecutive wakes: wake 1 has a real visitor (noteVisitorActivity),
  // then fully stops; wake 2 is a fresh backlog-only wake with NO visitor
  // activity of its own. `LAST_GRAFANA_STORAGE_KEY` is not scoped by
  // wakeId, so without resetting it at the start of #doWake, wake 2's own
  // #finishDrain reads wake 1's still-recent timestamp and wrongly treats
  // itself as "not quiet," refusing to self-stop a backlog wake nobody is
  // visiting — exactly ADR §A's quiet-stop rule broken, and awake-time
  // wasted (exit criterion 7). Reverting the `ctx.storage.delete(...)` in
  // #doWake (box.ts, fix round I1) makes this fail: `stopped` stays false.
  const { box } = makeBox({ inboxWriter: { writtenKeys: [] } });
  installContainerFetchRouter();

  // Wake 1: a real visitor.
  await box.wake("visit");
  await box.noteVisitorActivity();
  const wake1 = await box.ctx.storage.get("wake");
  await box.drainStep({ wakeId: wake1.wakeId }); // drains (nothing to do), stays up (active visitor)
  assert.equal((await box.getState()).status, "healthy", "wake 1 must still be running (active visitor)");

  // Wake 1 fully stops (simulating its own eventual idle/hard-cap stop) —
  // not merely "running"/"healthy" mid-SIGTERM (which stays idempotent, C1),
  // so wake() mints a genuinely new id next.
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

// F2: T03-D2's other finding — a visit wake with an empty backlog SIGTERMs
// itself ~20s after boot, because `handleGrafana` (grafana/proxy.ts) used
// to record no activity at all for a request that only ever saw the
// waking page (the box was still booting). Driven through the REAL
// `handleGrafana` handler (not `box.noteVisitorActivity()` called
// directly) — calling the box method directly would pass even with the
// proxy-level ordering bug this fix addresses; only exercising the actual
// route handler proves it.
test("F2: a waking-page request (box not yet ready) still counts as visitor activity, so an empty-backlog visit wake stays up past the first drain-finish", async () => {
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

// ---- F6: every container response body is released ------------------------
//
// V-triage F6: `@cloudflare/containers` counts a `containerFetch` as in
// flight until its response body is consumed or cancelled, and never runs
// the `sleepAfter` idle stop while that count is above zero. `isReady()`
// read only `.status`, so each probe pinned the count up by two and a visit
// wake ran to the 4-hour cap. The stub now models that accounting
// (`cloudflare-containers-stub.mjs`, "in-flight accounting"); these tests
// answer with REAL bodies, as Loki (`ready\n`) and Grafana (JSON) do —
// `installContainerFetchRouter`'s `null` bodies could never leak.

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

test("F6: isReady() releases both probe bodies, so the in-flight count returns to 0 and the idle stop can fire", async () => {
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

test("F6: a not-ready probe's body is released too (Loki answers 503 with a body while it boots)", async () => {
  const { box } = makeBox();
  await box.wake("visit");
  installRealisticProbeBodies({ lokiStatus: 503, lokiBody: "Ingester not ready: waiting for 15s after being ready\n" });

  assert.equal(await box.isReady(), false);
  await settle();
  assert.equal(box.inflightRequests, 0);
});

test("F6: when one probe throws, the other probe's body is still released", async () => {
  const { box } = makeBox();
  await box.wake("visit");
  installRealisticProbeBodies({ grafana: "throw" });

  assert.equal(await box.isReady(), false);
  await settle();
  assert.equal(box.inflightRequests, 0, "the Loki probe's body must not leak because the Grafana probe threw");
});

test("F6: drainStep's Loki push releases a 2xx response body (not only a >=400 one)", async () => {
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

// ---- F8: wake-to-ready time ------------------------------------------------

test("F8: the first successful isReady() of a wake reports wake-to-ready, once", async () => {
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

test("F8: a new wake reports its own wake-to-ready again", async () => {
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

test("F8: a failing recordWakeReady never fails isReady(), and the next successful probe retries it", async () => {
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

// ---- F13: no await on the container is unbounded ---------------------------
//
// F13 (local verification): after the box container was SIGKILLed while a
// dashboard was open, the library's `start()` for the next wake never
// settled (the new container itself booted fine). `wake()` shares one
// in-flight promise between callers, so every later `/grafana/*` request and
// the cron's backlog wake waited on it forever. VA measured the second half
// in workerd: a container port that accepts and never answers held every
// `isReady()` caller forever. Each test below would hang on the old code, so
// each one races its subject against `within()`, which fails the test
// instead of letting it hang.

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

test("F13: a start() that never settles no longer pins every later wake() caller", async () => {
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

test("F13: a wedged start() resets the DO instance (ctx.abort) and still leaves the wake its 4-hour cap", async () => {
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

test("F13 (positive control): a start() that settles normally never resets the instance", async () => {
  const { box } = makeBox();
  box.startDeadlineMs = 50;
  const aborts = [];
  box.ctx.abort = (reason) => aborts.push(reason);
  await box.wake("visit");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(aborts.length, 0);
});

test("F13: /grafana/* serves the waking page instead of hanging while the box's start is wedged", async () => {
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

test("F13: isReady() answers false within its deadline when a probe never answers, and releases a late answer", async () => {
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

test("F13: drainStep finishes when Loki's push port never answers, instead of freezing the alarm loop", async () => {
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
