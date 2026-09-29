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

/**
 * new-fingerprint reports a stream of individual events, not a stateful
 * condition — forcing it through {@link evaluateAndNotify}'s fire-once
 * machinery would mask a second batch arriving before the cursor caught
 * up. Notifies unconditionally when new; never writes "resolved". Rate-
 * caps ITS OWN posts: at most {@link MAX_FINGERPRINT_POSTS_PER_WINDOW}
 * lines per {@link FINGERPRINT_POST_WINDOW_MS}, then one summary line.
 */
const FINGERPRINT_POST_WINDOW_MS = 60 * 60 * 1000;
const MAX_FINGERPRINT_POSTS_PER_WINDOW = 20;
const FINGERPRINT_POST_WINDOW_META_KEY = "newFingerprintPostWindow";

interface FingerprintPostWindowState {
  windowStart: number;
  /** Individual detail lines posted so far this window. */
  posted: number;
  /** Firing calls suppressed (not individually posted) so far this window. */
  suppressed: number;
  /** Whether the one summary line for this window has already gone out. */
  summarized: boolean;
}

function freshFingerprintPostWindow(nowMs: number): FingerprintPostWindowState {
  return { windowStart: nowMs, posted: 0, suppressed: 0, summarized: false };
}

export async function notifyFingerprintEvent(
  inboxWriter: InboxWriterApi,
  postSlack: PostSlack,
  aeSink: AeSink,
  commonAttrs: CommonResourceAttrs,
  rule: string,
  detail: string,
  nowMs = Date.now(),
): Promise<void> {
  const raw = await inboxWriter.getAlertMeta(FINGERPRINT_POST_WINDOW_META_KEY);
  let state: FingerprintPostWindowState = raw ? (JSON.parse(raw) as FingerprintPostWindowState) : freshFingerprintPostWindow(nowMs);
  if (nowMs - state.windowStart >= FINGERPRINT_POST_WINDOW_MS) state = freshFingerprintPostWindow(nowMs);

  if (state.posted < MAX_FINGERPRINT_POSTS_PER_WINDOW) {
    state.posted += 1;
    await inboxWriter.setAlertMeta(FINGERPRINT_POST_WINDOW_META_KEY, JSON.stringify(state));
    await postSlack(`:rotating_light: [o11y] *${escapeSlackMrkdwn(rule)}* — ${escapeSlackMrkdwn(detail)}`);
    writeAlertPoint(aeSink, commonAttrs, rule, "fired");
    return;
  }

  state.suppressed += 1;
  const postSummaryNow = !state.summarized;
  if (postSummaryNow) state.summarized = true;
  await inboxWriter.setAlertMeta(FINGERPRINT_POST_WINDOW_META_KEY, JSON.stringify(state));
  if (postSummaryNow) {
    await postSlack(
      `:rotating_light: [o11y] *${escapeSlackMrkdwn(rule)}* — rate-capped after ${MAX_FINGERPRINT_POSTS_PER_WINDOW} posts this window; ${state.suppressed} further new-fingerprint report(s) suppressed (not dropped — see the cursor), no more individual lines until the window rolls over`,
    );
    writeAlertPoint(aeSink, commonAttrs, rule, "fired");
  }
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
