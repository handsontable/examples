// Self-enforced spend ceiling for the demo runner (DEV-2030).
//
// Why this file exists: Cloudflare offers **no hard spend cap** on Workers
// Paid. Its Budget alerts (Manage Account -> Billing -> Billable Usage) are
// informational — they email on projected spend and stop nothing. `containers
// .max_instances` is a real cap, but it only bounds container compute; egress,
// requests and R2 storage are unbounded and `POST /api/session` is public.
//
// So the ceiling has to be ours. The design goal is *graceful degradation*:
// static shares (`/d/:id`, `/embed/:id`) are served from R2, cost effectively
// nothing, and must keep working at 100% of budget. Only Tier-2 live sessions
// and builds — the parts that boot containers — are switched off, in stages.
//
// Accuracy is deliberately one-sided: every estimate here rounds *against* us,
// because under-billing ourselves is the failure mode that matters. The nightly
// reconciliation (reconcile.ts) replaces guesses with Cloudflare's own numbers.

import type { Env } from "./env.js";
import { loadSettings, type ResolvedBudgetSettings } from "./settings.js";

/** Cloudflare Containers rates, USD. https://developers.cloudflare.com/workers/platform/pricing/#containers
 *  Memory and disk bill on *provisioned* size for every second the instance is
 *  awake; CPU bills on *actual* use (since the 2025-11-21 pricing change). */
const RATE = {
  memGiBSec: 0.0000025,
  vcpuSec: 0.000020,
  diskGBSec: 0.00000007,
  /** Container egress, NA/EU. Ignores the 1 TB/month included allowance. */
  egressUsdPerGB: 0.025,
  /** Workers requests, $0.30/million. Ignores the 10M/month included. */
  requestsUsdPerMillion: 0.30,
} as const;

/** Provisioned shape per predefined instance type.
 *  https://developers.cloudflare.com/containers/platform-details/limits/#instance-types */
const INSTANCE = {
  lite: { mem: 0.25, vcpu: 1 / 16, disk: 2 },
  basic: { mem: 1, vcpu: 1 / 4, disk: 4 },
  "standard-1": { mem: 4, vcpu: 1 / 2, disk: 8 },
  "standard-2": { mem: 6, vcpu: 1, disk: 12 },
  "standard-3": { mem: 8, vcpu: 2, disk: 16 },
  "standard-4": { mem: 12, vcpu: 4, disk: 20 },
} as const;

export type InstanceType = keyof typeof INSTANCE;

/** Both container classes in wrangler.jsonc run standard-1. */
export const SESSION_INSTANCE_TYPE: InstanceType = "standard-1";

export type BudgetTier =
  | "ok" // business as usual
  | "warn" // >=60%: surface a notice in the UI, keep serving
  | "anon_blocked" // >=80%: live sessions require a Handsontable login
  | "new_blocked" // >=95%: no new sessions or builds; running ones finish
  | "closed"; // >=100%: tear down live sessions, static shares only

export interface BudgetState {
  tier: BudgetTier;
  spendUsd: number;
  limitUsd: number;
  /** spendUsd / limitUsd, 0 when the limit is disabled. */
  pct: number;
  /** True when every ledger row behind `spendUsd` came from reconciled billing
   *  data rather than our own estimator. */
  reconciled: boolean;
  /** Whether the tier above is actually being acted on, or only observed.
   *  Carried on the state so a gate needs exactly one read to decide. */
  enforced: boolean;
  /** The dollar thresholds this tier was computed against (panel-editable). */
  settings: ResolvedBudgetSettings;
  asOf: number;
}

const KV_STATE_KEY = "budget:state";
const KV_STATE_TTL_SECONDS = 300;

/** Per-session awake-window meter. */
const KV_METER_PREFIX = "session-meter:";
const KV_METER_TTL_SECONDS = 60 * 60 * 24;
/** Don't write a KV/D1 round trip on every keepalive ping; a session pings
 *  every ~60s while visible and polls every 2.5s while booting. */
const METER_FLUSH_SECONDS = 60;
/** A gap between pings longer than the container's own idle window means the
 *  container slept in between and stopped billing — never charge the whole
 *  gap. Must stay >= the `sleepAfter` in index.ts. */
const MAX_UNSEEN_AWAKE_SECONDS = 300;

/**
 * Cost of one awake container-second.
 *
 * `cpuUtilisation` scales only the CPU term. The 0.35 default is pessimistic
 * for a dev server that is mostly idle between edits: at standard-1 it prices
 * an awake hour at $0.0505 against a $0.0380 idle floor and a $0.0740 ceiling
 * at 100% of the provisioned half-vCPU.
 */
export function containerUsdPerSecond(type: InstanceType, cpuUtilisation = 0.35): number {
  const i = INSTANCE[type];
  return i.mem * RATE.memGiBSec + i.disk * RATE.diskGBSec + i.vcpu * cpuUtilisation * RATE.vcpuSec;
}

/** Which tier a month-to-date dollar figure falls into. Thresholds come from
 *  the panel-editable settings, so this is pure arithmetic on dollars. */
export function tierFor(spendUsd: number, s: ResolvedBudgetSettings): BudgetTier {
  if (spendUsd >= s.closedUsd) return "closed";
  if (spendUsd >= s.newBlockUsd) return "new_blocked";
  if (spendUsd >= s.anonBlockUsd) return "anon_blocked";
  if (spendUsd >= s.warnUsd) return "warn";
  return "ok";
}

const utcDay = (at = Date.now()): string => new Date(at).toISOString().slice(0, 10);

/** Hot path: KV-cached, so `POST /api/session` never pays for a D1 aggregate.
 *  The cached copy embeds the thresholds it was computed with, which is why
 *  saving settings in the admin panel invalidates it explicitly. */
export async function getBudgetState(env: Env): Promise<BudgetState> {
  const cached = await env.CACHE.get(KV_STATE_KEY, "json").catch(() => null);
  if (cached) return cached as BudgetState;
  const fresh = await computeBudgetState(env);
  await env.CACHE.put(KV_STATE_KEY, JSON.stringify(fresh), { expirationTtl: KV_STATE_TTL_SECONDS })
    .catch(() => { /* cache miss next time is fine */ });
  return fresh;
}

/** Drop the cached state so the next read reflects a just-written ledger row. */
export const invalidateBudgetState = (env: Env): Promise<void> =>
  env.CACHE.delete(KV_STATE_KEY).catch(() => { /* stale-for-5-minutes is acceptable */ });

/**
 * Month-to-date spend, preferring reconciled billing rows over our estimates.
 *
 * Calendar month, not billing cycle — Cloudflare's own alerts follow the
 * billing cycle, so the two can disagree for a few days around the boundary.
 * That is a deliberate simplification: this ceiling is a backstop, and a
 * calendar month is the one boundary a Worker can compute without an API call.
 */
export async function computeBudgetState(env: Env, preloaded?: ResolvedBudgetSettings): Promise<BudgetState> {
  const monthPrefix = new Date().toISOString().slice(0, 7); // YYYY-MM
  const settings = preloaded ?? (await loadSettings(env));
  const limitUsd = settings.limitUsd;

  // One row per (day, sku): the 'billing' figure when the cron has reconciled
  // that day, else our own 'estimate'.
  const { results } = await env.DB.prepare(
    `SELECT COALESCE(MAX(CASE WHEN source = 'billing'  THEN usd END),
                     MAX(CASE WHEN source = 'estimate' THEN usd END), 0) AS usd,
            MAX(CASE WHEN source = 'billing' THEN 1 ELSE 0 END) AS reconciled
       FROM cost_ledger
      WHERE day LIKE ?1
      GROUP BY day, sku`,
  ).bind(`${monthPrefix}%`).all<{ usd: number; reconciled: number }>();

  const rows = results ?? [];
  const spendUsd = rows.reduce((sum, r) => sum + (r.usd ?? 0), 0);
  const pct = limitUsd > 0 ? spendUsd / limitUsd : 0;

  return {
    tier: tierFor(spendUsd, settings),
    spendUsd,
    limitUsd,
    pct,
    reconciled: rows.length > 0 && rows.every((r) => r.reconciled === 1),
    enforced: settings.enforce,
    settings,
    asOf: Date.now(),
  };
}

/** Additive upsert of one (day, sku) estimate row. */
function upsertEstimate(env: Env, day: string, sku: string, units: number, usd: number) {
  return env.DB.prepare(
    `INSERT INTO cost_ledger (day, sku, source, units, usd, updated_at)
          VALUES (?1, ?2, 'estimate', ?3, ?4, ?5)
     ON CONFLICT(day, sku, source) DO UPDATE
          SET units = units + ?3, usd = usd + ?4, updated_at = ?5`,
  ).bind(day, sku, units, usd, Date.now());
}

/**
 * Meter a closed container awake window. Additive per (day, sku) so concurrent
 * writers never clobber each other.
 */
export async function recordContainerUsage(
  env: Env,
  opts: { instanceType: InstanceType; awakeSeconds: number },
): Promise<void> {
  if (!(opts.awakeSeconds > 0)) return;
  const usd = opts.awakeSeconds * containerUsdPerSecond(opts.instanceType);
  await upsertEstimate(env, utcDay(), "container", opts.awakeSeconds, usd).run();
  await invalidateBudgetState(env);
}

/** Meter proxied preview traffic + Worker requests (see the accumulator below). */
export async function recordTraffic(env: Env, egressBytes: number, requests: number): Promise<void> {
  const day = utcDay();
  const gb = egressBytes / 1e9;
  const batch = [];
  if (gb > 0) batch.push(upsertEstimate(env, day, "egress", gb, gb * RATE.egressUsdPerGB));
  if (requests > 0) {
    batch.push(upsertEstimate(env, day, "workers", requests, (requests / 1e6) * RATE.requestsUsdPerMillion));
  }
  if (!batch.length) return;
  await env.DB.batch(batch);
  await invalidateBudgetState(env);
}

// ---- Per-session awake-window meter -----------------------------------------
//
// A container bills from the first request until it scales to zero after
// `sleepAfter`. The client keepalive gives us a reliable liveness signal, so we
// meter incrementally: each ping past METER_FLUSH_SECONDS books the elapsed
// slice, and teardown books the remainder. An abandoned session (client gone,
// no DELETE) therefore under-counts by at most one idle window — the nightly
// reconciliation is what closes that gap.

interface SessionMeter {
  startedAt: number;
  meteredThrough: number;
  instanceType: InstanceType;
}

const meterKey = (sessionId: string) => `${KV_METER_PREFIX}${sessionId}`;

export async function startSessionMeter(
  env: Env,
  sessionId: string,
  instanceType: InstanceType = SESSION_INSTANCE_TYPE,
): Promise<void> {
  const now = Date.now();
  const meter: SessionMeter = { startedAt: now, meteredThrough: now, instanceType };
  await env.CACHE.put(meterKey(sessionId), JSON.stringify(meter), { expirationTtl: KV_METER_TTL_SECONDS })
    .catch(() => { /* metering is best effort; never fail a session on it */ });
}

/**
 * Book the slice of awake time since the last flush.
 * `final` (teardown) always books and then drops the meter.
 */
export async function meterSession(
  env: Env,
  sessionId: string,
  opts: { final?: boolean } = {},
): Promise<void> {
  // Metering is telemetry, and telemetry must never be the reason a request
  // fails. The teardown path in particular: a throw here would skip the
  // `sandbox.destroy()` that follows it and leave a container billing until
  // its idle window lapses — the exact cost this file exists to prevent.
  try {
    await meterSessionUnsafe(env, sessionId, opts);
  } catch (err) {
    console.warn("[budget] session metering failed:", err instanceof Error ? err.message : String(err));
  }
}

async function meterSessionUnsafe(
  env: Env,
  sessionId: string,
  opts: { final?: boolean },
): Promise<void> {
  const key = meterKey(sessionId);
  const meter = (await env.CACHE.get(key, "json").catch(() => null)) as SessionMeter | null;
  if (!meter) return;

  const now = Date.now();
  const elapsedSeconds = Math.max(0, (now - meter.meteredThrough) / 1000);
  if (!opts.final && elapsedSeconds < METER_FLUSH_SECONDS) return;

  const awakeSeconds = Math.min(elapsedSeconds, MAX_UNSEEN_AWAKE_SECONDS);
  if (opts.final) {
    await env.CACHE.delete(key).catch(() => { /* TTL cleans it up */ });
  } else {
    await env.CACHE.put(key, JSON.stringify({ ...meter, meteredThrough: now }), {
      expirationTtl: KV_METER_TTL_SECONDS,
    }).catch(() => { /* next ping re-books the same slice; capped above */ });
  }
  await recordContainerUsage(env, { instanceType: meter.instanceType, awakeSeconds });
}

// ---- Traffic accumulator -----------------------------------------------------
//
// Every proxied preview asset and every API request would be one D1 write if
// metered individually, which is absurd. Instead they accumulate in isolate
// memory and flush in batches. Isolate eviction drops the partial batch — an
// acceptable under-count for an estimate that the nightly job overwrites with
// Cloudflare's own `responseBodySize` figures.

let pendingEgressBytes = 0;
let pendingRequests = 0;
const FLUSH_EGRESS_BYTES = 64 * 1024 * 1024;
const FLUSH_REQUESTS = 2000;

/** Accumulate; returns true when the batch is worth a D1 write. */
export function noteTraffic(egressBytes: number, requests = 0): boolean {
  pendingEgressBytes += Math.max(0, egressBytes);
  pendingRequests += requests;
  return pendingEgressBytes >= FLUSH_EGRESS_BYTES || pendingRequests >= FLUSH_REQUESTS;
}

/** Write and reset the accumulator. Safe to call when empty. */
export async function flushTraffic(env: Env): Promise<void> {
  const bytes = pendingEgressBytes;
  const requests = pendingRequests;
  if (!bytes && !requests) return;
  pendingEgressBytes = 0;
  pendingRequests = 0;
  try {
    await recordTraffic(env, bytes, requests);
  } catch {
    // Put it back rather than silently losing the slice.
    pendingEgressBytes += bytes;
    pendingRequests += requests;
  }
}

/**
 * Wrap a proxied container response so its body bytes land in the accumulator.
 *
 * WebSocket upgrades (HMR) carry no measurable body here and pass through
 * untouched — container egress is therefore a lower bound until the nightly
 * reconciliation replaces it.
 */
export function countEgress(response: Response): Response {
  const withSocket = response as Response & { webSocket?: unknown };
  if (withSocket.webSocket || !response.body) return response;
  try {
    let bytes = 0;
    const counter = new TransformStream({
      transform(chunk: Uint8Array, controller) {
        bytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
      flush() {
        noteTraffic(bytes);
      },
    });
    return new Response(response.body.pipeThrough(counter), response);
  } catch {
    return response;
  }
}

// ---- Gates -------------------------------------------------------------------

/** Seconds until the ledger's month rolls over (what a client should wait). */
function retryAfterMonthEnd(): number {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.ceil((next - now.getTime()) / 1000);
}

export interface BudgetDenial {
  status: number;
  body: { error: string; message: string; tier: BudgetTier; [k: string]: unknown };
}

/**
 * Gate for `POST /api/session` and the share build. Returns null when the
 * request may proceed. Static share reads are never passed through here —
 * they are the degradation path and must survive `closed`.
 */
export function sessionDenial(state: BudgetState, isAuthenticated: boolean): BudgetDenial | null {
  if (state.tier === "closed" || state.tier === "new_blocked") {
    return {
      status: 503,
      body: {
        error: "budget_exhausted",
        message:
          "Live editing is paused until the next billing cycle. Shared demos and embeds still "
          + "work — they are static builds and cost nothing to serve.",
        tier: state.tier,
        retryAfterSeconds: retryAfterMonthEnd(),
      },
    };
  }
  if (state.tier === "anon_blocked" && !isAuthenticated) {
    return {
      status: 401,
      body: {
        error: "budget_login_required",
        message: "Live editing is limited to signed-in Handsontable users while spend is high.",
        tier: state.tier,
        loginUrl: "/api/login",
      },
    };
  }
  return null;
}

/** The public shape of the budget state (no dollar figures for anonymous callers). */
export function publicBudget(state: BudgetState, opts: { detailed: boolean }) {
  const notice =
    state.tier === "warn"
      ? "Live-session budget is running high; sessions may soon require sign-in."
      : state.tier === "anon_blocked"
        ? "Live editing currently requires a Handsontable sign-in (budget guardrail)."
        : state.tier === "new_blocked" || state.tier === "closed"
          ? "Live editing is paused until the next billing cycle. Shared demos still work."
          : null;
  return {
    tier: state.tier,
    pct: Math.round(state.pct * 1000) / 1000,
    // Observe-only deployments report a tier but never act on it; the UI must
    // not tell users sessions are restricted when nothing is being refused.
    enforced: state.enforced,
    notice: state.enforced ? notice : null,
    ...(opts.detailed
      ? {
          spendUsd: Math.round(state.spendUsd * 100) / 100,
          limitUsd: state.limitUsd,
          reconciled: state.reconciled,
          asOf: state.asOf,
        }
      : {}),
  };
}
