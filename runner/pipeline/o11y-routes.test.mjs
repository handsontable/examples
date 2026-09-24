// Route-level proof for the o11y worker (the `mcp-routes.test.mjs` pattern,
// TESTING.md "the untested router" anti-pattern): driven through the REAL
// router — the default export of `workers/o11y/src/index.ts` — not through
// re-declared copies of its gates. Status codes, 2xx-after-commit, and the
// gate-bypass proofs live here.
//
// Run: node --experimental-strip-types --test pipeline/o11y-routes.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

register("./fixtures/o11y-worker-hooks.mjs", import.meta.url);

const { default: worker } = await import("../workers/o11y/src/index.ts");
const { InboxWriter } = await import("../workers/o11y/src/inbox/writer.ts");
const { makeEnv, ctx } = await import("./fixtures/o11y-harness.mjs");
const { hmacSha256Hex } = await import("../workers/o11y/src/gates/util.ts");

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const faroFixture = (name) => readFileSync(`${FIXTURES}faro/${name}`, "utf8");
const otlpJsonFixture = (name) => readFileSync(`${FIXTURES}otlp/json/${name}`, "utf8");
const otlpProtobufFixture = (name) => readFileSync(`${FIXTURES}otlp/protobuf/${name}`);
const jsonFixture = (name) => readFileSync(`${FIXTURES}otlp/${name}`, "utf8");

/** Faro's real timestamp is a JSON string field; a fixture written once and
 *  replayed months later would fall outside ADR §C.2's 5-minute clamp
 *  window and silently exercise the fallback instead of the intended value
 *  — this keeps every Faro test on "now." */
function withFreshTimestamp(fixtureText) {
  const body = JSON.parse(fixtureText);
  for (const key of ["exceptions", "logs", "measurements", "events"]) {
    for (const item of body[key] ?? []) item.timestamp = new Date().toISOString();
  }
  return body;
}

function freshEnv() {
  return makeEnv(InboxWriter);
}

test("POST /telemetry/collect: an accepted Faro batch answers 2xx after the storage commit", async () => {
  const { env } = freshEnv();
  const body = withFreshTimestamp(faroFixture("log.json"));
  const req = new Request("https://demos.handsontable.com/telemetry/collect", {
    method: "POST",
    headers: { Origin: "https://demos.handsontable.com", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await worker.fetch(req, env, ctx);
  await ctx.drain();
  assert.ok(res.status >= 200 && res.status < 300, `expected 2xx, got ${res.status}`);
});

test("POST /telemetry/collect: a bot user-agent is refused, never reaches the inbox", async () => {
  const { env, doStorage } = freshEnv();
  const body = withFreshTimestamp(faroFixture("log.json"));
  const req = new Request("https://demos.handsontable.com/telemetry/collect", {
    method: "POST",
    headers: {
      Origin: "https://demos.handsontable.com",
      "content-type": "application/json",
      "user-agent": "curl/8.0.0",
    },
    body: JSON.stringify(body),
  });
  const res = await worker.fetch(req, env, ctx);
  await ctx.drain();
  assert.equal(res.status, 403);
  assert.equal([...doStorage._data.keys()].some((k) => k.startsWith("row:")), false);
});

test("POST /telemetry/collect: a wrong Origin is refused with the host gate", async () => {
  const { env } = freshEnv();
  const req = new Request("https://demos.handsontable.com/telemetry/collect", {
    method: "POST",
    headers: { Origin: "https://evil.example.com", "content-type": "application/json" },
    body: JSON.stringify({ meta: {} }),
  });
  const res = await worker.fetch(req, env, ctx);
  await ctx.drain();
  assert.equal(res.status, 403);
});

test("POST /telemetry/collect: a batch over MAX_FARO_ITEMS_PER_BODY is refused outright, never partially processed (finding A-I4)", async () => {
  const { env, doStorage } = freshEnv();
  const body = withFreshTimestamp(faroFixture("log.json"));
  // Inflate one legitimate log item into 300 — well over the 200 cap —
  // the same shape the finding's own measured probe describes (a giant
  // batch inflating AE points and DO dedupe-check load).
  const one = body.logs[0];
  body.logs = Array.from({ length: 300 }, () => ({ ...one }));

  const req = new Request("https://demos.handsontable.com/telemetry/collect", {
    method: "POST",
    headers: { Origin: "https://demos.handsontable.com", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await worker.fetch(req, env, ctx);
  await ctx.drain();
  assert.equal(res.status, 400);
  assert.equal(
    [...doStorage._data.keys()].some((k) => k.startsWith("row:")),
    false,
    "an over-cap batch must never reach storage, not even partially",
  );
});

// N2 (merge blocker, final review): the real SQLite-backed DO storage API
// caps get/put/delete at 128 keys/pairs per call. 65 UNIQUE log messages
// (still under the 200-item A-I4 cap) already need 130 lookup keys in
// `dedupe.ts#checkDuplicates`'s single `getMany` (2 day-buckets per unique
// hash) — well over 128. Before this fix round chunked every such call,
// this would either throw inside `InboxWriter.ingest`'s transaction (and
// the route's own catch would then answer a MISLEADING 204 with nothing
// stored — finding N3) or, if `memoryStorage`/the harness didn't enforce
// the real limit, silently pass locally while throwing in production.
// Per the advisor review this fix round recorded: assert the records
// actually LANDED in storage, not just the response status code.
test("POST /telemetry/collect: a batch of 65 unique log records (over the DO storage 128-key limit once bucketed) is fully accepted and stored (finding N2)", async () => {
  const { env, doStorage } = freshEnv();
  const body = withFreshTimestamp(faroFixture("log.json"));
  const template = body.logs[0];
  const UNIQUE_COUNT = 65;
  body.logs = Array.from({ length: UNIQUE_COUNT }, (_, i) => ({ ...template, message: `${template.message} #${i}` }));

  const req = new Request("https://demos.handsontable.com/telemetry/collect", {
    method: "POST",
    headers: { Origin: "https://demos.handsontable.com", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await worker.fetch(req, env, ctx);
  await ctx.drain();
  assert.ok(res.status >= 200 && res.status < 300, `expected 2xx, got ${res.status}`);

  // Assert the records actually reached storage — not just a 2xx, which
  // `handleCollect`'s own catch (N3) can answer even when `ingest` threw
  // and stored nothing.
  const rowKeys = [...doStorage._data.keys()].filter((k) => k.startsWith("row:"));
  assert.ok(rowKeys.length > 0, "at least one row: entry must exist after a 65-unique-item batch");
  let totalRecords = 0;
  for (const k of rowKeys) totalRecords += doStorage._data.get(k).resourceLogs.length;
  assert.equal(totalRecords, UNIQUE_COUNT, "every one of the 65 unique records must be stored, none dropped");

  // A redelivery of the SAME batch must dedupe every one of the 65 hashes
  // in one call too (the other half of checkDuplicates's chunked getMany).
  const replay = await worker.fetch(
    new Request("https://demos.handsontable.com/telemetry/collect", {
      method: "POST",
      headers: { Origin: "https://demos.handsontable.com", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
  await ctx.drain();
  assert.ok(replay.status >= 200 && replay.status < 300);
  const rowKeysAfterReplay = [...doStorage._data.keys()].filter((k) => k.startsWith("row:"));
  let totalAfterReplay = 0;
  for (const k of rowKeysAfterReplay) totalAfterReplay += doStorage._data.get(k).resourceLogs.length;
  assert.equal(totalAfterReplay, UNIQUE_COUNT, "a redelivery of all 65 must be fully deduped, not stored a second time");
});

test("POST /telemetry/collect: a retried batch (identical body, redelivered) does not double-count the browser metric point — only the dedupe-accepted copy writes error.uncaught (finding A-I4)", async () => {
  const { env, ae } = freshEnv();
  const body = withFreshTimestamp(faroFixture("exception-code-frame.json"));
  const req = () =>
    new Request("https://demos.handsontable.com/telemetry/collect", {
      method: "POST",
      headers: { Origin: "https://demos.handsontable.com", "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const first = await worker.fetch(req(), env, ctx);
  await ctx.drain();
  assert.ok(first.status >= 200 && first.status < 300);

  const second = await worker.fetch(req(), env, ctx);
  await ctx.drain();
  assert.ok(second.status >= 200 && second.status < 300, "a duplicate delivery must still answer 2xx");

  const errorPoints = ae.points.filter((p) => p.indexes[0] === "error.uncaught");
  assert.equal(errorPoints.length, 1, "a redelivered batch must write exactly one error.uncaught point, not two");
});

// A-I4 remainder (closed, second wave): `example.*` events used to bypass
// InboxWriter.ingest's dedupe transaction entirely (no ingestItem at all),
// so a retried/redelivered batch inflated ADR-0042's analytics counts on
// every replay — unlike every other item type, which A-I4's original fix
// already protected. `normalise/faro.ts` now gives an example.* event a
// hash-only ingestItem (no `record`, so it is still never stored, §6)
// purely so it flows through the SAME dedupe-gated point-write logic
// `index.ts#handleCollect` already has for everything else.
test("POST /telemetry/collect: a retried batch (identical body, redelivered) does not double-count an example.* analytics point (A-I4 remainder)", async () => {
  const { env, ae, doStorage } = freshEnv();
  const body = withFreshTimestamp(faroFixture("example-open.json"));
  const req = () =>
    new Request("https://demos.handsontable.com/telemetry/collect", {
      method: "POST",
      headers: { Origin: "https://demos.handsontable.com", "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const first = await worker.fetch(req(), env, ctx);
  await ctx.drain();
  assert.ok(first.status >= 200 && first.status < 300);

  const second = await worker.fetch(req(), env, ctx);
  await ctx.drain();
  assert.ok(second.status >= 200 && second.status < 300, "a duplicate delivery must still answer 2xx");

  const examplePoints = ae.points.filter((p) => p.indexes[0] === "example.open");
  assert.equal(examplePoints.length, 1, "a redelivered example.* batch must write exactly one point, not two");

  // §6 must still hold: an example.* event is never stored, redelivered or not.
  const rowKeys = [...doStorage._data.keys()].filter((k) => k.startsWith("row:"));
  assert.equal(rowKeys.length, 0, "an example.* event must never produce a row: entry");
});

test("POST /telemetry/v1/logs: the x-o11y-secret gate — wrong secret is 401, correct secret is 2xx", async () => {
  const { env } = freshEnv();
  const body = otlpJsonFixture("basic.json");

  const wrong = await worker.fetch(
    new Request("https://demos.handsontable.com/telemetry/v1/logs", {
      method: "POST",
      headers: { "x-o11y-secret": "wrong", "content-type": "application/json" },
      body,
    }),
    env,
    ctx,
  );
  await ctx.drain();
  assert.equal(wrong.status, 401);

  const right = await worker.fetch(
    new Request("https://demos.handsontable.com/telemetry/v1/logs", {
      method: "POST",
      headers: { "x-o11y-secret": env.O11Y_EXPORT_SECRET, "content-type": "application/json" },
      body,
    }),
    env,
    ctx,
  );
  await ctx.drain();
  assert.ok(right.status >= 200 && right.status < 300);
});

test("POST /telemetry/v1/logs: protobuf content-type is decoded via the protobuf path", async () => {
  const { env } = freshEnv();
  const res = await worker.fetch(
    new Request("https://demos.handsontable.com/telemetry/v1/logs", {
      method: "POST",
      headers: { "x-o11y-secret": env.O11Y_EXPORT_SECRET, "content-type": "application/x-protobuf" },
      body: otlpProtobufFixture("basic.bin"),
    }),
    env,
    ctx,
  );
  await ctx.drain();
  assert.ok(res.status >= 200 && res.status < 300, `expected 2xx, got ${res.status}`);
});

test("POST /telemetry/v1/logs: an oversize record writes an o11y.ingest point with reason=size, not invalid_item (I3)", async () => {
  const { env, ae } = freshEnv();
  const huge = "x".repeat(300_000);
  const body = JSON.stringify({
    resourceLogs: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "demos-api" } }] },
        scopeLogs: [{ logRecords: [{ timeUnixNano: "1735689600000000000", body: { stringValue: huge } }] }],
      },
    ],
  });
  const res = await worker.fetch(
    new Request("https://demos.handsontable.com/telemetry/v1/logs", {
      method: "POST",
      headers: { "x-o11y-secret": env.O11Y_EXPORT_SECRET, "content-type": "application/json" },
      body,
    }),
    env,
    ctx,
  );
  await ctx.drain();
  assert.ok(res.status >= 200 && res.status < 300, "the batch itself still answers 2xx");

  const ingestPoints = ae.points.filter((p) => p.indexes[0] === "o11y.ingest");
  const reasons = ingestPoints.map((p) => p.blobs[8]); // reason = blob9, index 8
  assert.ok(reasons.includes("size"), `expected a reason="size" point, got reasons: ${JSON.stringify(reasons)}`);
  assert.ok(!reasons.includes("invalid_item"), "an oversize drop must not be recorded as invalid_item");
});

test("POST /telemetry/collect: an oversize Faro record writes an o11y.ingest point with reason=size (I2 + I3)", async () => {
  const { env, ae } = freshEnv();
  const body = withFreshTimestamp(faroFixture("log.json"));
  body.logs[0].message = "x".repeat(300_000);
  const req = new Request("https://demos.handsontable.com/telemetry/collect", {
    method: "POST",
    headers: { Origin: "https://demos.handsontable.com", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await worker.fetch(req, env, ctx);
  await ctx.drain();
  assert.ok(res.status >= 200 && res.status < 300, "the batch itself still answers 2xx");

  const ingestPoints = ae.points.filter((p) => p.indexes[0] === "o11y.ingest");
  const reasons = ingestPoints.map((p) => p.blobs[8]);
  assert.ok(reasons.includes("size"), `expected a reason="size" point, got reasons: ${JSON.stringify(reasons)}`);
  assert.ok(!reasons.includes("invalid_item"), "an oversize drop must not be recorded as invalid_item");
});

// ---- Exit criterion 4: duplicate delivery -------------------------------------

test("exit criterion 4: the same OTLP export body posted twice, seconds apart, including a zero-timestamp record, yields one stored copy and one duplicate point", async (t) => {
  const { env, doStorage, ae } = freshEnv();
  const body = jsonFixture("json/zero-timestamp.json");
  const headers = { "x-o11y-secret": env.O11Y_EXPORT_SECRET, "content-type": "application/json" };

  const first = await worker.fetch(
    new Request("https://demos.handsontable.com/telemetry/v1/logs", { method: "POST", headers, body }),
    env,
    ctx,
  );
  await ctx.drain();
  assert.ok(first.status >= 200 && first.status < 300);

  // "seconds apart" — a real clock gap, not just a second call in the same tick.
  await new Promise((r) => setTimeout(r, 20));

  const second = await worker.fetch(
    new Request("https://demos.handsontable.com/telemetry/v1/logs", { method: "POST", headers, body }),
    env,
    ctx,
  );
  await ctx.drain();
  assert.ok(second.status >= 200 && second.status < 300, "a duplicate delivery still answers 2xx");

  const rowKeys = [...doStorage._data.keys()].filter((k) => k.startsWith("row:"));
  const totalRecords = rowKeys.reduce((n, k) => n + doStorage._data.get(k).resourceLogs.length, 0);
  assert.equal(totalRecords, 1, "exactly one copy must be pending after the duplicate delivery");

  const ingestPoints = ae.points.filter((p) => p.indexes[0] === "o11y.ingest");
  const outcomes = ingestPoints.map((p) => p.blobs[7]); // hot.outcome = blob8, index 7
  assert.ok(outcomes.includes("duplicate"), "one duplicate o11y.ingest point must be written");
  const duplicatePoints = ingestPoints.filter((p) => p.blobs[7] === "duplicate");
  assert.equal(duplicatePoints.length, 1, "exactly one duplicate point, not one per record");
});

// ---- POST /telemetry/deploy ------------------------------------------------------

test("POST /telemetry/deploy: GitHub OIDC absent, correct secret passes", async () => {
  const { env } = freshEnv();
  const res = await worker.fetch(
    new Request("https://demos.handsontable.com/telemetry/deploy", {
      method: "POST",
      headers: { "x-o11y-secret": env.O11Y_EXPORT_SECRET, "content-type": "application/json" },
      body: jsonFixture("deploy-event.json"),
    }),
    env,
    ctx,
  );
  await ctx.drain();
  assert.ok(res.status >= 200 && res.status < 300, `expected 2xx, got ${res.status}`);
});

test("POST /telemetry/deploy: the stored record is self-identified (demos-o11y/o11y) with the deploy fields in the body (controller-pinned shape for T09)", async () => {
  const { env, r2 } = freshEnv();
  const payload = JSON.parse(jsonFixture("deploy-event.json"));
  await worker.fetch(
    new Request("https://demos.handsontable.com/telemetry/deploy", {
      method: "POST",
      headers: { "x-o11y-secret": env.O11Y_EXPORT_SECRET, "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
    env,
    ctx,
  );
  await ctx.drain();

  const inboxWriter = env.INBOX_WRITER.get();
  await inboxWriter.alarm();
  assert.equal(r2.objects.size, 1);
  const [key, bytes] = [...r2.objects.entries()][0];
  assert.match(key, /^inbox\/worker\//);
  const text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
  const resourceLogs = JSON.parse(text.trim());
  const attrs = Object.fromEntries(resourceLogs.resource.attributes.map((a) => [a.key, a.value.stringValue]));
  assert.equal(attrs["service.name"], "demos-o11y");
  assert.equal(attrs["hot.surface"], "o11y");
  const body = JSON.parse(resourceLogs.scopeLogs[0].logRecords[0].body.stringValue);
  assert.deepEqual(body, { event: "deploy", ...payload });
});

test("POST /telemetry/deploy: no OIDC token and no secret is refused", async () => {
  const { env } = freshEnv();
  const res = await worker.fetch(
    new Request("https://demos.handsontable.com/telemetry/deploy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: jsonFixture("deploy-event.json"),
    }),
    env,
    ctx,
  );
  await ctx.drain();
  assert.equal(res.status, 401);
});

// ---- POST /telemetry/hooks/sentry -------------------------------------------------

test("POST /telemetry/hooks/sentry: a correct HMAC signature passes, a wrong one is refused", async () => {
  const { env } = freshEnv();
  const body = jsonFixture("sentry-issue.json");
  const sig = await hmacSha256Hex(env.SENTRY_HOOK_SECRET, body);

  const good = await worker.fetch(
    new Request("https://demos.handsontable.com/telemetry/hooks/sentry", {
      method: "POST",
      headers: { "sentry-hook-signature": sig, "content-type": "application/json" },
      body,
    }),
    env,
    ctx,
  );
  await ctx.drain();
  assert.ok(good.status >= 200 && good.status < 300);

  const bad = await worker.fetch(
    new Request("https://demos.handsontable.com/telemetry/hooks/sentry", {
      method: "POST",
      headers: { "sentry-hook-signature": "0".repeat(64), "content-type": "application/json" },
      body,
    }),
    env,
    ctx,
  );
  await ctx.drain();
  assert.equal(bad.status, 401);
});

test("POST /telemetry/hooks/sentry: fix round A-I3 — a title embedding a preview host, a query string, an email and a user-agent is scrubbed before storage, not stored verbatim", async () => {
  const { env, r2 } = freshEnv();
  // The exact probe from the finding: a correctly-signed hook whose title
  // carries a preview host (a session credential), a query string, an
  // email and a user-agent — all on contract §3's "never sent" list.
  const payload = {
    action: "created",
    data: {
      issue: {
        id: "987654321",
        title:
          "TypeError: Failed to fetch (https://8787-abc-tok3n.demos.handsontable.com/a?token=SECRET) user a@b.com Mozilla/5.0 (X11; Linux) Chrome/1",
        permalink: "https://handsoncode.sentry.io/issues/987654321/?referrer=slack",
      },
    },
  };
  const body = JSON.stringify(payload);
  const sig = await hmacSha256Hex(env.SENTRY_HOOK_SECRET, body);

  const res = await worker.fetch(
    new Request("https://demos.handsontable.com/telemetry/hooks/sentry", {
      method: "POST",
      headers: { "sentry-hook-signature": sig, "content-type": "application/json" },
      body,
    }),
    env,
    ctx,
  );
  await ctx.drain();
  assert.ok(res.status >= 200 && res.status < 300);

  const inboxWriter = env.INBOX_WRITER.get();
  await inboxWriter.alarm();
  assert.equal(r2.objects.size, 1);
  const [, bytes] = [...r2.objects.entries()][0];
  const text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();

  assert.doesNotMatch(text, /8787-abc-tok3n/, "no preview hostname (session credential) survives");
  assert.doesNotMatch(text, /token=SECRET/, "no query string survives");
  assert.doesNotMatch(text, /a@b\.com/, "no email survives");
  assert.doesNotMatch(text, /Mozilla\/5\.0/, "no user-agent survives");
  assert.doesNotMatch(text, /referrer=slack/, "no query string on the permalink survives");
});

// ---- unregistered contract routes still 501/404 -----------------------------------
//
// `POST /telemetry/lite` was this file's own placeholder for "not yet
// registered" until T08 (ADR §C.5) implemented it — `workers/o11y/src/lite.ts`,
// registered through the same `router.ts` this file drives its assertions
// through. Its real behaviour (status codes, gates, the stored shape) is
// `pipeline/lite-beacon.test.mjs`'s job now, the same split every other T02
// route already has with its own dedicated fixtures.

test("an unknown path answers 404", async () => {
  const { env } = freshEnv();
  const res = await worker.fetch(new Request("https://demos.handsontable.com/nope"), env, ctx);
  assert.equal(res.status, 404);
});

// ---- Every stored record carries the contract labels, none carry forbidden data ---

test("a Faro exception fixture, replayed end to end, is scrubbed in the actual R2 object", async () => {
  const { env, r2 } = freshEnv();
  const body = withFreshTimestamp(faroFixture("exception-code-frame.json"));
  const req = new Request("https://demos.handsontable.com/telemetry/collect", {
    method: "POST",
    headers: { Origin: "https://demos.handsontable.com", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await worker.fetch(req, env, ctx);
  await ctx.drain();
  assert.ok(res.status >= 200 && res.status < 300);

  // Force the pack alarm rather than waiting 60s.
  const inboxWriter = env.INBOX_WRITER.get();
  await inboxWriter.alarm();

  assert.equal(r2.objects.size, 1, "one packed object should exist after the alarm");
  const [key, bytes] = [...r2.objects.entries()][0];
  assert.match(key, /^inbox\/browser\//);
  const text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
  assert.doesNotMatch(text, /8787-abc123-tok3n/);
  assert.doesNotMatch(text, /\?t=1700000000/);
  assert.doesNotMatch(text, /> 2 \|/);
});
