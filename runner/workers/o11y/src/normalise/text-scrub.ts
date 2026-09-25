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

import { stripQueryAndFragment, truncateForScrub } from "@handsontable/demo-runtime/telemetry";

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
// Fix round (finding Z-A-C1): every quantifier below used to be unbounded
// (`[\d.]+`, `\s*`, `[^)]*`, `[^\s,;]*`). On an input like `"Mozilla/1 ("`
// repeated, `[^)]*` greedily ran to the end of the string, the required
// closing `)` never matched, and the engine backtracked one character at a
// time before moving to the next `Mozilla/` occurrence — O(n) of work at
// each of O(n) occurrences, O(n²) total (measured: 40k chars ~1.2s, 80k
// ~4.8s). No real user-agent string is anywhere near these bounds (a UA's
// platform-token parenthetical, `[\d.]` version run, and trailing suffix
// are each well under a few hundred characters), so bounding every
// quantifier is not a behavior change for any real UA string — it caps the
// backtrack at a small constant per occurrence, making this O(n) overall.
const USER_AGENT_PATTERN = /Mozilla\/[\d.]{1,32}\s{0,16}\([^)]{0,512}\)[^\s,;]{0,256}/gi;

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
// Fix round (finding Z-A-C1): `[a-z0-9._%+-]+` and `[a-z0-9.-]+` used to be
// unbounded. On an input like 80k `a` characters with no `@` at all, the
// local-part class greedily consumed every start position's entire
// remainder, the required `@` never matched, and the engine backtracked
// one character at a time before advancing the start position — O(n) of
// work at each of O(n) positions, O(n²) total (measured: 10k chars ~72ms,
// 80k ~4.3s). Bounded per RFC 5321 §4.5.3.1 (local part ≤64 octets, and a
// domain name ≤253 octets total), which is not a behavior change for any
// real address — it caps the backtrack at a fixed constant per start
// position, making this O(n) overall.
const EMAIL_PATTERN = /[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,63}/gi;

export function redactEmailInText(text: string): string {
  return text.replace(EMAIL_PATTERN, "<email>");
}

/** R3 F17c: contract §3's "never sent" list includes "an IP" — nothing
 *  redacted one anywhere before this fix. The privacy canary `192.0.2.55`
 *  only "passed" verification because F17a lost its whole record to a
 *  different bug (a Faro gecko-regex fallback that turned the message line
 *  into a fake stack frame, which the noise gate then dropped) — once that
 *  is fixed separately, the IP would have reached here unredacted.
 *
 *  Bounded from the start, unlike `EMAIL_PATTERN`/`USER_AGENT_PATTERN`
 *  above (both needed their own ReDoS fix round, Z-A-C1/Y2): every
 *  quantifier here is a small fixed alternation or a `{1,4}` cap, so there
 *  is no unbounded run to backtrack over regardless of input shape — see
 *  `pipeline/o11y-redos.test.mjs` for the adversarial-input timing proof
 *  all the same, the same budget every other pattern in this file is held
 *  to.
 *
 *  IPv4: four dotted octets 0–255, boundary-guarded on both ends so a
 *  version string never matches — `18.1.1` has too few dotted numbers to
 *  reach the pattern at all, and `1.2.3.4-beta`/`1.2.3.4.5` are rejected by
 *  the trailing lookahead: `[\w-]` catches a `-`/alnum suffix right after
 *  the fourth octet (a semver pre-release/build tag), and `\.\d` catches a
 *  FIFTH dotted number (so a 5-part dotted run never gets read as "an IP
 *  plus trailing junk"). A single trailing `.` with nothing (or a non-digit)
 *  after it — an IP address that simply ends a sentence — is deliberately
 *  NOT excluded (advisor review, this fix round: an earlier `(?![\w.-])`
 *  form also rejected `10.0.0.1.` for that reason, a real under-redaction,
 *  not just a version-string false-positive dodge).
 *
 *  The START boundary is a CAPTURING alternation (`^` or one non-`[\w.-]`
 *  character), not a lookbehind (advisor review, this fix round): a
 *  lookbehind assertion (`(?<!...)`) is ES2018, and Safari did not support
 *  it until 16.4 (March 2023) — a `new RegExp` with one at browser module
 *  top level would throw on any older Safari, failing this whole telemetry
 *  module's import (see `apps/authoring/src/main.tsx`, which imports
 *  `initTelemetry` eagerly — `pipeline/telemetry-facade-boot-safety.test.mjs`
 *  is this codebase's own guard against exactly this class of eager-import
 *  failure). The trailing boundary stays a plain negative LOOKAHEAD
 *  (`(?!...)`), which has always been supported — only lookBEHIND is the
 *  compatibility risk. `redactIpInText`/`scrubText` below re-attach the
 *  captured prefix character in the replacement. */
const IPV4_OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d{2}|[1-9]?\\d)";
const IPV4_PATTERN = new RegExp(`(^|[^\\w.-])(?:${IPV4_OCTET}\\.){3}${IPV4_OCTET}(?![\\w-]|\\.\\d)`, "g");

/** IPv6: the standard bounded form (7 alternatives covering the
 *  uncompressed 8-group shape and every valid position of one `::`
 *  compression), each alternative built only from a `{1,4}` hex-digit group
 *  and a `{1,7}`-capped group count — the same "small fixed alternation,
 *  bounded quantifiers only" shape as the IPv4 pattern above, so a single
 *  match attempt costs a small constant regardless of input length. Same
 *  capturing-prefix boundary as IPv4 above, for the same lookbehind
 *  compatibility reason. */
const IPV6_GROUP = "[0-9A-Fa-f]{1,4}";
const IPV6_PATTERN = new RegExp(
  "(^|[^\\w:])(?:" +
    `(?:${IPV6_GROUP}:){7}${IPV6_GROUP}` + // 1:2:3:4:5:6:7:8 (no compression)
    `|(?:${IPV6_GROUP}:){1,7}:` + // 1::  ...  1:2:3:4:5:6:7::
    `|(?:${IPV6_GROUP}:){1,6}:${IPV6_GROUP}` + // 1::8  ...  1:2:3:4:5:6::8
    `|(?:${IPV6_GROUP}:){1,5}(?::${IPV6_GROUP}){1,2}` + // 1::7:8 ...
    `|(?:${IPV6_GROUP}:){1,4}(?::${IPV6_GROUP}){1,3}` +
    `|(?:${IPV6_GROUP}:){1,3}(?::${IPV6_GROUP}){1,4}` +
    `|(?:${IPV6_GROUP}:){1,2}(?::${IPV6_GROUP}){1,5}` +
    `|${IPV6_GROUP}:(?::${IPV6_GROUP}){1,6}` + // 1::3:4:5:6:7:8
    `|:(?:(?::${IPV6_GROUP}){1,7}|:)` + // ::2:3:4:5:6:7:8  ::
    ")(?![\\w:])",
  "g",
);

/** IPv4 first, then IPv6 (advisor review, this fix round): an IPv4-mapped
 *  IPv6 address (`::ffff:192.0.2.55`) has hex-digit-shaped octets, so
 *  IPV6_PATTERN alone can consume the leading `::ffff:192` (`192` reads as
 *  a valid hex group) and leave a REAL fragment of the address,
 *  `.0.2.55`, unredacted in the output — the wrong order turns "redact the
 *  IP" into "partially redact the IP and leak the rest." Redacting the
 *  IPv4 tail first turns it into `::ffff:<ip>`, which IPV6_PATTERN then
 *  redacts as a whole on the second pass. Each replacer re-attaches the
 *  captured boundary character (see the patterns' own doc comments — the
 *  boundary is captured, not a lookbehind, for Safari <16.4). */
export function redactIpInText(text: string): string {
  return text
    .replace(IPV4_PATTERN, (_match, prefix: string) => `${prefix}<ip>`)
    .replace(IPV6_PATTERN, (_match, prefix: string) => `${prefix}<ip>`);
}

/** The combined extra pass this task runs on every stored record's free
 *  body text, beyond what `scrubTelemetry` alone guarantees.
 *
 *  Fix round (finding Z-A-C1, step 2 "truncate first"): `truncateForScrub`
 *  bounds `text` to `SCRUB_TEXT_MAX_CHARS` (= `INBOX_RECORD_MAX_BYTES`, §8)
 *  before any of the three scrub passes below ever see it — defense in
 *  depth alongside making each pattern itself linear, and sized so it never
 *  changes the outcome of the record-level 256 KB oversize check that runs
 *  after this (`pipeline/o11y-normalise.test.mjs`'s two oversize tests).
 *
 *  R3 F17c: `redactIpInText` added as a fourth chained pass. */
export function scrubBodyText(text: string): string {
  return redactIpInText(redactEmailInText(redactUserAgentInText(stripUrlQueriesInText(truncateForScrub(text)))));
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
    out[key] = redactIpInText(redactEmailInText(redactUserAgentInText(stripQueryAndFragment(truncateForScrub(value)))));
  }
  return out;
}
