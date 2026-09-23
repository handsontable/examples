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
  atCapacityRule,
  fiveXxRateRule,
  previewReadyRateRule,
  sessionStartP95Rule,
  embedErrorRateRule,
  compileErrorDoublingRule,
  litellmErrorRateRule,
  backlogAgeRule,
  rejectedKeyRule,
  newFingerprintRule,
  o11yCapRule,
  alertEvalErrorRule,
} = await import("../workers/o11y/src/alerts/rules.ts");
const { assertAllowedAeQuery, findDisallowedAeFunctions, ALLOWED_AE_FUNCTIONS } =
  await import("../workers/o11y/src/alerts/ae-query.ts");
const { inboxKeyStorageKey, fingerprintStorageKey, AE_COLUMNS } = await import("@handsontable/demo-runtime/telemetry");
const { InboxWriter } = await import("../workers/o11y/src/inbox/writer.ts");
const { readHeartbeatReport } = await import("../workers/o11y/src/heartbeat.ts");
const { canWakeForBacklog, runAlerts } = await import("../workers/o11y/src/alerts/index.ts");
const { makeEnv } = await import("./fixtures/o11y-harness.mjs");
const { makeFakeAeQuery } = await import("./fixtures/fake-ae-query.mjs");

const DAY_MS = 24 * 60 * 60 * 1000;

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

// ---- Fix round (I1): the 7 AE-query rules + their shared SQL helpers -----
//
// Each test drives the REAL rule function over an injected fake `queryFn`
// (`fixtures/fake-ae-query.mjs`) — no live ClickHouse/AE endpoint, fully
// deterministic. Every test also asserts the SQL the rule actually issued
// names the right AE_COLUMNS slot (imported, never hand-numbered) for at
// least one column central to that rule.

test("atCapacityRule: over threshold (6 > 5) fires; under threshold (5) does not", async () => {
  const over = makeFakeAeQuery([{ metric: "session.start", outcome: "at_capacity", count: 6 }]);
  const overResult = await atCapacityRule({}, over.queryFn);
  assert.equal(overResult.firing, true);
  assert.match(overResult.detail, /^6 at_capacity/);
  assert.ok(over.calls[0].includes(AE_COLUMNS.outcome), "SQL must reference the outcome column (AE_COLUMNS.outcome)");

  const under = makeFakeAeQuery([{ metric: "session.start", outcome: "at_capacity", count: 5 }]);
  const underResult = await atCapacityRule({}, under.queryFn);
  assert.equal(underResult.firing, false);
});

test("fiveXxRateRule: over threshold (5%) fires; under threshold (0.5%) does not", async () => {
  const over = makeFakeAeQuery([
    { metric: "api.request", outcome: "2xx", count: 95 },
    { metric: "api.request", outcome: "5xx", count: 5 },
  ]);
  const overResult = await fiveXxRateRule({}, over.queryFn);
  assert.equal(overResult.firing, true);
  assert.ok(over.calls[0].includes(AE_COLUMNS.outcome));
  assert.ok(over.calls[0].includes(AE_COLUMNS.count), "SQL must sum the count column (AE_COLUMNS.count)");

  const under = makeFakeAeQuery([
    { metric: "api.request", outcome: "2xx", count: 199 },
    { metric: "api.request", outcome: "5xx", count: 1 },
  ]);
  const underResult = await fiveXxRateRule({}, under.queryFn);
  assert.equal(underResult.firing, false);
});

test("previewReadyRateRule: tier 1 below 97% fires, tier 2 within threshold does not (mixed)", async () => {
  const fake = makeFakeAeQuery([
    { metric: "preview.ready_ms", tier: "1", outcome: "ready", count: 90 },
    { metric: "preview.ready_ms", tier: "1", outcome: "error", count: 10 },
    { metric: "preview.ready_ms", tier: "2", outcome: "ready", count: 96 },
    { metric: "preview.ready_ms", tier: "2", outcome: "error", count: 4 },
  ]);
  const result = await previewReadyRateRule({}, fake.queryFn);
  assert.equal(result.firing, true, "tier 1 at 90% ready is below its 97% threshold");
  assert.match(result.detail, /tier 1/);
  assert.doesNotMatch(result.detail, /tier 2/, "tier 2 (96% ready, threshold 95%) must not be listed as an offender");
  assert.ok(fake.calls.some((s) => s.includes(AE_COLUMNS.tier)), "SQL must filter on the tier column (AE_COLUMNS.tier)");

  const healthy = makeFakeAeQuery([
    { metric: "preview.ready_ms", tier: "1", outcome: "ready", count: 98 },
    { metric: "preview.ready_ms", tier: "1", outcome: "error", count: 2 },
    { metric: "preview.ready_ms", tier: "2", outcome: "ready", count: 96 },
    { metric: "preview.ready_ms", tier: "2", outcome: "error", count: 4 },
  ]);
  const healthyResult = await previewReadyRateRule({}, healthy.queryFn);
  assert.equal(healthyResult.firing, false);
});

test("sessionStartP95Rule: over 20s fires, under does not; outcome='ready' filter is real, not decorative", async () => {
  const over = makeFakeAeQuery([
    ...Array.from({ length: 10 }, () => ({ metric: "session.start", outcome: "ready", duration_ms: 5000 })),
    { metric: "session.start", outcome: "ready", duration_ms: 30_000 },
  ]);
  const overResult = await sessionStartP95Rule({}, over.queryFn);
  assert.equal(overResult.firing, true, `expected p95 > 20s: ${overResult.detail}`);
  assert.ok(over.calls[0].includes(AE_COLUMNS.duration_ms), "SQL must read the duration_ms column (AE_COLUMNS.duration_ms)");
  assert.ok(
    over.calls[0].includes(`${AE_COLUMNS.outcome} = 'ready'`),
    "SQL must filter to outcome='ready' (controller ruling, fix round Minor 3)",
  );

  const under = makeFakeAeQuery(
    Array.from({ length: 20 }, () => ({ metric: "session.start", outcome: "ready", duration_ms: 5000 })),
  );
  const underResult = await sessionStartP95Rule({}, under.queryFn);
  assert.equal(underResult.firing, false);

  // The filter is load-bearing: a huge non-'ready' outcome (a fast refusal
  // that happens to carry a stale/garbage duration) must NOT be allowed to
  // drag the computed p95 up. If the filter were dropped, this fake would
  // include the 999999ms row and firing would flip to true.
  const filtered = makeFakeAeQuery([
    ...Array.from({ length: 10 }, () => ({ metric: "session.start", outcome: "ready", duration_ms: 1000 })),
    { metric: "session.start", outcome: "at_capacity", duration_ms: 999_999 },
  ]);
  const filteredResult = await sessionStartP95Rule({}, filtered.queryFn);
  assert.equal(filteredResult.firing, false, "the at_capacity row's huge duration must be excluded by the outcome filter");
});

test("embedErrorRateRule: a demo over 20% error rate with >50 views fires; under threshold and the views floor do not", async () => {
  const over = makeFakeAeQuery([
    { metric: "error.uncaught", surface: "embed", demo_id: "r-react", count: 30 },
    { metric: "serve.embed", outcome: "2xx", demo_id: "r-react", count: 100 },
  ]);
  const overResult = await embedErrorRateRule({}, over.queryFn);
  assert.equal(overResult.firing, true);
  assert.match(overResult.detail, /r-react/);
  assert.ok(over.calls.some((s) => s.includes(AE_COLUMNS.demo_id)), "SQL must group by demo_id (AE_COLUMNS.demo_id)");
  assert.ok(over.calls.some((s) => s.includes(AE_COLUMNS.surface)), "SQL must filter surface='embed' (AE_COLUMNS.surface)");

  const under = makeFakeAeQuery([
    // Under threshold: 5% error rate on a demo with plenty of views.
    { metric: "error.uncaught", surface: "embed", demo_id: "r-vue", count: 5 },
    { metric: "serve.embed", outcome: "2xx", demo_id: "r-vue", count: 100 },
    // Views floor: 100% error rate but only 50 views (not > 50) — excluded.
    { metric: "error.uncaught", surface: "embed", demo_id: "r-tiny", count: 50 },
    { metric: "serve.embed", outcome: "2xx", demo_id: "r-tiny", count: 50 },
  ]);
  const underResult = await embedErrorRateRule({}, under.queryFn);
  assert.equal(underResult.firing, false, underResult.detail);
});

test("compileErrorDoublingRule: today >= 2x yesterday (floor met) fires; under the doubling ratio and under the floor do not", async () => {
  const TODAY_AGE_MS = 60_000; // within the last 24h
  const YESTERDAY_AGE_MS = 90_000_000; // ~25h ago, within the 24-48h-ago window

  const over = makeFakeAeQuery([
    { metric: "sandpack.compile_error", ht_major: "18", count: 10, ageMs: TODAY_AGE_MS },
    { metric: "sandpack.compile_error", ht_major: "18", count: 4, ageMs: YESTERDAY_AGE_MS },
  ]);
  const overResult = await compileErrorDoublingRule({}, over.queryFn);
  assert.equal(overResult.firing, true, overResult.detail);
  assert.match(overResult.detail, /ht_major 18/);
  assert.ok(over.calls.some((s) => s.includes(AE_COLUMNS.ht_major)), "SQL must group by ht_major (AE_COLUMNS.ht_major)");

  const under = makeFakeAeQuery([
    // Under the doubling ratio: 10 today vs 6 yesterday (< 2x).
    { metric: "sandpack.compile_error", ht_major: "19", count: 10, ageMs: TODAY_AGE_MS },
    { metric: "sandpack.compile_error", ht_major: "19", count: 6, ageMs: YESTERDAY_AGE_MS },
    // Under the floor: 3 today (< 5) even against 0 yesterday — never "doubling".
    { metric: "sandpack.compile_error", ht_major: "20", count: 3, ageMs: TODAY_AGE_MS },
  ]);
  const underResult = await compileErrorDoublingRule({}, under.queryFn);
  assert.equal(underResult.firing, false, underResult.detail);
});

test("litellmErrorRateRule: chat.answer + theme.ai combined over 5% fires; under does not", async () => {
  const over = makeFakeAeQuery([
    { metric: "chat.answer", outcome: "answered", count: 46 },
    { metric: "chat.answer", outcome: "error", count: 4 },
    { metric: "theme.ai", outcome: "answered", count: 48 },
    { metric: "theme.ai", outcome: "error", count: 2 },
  ]);
  const overResult = await litellmErrorRateRule({}, over.queryFn);
  assert.equal(overResult.firing, true, overResult.detail); // 6/100 = 6%

  const under = makeFakeAeQuery([
    { metric: "chat.answer", outcome: "answered", count: 99 },
    { metric: "chat.answer", outcome: "error", count: 1 },
    { metric: "theme.ai", outcome: "answered", count: 99 },
    { metric: "theme.ai", outcome: "error", count: 1 },
  ]);
  const underResult = await litellmErrorRateRule({}, under.queryFn);
  assert.equal(underResult.firing, false, underResult.detail); // 2/200 = 1%
});

// ---- Fix round (I2): alert-eval-error, surfaced from inside runAlerts ----

test("alertEvalErrorRule: fires with every failing rule id named, resolves on a clean errors map", () => {
  const clean = alertEvalErrorRule({});
  assert.equal(clean.firing, false);

  const broken = alertEvalErrorRule({ "at-capacity-rate": "boom", "api-5xx-rate": "kaboom" });
  assert.equal(broken.firing, true);
  assert.match(broken.detail, /at-capacity-rate/);
  assert.match(broken.detail, /api-5xx-rate/);
});

test("alertEvalErrorRule's RuleResult holds under the same fire-once/resolve-once machinery as every other rule", async () => {
  const writer = fakeInboxWriter();
  const sink = fakeAeSink();
  const slackCalls = [];
  const postSlack = async (text) => slackCalls.push(text);

  const fired = await evaluateAndNotify(
    alertEvalErrorRule({ "some-rule": "network error" }),
    { inboxWriter: writer, postSlack, aeSink: sink, commonAttrs: COMMON_ATTRS, nowMs: 1000 },
  );
  assert.equal(fired, "fired");
  assert.equal(slackCalls.length, 1);
  assert.match(slackCalls[0], /alert-eval-error/);
  assert.match(slackCalls[0], /some-rule/);

  // Still failing on the next tick -> silent (fire-once).
  const stillFiring = await evaluateAndNotify(
    alertEvalErrorRule({ "some-rule": "network error" }),
    { inboxWriter: writer, postSlack, aeSink: sink, commonAttrs: COMMON_ATTRS, nowMs: 2000 },
  );
  assert.equal(stillFiring, undefined);
  assert.equal(slackCalls.length, 1);

  const resolved = await evaluateAndNotify(
    alertEvalErrorRule({}),
    { inboxWriter: writer, postSlack, aeSink: sink, commonAttrs: COMMON_ATTRS, nowMs: 3000 },
  );
  assert.equal(resolved, "resolved");
  assert.equal(slackCalls.length, 2);
  assert.match(slackCalls[1], /resolved/);
});

test("runAlerts: a real query failure (unreachable local ClickHouse) is surfaced as errors AND fires alert-eval-error", async () => {
  const { env } = makeEnv(InboxWriter, {
    env: {
      O11Y_ENV: "local",
      // Port 1 on loopback refuses immediately — no real network hit, no
      // flakiness, and every AE-query rule's `runAeQuery` call fails fast.
      RUNNER_EVENTS_CLICKHOUSE_URL: "http://127.0.0.1:1",
    },
  });

  const first = await runAlerts(env);
  assert.ok(Object.keys(first.errors).length > 0, "expected at least one rule to fail against an unreachable endpoint");
  assert.ok(
    ["at-capacity-rate", "api-5xx-rate", "session-start-p95"].some((id) => id in first.errors),
    `expected known AE-query rule ids as error keys, got: ${Object.keys(first.errors).join(", ")}`,
  );
  assert.equal(first.transitions["alert-eval-error"], "fired");

  // Same broken config, second tick: errors persist, but the alert must NOT
  // notify a second time (fire-once, held by runAlerts calling the same
  // evaluateAndNotify every other rule uses).
  const second = await runAlerts(env);
  assert.ok(Object.keys(second.errors).length > 0);
  assert.equal(second.transitions["alert-eval-error"], undefined, "must stay silent while still failing");
});
