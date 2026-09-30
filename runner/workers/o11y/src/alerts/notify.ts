// ADR-0041 §F.3: "a rule notifies once when it fires and once when it
// resolves, never on every tick." State lives in `InboxWriter` (`alert:<rule>`,
// contract §8); the channel is Slack, one line per transition. Also writes
// the `o11y.alert` Analytics Engine point (contract §5: reason = rule id,
// outcome `fired`/`resolved`) so the Observability-self dashboard's existing
// "o11y.alert fired/resolved" panel has something to show.

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
 * Slack's own mrkdwn escaping rule: `&` first, then `<`/`>` — every rule's
 * `detail` is built at least partly from data an unauthenticated client
 * can influence. Without this, `<!channel>` and a masked link post as
 * live Slack markup under the team's own alert bot.
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

/** Analytics Engine allows 250 data points per Worker invocation; 100 leaves room for the tick's other points. */
export const MAX_NEW_FINGERPRINT_POINTS_PER_TICK = 100;

/**
 * new-fingerprint is a dashboard signal, not a page: one `o11y.new_fingerprint`
 * point per fingerprint the registry saw for the first time, charted by the
 * Observability self "new handled-error fingerprints" panel. Returns how many
 * were written; the rest of a flood stays in the registry and is not charted.
 */
export function writeNewFingerprintPoints(
  sink: AeSink,
  commonAttrs: CommonResourceAttrs,
  fingerprints: readonly string[],
): number {
  let written = 0;
  for (const fingerprint of fingerprints.slice(0, MAX_NEW_FINGERPRINT_POINTS_PER_TICK)) {
    try {
      const point: AePoint = toAePoint("o11y.new_fingerprint", { count: 1 }, { ...commonAttrs, fingerprint });
      Promise.resolve(sink.writeDataPoint(point)).catch(() => {
        // A failed chart point must not fail the alert tick.
      });
      written += 1;
    } catch {
      // toAePoint rejects a value outside the contract; skip that one fingerprint.
    }
  }
  return written;
}

function writeAlertPoint(
  sink: AeSink,
  commonAttrs: CommonResourceAttrs,
  rule: string,
  outcome: "fired" | "resolved",
): void {
  try {
    const point: AePoint = toAePoint("o11y.alert", { count: 1 }, { ...commonAttrs, reason: rule, outcome });
    // `writeDataPoint` can return a REJECTED promise — `void`-ing it alone
    // doesn't catch it (measured: an unhandled rejection failed the whole
    // test file once). `Promise.resolve(...).catch()` handles both the
    // sync and async cases.
    Promise.resolve(sink.writeDataPoint(point)).catch(() => {
      // Never let a point failure block the notification it describes.
    });
  } catch {
    // A synchronous throw from `toAePoint` itself (an out-of-enum
    // outcome/reason — see `metrics.ts#toAePoint`'s own doc comment).
  }
}
