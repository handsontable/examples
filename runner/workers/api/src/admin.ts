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
import {
  computeBudgetState,
  containerUsdPerSecond,
  KV_METER_PREFIX,
  SESSION_INSTANCE_TYPE,
  type SessionMeter,
  type SessionMeterMetadata,
} from "./budget.js";
import { analyticsReport } from "./analytics.js";
import {
  classifyMeter,
  frameworkOf,
  type Page,
  pageOf,
  parseSessionQuery,
  resolveSessionRef,
  scanTruncated,
  sessionRef,
  type SessionQuery,
  type SessionState,
} from "./session-listing.js";

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

/**
 * A Tier-2 session with a meter in KV — awake, or on the 24h tail (DEV-2567).
 *
 * `ref` is a one-way digest of the session id, never the id itself. Session
 * ids are bearer capabilities — `/api/session/:id/*` is unauthenticated by
 * design, so anyone holding an id can write files into that container or tear
 * it down. Handing them to every signed-in viewer of this panel would let one
 * colleague interfere with another's live session. The digest is enough to
 * tell two rows apart, and `DELETE /api/admin/sessions/:ref` resolves it back
 * server-side, so the kill button needs no id either.
 */
export interface LiveSession {
  ref: string;
  framework: string;
  startedAt: number;
  /** Wall-clock since session start — what the Awake column has always shown. */
  awakeSeconds: number;
  /** Awake time the ledger can stand behind: capped at the idle window past the
   *  last keepalive tick. For a `slept` row this is far below `awakeSeconds`,
   *  and it is the honest basis for `estimatedUsd`. */
  billableSeconds: number;
  /** Since the last keepalive tick; `state` is a threshold on this. */
  quietSeconds: number;
  state: SessionState;
  estimatedUsd: number;
}

export interface LiveSessionsPage extends Page<LiveSession> {
  /** Matching the filter (`total`) vs. every meter in KV, so the panel can label
   *  its own checkbox with what unchecking it would reveal. */
  awakeCount: number;
  meterCount: number;
  /** True when the KV scan hit its own ceiling — see MAX_LIST_PAGES. Never let a
   *  bounded table read as a complete one; that is how the 50-row cap this
   *  replaces went unnoticed. */
  truncated: boolean;
}

const dayAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

/** KV's own per-call maximum. */
const LIST_PAGE_LIMIT = 1000;
/** Ceiling on the scan. Four calls is ~4000 concurrent-plus-stale sessions, well
 *  past anything 24h of Tier-2 traffic against a 5-instance pool can produce; it
 *  exists so a runaway cannot turn one panel load into an unbounded KV bill. */
const MAX_LIST_PAGES = 4;
/** Meters written before `SessionMeterMetadata` shipped need a `get` each. Bounded
 *  because that is a per-row round trip; the branch empties itself within one
 *  KV_METER_TTL_SECONDS of the deploy, after which this is dead code. */
const MAX_LEGACY_READS = 200;
/** Legacy `get`s run in parallel batches rather than all at once — a burst of
 *  hundreds of concurrent subrequests is its own failure mode. */
const LEGACY_READ_BATCH = 20;

interface MeterRecord {
  sessionId: string;
  startedAt: number;
  meteredThrough: number;
  instanceType: typeof SESSION_INSTANCE_TYPE;
}

/**
 * Every metered session, from KV list metadata alone where possible.
 *
 * `list()` returns each key's metadata inline, which is what lets this page over
 * the whole prefix without a read per row — the previous shape spent one `get`
 * per key and was capped at 50, and since KV lists in UTF-8 key order and session
 * ids begin with the framework slug, that cap meant the table could only ever
 * show `angular` (the alphabetically first Tier-2 slug). That artifact is the
 * whole reason DEV-2567 read as an Angular-specific leak.
 */
async function readMeters(env: Env): Promise<{ meters: MeterRecord[]; truncated: boolean }> {
  const meters: MeterRecord[] = [];
  const legacyKeys: string[] = [];
  let cursor: string | undefined;
  let complete = false;

  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const listed = await env.CACHE.list<SessionMeterMetadata>({
      prefix: KV_METER_PREFIX,
      limit: LIST_PAGE_LIMIT,
      cursor,
    });
    for (const key of listed.keys) {
      const sessionId = key.name.slice(KV_METER_PREFIX.length);
      const meta = key.metadata;
      // A partial metadata record counts as legacy: half a meter would price a
      // row off NaN, and the `get` is authoritative anyway.
      if (meta && Number.isFinite(meta.s) && Number.isFinite(meta.m)) {
        meters.push({
          sessionId,
          startedAt: meta.s,
          meteredThrough: meta.m,
          instanceType: meta.i ?? SESSION_INSTANCE_TYPE,
        });
      } else {
        legacyKeys.push(sessionId);
      }
    }
    if (listed.list_complete) { complete = true; break; }
    cursor = listed.cursor;
  }

  const legacy = legacyKeys.slice(0, MAX_LEGACY_READS);
  const truncated = scanTruncated({
    listComplete: complete,
    legacyFound: legacyKeys.length,
    legacyRead: legacy.length,
  });
  for (let i = 0; i < legacy.length; i += LEGACY_READ_BATCH) {
    const batch = await Promise.all(
      legacy.slice(i, i + LEGACY_READ_BATCH).map(async (sessionId) => {
        const meter = (await env.CACHE.get(`${KV_METER_PREFIX}${sessionId}`, "json")
          .catch(() => null)) as SessionMeter | null;
        if (!meter || !Number.isFinite(meter.startedAt)) return null;
        return {
          sessionId,
          startedAt: meter.startedAt,
          // Pre-metadata meters do carry `meteredThrough`; the fallback is for a
          // record written by an even older shape, where the safe reading is "no
          // tick has ever been observed" — i.e. slept unless it just started.
          meteredThrough: Number.isFinite(meter.meteredThrough) ? meter.meteredThrough : meter.startedAt,
          instanceType: meter.instanceType ?? SESSION_INSTANCE_TYPE,
        };
      }),
    );
    for (const record of batch) if (record) meters.push(record);
  }
  return { meters, truncated };
}

/**
 * The panel's session table: classified, filtered, paged.
 *
 * Sorted oldest-first and kept that way: the longest-quiet row is the one worth
 * acting on, and it must not fall off the end of page one.
 */
export async function liveSessions(env: Env, query: SessionQuery): Promise<LiveSessionsPage> {
  const { meters, truncated } = await readMeters(env);
  const now = Date.now();
  const all: LiveSession[] = [];
  for (const meter of meters) {
    const state = classifyMeter(meter, now);
    all.push({
      ref: await sessionRef(meter.sessionId),
      framework: frameworkOf(meter.sessionId),
      startedAt: meter.startedAt,
      awakeSeconds: state.ageSeconds,
      billableSeconds: state.billableSeconds,
      quietSeconds: state.quietSeconds,
      state: state.state,
      estimatedUsd: state.billableSeconds * containerUsdPerSecond(meter.instanceType),
    });
  }
  all.sort((a, b) => a.startedAt - b.startedAt);
  const awakeCount = all.filter((s) => s.state === "awake").length;
  const matching = query.awakeOnly ? all.filter((s) => s.state === "awake") : all;
  return { ...pageOf(matching, query), awakeCount, meterCount: all.length, truncated };
}

/** Which session id the panel's `ref` stands for, or why it cannot say. */
export async function lookupSessionRef(env: Env, ref: string) {
  const { meters } = await readMeters(env);
  return resolveSessionRef(meters.map((m) => m.sessionId), ref);
}

/** The table on its own, for paging and for the awake/all toggle — so neither
 *  costs a re-run of the D1 aggregates behind the rest of the report. */
export const adminSessions = (env: Env, params: { get(name: string): string | null }) =>
  liveSessions(env, parseSessionQuery(params));

export async function adminUsage(env: Env, days: number) {
  const since = dayAgo(days);
  const monthPrefix = new Date().toISOString().slice(0, 7);

  const [ledger, usage, demoTotals, demosByFramework, topDemos, budget, sessions, audience] = await Promise.all([
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

    // The default view (awake only, first page). Paging and the "show the 24h
    // tail" toggle go to `GET /api/admin/sessions` instead, so neither re-runs
    // the D1 aggregates above.
    liveSessions(env, parseSessionQuery(new URLSearchParams())),

    analyticsReport(env, days),
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
      enforced: budget.enforced,
    },
    // The editable thresholds, so the panel's form starts from what is
    // actually in force rather than from a copy of the defaults.
    settings: budget.settings,
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
    audience,
  };
}
