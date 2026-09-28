// ADR-0041 §F.3's alert entry of the o11y worker's `*/10` cron —
// `runAlerts(env, ctx)`. `index.ts`'s single `scheduled()` export calls
// this alongside the real backlog-wake handler (`handleScheduled`).

import { bindingSink, clickhouseSink, type AeSink, type CommonResourceAttrs } from "@handsontable/demo-runtime/telemetry";
import type { Env } from "../env.js";
import { inboxWriter } from "../inbox/accessor.js";
import { readO11ySpend } from "../cost.js";
import { evaluateAndNotify, notifyFingerprintEvent, slackPoster } from "./notify.js";
import {
  alertEvalErrorRule,
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
  snapshotBuildFailedRateRule,
  type RuleResult,
} from "./rules.js";

/** `InboxWriter.alertMeta` key for the LAST failing detail
 *  `alertEvalErrorRule` saw while firing — persisted on top of the Slack
 *  "firing" line, which already names the failing rule id(s). */
export const ALERT_EVAL_ERROR_DETAIL_KEY = "alertEvalErrorDetail";

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
  /** Non-fatal errors from individual rule evaluations — one bad rule must
   *  never stop the rest from being evaluated. */
  errors: Record<string, string>;
}

type RuleFn = (env: Env) => Promise<RuleResult>;

/** `id` matches the exact `RuleResult.rule` string the function returns,
 *  not the JS function name, so a failing rule's error and its ordinary
 *  fire/resolve messages name it the same way. */
const QUERY_RULES: { id: string; fn: RuleFn }[] = [
  { id: "at-capacity-rate", fn: atCapacityRule },
  { id: "api-5xx-rate", fn: fiveXxRateRule },
  { id: "preview-ready-rate", fn: previewReadyRateRule },
  { id: "session-start-p95", fn: sessionStartP95Rule },
  { id: "embed-error-rate", fn: embedErrorRateRule },
  { id: "compile-error-doubling", fn: compileErrorDoublingRule },
  { id: "litellm-error-rate", fn: litellmErrorRateRule },
  { id: "snapshot-build-failed-rate", fn: snapshotBuildFailedRateRule },
];

/** Runs every ADR §F.3 rule, notifies on any fire/resolve transition, and
 *  — for the o11y spend cap — pauses/resumes backlog drains. Never
 *  throws: a bad rule is caught into the returned `errors` map. The
 *  synthetic `alert-eval-error` rule is evaluated last, over exactly the
 *  errors this run collected, through the same fire-once machinery every
 *  other rule uses — so it holds regardless of which cron handler calls
 *  this. */
export async function runAlerts(env: Env, _ctx?: ExecutionContext): Promise<RunAlertsResult> {
  const writer = inboxWriter(env);
  const sink = aeSink(env);
  const postSlack = slackPoster(env.SLACK_WEBHOOK_URL);
  const attrs = commonAttrs(env);
  const nowMs = Date.now();

  const results: RuleResult[] = [];
  const transitions: Record<string, "fired" | "resolved"> = {};
  const errors: Record<string, string> = {};

  for (const { id, fn } of QUERY_RULES) {
    try {
      const result = await fn(env);
      results.push(result);
      const transition = await evaluateAndNotify(result, { inboxWriter: writer, postSlack, aeSink: sink, commonAttrs: attrs, nowMs });
      if (transition) transitions[result.rule] = transition;
    } catch (err) {
      errors[id] = err instanceof Error ? err.message : String(err);
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

  // new-fingerprint is notify-only, not fire/resolve (see
  // `notify.ts#notifyFingerprintEvent`) — never contributes a
  // `transitions` entry.
  try {
    const result = await newFingerprintRule(writer, nowMs);
    results.push(result);
    if (result.firing) {
      await notifyFingerprintEvent(writer, postSlack, sink, attrs, result.rule, result.detail, nowMs);
    }
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
    // LEVEL-triggered, not edge-triggered — set from `result.firing` on
    // EVERY tick, not just a transition. An edge-triggered write could
    // leave drains paused forever if `setDrainsPaused` itself threw right
    // after firing (the throw lands in `errors`, and the alert state
    // already recorded `firing`, so no later transition would retry it).
    // Unconditional means every tick re-derives and re-applies the
    // correct state, self-correcting after any transient RPC failure.
    await writer.setDrainsPaused(result.firing);
  } catch (err) {
    errors["o11y-spend-cap"] = err instanceof Error ? err.message : String(err);
  }

  // Surface accumulated rule-evaluation failures through the same
  // fire-once machinery, last, after every other rule has had its chance
  // to add to `errors`. Not wrapped in try/catch: a failure here should
  // surface loudly, not swallow a second time.
  const evalErrorResult = alertEvalErrorRule(errors);
  results.push(evalErrorResult);
  // Persisted independent of Slack (a no-op with no `SLACK_WEBHOOK_URL`
  // would otherwise make this untraceable): the Slack line is the only
  // place the failing rule id(s) ever go. Written on every FIRING tick,
  // never cleared on resolve, so a later read still shows what was last
  // wrong.
  if (evalErrorResult.firing) {
    try {
      await writer.setAlertMeta(
        ALERT_EVAL_ERROR_DETAIL_KEY,
        JSON.stringify({ detail: evalErrorResult.detail, failingRules: Object.keys(errors), updatedAtMs: nowMs }),
      );
    } catch (err) {
      // Best-effort, like every other alertMeta write in this module — must
      // never block the fire-once notification below.
      console.error(JSON.stringify({ event: "o11y.alert.eval_error_detail_persist_failed", message: String(err) }));
    }
  }
  const evalErrorTransition = await evaluateAndNotify(evalErrorResult, {
    inboxWriter: writer,
    postSlack,
    aeSink: sink,
    commonAttrs: attrs,
    nowMs,
  });
  if (evalErrorTransition) transitions[evalErrorResult.rule] = evalErrorTransition;

  return { results, transitions, errors };
}

/**
 * The backlog-wake decision should refuse a *backlog* wake while
 * `drainsPaused` is set (ADR §G: "drains pause, visit wakes still work").
 * A Grafana-visit wake must NOT call this — it is unaffected by the cap by
 * design.
 */
export async function canWakeForBacklog(env: Env): Promise<boolean> {
  return !(await inboxWriter(env).drainsPaused());
}
