// ADR-0041 §F.3's o11y-worker-cron rules, plus the new-fingerprint rule
// (read straight from `InboxWriter`'s exact registry, never sampled data).
// Every rule returns a {@link RuleResult}; `notify.ts` applies the
// fire-once/resolve-once `alert:<rule>` transition and posts to Slack.
// Every AE-query rule takes an injectable `queryFn` so
// `pipeline/o11y-alerts.test.mjs` can drive it over a synchronous fake.

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

/** {@link countByGroup} split by a second column: outer key = `groupColumn`, inner key = `subColumn`. */
async function countByGroupPair(
  env: Env,
  metric: string,
  groupColumn: keyof typeof AE_COLUMNS,
  subColumn: keyof typeof AE_COLUMNS,
  windowMs: number,
  extraWhere = "",
  queryFn: AeQueryFn = runAeQuery,
): Promise<Map<string, Map<string, number>>> {
  const groupCol = col(groupColumn);
  const subCol = col(subColumn);
  const countCol = col("count");
  const sql =
    `SELECT ${groupCol} AS grp, ${subCol} AS sub, sum(_sample_interval * ${countCol}) AS c ` +
    `FROM runner_events WHERE index1 = '${metric}' ` +
    `AND timestamp >= now() - INTERVAL '${Math.round(windowMs / 1000)}' SECOND ${extraWhere} ` +
    `GROUP BY grp, sub`;
  const rows = await queryFn(env, sql);
  const out = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const grp = String(row.grp ?? "");
    const inner = out.get(grp) ?? new Map<string, number>();
    inner.set(String(row.sub ?? ""), Number(row.c ?? 0));
    out.set(grp, inner);
  }
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

/** The API's deliberate 503s (at-capacity, container-starting, chat/theme
 *  refusals) are excluded from the 5xx ratio by their own exact counts. The
 *  "still building" placeholder on these two route classes has no such count,
 *  so it is excluded by status: `api.request` carries a 5xx's exact status in
 *  `reason`, and only the 503 is dropped. A build-failed 500 there still counts. */
const FIVE_XX_STILL_BUILDING_ROUTE_CLASSES = ["d/:id", "embed/:id"];

export async function fiveXxRateRule(env: Env, queryFn: AeQueryFn = runAeQuery): Promise<RuleResult> {
  const windowMs = 15 * 60 * 1000;
  const routeClassCol = col("route_class");
  const outcomeCol = col("outcome");
  const reasonCol = col("reason");
  const stillBuildingRoutes = FIVE_XX_STILL_BUILDING_ROUTE_CLASSES.map((rc) => `'${rc}'`).join(", ");
  // `''` matches a point written before `reason` existed: a 5xx on these routes from then
  // was still-building, and without the fallback every deploy would page for one window.
  const stillBuildingWhere =
    `AND ${routeClassCol} IN (${stillBuildingRoutes}) AND ${outcomeCol} = '5xx' AND ${reasonCol} IN ('503', '')`;
  const [allCounts, stillBuilding, sessionOutcomes, chatOutcomes, themeOutcomes] = await Promise.all([
    countByOutcome(env, "api.request", windowMs, "", queryFn),
    countByOutcome(env, "api.request", windowMs, stillBuildingWhere, queryFn),
    countByOutcome(env, "session.start", windowMs, "", queryFn),
    countByOutcome(env, "chat.answer", windowMs, "", queryFn),
    countByOutcome(env, "theme.ai", windowMs, "", queryFn),
  ]);
  const stillBuildingCount = stillBuilding.get("5xx") ?? 0;
  const counts = new Map(allCounts);
  counts.set("5xx", Math.max(0, (counts.get("5xx") ?? 0) - stillBuildingCount));
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const fiveXx = counts.get("5xx") ?? 0;
  const deliberate =
    (sessionOutcomes.get("at_capacity") ?? 0) +
    (sessionOutcomes.get("container_starting") ?? 0) +
    (chatOutcomes.get("error") ?? 0) +
    (themeOutcomes.get("error") ?? 0);
  const adjustedFiveXx = Math.max(0, fiveXx - deliberate);
  const adjustedTotal = Math.max(0, total - deliberate);
  const pct = ratio(adjustedFiveXx, adjustedTotal) * 100;
  return {
    rule: "api-5xx-rate",
    firing: adjustedTotal > 0 && pct > 1,
    detail:
      `${pct.toFixed(2)}% 5xx over the last 15 min (${adjustedFiveXx}/${adjustedTotal}, threshold 1%, ` +
      `excludes at-capacity/container-starting/chat-theme-gateway refusals and still-building 503s)`,
  };
}

// ---- preview-ready rate: below 97% (tier 1) or 95% (tier 2) over 1h -------

const PREVIEW_READY_THRESHOLD_PCT: Record<string, number> = { "1": 97, "2": 95 };

/** Non-abandoned previews per tier per hour below which the tier is not evaluated, because one failure in two previews (50 %) says nothing about reliability. */
export const PREVIEW_READY_MIN_SAMPLES = 10;

export async function previewReadyRateRule(env: Env, queryFn: AeQueryFn = runAeQuery): Promise<RuleResult> {
  const tierCol = col("tier");
  const results: string[] = [];
  let anyFiring = false;
  for (const [tier, thresholdPct] of Object.entries(PREVIEW_READY_THRESHOLD_PCT)) {
    const counts = await countByOutcome(env, "preview.ready_ms", HOUR_MS, `AND ${tierCol} = '${tier}'`, queryFn);
    // `abandoned` (navigated away before the preview finished) is excluded
    // from both numerator and denominator — otherwise a burst of ordinary
    // navigation-aways would fire a false preview-reliability alert.
    const total = [...counts.entries()]
      .filter(([outcome]) => outcome !== "abandoned")
      .reduce((sum, [, c]) => sum + c, 0);
    const ready = counts.get("ready") ?? 0;
    if (total < PREVIEW_READY_MIN_SAMPLES) continue;
    const pct = ratio(ready, total) * 100;
    if (pct < thresholdPct) {
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

// ---- session-start p95: above 20s (window: 1h — the ADR text names the --
// threshold but not an evaluation window) -----------------------------------

/** Ready session starts in the window below which the p95 is not evaluated, because a p95 over a handful of starts is one slow start. */
export const SESSION_START_P95_MIN_SAMPLES = 20;

export async function sessionStartP95Rule(env: Env, queryFn: AeQueryFn = runAeQuery): Promise<RuleResult> {
  // p95 over `outcome = 'ready'` only — at_capacity/container_starting/
  // budget_denied refusals return almost instantly and would drag the
  // percentile down, masking a real slow-start problem during overload.
  const outcomeCol = col("outcome");
  const readyWhere = `AND ${outcomeCol} = 'ready'`;
  const [p95, byOutcome] = await Promise.all([
    weightedQuantile(env, "session.start", HOUR_MS, 0.95, readyWhere, queryFn),
    countByOutcome(env, "session.start", HOUR_MS, readyWhere, queryFn),
  ]);
  // Same metric, window and outcome filter as the quantile, so the count and the p95 describe one population.
  const readyStarts = byOutcome.get("ready") ?? 0;
  const enoughSamples = readyStarts >= SESSION_START_P95_MIN_SAMPLES;
  const firing = enoughSamples && p95 !== null && p95 > 20_000;
  return {
    rule: "session-start-p95",
    firing,
    detail: p95 === null
      ? "no ready session.start samples in the last hour"
      : !enoughSamples
        ? `${readyStarts} ready session.start(s) in the last hour, below the ${SESSION_START_P95_MIN_SAMPLES} needed to evaluate the p95`
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

// ---- compile-error rate per ht_major: doubling day over day (a floor of --
// 5 today-count avoids "doubling" noise on tiny counts like 0->1) -----------

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

// ---- snapshot builds failing: above 50% per framework over 30 min ---------
// The backstop for build failures `api-5xx-rate` no longer sees (a 422 for the demo's
// own input can still be a systemic break, contract §5). 10 failed builds: one author
// retrying a broken Save makes a handful, a framework-wide break reaches 10 at low traffic.

const SNAPSHOT_BUILD_WINDOW_MS = 30 * 60 * 1000;
const SNAPSHOT_BUILD_FAILED_PCT = 50;
const SNAPSHOT_BUILD_FAILED_FLOOR = 10;
/** Distinct demos the failures must span: one author retrying one broken demo is not a framework break. Points from before `demo_id` existed carry `''`, which counts as one demo, so a break straddling the deploy stays silent for at most one window. */
const SNAPSHOT_BUILD_FAILED_MIN_DEMOS = 3;

export async function snapshotBuildFailedRateRule(env: Env, queryFn: AeQueryFn = runAeQuery): Promise<RuleResult> {
  const outcomeCol = col("outcome");
  const [total, failedByDemo] = await Promise.all([
    countByGroup(env, "snapshot.build", "framework", SNAPSHOT_BUILD_WINDOW_MS, "", queryFn),
    countByGroupPair(env, "snapshot.build", "framework", "demo_id", SNAPSHOT_BUILD_WINDOW_MS, `AND ${outcomeCol} = 'failed'`, queryFn),
  ]);
  const failed = new Map<string, { count: number; demos: number }>();
  for (const [framework, demos] of failedByDemo) {
    let count = 0;
    for (const c of demos.values()) count += c;
    failed.set(framework, { count, demos: demos.size });
  }
  const offenders: string[] = [];
  for (const [framework, { count: failedCount, demos }] of failed) {
    if (failedCount < SNAPSHOT_BUILD_FAILED_FLOOR || demos < SNAPSHOT_BUILD_FAILED_MIN_DEMOS) continue;
    const builds = total.get(framework) ?? failedCount;
    const pct = ratio(failedCount, builds) * 100;
    if (pct > SNAPSHOT_BUILD_FAILED_PCT) {
      offenders.push(`${framework || "unknown"}: ${pct.toFixed(0)}% failed (${failedCount}/${builds}, ${demos} demos)`);
    }
  }
  return {
    rule: "snapshot-build-failed-rate",
    firing: offenders.length > 0,
    detail:
      offenders.length > 0
        ? `${offenders.join("; ")} over the last 30 min (threshold ${SNAPSHOT_BUILD_FAILED_PCT}%, at least ${SNAPSHOT_BUILD_FAILED_FLOOR} failed across ${SNAPSHOT_BUILD_FAILED_MIN_DEMOS}+ demos)`
        : "no framework over threshold",
  };
}

// ---- LiteLLM errors: above 5% (chat.answer + theme.ai, both gateway -------
// call sites; window: 1h, same reasoning as session-start) ------------------

export async function litellmErrorRateRule(env: Env, queryFn: AeQueryFn = runAeQuery): Promise<RuleResult> {
  const windowMs = HOUR_MS;
  const [chat, theme] = await Promise.all([
    countByOutcome(env, "chat.answer", windowMs, "", queryFn),
    countByOutcome(env, "theme.ai", windowMs, "", queryFn),
  ]);
  // `denied` (a rate-limit/budget refusal before reaching LiteLLM) is
  // excluded — otherwise a burst of denials would shrink the ratio and
  // could hide a real >5% gateway failure rate.
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

/** `rejected:` `key:` entries are never pruned, so a plain "count > 0"
 *  firing condition would never resolve. Fire on RECENT rejection events
 *  instead (`rejectedEvent:`), which resolve once none are recent. */
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
// Detection only: `index.ts` charts `fresh` on the Observability self dashboard and
// posts nothing to Slack.

export interface NewFingerprintResult extends RuleResult {
  /** Fingerprints first announced by this tick, in registry order. */
  fresh: string[];
}

const NEW_FINGERPRINT_CURSOR_META_KEY = "newFingerprintCursorKey";
/** JSON array of the `fpts:` keys already announced that may still be past
 *  the cursor, i.e. the entries inside the grace window that the next tick
 *  reads again (see {@link CURSOR_GRACE_MS}). */
const NEW_FINGERPRINT_ANNOUNCED_META_KEY = "newFingerprintAnnouncedKeys";

/** A missing or unreadable value means nothing past the cursor has been
 *  announced yet. That can cost one extra announcement, never a missed one. */
function parseAnnouncedKeys(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((k): k is string => typeof k === "string" && k.startsWith("fpts:")));
  } catch {
    return new Set();
  }
}

/** A fingerprint's `firstSeen` is stamped before its `InboxWriter` write
 *  commits, so advancing the cursor straight to `nowMs` could skip a write
 *  that commits just after this tick's read — permanently missed, not
 *  merely delayed. Lagging the cursor by this margin means it never passes
 *  a `firstSeen` that could still be in flight; real writes commit well
 *  under this margin. A fingerprint inside the lag window is re-read next
 *  tick, so {@link NEW_FINGERPRINT_ANNOUNCED_META_KEY} tracks what was
 *  already announced. Not a full fix: that needs a monotonic sequence
 *  inside the ingest transaction itself. */
const CURSOR_GRACE_MS = 2 * 60 * 1000;

/** How many fingerprint names the result detail lists before truncating, so a flood cannot grow it without bound. */
const MAX_FINGERPRINTS_LISTED = 10;

// A millisecond holding 2,000+ fingerprints would stall an ms-only cursor
// forever (`lastMs - 1` always re-equals itself). The cursor is a KEYSET
// cursor instead: it persists the exact `fpts:` key it advanced past and
// resumes strictly after it, so a shared millisecond can't collapse to one
// unadvanceable point.
export async function newFingerprintRule(
  inboxWriter: InboxWriterApi,
  nowMs = Date.now(),
  publish: (fresh: string[]) => Promise<unknown> = async () => {},
): Promise<NewFingerprintResult> {
  const cursorKeyRaw = await inboxWriter.getAlertMeta(NEW_FINGERPRINT_CURSOR_META_KEY);
  // A bare ms number, with no `fpts:` prefix, is not a valid keyset
  // position — treat it the same as "no cursor yet" rather than passing a
  // bogus `start` to `list()`.
  const cursorKey = cursorKeyRaw && cursorKeyRaw.startsWith("fpts:") ? cursorKeyRaw : null;
  const fallbackSinceMs = nowMs - HOUR_MS; // first run: look back one hour
  const { entries, truncated } = await inboxWriter.newFingerprintsAfterKey(cursorKey, fallbackSinceMs);

  // Every entry not yet announced is reported this tick regardless of how
  // recent it is, but the cursor only advances up to the last entry whose
  // `firstSeenMs` is at/under the grace cutoff — never to a synthetic value
  // that could get stuck, always to a real row it read.
  const graceCutoffMs = nowMs - CURSOR_GRACE_MS;
  let advanceToKey: string | null = null;
  for (const entry of entries) {
    if (entry.firstSeenMs <= graceCutoffMs) advanceToKey = entry.key;
  }
  const nextCursorKey = advanceToKey ?? cursorKey;

  // The grace lag re-reads every entry inside the window on the next tick,
  // which would otherwise announce it a second time. Skip the keys an
  // earlier tick already announced.
  const announced = parseAnnouncedKeys(await inboxWriter.getAlertMeta(NEW_FINGERPRINT_ANNOUNCED_META_KEY));
  const unannounced = entries.filter((entry) => !announced.has(entry.key));

  // The point is the announcement, so it is written before any state records the
  // fingerprint as announced: if `publish` throws, nothing is saved and the next
  // tick re-reads and re-announces it.
  const fresh = unannounced.map((entry) => entry.name);
  if (fresh.length > 0) await publish(fresh);

  // Write order matters (two separate RPCs): the announced set is written
  // first, so a failed cursor write still finds these keys already
  // announced on the next tick's re-read from the old cursor.
  const keep = new Set<string>();
  for (const key of [...announced, ...entries.map((entry) => entry.key)]) {
    if (cursorKey === null || key > cursorKey) keep.add(key);
  }
  await inboxWriter.setAlertMeta(NEW_FINGERPRINT_ANNOUNCED_META_KEY, JSON.stringify([...keep]));
  if (nextCursorKey !== null) {
    await inboxWriter.setAlertMeta(NEW_FINGERPRINT_CURSOR_META_KEY, nextCursorKey);
  }
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
    fresh,
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

// ---- the alert-evaluation-itself-failed rule -------------------------------
//
// Not an ADR §F.3 signal — a synthetic rule `runAlerts` builds from every
// other rule's errors this tick, so a query failure is never silent. Same
// fire-once/resolve-once machinery as every other rule (`notify.ts`).

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
