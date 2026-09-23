// T04 — ADR-0041 §F.3's fourth alerting row: "The o11y stack itself stale
// (no cron tick or ingest for 30 min) — the API worker's `*/5` cron reads
// the o11y heartbeat over a service binding and sends `captureMessage` to
// Sentry." One message on the transition into stale, one on recovery, never
// on every tick.
//
// Run: node --experimental-strip-types --test pipeline/o11y-watchdog.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { fakeKV } from "./fixtures/worker-harness.mjs";

register("./fixtures/worker-hooks.mjs", import.meta.url);

const { checkO11yHeartbeat } = await import("../workers/api/src/o11y-watchdog.ts");

const FRESH_MS = 30 * 60 * 1000;

function makeEnv(heartbeatResponder) {
  return {
    CACHE: fakeKV(),
    O11Y: {
      async fetch() {
        return heartbeatResponder();
      },
    },
  };
}

function okResponse(body) {
  return { ok: true, json: async () => body };
}

function captureSpy() {
  const calls = [];
  const capture = (message, opts) => calls.push({ message, opts });
  return { calls, capture };
}

test("checkO11yHeartbeat: fresh heartbeat -> no capture", async () => {
  const now = 10_000_000;
  const env = makeEnv(() => okResponse({ lastCron: now - 1000, lastIngest: now - 1000, backlogOldestAgeMs: 0 }));
  const { calls, capture } = captureSpy();
  await checkO11yHeartbeat(env, capture, now);
  assert.equal(calls.length, 0);
});

test("checkO11yHeartbeat: stale lastCron -> exactly one capture, error level", async () => {
  const now = 10_000_000;
  const env = makeEnv(() => okResponse({ lastCron: now - FRESH_MS - 1, lastIngest: now, backlogOldestAgeMs: 0 }));
  const { calls, capture } = captureSpy();
  await checkO11yHeartbeat(env, capture, now);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.level, "error");
  assert.match(calls[0].message, /stale/);
});

test("checkO11yHeartbeat: an unreachable o11y worker counts as stale", async () => {
  const now = 10_000_000;
  const env = makeEnv(() => {
    throw new Error("network down");
  });
  const { calls, capture } = captureSpy();
  await checkO11yHeartbeat(env, capture, now);
  assert.equal(calls.length, 1);
  assert.match(calls[0].message, /unreachable/);
});

test("checkO11yHeartbeat: stays firing across ticks -> only ONE capture, not one per tick", async () => {
  const now = 10_000_000;
  const env = makeEnv(() => okResponse({ lastCron: now - FRESH_MS - 1, lastIngest: now, backlogOldestAgeMs: 0 }));
  const { calls, capture } = captureSpy();
  await checkO11yHeartbeat(env, capture, now);
  await checkO11yHeartbeat(env, capture, now + 5 * 60 * 1000);
  await checkO11yHeartbeat(env, capture, now + 10 * 60 * 1000);
  assert.equal(calls.length, 1, `expected exactly one capture across three still-stale ticks, got ${calls.length}`);
});

test("checkO11yHeartbeat: recovery after staleness -> exactly one more capture, warning level", async () => {
  const now = 10_000_000;
  let stale = true;
  const env = makeEnv(() =>
    okResponse(
      stale
        ? { lastCron: now - FRESH_MS - 1, lastIngest: now, backlogOldestAgeMs: 0 }
        : { lastCron: now, lastIngest: now, backlogOldestAgeMs: 0 },
    ),
  );
  const { calls, capture } = captureSpy();
  await checkO11yHeartbeat(env, capture, now); // fires
  stale = false;
  await checkO11yHeartbeat(env, capture, now + 60_000); // resolves
  await checkO11yHeartbeat(env, capture, now + 120_000); // must stay silent
  assert.equal(calls.length, 2, `expected fire + resolve = 2 captures, got ${calls.length}`);
  assert.equal(calls[0].opts.level, "error");
  assert.equal(calls[1].opts.level, "warning");
  assert.match(calls[1].message, /recovered/);
});
