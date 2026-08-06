// Internal usage + cost dashboard data (DEV-2030).
//
// One authenticated endpoint (`GET /api/admin/usage`) that answers the two
// questions the guardrails raise: what is this costing us this month, and what
// is anyone actually doing with it. Everything here reads aggregates that are
// already being written on the hot paths — the panel adds no new instrumentation
// and no per-request storage.
//
// Auth is the same broker check as the rest of the write API: any verified
// @handsontable.com identity. Spend figures are internal, not secret.

import type { Env } from "./env.js";
import { computeBudgetState, budgetEnforced, containerUsdPerSecond, SESSION_INSTANCE_TYPE } from "./budget.js";

export interface LedgerRow {
  day: string;
  sku: string;
  source: string;
  units: number;
  usd: number;
}

export interface UsageRow {
  day: string;
  metric: string;
  dimension: string;
  count: number;
}

/** A live Tier-2 session, derived from the awake-window meters in KV. */
interface LiveSession {
  sessionId: string;
  framework: string;
  startedAt: number;
  awakeSeconds: number;
  estimatedUsd: number;
}

const dayAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

/** Session ids are `<framework-slug>-<8 random chars>` (see mintSessionId). */
const frameworkOf = (sessionId: string): string => {
  const cut = sessionId.lastIndexOf("-");
  return cut > 0 ? sessionId.slice(0, cut) : sessionId;
};

/**
 * Sessions currently being metered. The meter key exists from session start
 * until teardown, so this is "live" to within one keepalive interval — a
 * crashed client lingers here until its idle window lapses, which is exactly
 * the thing worth seeing on a cost panel.
 */
async function liveSessions(env: Env): Promise<LiveSession[]> {
  const listed = await env.CACHE.list({ prefix: "session-meter:", limit: 50 });
  const now = Date.now();
  const out: LiveSession[] = [];
  for (const key of listed.keys) {
    const meter = (await env.CACHE.get(key.name, "json").catch(() => null)) as
      | { startedAt: number; instanceType: typeof SESSION_INSTANCE_TYPE }
      | null;
    if (!meter) continue;
    const sessionId = key.name.slice("session-meter:".length);
    const awakeSeconds = Math.max(0, (now - meter.startedAt) / 1000);
    out.push({
      sessionId,
      framework: frameworkOf(sessionId),
      startedAt: meter.startedAt,
      awakeSeconds,
      estimatedUsd: awakeSeconds * containerUsdPerSecond(meter.instanceType ?? SESSION_INSTANCE_TYPE),
    });
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

export async function adminUsage(env: Env, days: number) {
  const since = dayAgo(days);
  const monthPrefix = new Date().toISOString().slice(0, 7);

  const [ledger, usage, demoTotals, demosByFramework, topDemos, budget, sessions] = await Promise.all([
    env.DB.prepare(
      `SELECT day, sku, source, units, usd FROM cost_ledger WHERE day >= ?1 ORDER BY day DESC, sku`,
    ).bind(since).all<LedgerRow>(),

    env.DB.prepare(
      `SELECT day, metric, dimension, count FROM usage_daily WHERE day >= ?1 ORDER BY day DESC`,
    ).bind(since).all<UsageRow>(),

    env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN revoked = 1 THEN 1 ELSE 0 END) AS revoked,
              SUM(CASE WHEN created_at >= ?1 THEN 1 ELSE 0 END) AS created_in_window
         FROM demos`,
    ).bind(since).first<{ total: number; revoked: number; created_in_window: number }>(),

    env.DB.prepare(
      `SELECT framework, COUNT(*) AS count FROM demos GROUP BY framework ORDER BY count DESC`,
    ).all<{ framework: string; count: number }>(),

    // Most-viewed shares in the window, titled from the demos table. A view row
    // whose demo has since been deleted simply drops out of the join.
    env.DB.prepare(
      `SELECT u.dimension AS id, d.title AS title, d.framework AS framework, SUM(u.count) AS views
         FROM usage_daily u JOIN demos d ON d.id = u.dimension
        WHERE u.day >= ?1 AND u.metric IN ('share_view', 'embed_view')
        GROUP BY u.dimension, d.title, d.framework
        ORDER BY views DESC
        LIMIT 15`,
    ).bind(since).all<{ id: string; title: string; framework: string; views: number }>(),

    // Uncached: the panel is the one place that should always see the truth,
    // not a five-minute-old copy of it.
    computeBudgetState(env),

    liveSessions(env),
  ]);

  const ledgerRows = ledger.results ?? [];
  const spendBySku: Record<string, { estimate: number; billing: number }> = {};
  for (const row of ledgerRows) {
    if (!row.day.startsWith(monthPrefix)) continue;
    const bucket = (spendBySku[row.sku] ??= { estimate: 0, billing: 0 });
    if (row.source === "billing") bucket.billing += row.usd;
    else bucket.estimate += row.usd;
  }

  return {
    generatedAt: Date.now(),
    windowDays: days,
    budget: {
      tier: budget.tier,
      pct: budget.pct,
      spendUsd: budget.spendUsd,
      limitUsd: budget.limitUsd,
      reconciled: budget.reconciled,
      enforced: budgetEnforced(env),
      thresholds: {
        warn: Number(env.BUDGET_WARN_PCT ?? 0.6),
        anonBlocked: Number(env.BUDGET_ANON_BLOCK_PCT ?? 0.8),
        newBlocked: Number(env.BUDGET_NEW_BLOCK_PCT ?? 0.95),
        closed: Number(env.BUDGET_CLOSED_PCT ?? 1),
      },
    },
    // Month-to-date, split so it is obvious which SKUs are still guesses.
    spendBySku,
    ledger: ledgerRows,
    usage: usage.results ?? [],
    demos: {
      total: demoTotals?.total ?? 0,
      revoked: demoTotals?.revoked ?? 0,
      createdInWindow: demoTotals?.created_in_window ?? 0,
      byFramework: demosByFramework.results ?? [],
      topViewed: topDemos.results ?? [],
    },
    liveSessions: sessions,
  };
}
