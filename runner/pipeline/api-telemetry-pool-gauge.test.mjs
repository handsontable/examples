// `pool.gauge` (`workers/api/src/telemetry/cron.ts`, reason `live`) must not
// count every `session-meter:` key in KV: a meter key outlives the
// container it fronts by `KV_METER_TTL_SECONDS` (24h, `budget.ts`), so a
// single stale 24h tail would read as pool pressure. This file proves
// `countLiveSessionMeters` shares the same awake/slept split
// `admin.ts#liveSessions`'s `awakeCount` uses (`session-listing.ts
// #classifyMeter`, via `admin.ts#readMeters`, the same KV scan the panel
// runs) rather than trusting key existence or inventing a second window.
// Run: node --experimental-strip-types --test pipeline/api-telemetry-pool-gauge.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { fakeKV } from "./fixtures/worker-harness.mjs";

register("./fixtures/worker-hooks.mjs", import.meta.url);

const { countLiveSessionMeters, LIVE_POOL_MAX_INSTANCES } = await import("../workers/api/src/telemetry/cron.ts");
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

// Boundary: one meter exactly at the idle window (must count, inclusive —
// matches `classifyMeter`'s own `quietSeconds <= AWAKE_WINDOW_SECONDS` rule)
// and one meter one second past it (must not). A key-count-only
// implementation answers 2; a classifier with the boundary flipped to
// exclusive (`<` instead of `<=`) answers 0. Only the fix under test
// answers 1.
test("countLiveSessionMeters: the idle-window boundary is inclusive, same rule as classifyMeter", async () => {
  const cache = fakeKV();
  await seedMeter(cache, "astro-atwindow1", now - sec(900), now - sec(AWAKE_WINDOW_SECONDS));
  await seedMeter(cache, "astro-pastwindow", now - sec(900), now - sec(AWAKE_WINDOW_SECONDS + 1));
  const env = { CACHE: cache };
  assert.equal(await countLiveSessionMeters(env, now), 1);
});

// ---------------------------------------------------------------------------
// `pool.gauge`'s `cap` (`LIVE_POOL_MAX_INSTANCES`) is a hard-coded constant,
// not read from config at runtime (wrangler does not expose
// `containers[].max_instances` to `env`), so it can drift silently from
// `Sandbox.max_instances` in wrangler.jsonc — the "Pool gauge vs cap" panel
// would then compare live sessions against the wrong ceiling with no error
// anywhere. This test parses the real wrangler.jsonc and pins the two
// together: change either number alone and this goes red.
// ---------------------------------------------------------------------------

function stripLineComments(text) {
  let out = "";
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      out += c;
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === "\"") inString = false;
      continue;
    }
    if (c === "\"") {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    out += c;
  }
  return out;
}

test("drift: LIVE_POOL_MAX_INSTANCES equals workers/api/wrangler.jsonc's Sandbox max_instances", () => {
  const workersApiDir = fileURLToPath(new URL("../workers/api/", import.meta.url));
  const wranglerJsonc = fs.readFileSync(`${workersApiDir}wrangler.jsonc`, "utf8");
  const wrangler = JSON.parse(stripLineComments(wranglerJsonc));
  const sandbox = wrangler.containers.find((c) => c.class_name === "Sandbox");
  assert.ok(sandbox, "wrangler.jsonc must declare a Sandbox container");
  assert.equal(
    LIVE_POOL_MAX_INSTANCES,
    sandbox.max_instances,
    "cron.ts's LIVE_POOL_MAX_INSTANCES must be updated in the same commit as wrangler.jsonc's Sandbox max_instances",
  );
});
