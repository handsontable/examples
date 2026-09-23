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

/** Structural shape of `workers/o11y/src/heartbeat.ts`'s `O11yHeartbeat`
 *  `WorkerEntrypoint`, duplicated here rather than imported (T04-D, see the
 *  task Outcome): the two Workers are separate `tsconfig.json` projects
 *  (each `"include": ["src"]`), so a type-only import across the worker
 *  boundary is unnecessary; `env.O11Y` stays typed `Fetcher` (T00's own
 *  declaration, unchanged) and this interface is only ever used for a local
 *  structural cast, the same pattern `chat.ts`'s `ChatUnavailableError`
 *  duplication documents for the sibling-import constraint (T05-D2). */
interface O11yHeartbeatFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
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

/** Fetches `GET /_internal/heartbeat` over the `O11Y` service binding — not
 *  a path any `--routes` flag on either Worker's deploy script names (the
 *  o11y worker's own routes are `demos.handsontable.com/telemetry/*` and
 *  `/grafana/*` only), so it is unreachable except through this binding.
 *  Any failure (network, non-2xx, malformed JSON) is treated the same as a
 *  stale heartbeat — an unreachable o11y worker is exactly the condition
 *  this watchdog exists to catch. */
async function fetchHeartbeat(env: Env): Promise<HeartbeatReport | null> {
  const o11y = env.O11Y as O11yHeartbeatFetcher | undefined;
  if (!o11y) return null;
  try {
    const res = await o11y.fetch("https://o11y-internal.invalid/_internal/heartbeat");
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<HeartbeatReport>;
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
