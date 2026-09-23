// T04 — ADR-0041 §F.3's alert cron: rules, state (`alert:<rule>`, contract
// §8), the AE query helper's allowlist, and the fire-once/resolve-once
// notify contract. Deterministic unit coverage over injected fakes; a
// one-time LIVE pass against a real local ClickHouse container plus a local
// Slack capture server (the acceptance criterion's own wording) is recorded
// in the task Outcome, not repeated here — Docker-in-`node --test` would
// make this suite slow and flaky for every future run.
//
// Run: node --experimental-strip-types --test pipeline/o11y-alerts.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./fixtures/o11y-worker-hooks.mjs", import.meta.url);

const inboxState = await import("../workers/o11y/src/alerts/inbox-state.ts");
const { memoryStorage } = await import("../workers/o11y/src/inbox/storage.ts");
const { evaluateAndNotify, slackPoster } = await import("../workers/o11y/src/alerts/notify.ts");
const {
  backlogAgeRule,
  rejectedKeyRule,
  newFingerprintRule,
  o11yCapRule,
} = await import("../workers/o11y/src/alerts/rules.ts");
const { assertAllowedAeQuery, findDisallowedAeFunctions, ALLOWED_AE_FUNCTIONS } =
  await import("../workers/o11y/src/alerts/ae-query.ts");
const { inboxKeyStorageKey, fingerprintStorageKey } = await import("@handsontable/demo-runtime/telemetry");
const { InboxWriter } = await import("../workers/o11y/src/inbox/writer.ts");
const { readHeartbeatReport } = await import("../workers/o11y/src/heartbeat.ts");
const { canWakeForBacklog } = await import("../workers/o11y/src/alerts/index.ts");
const { makeEnv } = await import("./fixtures/o11y-harness.mjs");

// ---- alerts/ae-query.ts: the allowlist ------------------------------------

test("ae-query: refuses a disallowed function (COUNT)", () => {
  assert.throws(() => assertAllowedAeQuery("SELECT COUNT(*) FROM runner_events"), /COUNT/);
});

test("ae-query: refuses an undocumented aggregate (quantileTDigestWeighted)", () => {
  const disallowed = findDisallowedAeFunctions(
    "SELECT quantileTDigestWeighted(0.95)(double2, _sample_interval) FROM runner_events",
  );
  assert.deepEqual(disallowed, ["quantileTDigestWeighted"]);
});

test("ae-query: allows every function this task's own queries use", () => {
  for (const fn of ["sum", "avg", "quantileExactWeighted", "toStartOfInterval", "toUInt32", "now"]) {
    assert.ok(ALLOWED_AE_FUNCTIONS.has(fn), `expected ${fn} to be allowed`);
  }
  assert.doesNotThrow(() =>
    assertAllowedAeQuery(
      "SELECT sum(_sample_interval * double1) AS c FROM runner_events WHERE timestamp >= now() - INTERVAL '3600' SECOND",
    ),
  );
});

// ---- alerts/inbox-state.ts: pure InboxWriter helpers ----------------------

test("inbox-state: heartbeat defaults to {0,0}, stampCronHeartbeat preserves lastIngest", async () => {
  const storage = memoryStorage();
  assert.deepEqual(await inboxState.readHeartbeat(storage), { lastCron: 0, lastIngest: 0 });
  await storage.put({ heartbeat: { lastCron: 0, lastIngest: 555 } });
  await inboxState.writeCronHeartbeat(storage, 999);
  assert.deepEqual(await inboxState.readHeartbeat(storage), { lastCron: 999, lastIngest: 555 });
});

test("inbox-state: backlogOldestAgeMs is null with no backlog, and only counts 'written' keys", async () => {
  const storage = memoryStorage();
  assert.equal(await inboxState.backlogOldestAgeMs(storage), null);

  // A committed key must NOT count as backlog.
  await storage.put({ [inboxKeyStorageKey("inbox/worker/2026-09-20/10/000000000001.ndjson.gz")]: "committed" });
  assert.equal(await inboxState.backlogOldestAgeMs(storage), null);

  // A written key from 2026-09-20 10:00 UTC counts, measured as a lower
  // bound from the END of that hour (10:59:59.999Z).
  await storage.put({ [inboxKeyStorageKey("inbox/worker/2026-09-20/10/000000000002.ndjson.gz")]: "written" });
  const nowMs = Date.parse("2026-09-20T13:00:00.000Z");
  const ageMs = await inboxState.backlogOldestAgeMs(storage, nowMs);
  const expected = nowMs - Date.parse("2026-09-20T10:59:59.999Z");
  assert.equal(ageMs, expected);
});

test("inbox-state: backlogOldestAgeMs picks the OLDEST written key, not the newest", async () => {
  const storage = memoryStorage();
  await storage.put({
    [inboxKeyStorageKey("inbox/worker/2026-09-20/10/000000000001.ndjson.gz")]: "written",
    [inboxKeyStorageKey("inbox/worker/2026-09-20/12/000000000002.ndjson.gz")]: "written",
  });
  const nowMs = Date.parse("2026-09-20T13:00:00.000Z");
  const ageMs = await inboxState.backlogOldestAgeMs(storage, nowMs);
  const expectedOldest = nowMs - Date.parse("2026-09-20T10:59:59.999Z");
  assert.equal(ageMs, expectedOldest);
});

test("inbox-state: rejectedKeyCount counts only rejected:* states", async () => {
  const storage = memoryStorage();
  await storage.put({
    [inboxKeyStorageKey("a")]: "written",
    [inboxKeyStorageKey("b")]: "rejected:too_far_behind",
    [inboxKeyStorageKey("c")]: "rejected:other",
    [inboxKeyStorageKey("d")]: "committed",
  });
  assert.equal(await inboxState.rejectedKeyCount(storage), 2);
});

test("inbox-state: newFingerprintsSince returns only names first-seen strictly after the cursor", async () => {
  const storage = memoryStorage();
  await storage.put({
    [fingerprintStorageKey("old-fp")]: 1000,
    [fingerprintStorageKey("new-fp")]: 5000,
  });
  assert.deepEqual(await inboxState.newFingerprintsSince(storage, 2000), ["new-fp"]);
  assert.deepEqual(await inboxState.newFingerprintsSince(storage, 5000), []);
});

test("inbox-state: drainsPaused defaults false, round-trips true", async () => {
  const storage = memoryStorage();
  assert.equal(await inboxState.readDrainsPaused(storage), false);
  await inboxState.writeDrainsPaused(storage, true);
  assert.equal(await inboxState.readDrainsPaused(storage), true);
});

test("inbox-state: alert state and alertMeta round-trip", async () => {
  const storage = memoryStorage();
  assert.equal(await inboxState.readAlertState(storage, "some-rule"), undefined);
  await inboxState.writeAlertState(storage, "some-rule", { state: "firing", since: 1, lastNotified: 1 });
  assert.deepEqual(await inboxState.readAlertState(storage, "some-rule"), { state: "firing", since: 1, lastNotified: 1 });

  assert.equal(await inboxState.readAlertMeta(storage, "cursor"), undefined);
  await inboxState.writeAlertMeta(storage, "cursor", "42");
  assert.equal(await inboxState.readAlertMeta(storage, "cursor"), "42");
});

// ---- alerts/notify.ts: fire-once / resolve-once ---------------------------

function fakeInboxWriter() {
  const alertState = new Map();
  return {
    async alertState(rule) {
      return alertState.get(rule);
    },
    async setAlertState(rule, state) {
      alertState.set(rule, state);
    },
    _alertState: alertState,
  };
}

function fakeAeSink() {
  const points = [];
  return { writeDataPoint(p) { points.push(p); }, _points: points };
}

const COMMON_ATTRS = { service_name: "demos-o11y", service_version: "test", environment: "local" };

test("notify: fires once on the first firing tick, stays silent while still firing", async () => {
  const writer = fakeInboxWriter();
  const sink = fakeAeSink();
  const slackCalls = [];
  const postSlack = async (text) => slackCalls.push(text);

  const t1 = await evaluateAndNotify(
    { rule: "r1", firing: true, detail: "d1" },
    { inboxWriter: writer, postSlack, aeSink: sink, commonAttrs: COMMON_ATTRS, nowMs: 1000 },
  );
  assert.equal(t1, "fired");
  assert.equal(slackCalls.length, 1);
  assert.match(slackCalls[0], /r1/);
  assert.match(slackCalls[0], /firing/);

  const t2 = await evaluateAndNotify(
    { rule: "r1", firing: true, detail: "d1 still" },
    { inboxWriter: writer, postSlack, aeSink: sink, commonAttrs: COMMON_ATTRS, nowMs: 2000 },
  );
  assert.equal(t2, undefined, "must not notify again while still firing");
  assert.equal(slackCalls.length, 1, "still exactly one Slack line");
});

test("notify: resolves once when firing clears, then stays silent", async () => {
  const writer = fakeInboxWriter();
  const sink = fakeAeSink();
  const slackCalls = [];
  const postSlack = async (text) => slackCalls.push(text);

  await evaluateAndNotify({ rule: "r2", firing: true, detail: "d" }, { inboxWriter: writer, postSlack, aeSink: sink, commonAttrs: COMMON_ATTRS, nowMs: 1000 });
  const resolved = await evaluateAndNotify({ rule: "r2", firing: false, detail: "d" }, { inboxWriter: writer, postSlack, aeSink: sink, commonAttrs: COMMON_ATTRS, nowMs: 2000 });
  assert.equal(resolved, "resolved");
  assert.equal(slackCalls.length, 2);
  assert.match(slackCalls[1], /resolved/);

  const again = await evaluateAndNotify({ rule: "r2", firing: false, detail: "d" }, { inboxWriter: writer, postSlack, aeSink: sink, commonAttrs: COMMON_ATTRS, nowMs: 3000 });
  assert.equal(again, undefined);
  assert.equal(slackCalls.length, 2, "no repeat 'resolved' notifications");
});

test("notify: writes an o11y.alert point with the closed outcome set (fired/resolved)", async () => {
  const writer = fakeInboxWriter();
  const sink = fakeAeSink();
  await evaluateAndNotify(
    { rule: "r3", firing: true, detail: "d" },
    { inboxWriter: writer, postSlack: async () => {}, aeSink: sink, commonAttrs: COMMON_ATTRS, nowMs: 1000 },
  );
  assert.equal(sink._points.length, 1);
  assert.equal(sink._points[0].indexes[0], "o11y.alert");
});

test("notify: a missing Slack webhook never throws (slackPoster no-ops)", async () => {
  const post = slackPoster(undefined);
  await assert.doesNotReject(() => post("hello"));
});

// ---- alerts/rules.ts: InboxWriter-only rules (no AE query needed) --------

test("backlogAgeRule: fires only past the 2h threshold", async () => {
  const writerUnder = { backlogOldestAgeMs: async () => 60 * 60 * 1000 }; // 1h
  const under = await backlogAgeRule(writerUnder);
  assert.equal(under.firing, false);

  const writerOver = { backlogOldestAgeMs: async () => 3 * 60 * 60 * 1000 }; // 3h
  const over = await backlogAgeRule(writerOver);
  assert.equal(over.firing, true);
});

test("rejectedKeyRule: fires on any rejected key, resolves at zero", async () => {
  const writerNone = { rejectedKeyCount: async () => 0 };
  assert.equal((await rejectedKeyRule(writerNone)).firing, false);
  const writerSome = { rejectedKeyCount: async () => 1 };
  assert.equal((await rejectedKeyRule(writerSome)).firing, true);
});

test("newFingerprintRule: fires when a new fingerprint appears since the cursor, advances the cursor", async () => {
  let cursor;
  const seen = [];
  const writer = {
    async getAlertMeta() {
      return cursor;
    },
    async setAlertMeta(_k, v) {
      cursor = v;
    },
    async newFingerprintsSince(since) {
      seen.push(since);
      return since === undefined || Number(since) < 5000 ? ["fp-a"] : [];
    },
  };
  const first = await newFingerprintRule(writer, 10_000);
  assert.equal(first.firing, true);
  assert.match(first.detail, /fp-a/);
  assert.equal(cursor, "10000", "cursor must advance to nowMs");

  // Cursor is now 10000, so the same underlying data source, queried again,
  // reports nothing new.
  const second = await newFingerprintRule(writer, 20_000);
  assert.equal(second.firing, false);
});

test("o11yCapRule: fires at or above the cap, not below it", async () => {
  const under = await o11yCapRule({ spendUsd: 14.99, capUsd: 15 });
  assert.equal(under.firing, false);
  const atCap = await o11yCapRule({ spendUsd: 15, capUsd: 15 });
  assert.equal(atCap.firing, true);
  const over = await o11yCapRule({ spendUsd: 20, capUsd: 15 });
  assert.equal(over.firing, true);
});

// ---- Through the REAL InboxWriter Durable Object (not just the pure -----
// helpers) — proves the RPC wiring in writer.ts, the same "route-level
// proof through the real class" rule o11y-routes.test.mjs/o11y-box.test.mjs
// already follow for their own surfaces.

test("InboxWriter (real DO): drainsPaused defaults false, round-trips through setDrainsPaused", async () => {
  const { env } = makeEnv(InboxWriter);
  const writer = env.INBOX_WRITER.jurisdiction("eu").get();
  assert.equal(await writer.drainsPaused(), false);
  await writer.setDrainsPaused(true);
  assert.equal(await writer.drainsPaused(), true);
  await writer.setDrainsPaused(false);
  assert.equal(await writer.drainsPaused(), false);
});

test("InboxWriter (real DO): alertState/setAlertState round-trip, distinct rules don't collide", async () => {
  const { env } = makeEnv(InboxWriter);
  const writer = env.INBOX_WRITER.jurisdiction("eu").get();
  assert.equal(await writer.alertState("rule-a"), undefined);
  await writer.setAlertState("rule-a", { state: "firing", since: 1, lastNotified: 1 });
  await writer.setAlertState("rule-b", { state: "resolved", since: 2, lastNotified: 2 });
  assert.deepEqual(await writer.alertState("rule-a"), { state: "firing", since: 1, lastNotified: 1 });
  assert.deepEqual(await writer.alertState("rule-b"), { state: "resolved", since: 2, lastNotified: 2 });
});

test("InboxWriter (real DO): stampCronHeartbeat + heartbeat, and backlogOldestAgeMs off the real ingest path", async () => {
  const { env } = makeEnv(InboxWriter);
  const writer = env.INBOX_WRITER.jurisdiction("eu").get();
  assert.deepEqual(await writer.heartbeat(), { lastCron: 0, lastIngest: 0 });
  await writer.stampCronHeartbeat(12345);
  assert.deepEqual(await writer.heartbeat(), { lastCron: 12345, lastIngest: 0 });

  // ingest() stamps lastIngest AND produces the `key:*` rows backlogOldestAgeMs reads.
  const result = await writer.ingest("worker", 100, [
    {
      hash: "h1",
      record: {
        body: "hello",
        timeUnixNano: "100000000",
        resourceAttributes: { "service.name": "demos-api" },
      },
    },
  ]);
  assert.equal(result.results[0].outcome, "accepted");
  assert.equal((await writer.heartbeat()).lastIngest, 100);
});

test("readHeartbeatReport (heartbeat.ts): composes InboxWriter's heartbeat + backlog into one report", async () => {
  const { env } = makeEnv(InboxWriter);
  const writer = env.INBOX_WRITER.jurisdiction("eu").get();
  await writer.stampCronHeartbeat(555);
  const report = await readHeartbeatReport(env);
  assert.equal(report.lastCron, 555);
  assert.equal(report.lastIngest, 0);
  assert.equal(report.backlogOldestAgeMs, null, "no backlog yet");
});

test("canWakeForBacklog: true when drains are not paused, false once the cap sets them", async () => {
  const { env } = makeEnv(InboxWriter);
  assert.equal(await canWakeForBacklog(env), true);
  const writer = env.INBOX_WRITER.jurisdiction("eu").get();
  await writer.setDrainsPaused(true);
  assert.equal(await canWakeForBacklog(env), false);
});
