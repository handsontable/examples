// F19b (R3-triage.md): `pool.gauge` (`workers/api/src/telemetry/cron.ts`,
// reason `live`) counted every `session-meter:` key in KV — full stop. A
// meter key outlives the container it fronts by `KV_METER_TTL_SECONDS` (24h,
// `budget.ts`), so a single stale 24h tail read as pool pressure ("7/10 with
// one live Tier-2 lane"). DEV-2567 already fixed the identical shape for the
// admin panel's own count (`admin.ts#liveSessions`'s `awakeCount`, unchanged
// since master) by classifying each meter with `session-listing.ts
// #classifyMeter` instead of trusting key existence. This file proves
// `countLiveSessionMeters` now shares that exact awake/slept split — via
// `admin.ts#readMeters`, the same KV scan the panel runs — rather than
// inventing a second window.
//
// Run: node --experimental-strip-types --test pipeline/api-telemetry-pool-gauge.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { fakeKV } from "./fixtures/worker-harness.mjs";

register("./fixtures/worker-hooks.mjs", import.meta.url);

const { countLiveSessionMeters } = await import("../workers/api/src/telemetry/cron.ts");
const { AWAKE_WINDOW_SECONDS } = await import("../workers/api/src/session-listing.ts");

const now = 1_800_000_000_000;
const sec = (n) => n * 1000;

/** Writes a meter the way `budget.ts#startSessionMeter`/`meterSessionUnsafe` do:
 *  value plus mirrored list metadata, so `admin.ts#readMeters` takes the fast
 *  (metadata-only) path instead of its legacy per-row `get` fallback. */
async function seedMeter(cache, sessionId, startedAt, meteredThrough) {
  await cache.put(
    `session-meter:${sessionId}`,
    JSON.stringify({ startedAt, meteredThrough, instanceType: "standard-1" }),
    { metadata: { s: startedAt, m: meteredThrough, i: "standard-1" } },
  );
}

test("countLiveSessionMeters: a stale 24h meter plus one awake meter counts only the awake one", async () => {
  const cache = fakeKV();
  // Stale: last ticked an hour ago, long past the idle window — the KV key is
  // still alive (well inside its 24h TTL) but the container behind it slept.
  await seedMeter(cache, "vue-stale00001", now - sec(20 * 3600), now - sec(3600));
  // Awake: the one live Tier-2 lane, ticked 30s ago.
  await seedMeter(cache, "vue-awake00001", now - sec(120), now - sec(30));
  const env = { CACHE: cache };
  assert.equal(await countLiveSessionMeters(env, now), 1);
});

test("countLiveSessionMeters: a meter exactly at the idle window still counts as awake (inclusive boundary)", async () => {
  const cache = fakeKV();
  await seedMeter(cache, "astro-atwindow1", now - sec(900), now - sec(AWAKE_WINDOW_SECONDS));
  const env = { CACHE: cache };
  assert.equal(await countLiveSessionMeters(env, now), 1);
});

test("countLiveSessionMeters: one second past the idle window drops out", async () => {
  const cache = fakeKV();
  await seedMeter(cache, "astro-pastwindow", now - sec(900), now - sec(AWAKE_WINDOW_SECONDS + 1));
  const env = { CACHE: cache };
  assert.equal(await countLiveSessionMeters(env, now), 0);
});

test("countLiveSessionMeters: an empty pool reads zero, not every-key count of the empty case", async () => {
  const env = { CACHE: fakeKV() };
  assert.equal(await countLiveSessionMeters(env, now), 0);
});
