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

const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>)]+/gi;

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

/** The combined extra pass this task runs on every stored record's free
 *  body text, beyond what `scrubTelemetry` alone guarantees. */
export function scrubBodyText(text: string): string {
  return redactUserAgentInText(stripUrlQueriesInText(text));
}
