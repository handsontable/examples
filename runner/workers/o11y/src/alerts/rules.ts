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
//
// Fix round (I1): every AE-query rule and its shared helper now takes an
// injectable `queryFn` (defaults to the real `runAeQuery`), so
// `pipeline/o11y-alerts.test.mjs` can drive each rule over a synchronous
// fake instead of a live ClickHouse/AE endpoint — the same injection shape
// `cron-step.ts#CronCaptureFn`/`diagnostic.ts#CaptureExceptionFn` already
// use elsewhere in this codebase for the same reason (a real transport is
// for one live pass, not every future `pnpm test`). Column references are
// built from the contract's own `AE_COLUMNS` map (`col()` below) rather
// than hand-numbered `blobN`/`doubleN` literals, so a future contract slot
// renumbering cannot silently desync this file from the columns it reads.

import { AE_COLUMNS, type Heartbeat } from "@handsontable/demo-runtime/telemetry";
import type { Env, InboxWriterApi } from "../env.js";
import { runAeQuery, type AeRow } from "./ae-query.js";

export interface RuleResult {
  rule: string;
  firing: boolean;
  /** Human-readable detail, used only in the Slack line on a fire
   *  transition — never on resolve (the resolve line names the rule only). */
  detail: string;
}

/** Matches `ae-query.ts#runAeQuery`'s signature — the injection point every
 *  AE-query rule below accepts. */
export type AeQueryFn = (env: Env, sql: string) => Promise<AeRow[]>;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

/** The AE slot (`blobN`/`doubleN`) for a contract column name — never a
 *  hand-numbered literal. Throws on an unknown name (a typo here must fail
 *  loudly, the same rule `metrics.ts#toAePoint`'s own `writeBlob` follows). */
function col(name: keyof typeof AE_COLUMNS): string {
  const slot = AE_COLUMNS[name];
  if (!slot) throw new Error(`rules.ts: no AE column for "${name}"`);
  return slot;
}

async function countByOutcome(
  env: Env,
  metric: string,
  windowMs: number,
  extraWhere = "",
  queryFn: AeQueryFn = runAeQuery,
): Promise<Map<string, number>> {
  const outcomeCol = col("outcome");
  const countCol = col("count");
  const sql =
    `SELECT ${outcomeCol} AS outcome, sum(_sample_interval * ${countCol}) AS c ` +
    `FROM runner_events WHERE index1 = '${metric}' ` +
    `AND timestamp >= now() - INTERVAL '${Math.round(windowMs / 1000)}' SECOND ${extraWhere} ` +
    `GROUP BY ${outcomeCol}`;
  const rows = await queryFn(env, sql);
  const out = new Map<string, number>();
  for (const row of rows) out.set(String(row.outcome ?? ""), Number(row.c ?? 0));
  return out;
}

async function countByGroup(
  env: Env,
  metric: string,
  groupColumn: keyof typeof AE_COLUMNS,
  windowMs: number,
  extraWhere = "",
  queryFn: AeQueryFn = runAeQuery,
): Promise<Map<string, number>> {
  const groupCol = col(groupColumn);
  const countCol = col("count");
  const sql =
    `SELECT ${groupCol} AS grp, sum(_sample_interval * ${countCol}) AS c ` +
    `FROM runner_events WHERE index1 = '${metric}' ` +
    `AND timestamp >= now() - INTERVAL '${Math.round(windowMs / 1000)}' SECOND ${extraWhere} ` +
    `GROUP BY grp`;
  const rows = await queryFn(env, sql);
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
  groupColumn: keyof typeof AE_COLUMNS,
  endAgoMs: number,
  windowMs: number,
  queryFn: AeQueryFn = runAeQuery,
): Promise<Map<string, number>> {
  const groupCol = col(groupColumn);
  const countCol = col("count");
  const endAgoS = Math.round(endAgoMs / 1000);
  const startAgoS = Math.round((endAgoMs + windowMs) / 1000);
  const sql =
    `SELECT ${groupCol} AS grp, sum(_sample_interval * ${countCol}) AS c FROM runner_events ` +
    `WHERE index1 = '${metric}' ` +
    `AND timestamp >= now() - INTERVAL '${startAgoS}' SECOND ` +
    `AND timestamp < now() - INTERVAL '${endAgoS}' SECOND ` +
    `GROUP BY grp`;
  const rows = await queryFn(env, sql);
  const out = new Map<string, number>();
  for (const row of rows) out.set(String(row.grp ?? ""), Number(row.c ?? 0));
  return out;
}

async function weightedQuantile(
  env: Env,
  metric: string,
  windowMs: number,
  q: number,
  extraWhere = "",
  queryFn: AeQueryFn = runAeQuery,
): Promise<number | null> {
  const valueCol = col("duration_ms");
  const sql =
    `SELECT quantileExactWeighted(${q})(${valueCol}, toUInt32(_sample_interval)) AS p ` +
    `FROM runner_events WHERE index1 = '${metric}' ` +
    `AND timestamp >= now() - INTERVAL '${Math.round(windowMs / 1000)}' SECOND ${extraWhere}`;
  const rows = await queryFn(env, sql);
  const first = rows[0];
  if (!first || first.p === undefined || first.p === null) return null;
  const n = Number(first.p);
  return Number.isFinite(n) ? n : null;
}

// ---- at_capacity rate: above 5/h ------------------------------------------

export async function atCapacityRule(env: Env, queryFn: AeQueryFn = runAeQuery): Promise<RuleResult> {
  const counts = await countByOutcome(env, "session.start", HOUR_MS, "", queryFn);
  const n = counts.get("at_capacity") ?? 0;
  return {
    rule: "at-capacity-rate",
    firing: n > 5,
    detail: `${n} at_capacity refusal(s) in the last hour (threshold 5)`,
  };
}

// ---- api.request 5xx rate: above 1% over 15 min ---------------------------

export async function fiveXxRateRule(env: Env, queryFn: AeQueryFn = runAeQuery): Promise<RuleResult> {
  const windowMs = 15 * 60 * 1000;
  const counts = await countByOutcome(env, "api.request", windowMs, "", queryFn);
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

export async function previewReadyRateRule(env: Env, queryFn: AeQueryFn = runAeQuery): Promise<RuleResult> {
  const tierCol = col("tier");
  const results: string[] = [];
  let anyFiring = false;
  for (const [tier, thresholdPct] of Object.entries(PREVIEW_READY_THRESHOLD_PCT)) {
    const counts = await countByOutcome(env, "preview.ready_ms", HOUR_MS, `AND ${tierCol} = '${tier}'`, queryFn);
    // Minor triage item 10: `abandoned` (the user simply navigated away
    // before the preview finished) excluded from BOTH the numerator (it was
    // never `ready`, so already excluded there by construction) and the
    // denominator — counting it against readiness let a burst of ordinary
    // navigation-aways fire an alert about preview reliability that never
    // actually had a problem.
    const total = [...counts.entries()]
      .filter(([outcome]) => outcome !== "abandoned")
      .reduce((sum, [, c]) => sum + c, 0);
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

export async function sessionStartP95Rule(env: Env, queryFn: AeQueryFn = runAeQuery): Promise<RuleResult> {
  // Controller ruling (fix round, was Minor 3): p95 over `outcome = 'ready'`
  // only — an unfiltered read blends in `at_capacity`/`container_starting`/
  // `budget_denied` refusals, which return almost instantly and drag the
  // percentile down, masking a real slow-start problem during overload
  // (exactly when this rule matters most).
  const outcomeCol = col("outcome");
  const p95 = await weightedQuantile(env, "session.start", HOUR_MS, 0.95, `AND ${outcomeCol} = 'ready'`, queryFn);
  const firing = p95 !== null && p95 > 20_000;
  return {
    rule: "session-start-p95",
    firing,
    detail: p95 === null
      ? "no ready session.start samples in the last hour"
      : `p95 ${(p95 / 1000).toFixed(1)}s (threshold 20s, outcome=ready only)`,
  };
}

// ---- embed error rate: above 20% with more than 50 views in 24h, per demo -

export async function embedErrorRateRule(env: Env, queryFn: AeQueryFn = runAeQuery): Promise<RuleResult> {
  const windowMs = DAY_MS;
  const surfaceCol = col("surface");
  const outcomeCol = col("outcome");
  const [errorsByDemo, viewsByDemo] = await Promise.all([
    countByGroup(env, "error.uncaught", "demo_id", windowMs, `AND ${surfaceCol} = 'embed'`, queryFn),
    countByGroup(env, "serve.embed", "demo_id", windowMs, `AND ${outcomeCol} = '2xx'`, queryFn),
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

export async function compileErrorDoublingRule(env: Env, queryFn: AeQueryFn = runAeQuery): Promise<RuleResult> {
  const [today, yesterday] = await Promise.all([
    countByGroupInWindow(env, "sandpack.compile_error", "ht_major", 0, DAY_MS, queryFn),
    countByGroupInWindow(env, "sandpack.compile_error", "ht_major", DAY_MS, DAY_MS, queryFn),
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

export async function litellmErrorRateRule(env: Env, queryFn: AeQueryFn = runAeQuery): Promise<RuleResult> {
  const windowMs = HOUR_MS;
  const [chat, theme] = await Promise.all([
    countByOutcome(env, "chat.answer", windowMs, "", queryFn),
    countByOutcome(env, "theme.ai", windowMs, "", queryFn),
  ]);
  // Minor triage item 10: `denied` (a rate-limit/budget refusal at
  // `index.ts`'s own gate — see its `outcome: "denied"` emits for both
  // `chat.answer`/`theme.ai`) never reaches the LiteLLM gateway at all, so
  // it must not dilute the GATEWAY error rate this rule measures. A burst of
  // denials (nothing to do with LiteLLM's own health) used to shrink the
  // ratio and could hide a real >5% gateway failure rate underneath it.
  const total = [...chat.entries(), ...theme.entries()]
    .filter(([outcome]) => outcome !== "denied")
    .reduce((sum, [, c]) => sum + c, 0);
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

/** B-C1/A-I1 remainder (rereview.md row 13): rejected `key:` entries are
 *  never pruned (`ledger.ts#rejectKey`'s own doc comment — an operator
 *  needs to still find one), so a plain "count > 0" firing condition, once
 *  true, stays true forever after the very first rejection ever seen. Fire
 *  on RECENT rejection events instead (`rejectedEvent:`, `ledger.ts`) —
 *  standard fire-once/resolve-once semantics (`evaluateAndNotify`) then
 *  resolve naturally once no new rejection lands within this window. */
const REJECTED_RECENT_WINDOW_MS = HOUR_MS;

export async function rejectedKeyRule(inboxWriter: InboxWriterApi, nowMs = Date.now()): Promise<RuleResult> {
  const recent = await inboxWriter.recentRejectionCount(nowMs - REJECTED_RECENT_WINDOW_MS);
  const total = await inboxWriter.rejectedKeyCount();
  return {
    rule: "rejected-inbox-key",
    firing: recent > 0,
    detail:
      recent > 0
        ? `${recent} rejection(s) in the last hour (${total} rejected key(s) overall)`
        : total > 0
          ? `no rejections in the last hour (${total} rejected key(s) overall, unresolved)`
          : "no rejected inbox keys",
  };
}

// ---- new handled-error fingerprint ------------------------------------------

const NEW_FINGERPRINT_CURSOR_META_KEY = "newFingerprintCursorKey";

/** Fix round (C cross-note, PLAUSIBLE double/missed report): the cursor used
 *  to advance to `nowMs` — this rule's OWN wall-clock time at the start of
 *  a cron tick — but a fingerprint's `firstSeen` is stamped in the
 *  stateless route handler, independently of when its `InboxWriter` write
 *  actually commits (which is what makes it visible to this rule's
 *  `list()`-backed `newFingerprintsSince`). A write that committed AFTER
 *  this tick's list() call, but whose `firstSeen` was stamped before
 *  `nowMs`, would satisfy `firstSeen <= nextCursor` on every later tick —
 *  permanently missed, not merely delayed.
 *
 *  Lagging the advanced cursor by this margin closes that hole: the cursor
 *  never advances past a `firstSeen` that could still be "in flight" from
 *  an in-progress request. Every real write's DO transaction commits
 *  synchronously inside the SAME request that stamped `firstSeen`, before
 *  that request answers `2xx` — comfortably under this margin even under
 *  load, and this rule's own ten-minute cron cadence gives further headroom.
 *  The remaining trade-off is a bounded, self-correcting DOUBLE report for
 *  a fingerprint whose `firstSeen` lands inside the last `CURSOR_GRACE_MS`
 *  of one tick (reported that tick and, at most, once more the next tick,
 *  never a third time, never silently) — a much smaller cost than a
 *  permanently missed report.
 *
 *  This is a partial mitigation, not "a cursor on the commit order" (the
 *  finding's own suggested fix): the full fix keys `fp:` entries by a
 *  monotonic sequence assigned inside the same `InboxWriter` transaction
 *  that commits them (the way `pack.ts`'s row/seq counters already do),
 *  which needs a storage-schema change inside `inbox/writer.ts#ingest` —
 *  outside this fix round's file ownership (F2's territory). See the
 *  report. */
const CURSOR_GRACE_MS = 2 * 60 * 1000;

/** How many fingerprint names one Slack line lists before truncating (fix
 *  round A-C2: "cap how many names one Slack message lists" — an
 *  attacker's flood of forged-then-validated-away fingerprints, or simply a
 *  large legitimate batch, must not grow one Slack message without bound). */
const MAX_FINGERPRINTS_LISTED = 10;

// Re-review 2, NB1 (G1 regression): a millisecond that holds
// `NEW_FINGERPRINT_SCAN_LIMIT` (2,000) or more fingerprints stalled the old
// ms-only cursor FOREVER — `lastMs - 1` always re-equals the stored cursor,
// so the next tick re-reads the exact same truncated page and every later,
// real fingerprint is never seen again. The cursor is now a KEYSET cursor:
// it persists the exact `fpts:` storage key of the last entry it advanced
// past (`inbox-state.ts#NewFingerprintEntry.key`), and the next tick resumes
// strictly after that key (`newFingerprintsAfterKey`), never by millisecond
// alone. Because a keyset position is a specific row, not a timestamp
// bucket, 2,000+ entries sharing one ms no longer collapse to one
// unadvanceable point — each tick still advances by up to
// `NEW_FINGERPRINT_SCAN_LIMIT` rows even inside that single ms.
export async function newFingerprintRule(inboxWriter: InboxWriterApi, nowMs = Date.now()): Promise<RuleResult> {
  const cursorKeyRaw = await inboxWriter.getAlertMeta(NEW_FINGERPRINT_CURSOR_META_KEY);
  // A stored value from before this fix (a bare ms number, no `fpts:`
  // prefix) is not a valid keyset position — treat it the same as "no
  // cursor yet" rather than passing a bogus `start` to `list()`.
  const cursorKey = cursorKeyRaw && cursorKeyRaw.startsWith("fpts:") ? cursorKeyRaw : null;
  const fallbackSinceMs = nowMs - HOUR_MS; // first run: look back one hour
  const { entries, truncated } = await inboxWriter.newFingerprintsAfterKey(cursorKey, fallbackSinceMs);

  // Grace-lag semantics, unchanged from the ms-cursor design (see the
  // module-level `CURSOR_GRACE_MS` doc comment): every entry actually read
  // is reported this tick (`fresh`, below) regardless of how recent it is,
  // but the cursor only advances up to the last entry whose `firstSeenMs`
  // is at/under `nowMs - CURSOR_GRACE_MS`. Entries are read in ascending
  // key order (ms, then fingerprint — `fingerprintTimeIndexKey`'s shape),
  // so the last entry meeting that bound is exactly the right resume point.
  // A fingerprint inside the grace window is reported now and, at most,
  // once more next tick (bounded, self-correcting double report) — never
  // silently skipped, and — unlike the old ms cursor — this bound can never
  // make the cursor get stuck: it always advances to a REAL row it read,
  // never to a synthetic "ms - 1" value that could re-equal itself forever.
  const graceCutoffMs = nowMs - CURSOR_GRACE_MS;
  let advanceToKey: string | null = null;
  for (const entry of entries) {
    if (entry.firstSeenMs <= graceCutoffMs) advanceToKey = entry.key;
  }
  const nextCursorKey = advanceToKey ?? cursorKey;
  if (nextCursorKey !== null) {
    await inboxWriter.setAlertMeta(NEW_FINGERPRINT_CURSOR_META_KEY, nextCursorKey);
  }
  const fresh = entries.map((entry) => entry.name);
  const shown = fresh.slice(0, MAX_FINGERPRINTS_LISTED);
  const overflow = fresh.length - shown.length;
  // `truncated` means real, unread fingerprints may exist beyond what this
  // tick even counted — "+N more" (computed only from what WAS read) would
  // understate them, so say "or more" instead of a precise count.
  const overflowSuffix = truncated ? " (+ more, still catching up)" : overflow > 0 ? ` (+${overflow} more)` : "";
  return {
    rule: "new-fingerprint",
    firing: fresh.length > 0,
    detail: fresh.length > 0 ? `new fingerprint(s): ${shown.join(", ")}${overflowSuffix}` : "no new fingerprints",
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

// ---- fix round (I2): the alert-evaluation-itself-failed rule ---------------
//
// Not an ADR §F.3 signal — a synthetic rule `runAlerts` builds from the
// errors every OTHER rule in this file threw this tick, so an AE query
// failure (a malformed query, ClickHouse/AE unreachable) is never silent.
// Same fire-once/resolve-once machinery as every other rule (`notify.ts`),
// so it holds regardless of which cron handler calls `runAlerts` — post-
// merge, `index.ts`'s single `scheduled()` export, alongside T03's real
// backlog-wake handler.

export function alertEvalErrorRule(errors: Readonly<Record<string, string>>): RuleResult {
  const failing = Object.keys(errors);
  return {
    rule: "alert-eval-error",
    firing: failing.length > 0,
    detail: failing.length > 0
      ? `${failing.length} rule(s) failed to evaluate: ${failing.map((r) => `${r} (${errors[r]})`).join("; ")}`
      : "every rule evaluated cleanly",
  };
}

// ---- watchdog: the o11y stack itself stale (owned by o11y-watchdog.ts on --
// the API side; not part of runAlerts — listed here only for the doc index)

export type { Heartbeat };
