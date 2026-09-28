// `scrubTelemetry`'s `stripQueryAndFragment` only runs on discrete
// URL-shaped fields, never on a message/body string that merely *contains*
// a URL — a real Cloudflare export line can embed one anyway (the Sandbox
// SDK's stale-preview-URL warning, ADR §D). This extra pass runs on every
// OTLP record's `body` (and, defensively, Faro's converted `body`) after
// `scrubTelemetry`, never instead of it.

import {
  redactIpInText,
  stripQueryAndFragment,
  stripUrlQueriesInText,
  truncateForScrub,
} from "@handsontable/demo-runtime/telemetry";

// Defined once in the runtime package (ADR §E.4); re-exported since
// `pipeline/o11y-redos.test.mjs`/`o11y-normalise.test.mjs` import it here.
export { redactIpInText };

/** Blanks a `Mozilla/<ver> (<platform tokens>)` UA prefix embedded in free
 *  text (`scrub.ts#reduceBrowserMeta` only reduces the structured
 *  `meta.browser.userAgent` field). Every quantifier is bounded against
 *  ReDoS (measured 40k chars ~1.2s unbounded); `o11y-redos.test.mjs` pins
 *  the timing. */
const USER_AGENT_PATTERN = /Mozilla\/[\d.]{1,32}\s{0,16}\([^)]{0,512}\)[^\s,;]{0,256}/gi;

export function redactUserAgentInText(text: string): string {
  return text.replace(USER_AGENT_PATTERN, "<ua>");
}

/** Blanks a standard email shape embedded in free text (contract §3 bans
 *  it). Bounded per RFC 5321 §4.5.3.1 (local ≤64, domain ≤253 octets)
 *  against ReDoS (measured 80k chars ~4.3s unbounded); `o11y-redos.test.mjs`
 *  pins the timing. */
const EMAIL_PATTERN = /[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,63}/gi;

export function redactEmailInText(text: string): string {
  return text.replace(EMAIL_PATTERN, "<email>");
}

/** The extra pass run on every stored record's free body text, beyond what
 *  `scrubTelemetry` guarantees. `truncateForScrub` bounds `text` to
 *  `SCRUB_TEXT_MAX_CHARS` (= `INBOX_RECORD_MAX_BYTES`, §8) before any pass
 *  runs. */
export function scrubBodyText(text: string): string {
  return redactIpInText(redactEmailInText(redactUserAgentInText(stripUrlQueriesInText(truncateForScrub(text)))));
}

/** `scrubTelemetry`'s OTLP-record branch scrubs preview hosts from every
 *  attribute value but never strips a query string or UA the way
 *  `scrubBodyText` does for `body`. Uses `stripQueryAndFragment`, not
 *  `stripUrlQueriesInText`: an attribute value is the WHOLE field, not
 *  text that merely *embeds* a URL, so it gets `scrub.ts`'s
 *  `meta.page.url` treatment. */
export function scrubAttributeValues(
  attrs: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!attrs) return attrs;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    out[key] = redactIpInText(redactEmailInText(redactUserAgentInText(stripQueryAndFragment(truncateForScrub(value)))));
  }
  return out;
}
