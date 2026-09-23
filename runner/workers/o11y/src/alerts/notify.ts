// ADR-0041 §F.3: "a rule notifies once when it fires and once when it
// resolves, never on every tick." State lives in `InboxWriter` (`alert:<rule>`,
// contract §8); the channel is Slack, one line per transition. Also writes
// the `o11y.alert` Analytics Engine point (contract §5: reason = rule id,
// outcome `fired`/`resolved`) so the Observability-self dashboard's existing
// "o11y.alert fired/resolved" panel (T09) has something to show.

import type { AePoint, AeSink, CommonResourceAttrs } from "@handsontable/demo-runtime/telemetry";
import { toAePoint } from "@handsontable/demo-runtime/telemetry";
import type { InboxWriterApi } from "../env.js";
import type { RuleResult } from "./rules.js";

export interface PostSlack {
  (text: string): Promise<void>;
}

/** `SLACK_WEBHOOK_URL`-backed poster, or a no-op when it is unset (never
 *  throws — a missing webhook must not turn an alert evaluation into a
 *  cron-step failure). */
export function slackPoster(webhookUrl: string | undefined, fetchImpl: typeof fetch = fetch): PostSlack {
  if (!webhookUrl) {
    return async () => {
      /* no webhook configured (e.g. wrangler dev without .dev.vars) */
    };
  }
  return async (text: string) => {
    try {
      await fetchImpl(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
    } catch {
      // Best-effort — a Slack hiccup must not fail the alert tick, the same
      // rule `emitPoint`'s own catch documents for Analytics Engine writes.
    }
  };
}

/**
 * Slack's own mrkdwn escaping rule, applied to every value this module
 * interpolates into a Slack `text` field (fix round, finding A-C2): `&`
 * first, then `<`/`>` — every rule's `detail` is built at least partly from
 * data an unauthenticated client can influence (an AE query result grouped
 * by a client-tagged column, or — the confirmed case — the exact
 * first-seen fingerprint registry, which stored a client-supplied string
 * verbatim before the companion fix in `normalise/faro.ts`). Without this,
 * `<!channel>` and a masked `<https://evil|link>` post as live Slack markup
 * under the team's own alert bot.
 */
export function escapeSlackMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface NotifyDeps {
  inboxWriter: InboxWriterApi;
  postSlack: PostSlack;
  aeSink: AeSink;
  /** blob1–3 (contract §3) for the `o11y.alert` point this module writes —
   *  the caller's own resource attrs, never hardcoded here. */
  commonAttrs: CommonResourceAttrs;
  nowMs?: number;
}

/**
 * Applies the fire-once/resolve-once transition for one rule's result.
 * Returns the transition that happened (`"fired"` / `"resolved"` /
 * `undefined` for no change) so a caller (a test, `runAlerts`'s own
 * summary) can assert on it without re-reading `InboxWriter` state.
 */
export async function evaluateAndNotify(
  result: RuleResult,
  deps: NotifyDeps,
): Promise<"fired" | "resolved" | undefined> {
  const now = deps.nowMs ?? Date.now();
  const prev = await deps.inboxWriter.alertState(result.rule);
  const wasFiring = prev?.state === "firing";

  if (result.firing && !wasFiring) {
    await deps.inboxWriter.setAlertState(result.rule, { state: "firing", since: now, lastNotified: now });
    await deps.postSlack(
      `:rotating_light: [o11y] *${escapeSlackMrkdwn(result.rule)}* firing — ${escapeSlackMrkdwn(result.detail)}`,
    );
    writeAlertPoint(deps.aeSink, deps.commonAttrs, result.rule, "fired");
    return "fired";
  }
  if (!result.firing && wasFiring) {
    await deps.inboxWriter.setAlertState(result.rule, { state: "resolved", since: now, lastNotified: now });
    await deps.postSlack(`:white_check_mark: [o11y] *${escapeSlackMrkdwn(result.rule)}* resolved`);
    writeAlertPoint(deps.aeSink, deps.commonAttrs, result.rule, "resolved");
    return "resolved";
  }
  return undefined;
}

/**
 * Fix round (C cross-note): new-fingerprint is not a fire/resolve alert —
 * it reports a stream of individual events (one Slack line per batch of
 * genuinely new fingerprints), not a stateful condition. Forcing it through
 * {@link evaluateAndNotify}'s fire-once/resolve-once machinery caused two
 * bugs at once: while the synthetic "firing" state stayed set, a second
 * batch of new fingerprints arriving before the cursor caught up produced
 * NO notification at all (fire-once masking real new errors behind a
 * sustained stream); and the very next clean tick then posted a pointless
 * "resolved" line for a rule that was never a condition to resolve.
 * Notifies unconditionally when `rules.ts#newFingerprintRule` found
 * something new — that rule's own cursor is what makes repeat calls
 * idempotent, not stored fire/resolve state (there is none here). Writes
 * the same `o11y.alert` `outcome: "fired"` point every other rule does, so
 * the existing dashboard panel still has something to show; never writes
 * `"resolved"` — there is no matching transition for an event stream.
 */
export async function notifyFingerprintEvent(
  postSlack: PostSlack,
  aeSink: AeSink,
  commonAttrs: CommonResourceAttrs,
  rule: string,
  detail: string,
): Promise<void> {
  await postSlack(`:rotating_light: [o11y] *${escapeSlackMrkdwn(rule)}* — ${escapeSlackMrkdwn(detail)}`);
  writeAlertPoint(aeSink, commonAttrs, rule, "fired");
}

function writeAlertPoint(
  sink: AeSink,
  commonAttrs: CommonResourceAttrs,
  rule: string,
  outcome: "fired" | "resolved",
): void {
  try {
    const point: AePoint = toAePoint("o11y.alert", { count: 1 }, { ...commonAttrs, reason: rule, outcome });
    // Fix round (I1 test run): `writeDataPoint` can return a REJECTED
    // promise (`clickhouseSink`'s HTTP write, unreachable local ClickHouse)
    // — `void`-ing it alone only silences a lint warning, it does not catch
    // the rejection, which then surfaces later as an unhandled rejection
    // (measured: `node --test` failed the whole file over exactly this,
    // once a test pointed `RUNNER_EVENTS_CLICKHOUSE_URL` at a refused
    // port). `Promise.resolve(...).catch()` handles both the synchronous
    // `void` case (`bindingSink`, the real AE binding) and the async one.
    Promise.resolve(sink.writeDataPoint(point)).catch(() => {
      // Never let a point failure block the notification it describes.
    });
  } catch {
    // A synchronous throw from `toAePoint` itself (an out-of-enum
    // outcome/reason — see `metrics.ts#toAePoint`'s own doc comment).
  }
}
