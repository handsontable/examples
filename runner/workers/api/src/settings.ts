// Runtime-editable guardrail settings (DEV-2030 follow-up).
//
// The wrangler.jsonc `BUDGET_*` vars are *defaults*. Anything stored here
// overrides them, so the ceiling, every tier and the enforcement switch can be
// changed from the admin panel without a deploy — which matters, because the
// moment you actually need to move a threshold is the moment you least want to
// be waiting on a build.
//
// Thresholds are absolute dollars, not fractions. "Sign-in required at $800"
// is a sentence a person can check against an invoice; "0.8" is not.

import type { Env } from "./env.js";

export interface BudgetSettings {
  /** The ceiling. Spend at or above this is the `closed` tier. */
  limitUsd: number;
  /** Tier boundaries, in dollars. Must be non-decreasing and <= limitUsd. */
  warnUsd: number;
  anonBlockUsd: number;
  newBlockUsd: number;
  closedUsd: number;
  /** false = compute and log tiers but refuse nothing (observe-only). */
  enforce: boolean;
  /** In-app alert thresholds. Unlike Cloudflare's account-wide budget alerts,
   *  these fire on *this runner's* metered spend. */
  alertsUsd: number[];
}

export interface ResolvedBudgetSettings extends BudgetSettings {
  source: "defaults" | "override";
  updatedAt: string | null;
  updatedBy: string | null;
}

const SETTINGS_KEY = "budget";
const KV_KEY = "budget:settings";
const KV_TTL_SECONDS = 60;

const num = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** The wrangler.jsonc vars, expressed in the same dollar terms as an override.
 *  The vars stay fractions because that is what they have always been; the
 *  conversion happens here, once. */
export function defaultSettings(env: Env): ResolvedBudgetSettings {
  const limitUsd = num(env.BUDGET_MONTHLY_USD, 1000);
  const pct = (v: unknown, d: number) => Math.min(1, Math.max(0, num(v, d))) * limitUsd;
  const alerts = String(env.BUDGET_ALERTS_USD ?? "200,500,800")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return {
    limitUsd,
    warnUsd: pct(env.BUDGET_WARN_PCT, 0.6),
    anonBlockUsd: pct(env.BUDGET_ANON_BLOCK_PCT, 0.8),
    newBlockUsd: pct(env.BUDGET_NEW_BLOCK_PCT, 0.95),
    closedUsd: pct(env.BUDGET_CLOSED_PCT, 1),
    enforce: String(env.BUDGET_ENFORCE ?? "0") === "1",
    alertsUsd: alerts.sort((a, b) => a - b),
    source: "defaults",
    updatedAt: null,
    updatedBy: null,
  };
}

/** Absolute ceiling on what the panel may set, so a fat finger in the form
 *  cannot turn the guardrail into a blank cheque. */
const MAX_LIMIT_USD = 100_000;

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Validate a settings payload from the admin panel.
 *
 * The invariant that matters is ordering: warn <= sign-in <= no-new <= closed
 * <= limit. Out of order, a tier becomes unreachable and the ceiling silently
 * stops doing what the panel says it does.
 */
export function validateSettings(input: unknown): Validation<BudgetSettings> {
  if (typeof input !== "object" || input === null) return { ok: false, error: "settings must be an object" };
  const raw = input as Record<string, unknown>;

  const limitUsd = Number(raw.limitUsd);
  if (!Number.isFinite(limitUsd) || limitUsd <= 0) return { ok: false, error: "limitUsd must be greater than 0" };
  if (limitUsd > MAX_LIMIT_USD) return { ok: false, error: `limitUsd must be at most ${MAX_LIMIT_USD}` };

  const fields = ["warnUsd", "anonBlockUsd", "newBlockUsd", "closedUsd"] as const;
  const values: Record<(typeof fields)[number], number> = {
    warnUsd: 0, anonBlockUsd: 0, newBlockUsd: 0, closedUsd: 0,
  };
  for (const field of fields) {
    const v = Number(raw[field]);
    if (!Number.isFinite(v) || v <= 0) return { ok: false, error: `${field} must be greater than 0` };
    if (v > limitUsd) return { ok: false, error: `${field} must not exceed the limit ($${limitUsd})` };
    values[field] = Math.round(v * 100) / 100;
  }
  if (!(values.warnUsd <= values.anonBlockUsd
    && values.anonBlockUsd <= values.newBlockUsd
    && values.newBlockUsd <= values.closedUsd)) {
    return { ok: false, error: "tiers must be in order: warn <= sign-in <= no-new <= closed" };
  }

  const alertsInput = Array.isArray(raw.alertsUsd) ? raw.alertsUsd : [];
  if (alertsInput.length > 8) return { ok: false, error: "at most 8 alert thresholds" };
  const alertsUsd = [...new Set(alertsInput.map((v) => Math.round(Number(v) * 100) / 100))]
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);
  if (alertsUsd.some((v) => v > MAX_LIMIT_USD)) return { ok: false, error: "alert thresholds are unreasonably large" };

  return {
    ok: true,
    value: {
      limitUsd: Math.round(limitUsd * 100) / 100,
      ...values,
      enforce: raw.enforce === true || raw.enforce === "true",
      alertsUsd,
    },
  };
}

/**
 * Effective settings: KV (fast) -> D1 (durable) -> wrangler vars (defaults).
 *
 * Read on the hot path, so the KV copy is the one that normally answers. Its
 * 60s TTL is the worst-case delay between saving in the panel and every colo
 * agreeing — deliberately short, because these are safety settings.
 */
export async function loadSettings(env: Env): Promise<ResolvedBudgetSettings> {
  const cached = await env.CACHE.get(KV_KEY, "json").catch(() => null);
  if (cached) return cached as ResolvedBudgetSettings;

  const defaults = defaultSettings(env);
  let resolved = defaults;
  try {
    const row = await env.DB.prepare("SELECT value, updated_at, updated_by FROM runner_settings WHERE key = ?1")
      .bind(SETTINGS_KEY)
      .first<{ value: string; updated_at: string; updated_by: string }>();
    if (row) {
      const parsed = validateSettings(JSON.parse(row.value));
      // A stored row that no longer validates (hand-edited, or written by an
      // older shape) must not take the guardrail down with it.
      if (parsed.ok) {
        resolved = { ...parsed.value, source: "override", updatedAt: row.updated_at, updatedBy: row.updated_by };
      } else {
        console.warn(`[budget] stored settings rejected (${parsed.error}); using defaults`);
      }
    }
  } catch (err) {
    console.warn("[budget] settings read failed, using defaults:", err instanceof Error ? err.message : String(err));
    return defaults;
  }

  await env.CACHE.put(KV_KEY, JSON.stringify(resolved), { expirationTtl: KV_TTL_SECONDS })
    .catch(() => { /* re-read next time */ });
  return resolved;
}

/** Persist an override and drop both caches so it takes effect immediately. */
export async function saveSettings(
  env: Env,
  value: BudgetSettings,
  updatedBy: string,
): Promise<ResolvedBudgetSettings> {
  const updatedAt = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO runner_settings (key, value, updated_at, updated_by)
          VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3, updated_by = ?4`,
  ).bind(SETTINGS_KEY, JSON.stringify(value), updatedAt, updatedBy).run();

  const resolved: ResolvedBudgetSettings = { ...value, source: "override", updatedAt, updatedBy };
  await env.CACHE.put(KV_KEY, JSON.stringify(resolved), { expirationTtl: KV_TTL_SECONDS }).catch(() => {});
  return resolved;
}

/** Drop the override and fall back to the wrangler.jsonc defaults. */
export async function resetSettings(env: Env): Promise<ResolvedBudgetSettings> {
  await env.DB.prepare("DELETE FROM runner_settings WHERE key = ?1").bind(SETTINGS_KEY).run();
  await env.CACHE.delete(KV_KEY).catch(() => {});
  return defaultSettings(env);
}
