// T02-D — query strings inside free body text (see the task Outcome):
// `scrubTelemetry`'s `stripQueryAndFragment` only runs on discrete
// URL-shaped fields (`meta.page.url`, a stack frame's `filename`), never on
// a message/body string that merely *contains* a URL. A real Cloudflare
// export line can embed one anyway — the Sandbox SDK's stale-preview-URL
// warning is exactly this shape (ADR §D: "stale-preview requests are
// answered before the Sandbox SDK … so its per-request warning does not
// fire" for *new* traffic, but old exported lines and other loggers are not
// covered by that guarantee) — and this task's own acceptance criteria
// require "no stored record contains a query string … assert over all
// fixtures," which is stricter than what the contract module alone
// guarantees. This is this task's own extra pass, run on every OTLP record's
// `body` (and, defensively, on Faro's converted `body` too) after
// `scrubTelemetry`, never instead of it.

import { stripQueryAndFragment } from "@handsontable/demo-runtime/telemetry";

// Fix round (finding A-I3): this pass always runs AFTER `scrubTelemetry`
// (see the file header), which has already replaced a preview host with
// the literal `<preview>` (`redactPreviewHosts`). The original
// `[^\s"'<>)]+` char class excludes `<`/`>`, so a URL like
// `https://<preview>/a?token=SECRET` failed to match at all — the very
// first character after the scheme is `<`, which the class forbids — and
// its query string survived untouched. The optional `(?:<preview>)?` group
// consumes that literal placeholder first, so matching can continue past
// it into the (ordinary, `<`/`>`-free) path and query.
const URL_PATTERN = /\bhttps?:\/\/(?:<preview>)?[^\s"'<>)]*/gi;

/** Strips the query string and fragment off every absolute URL found inside
 *  free text, leaving the rest of the text untouched. Not a full URL parse
 *  (the matched substring may include trailing punctuation an exact `new
 *  URL()` parse would reject) — cuts at the first `?`/`#` within the matched
 *  span, which is enough to remove a token/credential without needing the
 *  URL to be well-formed. */
export function stripUrlQueriesInText(text: string): string {
  return text.replace(URL_PATTERN, (url) => {
    const cut = url.search(/[?#]/);
    return cut === -1 ? url : url.slice(0, cut);
  });
}

/** T02-D — a user-agent string embedded in free body text (see the task
 *  Outcome): `scrub.ts#reduceBrowserMeta` only reduces the *structured*
 *  `meta.browser.userAgent` field to a device/browser class; nothing in the
 *  contract module reduces a UA string that shows up inside a log line's
 *  free text (a Worker warning that echoes a request header, for example).
 *  This task's acceptance criteria ban a user agent "over all fixtures," so
 *  this is this task's own extra pass — a `Mozilla/<ver> (<platform
 *  tokens>)` prefix, the shape every real UA string starts with, is blanked
 *  out; text with no such prefix is untouched. */
const USER_AGENT_PATTERN = /Mozilla\/[\d.]+\s*\([^)]*\)[^\s,;]*/gi;

export function redactUserAgentInText(text: string): string {
  return text.replace(USER_AGENT_PATTERN, "<ua>");
}

/** Fix round (finding A-I3): contract §3's "never sent" list includes "the
 *  user pseudonym, an email" — enforced everywhere else structurally (no
 *  `user` meta, no free-text console output reaches the pipeline at all),
 *  but a genuinely free-text field CAN embed one: the exact I3 probe is a
 *  Sentry issue title, `"... user a@b.com Mozilla/5.0 ..."`. No existing
 *  mechanism redacted an email anywhere in this codebase before this fix —
 *  a standard, conservative address shape, blanked the same way a UA is. */
const EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

export function redactEmailInText(text: string): string {
  return text.replace(EMAIL_PATTERN, "<email>");
}

/** The combined extra pass this task runs on every stored record's free
 *  body text, beyond what `scrubTelemetry` alone guarantees. */
export function scrubBodyText(text: string): string {
  return redactEmailInText(redactUserAgentInText(stripUrlQueriesInText(text)));
}

/** Fix round (finding A-M3, "also"): `scrubTelemetry`'s OTLP-record branch
 *  only runs `redactPreviewHosts` over every string, including attribute
 *  values — it never strips a query string or a UA embedded in one, the way
 *  this module's own `scrubBodyText` already does for `body`. A query
 *  string or a UA can end up inside an allowlisted attribute value
 *  (`session.id` is opaque, but `context`, a diagnostic tag value, is
 *  client-supplied — e.g. `"versions-fetch?token=SECRET"`) just as easily
 *  as inside a message.
 *
 *  Uses `stripQueryAndFragment` (the finding's own named fix), not
 *  `stripUrlQueriesInText` — an attribute value is the WHOLE field, not
 *  free text that might merely *embed* a URL, so it gets the same
 *  cut-at-first-`?`/`#` treatment `scrub.ts` already applies to `meta.page.url`
 *  and a stack frame's `filename`, including its non-URL fallback (a bare
 *  `context` value like the one above is not a well-formed absolute URL,
 *  and must still be cut). */
export function scrubAttributeValues(
  attrs: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!attrs) return attrs;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    out[key] = redactEmailInText(redactUserAgentInText(stripQueryAndFragment(value)));
  }
  return out;
}
