// ADR-0041 §F.3's alert entry of the o11y worker's `*/10` cron —
// `runAlerts(env, ctx)`, exported for T03's real cron handler to call
// (COMMON.md controller note: "Wire it into the scheduled handler
// minimally... When you merge the feature branch at the end, call
// `runAlerts` from T03's handler and remove yours"). This task's own
// `scheduled()` placeholder in `index.ts` calls it directly until then.

import { bindingSink, clickhouseSink, type AeSink, type CommonResourceAttrs } from "@handsontable/demo-runtime/telemetry";
import type { Env } from "../env.js";
import { inboxWriter } from "../inbox/accessor.js";
import { readO11ySpend } from "../cost.js";
import { evaluateAndNotify, slackPoster } from "./notify.js";
import {
  atCapacityRule,
  backlogAgeRule,
  compileErrorDoublingRule,
  embedErrorRateRule,
  fiveXxRateRule,
  litellmErrorRateRule,
  newFingerprintRule,
  o11yCapRule,
  previewReadyRateRule,
  rejectedKeyRule,
  sessionStartP95Rule,
  type RuleResult,
} from "./rules.js";

function commonAttrs(env: Env): CommonResourceAttrs {
  return {
    service_name: "demos-o11y",
    service_version: env.SERVICE_VERSION || "dev",
    environment: env.O11Y_ENV,
  };
}

function aeSink(env: Env): AeSink {
  if (env.O11Y_ENV === "production") {
    if (!env.RUNNER_EVENTS) return { writeDataPoint() {} };
    return bindingSink(env.RUNNER_EVENTS);
  }
  return clickhouseSink(env.RUNNER_EVENTS_CLICKHOUSE_URL || "http://localhost:8123", {
    user: "default",
    password: env.AE_SQL_TOKEN,
  });
}

export interface RunAlertsResult {
  results: RuleResult[];
  transitions: Record<string, "fired" | "resolved">;
  /** Non-fatal errors from individual rule evaluations — one bad rule (a
   *  malformed query, an unreachable dependency) must never stop the rest
   *  from being evaluated, the same isolation `cronStep` gives the API
   *  worker's cron branches. */
  errors: Record<string, string>;
}

type RuleFn = (env: Env) => Promise<RuleResult>;

/** Runs every ADR §F.3 rule this task owns, notifies on any fire/resolve
 *  transition, and — for the o11y spend cap specifically — pauses/resumes
 *  backlog drains. Never throws: a single bad rule is caught and recorded
 *  in the returned `errors` map instead of aborting the rest. */
export async function runAlerts(env: Env, _ctx?: ExecutionContext): Promise<RunAlertsResult> {
  const writer = inboxWriter(env);
  const sink = aeSink(env);
  const postSlack = slackPoster(env.SLACK_WEBHOOK_URL);
  const attrs = commonAttrs(env);
  const nowMs = Date.now();

  const results: RuleResult[] = [];
  const transitions: Record<string, "fired" | "resolved"> = {};
  const errors: Record<string, string> = {};

  const queryRules: RuleFn[] = [
    atCapacityRule,
    fiveXxRateRule,
    previewReadyRateRule,
    sessionStartP95Rule,
    embedErrorRateRule,
    compileErrorDoublingRule,
    litellmErrorRateRule,
  ];

  for (const rule of queryRules) {
    try {
      const result = await rule(env);
      results.push(result);
      const transition = await evaluateAndNotify(result, { inboxWriter: writer, postSlack, aeSink: sink, commonAttrs: attrs, nowMs });
      if (transition) transitions[result.rule] = transition;
    } catch (err) {
      errors[rule.name] = err instanceof Error ? err.message : String(err);
    }
  }

  // InboxWriter-only rules (no Analytics Engine query).
  try {
    const result = await backlogAgeRule(writer);
    results.push(result);
    const transition = await evaluateAndNotify(result, { inboxWriter: writer, postSlack, aeSink: sink, commonAttrs: attrs, nowMs });
    if (transition) transitions[result.rule] = transition;
  } catch (err) {
    errors["backlog-age"] = err instanceof Error ? err.message : String(err);
  }

  try {
    const result = await rejectedKeyRule(writer);
    results.push(result);
    const transition = await evaluateAndNotify(result, { inboxWriter: writer, postSlack, aeSink: sink, commonAttrs: attrs, nowMs });
    if (transition) transitions[result.rule] = transition;
  } catch (err) {
    errors["rejected-inbox-key"] = err instanceof Error ? err.message : String(err);
  }

  try {
    const result = await newFingerprintRule(writer, nowMs);
    results.push(result);
    const transition = await evaluateAndNotify(result, { inboxWriter: writer, postSlack, aeSink: sink, commonAttrs: attrs, nowMs });
    if (transition) transitions[result.rule] = transition;
  } catch (err) {
    errors["new-fingerprint"] = err instanceof Error ? err.message : String(err);
  }

  // The o11y spend cap — the one rule that also drives `drainsPaused`
  // (ADR §G), on top of the ordinary fire/resolve notify.
  try {
    const spend = await readO11ySpend(env);
    const result = await o11yCapRule(spend);
    results.push(result);
    const transition = await evaluateAndNotify(result, { inboxWriter: writer, postSlack, aeSink: sink, commonAttrs: attrs, nowMs });
    if (transition) transitions[result.rule] = transition;
    if (transition === "fired") await writer.setDrainsPaused(true);
    if (transition === "resolved") await writer.setDrainsPaused(false);
  } catch (err) {
    errors["o11y-spend-cap"] = err instanceof Error ? err.message : String(err);
  }

  return { results, transitions, errors };
}

/**
 * T03 handoff: the backlog-wake decision should refuse a *backlog* wake
 * while `drainsPaused` is set (ADR §G: "drains pause, visit wakes still
 * work"). Exported ready for T03's wake path to call after the merge —
 * not called from anywhere in this task's own code, since T04 does not own
 * the wake decision. A Grafana-visit wake must NOT call this — it is
 * unaffected by the cap by design.
 */
export async function canWakeForBacklog(env: Env): Promise<boolean> {
  return !(await inboxWriter(env).drainsPaused());
}
