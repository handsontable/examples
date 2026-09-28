// ADR-0041 §F.3: the o11y stack itself going stale (no cron tick or ingest
// for 30 min) is caught here — the API worker's `*/5` cron reads the o11y
// heartbeat over a service binding and sends `captureMessage` to Sentry.
// Dispatched from `index.ts#runFiveMinuteCron` through `cron-step.ts#cronStep`.
// State lives in this Worker's own KV `CACHE`, not `InboxWriter`: this
// watchdog watches the o11y stack from outside it and must keep working when
// that stack (and therefore `InboxWriter`) is what's stale or unreachable.

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
 *  (`workers/o11y/src/heartbeat.ts`), duplicated rather than imported: the
 *  two Workers are separate `tsconfig.json` projects. `env.O11Y` stays typed
 *  `Fetcher`; `workers/api/wrangler.jsonc` binds it to the named
 *  `O11yHeartbeat` entrypoint, so the RPC method below is real at runtime
 *  even though the ambient type does not know it. */
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

/** Calls `heartbeat()` over the `O11Y` binding's named `O11yHeartbeat` RPC
 *  entrypoint — never `.fetch()`: the o11y worker's default export has no
 *  HTTP route for this report. Any failure (missing binding, RPC rejection,
 *  malformed body) is treated as a stale heartbeat — an unreachable o11y
 *  worker is exactly the condition this watchdog exists to catch. */
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
 * One five-minute cron tick's watchdog check. Sends exactly one
 * `captureMessage` on the transition INTO stale, and one on the transition
 * back to fresh — never on every tick (same fire-once/resolve-once contract
 * ADR §F.3 asks of every alert).
 *
 * `capture` is injectable (mirrors `cron-step.ts#CronCaptureFn`) so a test
 * can assert on a transport spy instead of the real SDK call.
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
