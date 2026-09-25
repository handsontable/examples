// ADR-0041 §F.3's alert entry of the o11y worker's `*/10` cron —
// `runAlerts(env, ctx)`. Post-merge, `index.ts`'s single `scheduled()`
// export calls this alongside T03's real backlog-wake handler
// (`handleScheduled`), per COMMON.md's "call `runAlerts` from T03's
// handler" instruction.

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
  type RuleResult,
} from "./rules.js";

/** QA follow-up ("alert-eval-error names the failing rule"): `InboxWriter.alertMeta` key for the LAST failing
 *  detail `alertEvalErrorRule` saw while firing — see the write site's own
 *  doc comment below for why this exists on top of the Slack "firing" line,
 *  which already names the failing rule id(s) in `result.detail`. */
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
  /** Non-fatal errors from individual rule evaluations — one bad rule (a
   *  malformed query, an unreachable dependency) must never stop the rest
   *  from being evaluated, the same isolation `cronStep` gives the API
   *  worker's cron branches. */
  errors: Record<string, string>;
}

type RuleFn = (env: Env) => Promise<RuleResult>;

/** `id` matches the exact `RuleResult.rule` string the function itself
 *  returns (fix round I2 — before this, the error map was keyed by the JS
 *  function name, e.g. `atCapacityRule`, which never matched the rule id a
 *  Slack line or `alert:<rule>` state uses, e.g. `at-capacity-rate`; a
 *  failing rule's error and its ordinary fire/resolve messages named it
 *  two different ways). */
const QUERY_RULES: { id: string; fn: RuleFn }[] = [
  { id: "at-capacity-rate", fn: atCapacityRule },
  { id: "api-5xx-rate", fn: fiveXxRateRule },
  { id: "preview-ready-rate", fn: previewReadyRateRule },
  { id: "session-start-p95", fn: sessionStartP95Rule },
  { id: "embed-error-rate", fn: embedErrorRateRule },
  { id: "compile-error-doubling", fn: compileErrorDoublingRule },
  { id: "litellm-error-rate", fn: litellmErrorRateRule },
];

/** Runs every ADR §F.3 rule this task owns, notifies on any fire/resolve
 *  transition, and — for the o11y spend cap specifically — pauses/resumes
 *  backlog drains. Never throws: a single bad rule is caught and recorded
 *  in the returned `errors` map instead of aborting the rest.
 *
 *  Fix round (I2): a query/dependency failure is no longer silent past the
 *  returned `errors` map — the synthetic `alert-eval-error` rule
 *  (`rules.ts#alertEvalErrorRule`) is evaluated last, over exactly the
 *  errors this run collected, through the SAME fire-once/resolve-once
 *  `evaluateAndNotify` every other rule uses. This lives inside
 *  `runAlerts` itself (not the caller), so it holds regardless of which
 *  cron handler calls this function — post-merge, `index.ts`'s single
 *  `scheduled()` export, alongside T03's real backlog-wake handler. */
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

  // Fix round (C cross-note): new-fingerprint is notify-only, not a
  // fire/resolve alert (see `notify.ts#notifyFingerprintEvent`'s own doc
  // comment for why) — deliberately NOT `evaluateAndNotify`, and it writes
  // no `alert:<rule>` state at all, so it never contributes a `transitions`
  // entry.
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
    // Minor triage item 7: LEVEL-triggered, not edge-triggered — set from
    // `result.firing` on EVERY tick, not only on a `fired`/`resolved`
    // transition. The previous edge-triggered version only ever called
    // `setDrainsPaused` on the tick the rule's own state actually flipped —
    // if that one `setDrainsPaused` RPC threw right after the rule fired
    // (already inside this same `try`, so the throw lands in `errors` below
    // and the NEXT tick's `evaluateAndNotify` sees no transition at all,
    // because the alert state itself already recorded `firing`), drains
    // stayed paused (or unpaused) for the rest of the month with no retry —
    // nothing ever asked it to converge again. Calling it unconditionally
    // makes every tick self-correcting: a transient RPC failure here just
    // means the CURRENT tick's `errors` entry surfaces it (same as any
    // other rule failure), and the very next tick re-derives and re-applies
    // the correct paused state from `result.firing`, no transition needed.
    await writer.setDrainsPaused(result.firing);
  } catch (err) {
    errors["o11y-spend-cap"] = err instanceof Error ? err.message : String(err);
  }

  // Fix round (I2): surface accumulated rule-evaluation failures through
  // the same fire-once/resolve-once machinery, last — after every other
  // rule has had its chance to run and add to (or, on a clean tick, not
  // add to) `errors`. Deliberately NOT wrapped in its own try/catch: a
  // failure building/notifying this one is exactly the kind of problem a
  // cron log line should surface loudly, not swallow a second time.
  const evalErrorResult = alertEvalErrorRule(errors);
  results.push(evalErrorResult);
  // QA follow-up ("alert-eval-error names the failing rule"): persisted independent of Slack, whose poster is a
  // silent no-op with no `SLACK_WEBHOOK_URL` (exactly the local-dev shape
  // that made a real "alert-eval-error firing" tick during the F13 recovery
  // untraceable — fire-once means the Slack line is the ONLY place
  // `result.detail`'s failing rule id(s) ever go, and a post nobody
  // received left nothing else naming them). Written on every tick this
  // rule is FIRING, not only a transition tick, so it keeps reflecting the
  // most recent failing set if which rule fails changes mid-incident, and
  // it is never cleared on resolve — a later read still shows what was last
  // wrong, the same way `getAlertMeta`/`setAlertMeta` already persist the
  // new-fingerprint rate-cap window (`notify.ts#notifyFingerprintEvent`)
  // across ticks.
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
