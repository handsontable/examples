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

// `stripUrlQueriesInText` and `redactIpInText` are now defined once in the
// runtime package (browsers and this Worker both scrub with them, ADR §E.4).
// `redactIpInText` is re-exported because `pipeline/o11y-redos.test.mjs` and
// `pipeline/o11y-normalise.test.mjs` import it by this module's path.
export { redactIpInText };

/** `scrub.ts#reduceBrowserMeta` only reduces the *structured*
 *  `meta.browser.userAgent` field to a device/browser class; nothing in the
 *  contract module reduces a UA string embedded in a log line's free text
 *  (a Worker warning that echoes a request header, for example). A
 *  `Mozilla/<ver> (<platform tokens>)` prefix, the shape every real UA
 *  starts with, is blanked; text with no such prefix is untouched. */
// Every quantifier below is bounded (`[\d.]+`→`{1,32}`, `\s*`→`{0,16}`,
// `[^)]*`→`{0,512}`, `[^\s,;]*`→`{0,256}`): unbounded, an input like
// `"Mozilla/1 ("` repeated backtracks O(n) at each of O(n) occurrences,
// O(n²) total (measured: 40k chars ~1.2s, 80k ~4.8s). No real UA string
// is anywhere near these bounds, so this is not a behavior change.
const USER_AGENT_PATTERN = /Mozilla\/[\d.]{1,32}\s{0,16}\([^)]{0,512}\)[^\s,;]{0,256}/gi;

export function redactUserAgentInText(text: string): string {
  return text.replace(USER_AGENT_PATTERN, "<ua>");
}

/** Contract §3's "never sent" list includes "the user pseudonym, an
 *  email" — enforced structurally elsewhere (no `user` meta, no free-text
 *  console output reaches the pipeline), but a free-text field can embed
 *  one (a Sentry issue title, `"... user a@b.com Mozilla/5.0 ..."`). A
 *  standard, conservative address shape, blanked the same way a UA is. */
// `[a-z0-9._%+-]+`/`[a-z0-9.-]+` are bounded per RFC 5321 §4.5.3.1 (local
// part ≤64 octets, domain ≤253 octets): unbounded, 80k `a` chars with no
// `@` backtracks O(n) at each of O(n) start positions, O(n²) total
// (measured: 10k chars ~72ms, 80k ~4.3s). Not a behavior change for any
// real address.
const EMAIL_PATTERN = /[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,63}/gi;

export function redactEmailInText(text: string): string {
  return text.replace(EMAIL_PATTERN, "<email>");
}

/** The combined extra pass run on every stored record's free body text,
 *  beyond what `scrubTelemetry` alone guarantees. `truncateForScrub` bounds
 *  `text` to `SCRUB_TEXT_MAX_CHARS` (= `INBOX_RECORD_MAX_BYTES`, §8) before
 *  any of the four scrub passes below see it — defense in depth alongside
 *  making each pattern itself linear, sized so it never changes the
 *  record-level 256 KB oversize check that runs after this. */
export function scrubBodyText(text: string): string {
  return redactIpInText(redactEmailInText(redactUserAgentInText(stripUrlQueriesInText(truncateForScrub(text)))));
}

/** `scrubTelemetry`'s OTLP-record branch runs `redactPreviewHosts` over
 *  every attribute value, but never strips a query string or a UA embedded
 *  in one, the way `scrubBodyText` does for `body`. A client-supplied
 *  attribute value (`context`, a diagnostic tag) can carry a query string
 *  or UA just as easily as a message can (e.g.
 *  `"versions-fetch?token=SECRET"`).
 *
 *  Uses `stripQueryAndFragment`, not `stripUrlQueriesInText`: an attribute
 *  value is the WHOLE field, not free text that might merely *embed* a
 *  URL, so it gets the same cut-at-first-`?`/`#` treatment `scrub.ts`
 *  applies to `meta.page.url`, including its non-URL fallback. */
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
