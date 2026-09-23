// ADR-0041 §F.3's o11y-worker-cron rules (everything on that table's third
// row: `at_capacity` rate, 5xx rate, preview-ready rate, session-start p95,
// embed error rate, compile-error day-over-day, inbox backlog age, a
// `rejected` inbox key, the o11y spend cap) — plus the new-fingerprint rule
// (the table's fourth row, read straight from `InboxWriter`'s exact
// registry, never sampled data).
//
// Every rule returns a {@link RuleResult}; `notify.ts` turns that into the
// fire-once/resolve-once `alert:<rule>` state transition and the Slack line.
// SQL stays to the shared five-function allowlist (`ae-query.ts`) — a ratio,
// a day-over-day comparison, or an outcome breakdown is computed here in JS
// over grouped counts, never as a wider SQL feature (COMMON.md controller
// note: keep the allowlist the one T09 also uses).
//
// Every window/threshold below is the ADR §F.3 prose's own number. Two
// numbers the ADR leaves unstated (a rule evaluation window is not always
// named) are called out where chosen (T04-D, see the task Outcome).

import type { Heartbeat } from "@handsontable/demo-runtime/telemetry";
import type { Env, InboxWriterApi } from "../env.js";
import { runAeQuery, type AeRow } from "./ae-query.js";

export interface RuleResult {
  rule: string;
  firing: boolean;
  /** Human-readable detail, used only in the Slack line on a fire
   *  transition — never on resolve (the resolve line names the rule only). */
  detail: string;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

async function countByOutcome(env: Env, metric: string, windowMs: number, extraWhere = ""): Promise<Map<string, number>> {
  const sql =
    `SELECT blob8 AS outcome, sum(_sample_interval * double1) AS c ` +
    `FROM runner_events WHERE index1 = '${metric}' ` +
    `AND timestamp >= now() - INTERVAL '${Math.round(windowMs / 1000)}' SECOND ${extraWhere} ` +
    `GROUP BY blob8`;
  const rows = await runAeQuery(env, sql);
  const out = new Map<string, number>();
  for (const row of rows) out.set(String(row.outcome ?? ""), Number(row.c ?? 0));
  return out;
}

async function countByGroup(
  env: Env,
  metric: string,
  groupBlob: number,
  windowMs: number,
  extraWhere = "",
): Promise<Map<string, number>> {
  const sql =
    `SELECT blob${groupBlob} AS grp, sum(_sample_interval * double1) AS c ` +
    `FROM runner_events WHERE index1 = '${metric}' ` +
    `AND timestamp >= now() - INTERVAL '${Math.round(windowMs / 1000)}' SECOND ${extraWhere} ` +
    `GROUP BY grp`;
  const rows = await runAeQuery(env, sql);
  const out = new Map<string, number>();
  for (const row of rows) out.set(String(row.grp ?? ""), Number(row.c ?? 0));
  return out;
}

/** Same as {@link countByGroup} but for a fixed window in the past
 *  (`[nowMs - endAgoMs - windowMs, nowMs - endAgoMs)`), for a day-over-day
 *  comparison. `now() - INTERVAL` composes left to right in ClickHouse/AE
 *  SQL, so two interval subtractions chain correctly. */
async function countByGroupInWindow(
  env: Env,
  metric: string,
  groupBlob: number,
  endAgoMs: number,
  windowMs: number,
): Promise<Map<string, number>> {
  const endAgoS = Math.round(endAgoMs / 1000);
  const startAgoS = Math.round((endAgoMs + windowMs) / 1000);
  const sql =
    `SELECT blob${groupBlob} AS grp, sum(_sample_interval * double1) AS c FROM runner_events ` +
    `WHERE index1 = '${metric}' ` +
    `AND timestamp >= now() - INTERVAL '${startAgoS}' SECOND ` +
    `AND timestamp < now() - INTERVAL '${endAgoS}' SECOND ` +
    `GROUP BY grp`;
  const rows = await runAeQuery(env, sql);
  const out = new Map<string, number>();
  for (const row of rows) out.set(String(row.grp ?? ""), Number(row.c ?? 0));
  return out;
}

async function weightedQuantile(env: Env, metric: string, windowMs: number, q: number): Promise<number | null> {
  const sql =
    `SELECT quantileExactWeighted(${q})(double2, toUInt32(_sample_interval)) AS p ` +
    `FROM runner_events WHERE index1 = '${metric}' ` +
    `AND timestamp >= now() - INTERVAL '${Math.round(windowMs / 1000)}' SECOND`;
  const rows = await runAeQuery(env, sql);
  const first = rows[0];
  if (!first || first.p === undefined || first.p === null) return null;
  const n = Number(first.p);
  return Number.isFinite(n) ? n : null;
}

// ---- at_capacity rate: above 5/h ------------------------------------------

export async function atCapacityRule(env: Env): Promise<RuleResult> {
  const counts = await countByOutcome(env, "session.start", HOUR_MS);
  const n = counts.get("at_capacity") ?? 0;
  return {
    rule: "at-capacity-rate",
    firing: n > 5,
    detail: `${n} at_capacity refusal(s) in the last hour (threshold 5)`,
  };
}

// ---- api.request 5xx rate: above 1% over 15 min ---------------------------

export async function fiveXxRateRule(env: Env): Promise<RuleResult> {
  const windowMs = 15 * 60 * 1000;
  const counts = await countByOutcome(env, "api.request", windowMs);
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const fiveXx = counts.get("5xx") ?? 0;
  const pct = ratio(fiveXx, total) * 100;
  return {
    rule: "api-5xx-rate",
    firing: total > 0 && pct > 1,
    detail: `${pct.toFixed(2)}% 5xx over the last 15 min (${fiveXx}/${total}, threshold 1%)`,
  };
}

// ---- preview-ready rate: below 97% (tier 1) or 95% (tier 2) over 1h -------

const PREVIEW_READY_THRESHOLD_PCT: Record<string, number> = { "1": 97, "2": 95 };

export async function previewReadyRateRule(env: Env): Promise<RuleResult> {
  const results: string[] = [];
  let anyFiring = false;
  for (const [tier, thresholdPct] of Object.entries(PREVIEW_READY_THRESHOLD_PCT)) {
    const counts = await countByOutcome(env, "preview.ready_ms", HOUR_MS, `AND blob5 = '${tier}'`);
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    const ready = counts.get("ready") ?? 0;
    const pct = total > 0 ? ratio(ready, total) * 100 : 100;
    if (total > 0 && pct < thresholdPct) {
      anyFiring = true;
      results.push(`tier ${tier}: ${pct.toFixed(1)}% ready (${ready}/${total}, threshold ${thresholdPct}%)`);
    }
  }
  return {
    rule: "preview-ready-rate",
    firing: anyFiring,
    detail: results.join("; ") || "all tiers within threshold",
  };
}

// ---- session-start p95: above 20s (T04-D: window chosen as 1h, the ADR --
// text names the threshold but not an evaluation window) -------------------

export async function sessionStartP95Rule(env: Env): Promise<RuleResult> {
  const p95 = await weightedQuantile(env, "session.start", HOUR_MS, 0.95);
  const firing = p95 !== null && p95 > 20_000;
  return {
    rule: "session-start-p95",
    firing,
    detail: p95 === null ? "no session.start samples in the last hour" : `p95 ${(p95 / 1000).toFixed(1)}s (threshold 20s)`,
  };
}

// ---- embed error rate: above 20% with more than 50 views in 24h, per demo -

export async function embedErrorRateRule(env: Env): Promise<RuleResult> {
  const windowMs = DAY_MS;
  const [errorsByDemo, viewsByDemo] = await Promise.all([
    countByGroup(env, "error.uncaught", 12, windowMs, "AND blob4 = 'embed'"),
    countByGroup(env, "serve.embed", 12, windowMs, "AND blob8 = '2xx'"),
  ]);
  const offenders: string[] = [];
  for (const [demoId, views] of viewsByDemo) {
    if (!demoId || views <= 50) continue;
    const errors = errorsByDemo.get(demoId) ?? 0;
    const pct = ratio(errors, views) * 100;
    if (pct > 20) offenders.push(`${demoId}: ${pct.toFixed(1)}% (${errors}/${views} views)`);
  }
  return {
    rule: "embed-error-rate",
    firing: offenders.length > 0,
    detail: offenders.join("; ") || "no demo over threshold",
  };
}

// ---- compile-error rate per ht_major: doubling day over day (T04-D: a --
// floor of 5 today-count avoids "doubling" noise on tiny counts like 0->1)--

const COMPILE_ERROR_DOUBLING_FLOOR = 5;

export async function compileErrorDoublingRule(env: Env): Promise<RuleResult> {
  const [today, yesterday] = await Promise.all([
    countByGroupInWindow(env, "sandpack.compile_error", 7, 0, DAY_MS),
    countByGroupInWindow(env, "sandpack.compile_error", 7, DAY_MS, DAY_MS),
  ]);
  const offenders: string[] = [];
  for (const [htMajor, todayCount] of today) {
    if (!htMajor || todayCount < COMPILE_ERROR_DOUBLING_FLOOR) continue;
    const yesterdayCount = yesterday.get(htMajor) ?? 0;
    if (todayCount >= yesterdayCount * 2) {
      offenders.push(`ht_major ${htMajor}: ${todayCount} today vs ${yesterdayCount} yesterday`);
    }
  }
  return {
    rule: "compile-error-doubling",
    firing: offenders.length > 0,
    detail: offenders.join("; ") || "no ht_major doubled",
  };
}

// ---- LiteLLM errors: above 5% (chat.answer + theme.ai, both gateway --
// call sites; T04-D: window chosen as 1h, same reasoning as session-start)--

export async function litellmErrorRateRule(env: Env): Promise<RuleResult> {
  const windowMs = HOUR_MS;
  const [chat, theme] = await Promise.all([
    countByOutcome(env, "chat.answer", windowMs),
    countByOutcome(env, "theme.ai", windowMs),
  ]);
  const total = [...chat.values(), ...theme.values()].reduce((a, b) => a + b, 0);
  const errors = (chat.get("error") ?? 0) + (theme.get("error") ?? 0);
  const pct = ratio(errors, total) * 100;
  return {
    rule: "litellm-error-rate",
    firing: total > 0 && pct > 5,
    detail: `${pct.toFixed(2)}% gateway errors over the last hour (${errors}/${total}, threshold 5%)`,
  };
}

// ---- inbox backlog age: older than 2h --------------------------------------

export async function backlogAgeRule(inboxWriter: InboxWriterApi): Promise<RuleResult> {
  const ageMs = await inboxWriter.backlogOldestAgeMs();
  const firing = ageMs !== null && ageMs > 2 * HOUR_MS;
  return {
    rule: "backlog-age",
    firing,
    detail: ageMs === null ? "no backlog" : `oldest backlogged key is ${(ageMs / HOUR_MS).toFixed(1)}h old (threshold 2h)`,
  };
}

// ---- a rejected inbox key ---------------------------------------------------

export async function rejectedKeyRule(inboxWriter: InboxWriterApi): Promise<RuleResult> {
  const count = await inboxWriter.rejectedKeyCount();
  return {
    rule: "rejected-inbox-key",
    firing: count > 0,
    detail: `${count} rejected inbox key(s)`,
  };
}

// ---- new handled-error fingerprint ------------------------------------------

const NEW_FINGERPRINT_CURSOR_META_KEY = "newFingerprintCursorMs";

export async function newFingerprintRule(inboxWriter: InboxWriterApi, nowMs = Date.now()): Promise<RuleResult> {
  const cursorRaw = await inboxWriter.getAlertMeta(NEW_FINGERPRINT_CURSOR_META_KEY);
  const cursor = cursorRaw ? Number(cursorRaw) : nowMs - HOUR_MS; // first run: look back one hour
  const fresh = await inboxWriter.newFingerprintsSince(cursor);
  await inboxWriter.setAlertMeta(NEW_FINGERPRINT_CURSOR_META_KEY, String(nowMs));
  return {
    rule: "new-fingerprint",
    firing: fresh.length > 0,
    detail: fresh.length > 0 ? `new fingerprint(s): ${fresh.join(", ")}` : "no new fingerprints",
  };
}

// ---- the o11y spend cap -----------------------------------------------------

export interface O11ySpend {
  spendUsd: number;
  capUsd: number;
}

export async function o11yCapRule(spend: O11ySpend): Promise<RuleResult> {
  return {
    rule: "o11y-spend-cap",
    firing: spend.spendUsd >= spend.capUsd,
    detail: `observability spend $${spend.spendUsd.toFixed(2)} of $${spend.capUsd.toFixed(2)} cap`,
  };
}

// ---- watchdog: the o11y stack itself stale (owned by o11y-watchdog.ts on --
// the API side; not part of runAlerts — listed here only for the doc index)

export type { Heartbeat };
