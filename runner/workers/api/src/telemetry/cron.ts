// The API worker's `*/5` cron signals (ADR-0041 §D, §F.2; contract §5
// `pool.gauge` / `budget.gauge`). T04's watchdog heartbeat check dispatches
// alongside these from `index.ts#scheduled` — see the marked call point
// there; this module does not implement it.

import { readMeters } from "../admin.js";
import { getBudgetState } from "../budget.js";
import type { Env } from "../env.js";
import { classifyMeter } from "../session-listing.js";
import { emitPoint } from "./points.js";

/** Mirrors `wrangler.jsonc`'s `containers[].max_instances` for the live-preview
 *  pool (`Sandbox`, currently 10 — DEV-2909). Kept here rather than re-read
 *  from config at runtime (wrangler does not expose it to `env`); the two
 *  numbers must move together, same as `budget.ts`'s own `SESSION_INSTANCE_TYPE`
 *  comment already notes for the container shape. */
const LIVE_POOL_MAX_INSTANCES = 10;

/**
 * `pool.gauge` (reason `live`): how many Tier-2 sessions are actually AWAKE
 * right now, against the pool's `max_instances` ceiling — the same KV scan
 * the admin panel already runs (`admin.ts#readMeters`), reused read-only
 * rather than duplicated, classified with the one definition of "awake" this
 * codebase has (`session-listing.ts#classifyMeter`, `AWAKE_WINDOW_SECONDS`).
 *
 * F19b: the first cut of this function counted every `session-meter:` key in
 * KV, full stop. A meter key outlives the container it fronts by
 * `KV_METER_TTL_SECONDS` (24h, `budget.ts`) — the exact gap DEV-2567 already
 * fixed for the admin panel's own count (`admin.ts#liveSessions`'s
 * `awakeCount`, unchanged since master) by filtering on `classifyMeter(...)
 * .state === "awake"` instead of key existence. A stale 24h tail with one
 * genuinely awake session used to read as `value: N` for every stale key
 * still inside its TTL; it now reads 1.
 *
 * T05-D: reason `builder` (the `BuilderSandbox` share-build pool) is not
 * emitted — nothing in this worker meters builder-container concurrency today
 * (no KV row like the live-session meter exists for it), so a `builder` point
 * would only ever read zero. Left for whichever task adds that meter, rather
 * than shipping a point that always misreports.
 */
export async function countLiveSessionMeters(env: Env, now: number = Date.now()): Promise<number> {
  const { meters } = await readMeters(env);
  return meters.filter((meter) => classifyMeter(meter, now).state === "awake").length;
}

export async function emitPoolGauge(env: Env): Promise<void> {
  const live = await countLiveSessionMeters(env);
  await emitPoint(env, "pool.gauge", { value: live, cap: LIVE_POOL_MAX_INSTANCES }, { reason: "live" });
}

export async function emitBudgetGauge(env: Env): Promise<void> {
  const state = await getBudgetState(env);
  await emitPoint(env, "budget.gauge", { value: state.pct * 100, usd: state.spendUsd }, { reason: state.tier });
}
