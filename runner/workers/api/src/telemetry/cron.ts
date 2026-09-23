// The API worker's `*/5` cron signals (ADR-0041 §D, §F.2; contract §5
// `pool.gauge` / `budget.gauge`). T04's watchdog heartbeat check dispatches
// alongside these from `index.ts#scheduled` — see the marked call point
// there; this module does not implement it.

import { getBudgetState, KV_METER_PREFIX } from "../budget.js";
import type { Env } from "../env.js";
import { emitPoint } from "./points.js";

/** Mirrors `wrangler.jsonc`'s `containers[].max_instances` for the live-preview
 *  pool (`Sandbox`, currently 10 — DEV-2909). Kept here rather than re-read
 *  from config at runtime (wrangler does not expose it to `env`); the two
 *  numbers must move together, same as `budget.ts`'s own `SESSION_INSTANCE_TYPE`
 *  comment already notes for the container shape. */
const LIVE_POOL_MAX_INSTANCES = 10;

/**
 * `pool.gauge` (reason `live`): how many Tier-2 sessions currently hold an
 * awake-window meter, against the pool's `max_instances` ceiling — the same
 * KV prefix the admin panel already scans (`admin.ts#readMeters`), reused
 * read-only rather than duplicated.
 *
 * T05-D: reason `builder` (the `BuilderSandbox` share-build pool) is not
 * emitted — nothing in this worker meters builder-container concurrency today
 * (no KV row like the live-session meter exists for it), so a `builder` point
 * would only ever read zero. Left for whichever task adds that meter, rather
 * than shipping a point that always misreports.
 */
async function countLiveSessionMeters(env: Env): Promise<number> {
  let cursor: string | undefined;
  let count = 0;
  // The pool can never exceed max_instances, so a handful of pages is already
  // generous headroom against meter/container drift.
  for (let page = 0; page < 10; page += 1) {
    const listed = await env.CACHE.list({ prefix: KV_METER_PREFIX, limit: 1000, cursor });
    count += listed.keys.length;
    if (listed.list_complete) break;
    cursor = listed.cursor;
  }
  return count;
}

export async function emitPoolGauge(env: Env): Promise<void> {
  const live = await countLiveSessionMeters(env);
  await emitPoint(env, "pool.gauge", { value: live, cap: LIVE_POOL_MAX_INSTANCES }, { reason: "live" });
}

export async function emitBudgetGauge(env: Env): Promise<void> {
  const state = await getBudgetState(env);
  await emitPoint(env, "budget.gauge", { value: state.pct * 100, usd: state.spendUsd }, { reason: state.tier });
}
