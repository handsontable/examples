// ADR-0041 §F.3's fourth alerting row: "The o11y stack itself stale (no cron
// tick or ingest for 30 min) — the API worker's `*/5` cron reads the o11y
// heartbeat over a service binding and sends `captureMessage` to Sentry."
//
// Dispatched from `index.ts#runFiveMinuteCron`'s marked T04 call point
// (T05's handoff comment there), through `cron-step.ts#cronStep` like its
// sibling gauges — see that module's own doc comment for why every cron
// branch needs its own isolated try/catch (a heartbeat check must still run
// even when `emitPoolGauge`/`emitBudgetGauge` throw first).
//
// State (stale vs. recovered) lives in this Worker's own KV `CACHE` binding,
// not in `InboxWriter` (T04-D, see the task Outcome): the watchdog watches
// the o11y stack FROM OUTSIDE it, and its own fire/resolve bookkeeping must
// survive even when the o11y worker (and therefore `InboxWriter`) is the
// thing that is stale or unreachable.

import * as Sentry from "@sentry/cloudflare";
import type { Env } from "./env.js";

const STALE_THRESHOLD_MS = 30 * 60 * 1000;
const WATCHDOG_STATE_KV_KEY = "o11y-watchdog:state";

export interface HeartbeatReport {
  lastCron: number;
  lastIngest: number;
  backlogOldestAgeMs: number | null;
}

/** Structural mirror of `O11yHeartbeat`'s RPC surface
 *  (`workers/o11y/src/heartbeat.ts`), duplicated here rather than imported
 *  (T04-D, see the task Outcome; same reasoning `workers/o11y/src/cost.ts`'s
 *  own `O11yUsageRpc` doc comment gives on the o11y side): the two Workers
 *  are separate `tsconfig.json` projects (each `"include": ["src"]`), so a
 *  type-only import across the worker boundary is unnecessary. `env.O11Y`
 *  stays typed `Fetcher` (T00's own declaration, unchanged) —
 *  `workers/api/wrangler.jsonc` now binds it to the named `O11yHeartbeat`
 *  entrypoint (see that file's comment), so the RPC method below is real at
 *  runtime even though the ambient type does not know it. Fixed round
 *  A-C1: this used to call `.fetch("/_internal/heartbeat")` on the binding,
 *  which only ever worked while the o11y worker's default export answered
 *  that path over HTTP. It no longer does (RPC-only, W1) — without an
 *  `entrypoint` on the binding, `.fetch()` here resolved to the o11y
 *  worker's *default* export, which now 404s that route, permanently
 *  latching the watchdog stale. Calling the named RPC method directly is
 *  both the fix and the reason the binding now needs `entrypoint` set. */
interface O11yHeartbeatRpc {
  heartbeat(): Promise<HeartbeatReport>;
}

function o11yHeartbeatRpc(env: Env): O11yHeartbeatRpc | undefined {
  return env.O11Y as unknown as O11yHeartbeatRpc | undefined;
}

export type CaptureMessageFn = (message: string, opts: { level: "warning" | "error" }) => void;

const defaultCapture: CaptureMessageFn = (message, opts) => Sentry.captureMessage(message, opts);

export interface WatchdogState {
  stale: boolean;
  since: number;
}

async function readWatchdogState(env: Env): Promise<WatchdogState | null> {
  return (await env.CACHE.get(WATCHDOG_STATE_KV_KEY, "json").catch(() => null)) as WatchdogState | null;
}

async function writeWatchdogState(env: Env, state: WatchdogState): Promise<void> {
  await env.CACHE.put(WATCHDOG_STATE_KV_KEY, JSON.stringify(state)).catch(() => {
    /* a lost state write means the next tick re-decides from scratch — a
       missed transition, never a wrong one */
  });
}

/** Calls `heartbeat()` over the `O11Y` service binding's named
 *  `O11yHeartbeat` RPC entrypoint — never `.fetch()`: the o11y worker's
 *  default export has no HTTP route for this report any more (RPC-only,
 *  W1/A-C1), so a `.fetch()` call here would silently and permanently
 *  regress to always-unreachable. Any failure (missing binding, RPC
 *  rejection, malformed body) is treated the same as a stale heartbeat —
 *  an unreachable o11y worker is exactly the condition this watchdog
 *  exists to catch. */
async function fetchHeartbeat(env: Env): Promise<HeartbeatReport | null> {
  const o11y = o11yHeartbeatRpc(env);
  if (!o11y) return null;
  try {
    const body = await o11y.heartbeat();
    if (typeof body.lastCron !== "number" || typeof body.lastIngest !== "number") return null;
    return {
      lastCron: body.lastCron,
      lastIngest: body.lastIngest,
      backlogOldestAgeMs: typeof body.backlogOldestAgeMs === "number" ? body.backlogOldestAgeMs : null,
    };
  } catch {
    return null;
  }
}

/**
 * One five-minute cron tick's watchdog check. Sends exactly one `captureMessage`
 * on the transition INTO stale, and one on the transition back to fresh —
 * never on every tick (same fire-once/resolve-once contract ADR §F.3 asks
 * of every alert in this task, mirrored here even though this one channel
 * is Sentry, not Slack).
 *
 * `capture` is injectable (mirrors `cron-step.ts#CronCaptureFn`/
 * `diagnostic.ts#CaptureExceptionFn`) so a test can assert on a transport
 * spy instead of the real SDK call.
 */
export async function checkO11yHeartbeat(
  env: Env,
  capture: CaptureMessageFn = defaultCapture,
  nowMs = Date.now(),
): Promise<void> {
  const report = await fetchHeartbeat(env);
  const staleCron = report === null || nowMs - report.lastCron > STALE_THRESHOLD_MS;
  const staleIngest = report === null || nowMs - report.lastIngest > STALE_THRESHOLD_MS;
  const isStale = staleCron || staleIngest;

  const prev = await readWatchdogState(env);
  const wasStale = prev?.stale ?? false;

  if (isStale && !wasStale) {
    await writeWatchdogState(env, { stale: true, since: nowMs });
    const reason =
      report === null
        ? "heartbeat unreachable"
        : `${staleCron ? "lastCron" : ""}${staleCron && staleIngest ? " and " : ""}${staleIngest ? "lastIngest" : ""} stale (> 30 min)`;
    capture(`[o11y-watchdog] the o11y stack looks stale: ${reason}`, { level: "error" });
  } else if (!isStale && wasStale) {
    await writeWatchdogState(env, { stale: false, since: nowMs });
    capture("[o11y-watchdog] the o11y stack has recovered", { level: "warning" });
  }
}
