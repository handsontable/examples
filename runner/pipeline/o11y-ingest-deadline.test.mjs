// The ingest routes that await `InboxWriter.ingest` with no other catch
// (`v1/logs`, `deploy`, `hooks/sentry`) must fail visibly: a Durable Object
// call that never resolves answers 503 + Retry-After after the deadline, one
// that rejects answers 503 at once, and both write an `o11y.ingest` dropped
// point. Driven through the real default export, with only the DO stub faked.
// Run: node --experimental-strip-types --test pipeline/o11y-ingest-deadline.test.mjs

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

register("./fixtures/o11y-worker-hooks.mjs", import.meta.url);

const { default: worker } = await import("../workers/o11y/src/index.ts");
const { InboxWriter } = await import("../workers/o11y/src/inbox/writer.ts");
const { INGEST_DEADLINE_MS } = await import("../workers/o11y/src/inbox/ingest.ts");
const { makeEnv, ctx } = await import("./fixtures/o11y-harness.mjs");
const { hmacSha256Hex } = await import("../workers/o11y/src/gates/util.ts");

const FIXTURES = fileURLToPath(new URL("./fixtures/otlp/", import.meta.url));
const fixture = (name) => readFileSync(`${FIXTURES}${name}`, "utf8");

const ROUTES = {
  "v1/logs": {
    path: "/telemetry/v1/logs",
    async request(env) {
      return new Request("https://demos.handsontable.com/telemetry/v1/logs", {
        method: "POST",
        headers: { "x-o11y-secret": env.O11Y_EXPORT_SECRET, "content-type": "application/json" },
        body: fixture("json/zero-timestamp.json"),
      });
    },
  },
  deploy: {
    path: "/telemetry/deploy",
    async request(env) {
      return new Request("https://demos.handsontable.com/telemetry/deploy", {
        method: "POST",
        headers: { "x-o11y-secret": env.O11Y_EXPORT_SECRET, "content-type": "application/json" },
        body: fixture("deploy-event.json"),
      });
    },
  },
  "hooks/sentry": {
    path: "/telemetry/hooks/sentry",
    async request(env) {
      const body = fixture("sentry-issue.json");
      return new Request("https://demos.handsontable.com/telemetry/hooks/sentry", {
        method: "POST",
        headers: { "sentry-hook-signature": await hmacSha256Hex(env.SENTRY_HOOK_SECRET, body), "content-type": "application/json" },
        body,
      });
    },
  },
};

/** Replaces the InboxWriter stub the route resolves, keeping the real writer
 *  reachable so a test can delegate to it. */
function withStub(env, real, ingest) {
  const calls = [];
  const stub = {
    ingest(...args) {
      calls.push(args);
      return ingest(real, ...args);
    },
  };
  env.INBOX_WRITER.get = () => stub;
  return calls;
}

const ingestPoints = (ae) =>
  ae.points
    .filter((p) => p.indexes[0] === "o11y.ingest")
    .map((p) => ({ outcome: p.blobs[7], reason: p.blobs[8] }));

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(cond) {
  for (let i = 0; i < 1000 && !cond(); i++) await tick();
  assert.ok(cond(), "the route never reached InboxWriter.ingest");
}

for (const [name, route] of Object.entries(ROUTES)) {
  test(`${name}: a writer that never resolves answers 503 + Retry-After after the deadline and writes a dropped ingest_timeout point`, async () => {
    const { env, ae, inboxWriterInstance } = makeEnv(InboxWriter);
    const calls = withStub(env, inboxWriterInstance, () => new Promise(() => {}));
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const pending = worker.fetch(await route.request(env), env, ctx);
      await until(() => calls.length === 1);
      mock.timers.tick(INGEST_DEADLINE_MS);
      const res = await pending;
      await ctx.drain();
      assert.equal(res.status, 503);
      assert.ok(Number(res.headers.get("retry-after")) > 0, "Retry-After must be a positive number of seconds");
      assert.deepEqual(await res.json(), { error: "ingest_timeout" });
      assert.deepEqual(ingestPoints(ae), [{ outcome: "dropped", reason: "ingest_timeout" }]);
    } finally {
      mock.timers.reset();
    }
  });

  test(`${name}: a writer that rejects answers 503 + Retry-After at once and writes a dropped ingest_error point`, async () => {
    const { env, ae, inboxWriterInstance } = makeEnv(InboxWriter);
    withStub(env, inboxWriterInstance, async () => {
      throw new Error("DO storage unavailable");
    });
    const warn = mock.method(console, "warn", () => {});
    try {
      const res = await worker.fetch(await route.request(env), env, ctx);
      await ctx.drain();
      assert.equal(res.status, 503);
      assert.ok(Number(res.headers.get("retry-after")) > 0);
      assert.deepEqual(await res.json(), { error: "ingest_error" });
      assert.deepEqual(ingestPoints(ae), [{ outcome: "dropped", reason: "ingest_error" }]);
    } finally {
      warn.mock.restore();
    }
  });

  test(`${name}: a writer that resolves in time is unchanged (204 + one accepted point) and its deadline timer is cleared`, async () => {
    const { env, ae, inboxWriterInstance } = makeEnv(InboxWriter);
    const set = [];
    const cleared = new Set();
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    globalThis.setTimeout = (fn, ms, ...rest) => {
      const handle = realSet(fn, ms, ...rest);
      if (ms === INGEST_DEADLINE_MS) set.push(handle);
      return handle;
    };
    globalThis.clearTimeout = (handle) => {
      cleared.add(handle);
      return realClear(handle);
    };
    try {
      withStub(env, inboxWriterInstance, (real, ...args) => real.ingest(...args));
      const res = await worker.fetch(await route.request(env), env, ctx);
      await ctx.drain();
      assert.equal(res.status, 204);
      assert.deepEqual(
        ingestPoints(ae).filter((p) => p.outcome === "accepted").map((p) => p.reason),
        [name],
      );
      assert.equal(set.length, 1, "exactly one deadline timer per ingest");
      assert.ok(cleared.has(set[0]), "the deadline timer must be cleared once the call settles");
    } finally {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    }
  });

  test(`${name}: duplicate delivery answers 204 and counts only a duplicate point the second time`, async () => {
    const { env, ae } = makeEnv(InboxWriter);
    assert.equal((await worker.fetch(await route.request(env), env, ctx)).status, 204);
    await ctx.drain();
    ae.points.length = 0;
    assert.equal((await worker.fetch(await route.request(env), env, ctx)).status, 204);
    await ctx.drain();
    assert.deepEqual(ingestPoints(ae), [{ outcome: "duplicate", reason: name }]);
  });
}

// Accounting caveat (documented in the contract): a commit whose reply is
// lost is reported as a timeout, and the redelivery is counted as a
// duplicate, so the committed batch is never counted `accepted`.
test("v1/logs: a commit whose reply is lost counts as ingest_timeout, then only as duplicate on redelivery", async () => {
  const { env, ae, inboxWriterInstance, doStorage } = makeEnv(InboxWriter);
  const route = ROUTES["v1/logs"];
  let committed;
  const calls = withStub(env, inboxWriterInstance, (real, ...args) => {
    committed = real.ingest(...args);
    return new Promise(() => {});
  });
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = worker.fetch(await route.request(env), env, ctx);
    await until(() => calls.length === 1);
    mock.timers.tick(INGEST_DEADLINE_MS);
    assert.equal((await pending).status, 503);
  } finally {
    mock.timers.reset();
  }
  await committed;
  assert.ok([...doStorage._data.keys()].some((k) => k.startsWith("row:")), "the write did commit");

  env.INBOX_WRITER.get = () => inboxWriterInstance;
  assert.equal((await worker.fetch(await route.request(env), env, ctx)).status, 204);
  await ctx.drain();
  assert.deepEqual(ingestPoints(ae), [
    { outcome: "dropped", reason: "ingest_timeout" },
    { outcome: "duplicate", reason: "v1/logs" },
  ]);
});
