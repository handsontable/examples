// Usage counters behind the internal admin panel (DEV-2030).
//
// The cost ledger answers "what is this costing?". This answers "what is
// actually being used?" — which examples get opened live, which shared demos
// get viewed, how often the budget gate turns someone away.
//
// Everything is aggregated at write time into (day, metric, dimension) counters.
// No per-request rows, no IPs, no user agents: the panel is for capacity and
// cost decisions, and an events table would be both a privacy liability and a
// D1 write amplifier on the /d/:id path.

import type { Env } from "./env.js";

export type UsageMetric =
  | "session_started"
  | "session_denied"
  | "build"
  | "share_created"
  | "share_view"
  | "embed_view"
  | "chat_message"
  | "chat_edit"
  | "chat_edit_applied"
  | "chat_edit_undone"
  | "chat_denied"
  | "chat_error";

const utcDay = (): string => new Date().toISOString().slice(0, 10);

function upsert(env: Env, day: string, metric: string, dimension: string, count: number) {
  return env.DB.prepare(
    `INSERT INTO usage_daily (day, metric, dimension, count, updated_at)
          VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(day, metric, dimension) DO UPDATE
          SET count = count + ?4, updated_at = ?5`,
  ).bind(day, metric, dimension, count, Date.now());
}

/**
 * Record a low-frequency event immediately (session start, build, share).
 * Never throws: analytics must not be able to fail a user's request.
 */
export async function recordUsageEvent(env: Env, metric: UsageMetric, dimension = ""): Promise<void> {
  try {
    await upsert(env, utcDay(), metric, dimension.slice(0, 64), 1).run();
  } catch (err) {
    console.warn("[usage] counter write failed:", err instanceof Error ? err.message : String(err));
  }
}

// ---- High-frequency counters -------------------------------------------------
//
// Static share views are the cheap, high-volume path — one D1 write per view
// would cost more than the view does. They accumulate in isolate memory and are
// flushed in batches alongside the traffic meter (and by the nightly cron).
// Isolate eviction loses a partial batch; for view counts that is fine.

const pending = new Map<string, number>();
const FLUSH_AT_EVENTS = 200;
let pendingTotal = 0;

/** Accumulate one view. Returns true when a flush is worth a D1 batch. */
export function noteView(metric: "share_view" | "embed_view", demoId: string): boolean {
  const key = `${metric}|${demoId.slice(0, 64)}`;
  pending.set(key, (pending.get(key) ?? 0) + 1);
  pendingTotal++;
  return pendingTotal >= FLUSH_AT_EVENTS;
}

/** Write and reset the view accumulator. Safe to call when empty. */
export async function flushUsage(env: Env): Promise<void> {
  if (pending.size === 0) return;
  const batch = [...pending.entries()];
  pending.clear();
  pendingTotal = 0;
  const day = utcDay();
  try {
    await env.DB.batch(
      batch.map(([key, count]) => {
        const sep = key.indexOf("|");
        return upsert(env, day, key.slice(0, sep), key.slice(sep + 1), count);
      }),
    );
  } catch {
    // Put the batch back rather than losing it; the next flush retries.
    for (const [key, count] of batch) pending.set(key, (pending.get(key) ?? 0) + count);
    pendingTotal += batch.reduce((n, [, c]) => n + c, 0);
  }
}
