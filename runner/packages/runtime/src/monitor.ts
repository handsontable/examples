// Demo-runtime error monitoring (DEV-2527). Temporary: everything here is behind
// `VITE_MONITOR_DEMOS` in the browser and `MONITOR_DEMOS` in the API worker, and
// the removal path is documented in docs/run-and-deploy.md.
//
// The preview is cross-origin on both tiers — Sandpack's bundler host for Tier 1,
// `<port>-<id>-<token>.demos.handsontable.com` for Tier 2 — so nothing inside it
// can reach the authoring app's error handlers. This module is the bridge: a small
// reporter injected into the preview document, which postMessages what it sees to
// the parent, where sentry.ts re-files it under `environment: "demo-runtime"`.
//
// One copy serves both tiers. The API worker already depends on
// `@handsontable/demo-runtime`, so the reporter source must never be duplicated
// into workers/api — a second copy is a second set of caps to keep in sync.

import { injectedScriptTag, insertInjectedTag } from "./inject-html.js";
// T08 (ADR §C.5, contract §9): imported from the leaf modules directly, never
// from `./telemetry/index.js` — `scrub.ts` and `fingerprint.ts` already import
// `../monitor.js`, so a barrel import here would be a cycle.
import { LITE_PAYLOAD_MAX_BYTES, type LiteSurface } from "./telemetry/lite.js";
import type { Framework, HtMajor } from "./telemetry/attrs.js";

/** The `postMessage` discriminator. Also the injection idempotency marker. */
export const MONITOR_MESSAGE_TYPE = "hot-runner-monitor";

/**
 * Hard ceiling on relayed events per page load.
 *
 * The kill switch is build-time (see docs/run-and-deploy.md), so turning this
 * feature off costs a deploy. That makes the in-page ceiling the only brake that
 * acts immediately, and it has to hold for a demo whose render loop throws on
 * every frame.
 */
export const MONITOR_EVENT_CEILING = 20;

/**
 * Ceiling on relayed `console-warn` events per page load, counted separately from
 * `MONITOR_EVENT_CEILING` (DEV-2539).
 *
 * A warning is context, not a fault: parent-side it becomes a Sentry *breadcrumb*
 * attached to the next real error, never an issue of its own. That is why the two
 * ceilings are separate in both directions. Looser, because a breadcrumb costs no
 * issue and the whole point is to have the warnings that preceded a failure. But
 * still capped, and still its own budget — sharing the relay ceiling would let a
 * demo that warns on every render (Handsontable's own "Theme is already registered"
 * notice is emitted by normal re-renders) spend all twenty slots before the
 * `console.error` explaining the breakage is ever posted.
 *
 * Paired with `maxBreadcrumbs` in `apps/authoring/src/sentry.ts`, which the demo
 * shares with the authoring app's own trail and which evicts oldest-first: this
 * number must stay a small fraction of it, or a chatty demo silently erases the
 * clicks and fetches that explain an unrelated app failure. Move the two together.
 */
export const MONITOR_BREADCRUMB_CEILING = 50;

/** Message length cap. Demo code is authored by anonymous visitors; a message can
 *  quote it, so it is truncated rather than relayed whole. */
export const MONITOR_MESSAGE_MAX = 500;

/** Stack cap. Enough for a fingerprint and a first frame, not a whole trace. */
export const MONITOR_STACK_MAX = 2000;

/**
 * Cap for a Tier-1 compile message (DEV-2550) — the bundler's `show-error` string,
 * which reaches the error card and Sentry through `SandpackRuntime`.
 *
 * Deliberately larger than `MONITOR_MESSAGE_MAX`. A relayed message is one line of
 * a thrown error; this one is a babel diagnostic whose code frame *is* the useful
 * part, and 500 chars cuts it in half. Same order as the stack cap, and still ~2%
 * of the payload actually observed (DEMOS-15: a code frame followed by a
 * multi-kilobyte inline source map).
 *
 * It lives here, beside the other caps, rather than in sandpack.ts: this file's
 * header is explicit that a second set of caps elsewhere is a second set to keep in
 * sync.
 */
export const MONITOR_COMPILE_MESSAGE_MAX = 2000;

/** URL cap. A path this long is already unreadable; the rest is only volume. */
export const MONITOR_URL_MAX = 500;

/**
 * The exact prefix React 18 dev uses when it logs an error-boundary component
 * stack to `console.error` — `react-dom@18.3.1/cjs/react-dom.development.js:18689-18704`
 * (fetched verbatim) builds `componentNameMessage + "\n" + componentStack + "\n\n" +
 * errorBoundaryMessage` and calls `console['error'](combinedMessage)` as a single
 * string argument. Recognising it (DEV-2875, DEMOS-4P) is what lets that call be
 * promoted from `console-error` to `error`, carrying its component stack as a real
 * `stack` rather than losing it inside a message `send` truncates at
 * `MONITOR_MESSAGE_MAX`.
 *
 * React 19 needs none of this: it calls `console.error("%o\n\n%s\n\n%s\n", error, …)`,
 * so the Error object is an argument and `errorArgReport` already re-homes it with the
 * real message and stack.
 */
export const MONITOR_REACT_BOUNDARY_PREFIX = "The above error occurred in ";

/**
 * What a React 18 error-boundary component name is replaced with in a promoted
 * event's message.
 *
 * `<ExampleComponent>` and its siblings are docs-authored content, not ours — 1794
 * occurrences under `apps/authoring/public/docs-examples/` — and this message becomes
 * both the Sentry issue title and (via `normalizeMonitorMessage`) the fingerprint. An
 * unredacted component name would fingerprint one bucket per authored example instead
 * of one bucket for the defect, which is the DEV-2854 flapping-title failure this
 * ticket exists to fix. Matches house style: `<preview>` / `<n>` / `<str>` / `<ident>`.
 */
export const MONITOR_COMPONENT_PLACEHOLDER = "<component>";

/**
 * What a Tier-2 preview host is replaced with.
 *
 * Preview URLs are `<port>-<sandboxId>-<token>.demos.handsontable.com`, so **the
 * hostname is a session credential** — that token is what authorises access to a
 * live preview (a mismatch is the `INVALID_TOKEN` failure). It reaches strings three
 * ways: a scrubbed network URL, every frame of a stack from the preview
 * (`https://<port>-<id>-<token>.demos…/src/main.js:1:1`), and any message that quotes
 * a URL. All three are redacted — telemetry must never carry a credential that
 * anyone with dashboard access could replay.
 *
 * Losing the exact host costs nothing diagnostically: which session it was is not
 * actionable, and the path and third-party hosts survive.
 */
export const PREVIEW_HOST_PLACEHOLDER = "<preview>";

/**
 * Redact Tier-2 preview hostnames from a string.
 *
 * Matches only hosts with a subdomain label, so the app's own
 * `demos.handsontable.com` origin is left readable — a preview host always has the
 * `<port>-<id>-<token>` label in front.
 *
 * This is the parent's backstop. The reporter redacts its own `location.host` before
 * sending, which is the precise version; this catches whatever crossed the boundary
 * anyway, including a payload from a demo that never ran the reporter.
 */
export function redactPreviewHosts(value: string): string {
  return value.replace(/\b[a-z0-9-]+\.demos\.handsontable\.com\b/gi, PREVIEW_HOST_PLACEHOLDER);
}

/**
 * Bound and redact a payload that crossed the origin boundary.
 *
 * Nothing in it is trusted. The reporter truncates and redacts in-page, but a demo
 * can post this shape without ever running the reporter, so every field is done again
 * here — otherwise an unbounded `stack` is free client-side resource pressure (it is
 * hashed for dedupe, fingerprinted, and forwarded) and a leaked host is a live
 * session token in telemetry.
 */
export function sanitizeMonitorPayload(payload: MonitorPayload): MonitorPayload {
  const clean: MonitorPayload = {
    type: payload.type,
    kind: payload.kind,
    message: bound(payload.message, MONITOR_MESSAGE_MAX),
  };
  if (payload.stack) clean.stack = bound(payload.stack, MONITOR_STACK_MAX);
  if (payload.url) clean.url = bound(payload.url, MONITOR_URL_MAX);
  return clean;
}

/**
 * Redact, **then** truncate. The order is the security property, not a style choice.
 *
 * Truncating first can cut a hostname in half, and the surviving prefix still carries
 * the session token (`https://3000-sbx7f2a-tok9xQ`) — while `redactPreviewHosts` can
 * no longer match it, because the host it is looking for is incomplete. Long Next and
 * Angular stacks routinely run past the stack cap, and a crafted `postMessage` can put
 * a host on the boundary deliberately.
 *
 * Redacting first also leaves more of the useful string inside the cap, since a
 * hostname collapses to a short placeholder.
 */
function bound(value: string, max: number): string {
  return truncateMessage(redactPreviewHosts(value), max);
}

/** What the reporter observed. `stderr` is the only kind not raised in-page — it
 *  comes from the Tier-2 dev server via the session status poll.
 *
 *  `console-warn` is relayed but never filed as an issue: `reportDemoEvent` turns it
 *  into a breadcrumb (DEV-2539). It stays in the union and in `MONITOR_KINDS` because
 *  the payload still has to survive `isMonitorPayload` to reach that branch. */
export type MonitorKind =
  | "error"
  | "rejection"
  | "console-error"
  | "console-warn"
  | "network"
  | "stderr";

/**
 * The closed set of kinds. Load-bearing, not documentation: `kind` becomes a Sentry
 * tag, and the payload arrives from a page running code the visitor wrote. An
 * unchecked string there is unbounded tag cardinality chosen by whoever authored the
 * demo.
 */
export const MONITOR_KINDS: readonly MonitorKind[] = [
  "error",
  "rejection",
  "console-error",
  "console-warn",
  "network",
  "stderr",
];

export interface MonitorPayload {
  type: typeof MONITOR_MESSAGE_TYPE;
  kind: MonitorKind;
  message: string;
  /** Truncated. Absent for console and network events. */
  stack?: string;
  /** Network events only: scheme + host + path, query stripped. The reporter relays a
   *  network event only when that host is the preview's own (DEV-2539) — but that holds
   *  for payloads *the reporter produced*. A demo can post this shape without ever
   *  running the reporter, and `isMonitorPayload` only type-checks this field, so a
   *  crafted payload can still carry any url at all. Which is why it reaches `extra` and
   *  the issue title only, never a Sentry tag and never the fingerprint. */
  url?: string;
}

/**
 * True for a `message` event whose data is a well-formed reporter payload.
 *
 * Shape is validated here rather than at the callsite because the preview is
 * cross-origin: anything on the page can post to us, so the sender check
 * (`event.source === iframe.contentWindow`) and this are both required — and the
 * sender check alone is not enough, because the demo code *is* the sender. Every
 * field is checked against its declared type, and `kind` against the closed set:
 * this payload is written by whoever authored the demo, so nothing in it may reach a
 * Sentry tag unchecked. Volume is bounded separately, parent-side — the reporter's
 * own ceiling is not reachable from here.
 */
export function isMonitorPayload(data: unknown): data is MonitorPayload {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  if (d["type"] !== MONITOR_MESSAGE_TYPE) return false;
  if (typeof d["message"] !== "string") return false;
  if (!MONITOR_KINDS.includes(d["kind"] as MonitorKind)) return false;
  if (d["stack"] !== undefined && typeof d["stack"] !== "string") return false;
  if (d["url"] !== undefined && typeof d["url"] !== "string") return false;
  return true;
}

/** Cap a message. Exported for the parent, which re-truncates rather than trusting
 *  a payload that crossed an origin boundary. */
export function truncateMessage(value: unknown, max: number = MONITOR_MESSAGE_MAX): string {
  const s = typeof value === "string" ? value : String(value);
  return s.length <= max ? s : s.slice(0, max) + "...";
}

/** First stack frame, which is what makes two same-message faults distinguishable. */
function firstStackFrame(stack: string | undefined): string {
  if (!stack) return "";
  for (const raw of stack.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("at ")) return line;
  }
  return stack.split("\n")[0]?.trim() ?? "";
}

/** The identity two reports must share to count as the same one. */
export function monitorDedupeKey(kind: string, message: string, stack?: string): string {
  return `${kind}|${message}|${firstStackFrame(stack)}`;
}

/**
 * A relay budget: the same ceiling and dedupe the in-page reporter applies, counted
 * somewhere the demo cannot reach.
 *
 * The reporter's copy is not a cap. It runs *inside* the preview, alongside code
 * authored by whoever made the demo — and for a shared or docs example, by someone
 * other than the person viewing it. Such a demo can ignore the reporter entirely and
 * `postMessage` crafted payloads with unique messages straight at the parent. So the
 * parent keeps its own budget, and that one is enforceable.
 *
 * Deliberately not exported as a singleton: the app wants one per page load, and a
 * test wants a fresh one per case.
 */
export function createMonitorBudget(ceiling: number = MONITOR_EVENT_CEILING): {
  admit(kind: string, message: string, stack?: string): boolean;
} {
  const seen = new Set<string>();
  let used = 0;
  return {
    /** True if this event fits the budget, which it then consumes. */
    admit(kind, message, stack) {
      if (used >= ceiling) return false;
      const key = monitorDedupeKey(kind, message, stack);
      if (seen.has(key)) return false;
      seen.add(key);
      used += 1;
      return true;
    },
  };
}

/**
 * Collapse the volatile parts of a message so one broken demo files one issue
 * rather than hundreds. Numbers, quoted strings, URLs and timestamps are what
 * differ between two reports of the same fault (a row index, a version, a
 * session id, the clock a dev-server envelope was printed at).
 *
 * A timestamp is matched whole, ahead of the number rule, because it is one
 * volatile token rather than a run of numbers. The number rule's word
 * boundaries are load-bearing in the other direction: they are what keeps
 * `TS1005` out of `TS<n>`, so a diagnostic code stays a fingerprint and two
 * different compiler errors stay two issues — confirmed for the live
 * `TS1005` group (Sentry DEMOS-3K), and true even when two codes share
 * identical prose (constructed, not observed: `TS2554`/`TS2555` both read
 * "Expected N arguments, but got M"). Relaxing the boundaries to catch the
 * `…-25T18:…` they miss would collapse the codes too.
 *
 * DEV-2853: the live editor's own keystroke-by-keystroke compile/eval failures
 * were the biggest source of near-duplicate fingerprints — ~100 issues, each a
 * "ladder" of intermediate states for one edit (typing `licenseKey` alone opens
 * 13 issues: `l is not defined`, `li is not defined`, … `licenseKey is not
 * defined`). Two rules below collapse these, each anchored to a specific,
 * known prose shape rather than a blanket bare-word strip: a blanket rule would
 * also swallow diagnostic codes and API names that carry real signal (see the
 * `TS1005`/`TS2554`/`TS2555` guard above, and `hot.getData is not a function`,
 * which stays its own fingerprint on purpose — it names an API the demo
 * actually calls).
 *
 * Rule 1 (bare identifier before "is not defined") MUST run before the number
 * rule below. A digit run glued to letters (`col2`) is unaffected either way —
 * `\b\d+\b`'s word boundaries mean there is no transition between `l` and `2`
 * to anchor on, so the number rule never touches it regardless of order. The
 * order bites on a dotted path whose last segment is a bare number, e.g.
 * `foo.2 is not defined`: run the number rule first and it becomes
 * `foo.<n> is not defined`; rule 1's dotted-path group (`(?:\.[\w$]+)*`)
 * cannot span the `<` in `<n>`, so its match backs off to `foo` alone and the
 * lookahead — which needs the literal phrase immediately after — no longer
 * lines up, leaving the message unnormalized and still laddering. Running
 * rule 1 first avoids this: it also runs after the quoted-string rule, so
 * `Invalid language tag: "zh"` (a quoted tag, already `<str>` by that point)
 * and `Invalid language tag: zh` (the bare form) land on the same key instead
 * of one of them dodging rule 2 by already being partway normalized.
 *
 * Accepted non-coverage: `foo[0] is not defined` still keys as
 * `foo[<n>] is not defined`, because the identifier rule only matches a bare
 * dotted-path token, not one with a subscript. Also accepted: two different
 * demos' first undefined reference now merge if the identifier differs but
 * everything else about the message doesn't — e.g. `HyperFormula is not
 * defined` and `RechartsDevtools is not defined` fingerprint the same. Both
 * were still each their own issue with a distinct, diagnosable identifier in
 * the title before this change; now they're one issue, which is the
 * intentional trade for collapsing the ladder (a wrong-import fault is still
 * visible from the event body, just not from the issue count).
 *
 * No lookbehind anywhere in this function: it ships in the authoring bundle,
 * which still needs to parse in Safari <16.4.
 *
 * Used for the Sentry fingerprint, not for the message the issue displays.
 */
export function normalizeMonitorMessage(message: string): string {
  return message
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<ts>")
    .replace(/["'`][^"'`]*["'`]/g, "<str>")
    // DEV-2853 rule 1 — the bare identifier in a ReferenceError ladder
    // (`l`, `li`, `lic`, … `licenseKey` `is not defined`). Must precede the
    // number rule below (see the doc comment) and follow the quoted-string
    // rule above.
    .replace(/[A-Za-z_$][\w$]*(?:\.[\w$]+)*(?= is not defined\b)/g, "<ident>")
    // DEV-2853 rule 2 — the partial locale in a RangeError from Intl, e.g.
    // `Invalid language tag: zh-c` ladders alongside `zh-`, `z`, and the
    // empty tail `Invalid language tag: `. `[ \t]*`, not `\s*`: `\s` matches
    // `\n`, so on a multiline input the match would run past the newline and
    // eat the start of the next line. Both call sites are line-oriented today
    // (`relayStderr` splits on `\n` first; `sentry.ts` passes a single-line
    // `Error.message`), so this is defensive rather than a live bug — but it
    // costs nothing and stops the rule depending on that staying true.
    // `\S*`, not `\S+`, so the empty
    // tail is covered too.
    .replace(/(Invalid language tag:)[ \t]*\S*/g, "$1 <tag>")
    .replace(/\b\d+(\.\d+)*\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/**
 * The in-page reporter, as ES5 source.
 *
 * ES5 by hand, and deliberately not assembled from this module's own functions via
 * `Function.prototype.toString()`: the authoring bundle is minified, so the helper
 * names the reporter body referenced would be mangled in production and nowhere
 * else — a break that no local build or PR CI run would reproduce. The exported
 * helpers above are the parent's copy; `pipeline/monitor-inject.test.mjs` keeps the
 * two honest by *executing* this string and asserting the behaviour, rather than
 * reading it.
 *
 * Why ES5 at all: Tier 1 injects into the bundler-facing file view, and the classic
 * bundler runs its own 2018-era babel over the entry for several templates. It
 * parses ES2015 but not ES2018+, and there is no build step here to catch a slip —
 * a parse failure would present as a blank preview.
 *
 * Self-defence rules inside the reporter, all load-bearing:
 *   - it never calls `console` (it wraps it — a report from inside a wrapper is an
 *     infinite loop),
 *   - every hook body is wrapped so a throw cannot break the demo it observes,
 *   - `__hotRunnerMonitor` makes a double injection a no-op.
 */
export const REPORTER_SOURCE = `(function () {
  try {
    if (window.__hotRunnerMonitor) return;
    window.__hotRunnerMonitor = true;
  } catch (e) { return; }

  var TYPE = ${JSON.stringify(MONITOR_MESSAGE_TYPE)};
  var REACT_PREFIX = ${JSON.stringify(MONITOR_REACT_BOUNDARY_PREFIX)};
  var COMPONENT = ${JSON.stringify(MONITOR_COMPONENT_PLACEHOLDER)};
  var CEILING = ${MONITOR_EVENT_CEILING};
  var WARN_CEILING = ${MONITOR_BREADCRUMB_CEILING};
  var MAX = ${MONITOR_MESSAGE_MAX};
  var STACK_MAX = ${MONITOR_STACK_MAX};
  var seen = {};
  var used = 0;
  var warnUsed = 0;

  function truncate(value, max) {
    var s = typeof value === "string" ? value : String(value);
    return s.length <= max ? s : s.slice(0, max) + "...";
  }

  // A Tier-2 preview host carries the session token
  // (<port>-<id>-<token>.demos.handsontable.com), and this page is served from it —
  // so it appears in stack frames, in scrubbed URLs, and in any message quoting a
  // URL. Strip it before anything leaves.
  //
  // Matched case-insensitively, which is the whole difficulty: the token is
  // mixed-case, and anything that has been through a URL parser (\`scrub\` above, a
  // browser's own stack frames) hands back a lowercased hostname. A case-sensitive
  // compare therefore misses the very tokens it exists to remove. Done by hand rather
  // than with a regex so the host needs no escaping.
  var HOST = "";
  try { HOST = String(location.host).toLowerCase(); } catch (e) { HOST = ""; }
  function redact(value) {
    // Coerced here because \`redact\` now runs before \`truncate\`, which used to be what
    // turned a non-string into one.
    var s = typeof value === "string" ? value : String(value == null ? "" : value);
    if (!s || !HOST) return s;
    var haystack = s.toLowerCase();
    var out = "";
    var from = 0;
    for (;;) {
      var at = haystack.indexOf(HOST, from);
      if (at === -1) return out + s.slice(from);
      out += s.slice(from, at) + ${JSON.stringify(PREVIEW_HOST_PLACEHOLDER)};
      from = at + HOST.length;
    }
  }

  function firstFrame(stack) {
    if (!stack) return "";
    var lines = stack.split("\\n");
    for (var i = 0; i < lines.length; i++) {
      var line = String(lines[i] || "").replace(/^\\s+|\\s+$/g, "");
      if (line && line.indexOf("at ") === 0) return line;
    }
    return String(lines[0] || "").replace(/^\\s+|\\s+$/g, "");
  }

  // Scheme + host + path, **and only for the page's own host**. A query string can
  // carry a token, and none of the diagnostics here need one.
  //
  // The origin filter lives here rather than at the four \`send("network", ...)\` call
  // sites because this is the one function all four already go through, and because it
  // is the only place the URL is still intact: what this returns is
  // \`protocol + "//" + host + pathname\`, which for a \`data:\` or \`blob:\` URL is no
  // longer a parseable URL, so a second parse downstream cannot recover the host.
  //
  // The reporter runs *inside* the preview, so \`location.host\` is the preview origin on
  // both tiers — Sandpack's bundler host for Tier 1, the token-bearing
  // <port>-<id>-<token>.demos.handsontable.com for Tier 2. Anything else is a third
  // party, and a third party's failure is not the demo's fault: Tier 1's own bundler
  // beacons out, an ad blocker turns that into a fetch rejection, and the unfiltered
  // wrapper filed it against the demo (DEV-2539).
  //
  // Returning "" is what drops the event — \`send\` refuses a network event with no URL,
  // which is also the right answer for one nobody could act on. Three branches are
  // deliberate:
  //   - HOST empty (\`location\` unreadable) -> keep. Fail open, exactly as \`redact\`
  //     no-ops; blinding the monitor is worse than relaying noise.
  //   - parsed host empty (data:, blob:) -> keep. Not a third-party beacon; the demo's
  //     own bytes.
  //   - parse threw -> "" -> drop.
  //
  // Both sides lowercased, for the reason spelled out above \`redact\`: a URL parser
  // hands back a lowercased host while the session token is mixed-case. Both include
  // the port, so they compare consistently.
  function scrub(raw) {
    try {
      var a = document.createElement("a");
      a.href = String(raw);
      var h = String(a.host || "").toLowerCase();
      if (HOST && h && h !== HOST) return "";
      return a.protocol + "//" + a.host + a.pathname;
    } catch (e) {
      return "";
    }
  }

  function send(kind, message, stack, url) {
    try {
      // A network event with no URL is either third-party (\`scrub\` filtered it) or
      // unattributable (\`scrub\` could not parse it); neither is actionable. Tested
      // before the ceiling so a dropped event costs neither a budget slot nor a dedupe
      // entry. Every network callsite must pass \`scrub(...)\` — that is where the
      // same-origin filter lives.
      if (kind === "network" && !url) return;
      // Warnings are relayed as breadcrumbs, not issues, so they get a separate and
      // looser allowance. Shared with the error budget, a demo warning on every render
      // would evict the console.error that explains the breakage.
      var isWarn = kind === "console-warn";
      if (isWarn ? warnUsed >= WARN_CEILING : used >= CEILING) return;
      // Redact before truncating, never after: a cap that splits a hostname leaves
      // the session token in the surviving prefix, and \`redact\` can no longer match
      // an incomplete host. Angular and Next stacks run past STACK_MAX routinely.
      var m = truncate(redact(message), MAX);
      var s = stack ? truncate(redact(stack), STACK_MAX) : "";
      var k = kind + "|" + m + "|" + firstFrame(s);
      if (seen[k]) return;
      seen[k] = true;
      if (isWarn) warnUsed++; else used++;
      var payload = { type: TYPE, kind: kind, message: m };
      if (s) payload.stack = s;
      if (url) payload.url = redact(url);
      parent.postMessage(payload, "*");
    } catch (e) { /* the reporter must never be the reason a demo breaks */ }
  }

  // \`instanceof\` can throw on an exotic proxy, and a cross-realm error (one raised in
  // an iframe the demo itself created) answers false. Both degrade the same way: the
  // value is not treated as an Error, so the console event is relayed as a plain
  // \`console-error\` — the pre-DEV-2552 behaviour, never a crash. \`reactBoundaryReport\`
  // (DEV-2875) is the one other escape hatch off that default: React 18's
  // error-boundary log has no Error argument for this function to find at all, so it
  // is recognised by string shape instead, after this check has already declined.
  function isErrorLike(a) {
    try {
      return !!a && a instanceof Error;
    } catch (e) {
      return false;
    }
  }

  // DEV-2552. An Error that reaches \`console.error\` is the *error* channel's business,
  // not the console channel's. The same throw usually also reaches the window \`error\`
  // listener a few lines below, and relaying both filed one fault as two Sentry issues
  // — a stackless \`console-error\` and a stacked \`error\`.
  //
  // So the event is re-homed rather than dropped: relayed under kind \`error\`, with the
  // Error's *own* message and stack rather than the joined arguments. That makes the
  // key \`send\` dedupes on (\`kind|message|firstFrame\`) byte-identical to the one the
  // window listener produces for the same Error, so whichever channel sees it first
  // wins and the second is dropped. Order-independent on purpose: the console copy
  // consistently arrives first, so a "drop the console copy" rule would keep the
  // stackless one — and, worse, would report *nothing* for the faults where the window
  // listener never fires at all. Those are real and observed: a DOMException thrown out
  // of React's commit phase (Sentry DEMOS-19) has no \`error\`-kind twin, and Angular's
  // default \`ErrorHandler\` console.errors every error zone.js swallows, which is the
  // whole of that framework's error reporting on both tiers.
  //
  // Taking the Error's own message, not \`argsToMessage\`, is what makes the keys match
  // when the caller prefixes the log (\`console.error("ERROR", err)\`).
  //
  // Extraction is wrapped because it runs at the *call site*, outside \`send\`'s own
  // try/catch: a subclass with a throwing \`message\` getter must not throw out of the
  // demo's \`console.error\` call, which would also cost it \`origError.apply\` below.
  //
  // \`console.warn\` is not re-homed — it is a breadcrumb channel and has no
  // error-channel twin.
  function errorArgReport(args) {
    for (var i = 0; i < args.length; i++) {
      if (isErrorLike(args[i])) {
        try {
          return { message: String(args[i].message || "unknown error"), stack: args[i].stack };
        } catch (e) {
          return { message: "unknown error", stack: "" };
        }
      }
    }
    return null;
  }

  // DEV-2875. Second re-homing path, tried after \`errorArgReport\` so React 19 (an
  // Error argument, covered above) keeps winning. React 18's boundary log has no Error
  // arg at all — one joined string, component stack included — so it must be
  // recognised by shape, in-page, before \`send\` truncates the message and takes the
  // stack with it. Four load-bearing conditions: (1) one string arg — React 19's \`%o\`
  // form is excluded by arity; (2) REACT_PREFIX at index 0; (3) "error boundary"
  // present; (4) >=1 \`at \`-form frame below line 1 — the condition that makes
  // promotion conditional on actually carrying a stack, so frame-less prose stays on
  // \`console-error\`. \`at \`-form only: Sentry's parser reads that shape, the legacy
  // \`in X (at file:line)\` form parses to zero frames. \`else if (frames.length) break\`
  // skips React's one leading blank line without swallowing trailing prose. Component
  // name elided (first match only) — it is visitor-authored and would otherwise
  // fingerprint one issue per example (DEV-2854). try/catch as in \`errorArgReport\`:
  // runs at the call site, outside \`send\`'s own catch.
  function reactBoundaryReport(args) {
    try {
      if (args.length !== 1) return null;
      var s = args[0];
      if (typeof s !== "string") return null;
      if (s.indexOf(REACT_PREFIX) !== 0) return null;
      if (s.indexOf("error boundary") === -1) return null;
      var lines = s.split("\\n");
      var frames = [];
      for (var i = 1; i < lines.length; i++) {
        if (/^\\s+at\\s+\\S/.test(lines[i])) frames.push(lines[i]);
        else if (frames.length) break;
      }
      if (!frames.length) return null;
      return {
        message: lines[0].replace(/<[^<>]*>/, COMPONENT),
        stack: frames.join("\\n")
      };
    } catch (e) { return null; }
  }

  function argsToMessage(args) {
    var parts = [];
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      try {
        parts.push(isErrorLike(a) ? String(a && a.message) : typeof a === "string" ? a : String(a));
      } catch (e) {
        parts.push("<unserializable>");
      }
    }
    return parts.join(" ");
  }

  try {
    window.addEventListener("error", function (event) {
      try {
        // A failed <img>/<script>/<link> fetch also arrives here, with no
        // \`error\` and a element target. That is a network fault, not a throw.
        if (!event.error && event.target && event.target !== window) {
          var src = event.target.src || event.target.href;
          if (src) send("network", "resource failed to load", "", scrub(src));
          return;
        }
        var err = event.error;
        send("error", (err && err.message) || event.message || "unknown error", err && err.stack);
      } catch (e) { /* ignore */ }
    }, true);

    window.addEventListener("unhandledrejection", function (event) {
      try {
        var reason = event.reason;
        var message = reason && reason.message ? reason.message : String(reason);
        send("rejection", message, reason && reason.stack);
      } catch (e) { /* ignore */ }
    });
  } catch (e) { /* ignore */ }

  try {
    var origError = console.error;
    var origWarn = console.warn;
    console.error = function () {
      // See \`errorArgReport\`: an Error here belongs to the error channel, so its dedupe
      // key matches the window listener's copy of the same throw. It MUST keep winning
      // first — that covers React 19's Error-argument form. \`reactBoundaryReport\` is
      // the second and last escape hatch (DEV-2875): React 18's boundary log has no
      // Error argument, so it only gets a look once the first has declined. Passthrough
      // is outside both branches — the reporter must never change the demo's own
      // console output.
      var report = errorArgReport(arguments);
      if (report) send("error", report.message, report.stack);
      else {
        var boundary = reactBoundaryReport(arguments);
        if (boundary) send("error", boundary.message, boundary.stack);
        else send("console-error", argsToMessage(arguments), "");
      }
      if (origError) origError.apply(console, arguments);
    };
    console.warn = function () {
      send("console-warn", argsToMessage(arguments), "");
      if (origWarn) origWarn.apply(console, arguments);
    };
  } catch (e) { /* ignore */ }

  try {
    if (typeof window.fetch === "function") {
      var origFetch = window.fetch;
      window.fetch = function (input, init) {
        var target = input && input.url ? input.url : input;
        var method = (init && init.method) || (input && input.method) || "GET";
        return origFetch.apply(window, arguments).then(
          function (res) {
            try {
              if (res && !res.ok) {
                send("network", method + " " + res.status, "", scrub(target));
              }
            } catch (e) { /* ignore */ }
            return res;
          },
          function (err) {
            try {
              send("network", method + " failed: " + ((err && err.message) || "error"), "", scrub(target));
            } catch (e) { /* ignore */ }
            throw err;
          }
        );
      };
    }
  } catch (e) { /* ignore */ }

  try {
    var XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype && XHR.prototype.open) {
      var origOpen = XHR.prototype.open;
      XHR.prototype.open = function (method, url) {
        try {
          this.__hotMethod = method;
          this.__hotUrl = url;
          this.addEventListener("error", function () {
            send("network", String(this.__hotMethod) + " failed", "", scrub(this.__hotUrl));
          });
          this.addEventListener("load", function () {
            if (this.status >= 400) {
              send("network", String(this.__hotMethod) + " " + this.status, "", scrub(this.__hotUrl));
            }
          });
        } catch (e) { /* ignore */ }
        return origOpen.apply(this, arguments);
      };
    }
  } catch (e) { /* ignore */ }
})();
`;

/**
 * The reporter as a *single physical line*, for prepending to a JS module entry.
 *
 * DEV-2557. Whatever we prepend to the entry shifts every position the bundler
 * reports for that file, and the visitor is shown those positions verbatim. Inlining
 * the reporter body cost 226 lines at the releases the Sentry events were tagged
 * with, and 283 after DEV-2552 grew it — which is how a syntax error in a 70-line
 * file came back as "(257:22)". One line of prefix means one line of shift.
 *
 * Why an indirect eval and not a separate module the entry imports: a new module
 * would put a specifier the author never wrote into the graph, next to a moving entry
 * path, entangled with `resolveSandboxEntry`, `sameFiles` and `stampEntry`, and would
 * depend on the classic bundler evaluating an injected dependency before the entry
 * body. Its failure mode is a blank preview. This form has zero graph interaction.
 *
 * Why `(0,eval)` and not `eval`: the indirect form evaluates in global scope, where
 * the reporter's bare `window`/`parent`/`document`/`location`/`XMLHttpRequest`
 * resolve, and where it leaks no bindings into the bundler's module wrapper.
 *
 * Why the try/catch: if `eval` is ever unavailable, that must cost monitoring on this
 * path and never the demo. An entry that resolves to an HTML file (`parcel`/`static`
 * with an `htmlEntry` — see `resolveSandboxEntry`) keeps the `<script>` injection as a
 * working channel; anything else, the vue entry included, reaches the reporter only
 * through this one. Verified live rather than inferred, since the catch would hide the
 * failure: `window.__hotRunnerMonitor` is true inside the real Sandpack preview iframe
 * for both a vue and a react entry.
 *
 * Still byte-deterministic: a pure function of a constant, computed once at module
 * load — nothing hashed, padded, timestamped or randomised — so `sameFiles` keeps
 * skipping the no-op compile (see `injectReporter` below).
 *
 * `alreadyInjected` still matches it: `JSON.stringify` escapes the quotes around
 * MONITOR_MESSAGE_TYPE but leaves the string itself verbatim, so a double injection
 * stays a no-op.
 *
 * One physical line is not free, and the cost lands somewhere non-obvious: babel's code
 * frame prints the two lines above the fault verbatim, so a syntax error on authored
 * line 1 or 2 renders all ~14.9 KB of this into the compile message ahead of the line
 * that is actually wrong, and `MONITOR_COMPILE_MESSAGE_MAX` then cuts the diagnostic off
 * (measured after DEV-2875 grew the reporter: 294 characters of usable message with the
 * reporter inlined, 15,486 with it on one line — was 289 / 12,872 before that ticket).
 * `boundCompileMessage` in sandpack.ts therefore replaces this exact
 * constant with a marker before the cap runs — `stripInjectedReporter`, which is
 * coupled to this constant on purpose. Do not change the shape of this line without
 * checking that strip still fires.
 *
 * What this does NOT fix: the entry is generally transpiled before the injection —
 * `transpileFilesForParcel` for the parcel entries, and babel does not use
 * `retainLines` — so a reported line is still a *compiled* line. Do not read this as
 * "line numbers are now correct" for any entry: measured on the vue starter, a syntax
 * error typed on authored line 11 reports line 14, the residual +3 coming from that
 * entry's own TS transform. This removes the distortion we add (the same error
 * reported line 316 before), and only source maps can close the rest.
 */
export const REPORTER_MODULE_LINE = `try{(0,eval)(${JSON.stringify(REPORTER_SOURCE)})}catch(e){}`;

/** True when `source` already carries the reporter. */
function alreadyInjected(source: string): boolean {
  return source.indexOf(MONITOR_MESSAGE_TYPE) !== -1;
}

/**
 * Insert the reporter into an HTML document, as early as the document allows: a
 * fault raised while the demo's own scripts evaluate is exactly the class we are
 * here for, so the reporter has to be hooked before them.
 *
 * Inserted with no surrounding whitespace, and the tag deletes its own element
 * (see `inject-html.ts`): a React 18 hydrator that owns the whole document — remix's
 * `hydrateRoot(document, …)` — strict-matches every child of `<head>`, and a leftover
 * newline text node fails that match exactly as the `<script>` element does. Both
 * halves were measured against the remix starter; either one alone still throws
 * React #418 (DEV-2580).
 *
 * The insertion point itself is `insertInjectedTag` — shared with the scheme
 * receiver, and *before* `<body>` in a document with no `<head>`, which is what
 * DEV-2724 turned on.
 *
 * Returns `html` unchanged when it is already injected.
 */
export function injectReporterIntoHtml(html: string): string {
  if (alreadyInjected(html)) return html;
  return insertInjectedTag(html, injectedScriptTag(REPORTER_SOURCE));
}

/**
 * Add the reporter to the file map the Tier-1 bundler will see.
 *
 * `entryPath` is the resolved sandbox entry — an HTML file for the `parcel` and
 * `static` environments (which is every Tier-1 example that has one), a JS module
 * otherwise. Both are handled, because a module entry still runs before the demo.
 *
 * The module branch prepends `REPORTER_MODULE_LINE`, which is one physical line, so
 * the compile positions the visitor is shown are off by one rather than by the
 * reporter's length (DEV-2557). The HTML branch is deliberately left as it is: it is
 * Tier-2's only monitoring channel (`workers/api/src/monitor-inject.ts`) and widening
 * the eval bet to it wants its own decision.
 *
 * Byte-deterministic by construction: no timestamp, no id, no ordering that
 * depends on iteration. `SandpackRuntime.sameFiles` skips the compile when the
 * sandbox is unchanged, and a reporter that differed between two builds of the
 * same sources would turn every keystroke into a real diff and defeat that check.
 *
 * Returns `files` unchanged when the entry is missing from the map — that is
 * `setupFrom`'s error to raise, with its own message (DEV-2130), and it must not
 * become "monitoring broke the preview".
 */
export function injectReporter(files: Record<string, string>, entryPath: string): Record<string, string> {
  const source = files[entryPath];
  if (source === undefined) return files;
  if (alreadyInjected(source)) return files;
  const injected = entryPath.toLowerCase().endsWith(".html")
    ? injectReporterIntoHtml(source)
    : REPORTER_MODULE_LINE + "\n" + source;
  return { ...files, [entryPath]: injected };
}

// ---- T08: the lite beacon — standalone mode for `/d` and `/embed` -------------
//
// ADR §C.5 / contract §9. A wholly separate reporter from `REPORTER_SOURCE` above,
// never composed with it: `REPORTER_SOURCE` only ever runs inside a Tier-1 sandbox
// entry or a Tier-2 preview document, both framed by the authoring app, which is
// what makes `postMessage(..., "*")` to `parent` the right transport there.
//
// `/d`/`/embed` documents ARE sometimes framed by our own runner — the authoring
// app's FullMode view (`App.tsx`) frames `/d/:id/` cross-origin to show a saved
// demo's build full-window — so "no parent frame" is not a claim about every
// request this reporter ever sees. What is still true, and is the actual reason
// this needs no runtime parent-detection, is narrower: this reporter is injected
// only at the `share.ts` serve seam, never into a Tier-1 sandbox entry or a Tier-2
// preview document, so it never runs anywhere `REPORTER_SOURCE`'s `postMessage`
// transport would be the right answer — a FullMode-framed `/d/:id/` is still just
// the public build, standalone-transported exactly like a direct visit, and that
// framing costs nothing (no listener there expects this reporter's beacon either
// way). Standalone by construction, not by detection. Keeping the two reporters
// wholly separate is also what keeps `REPORTER_SOURCE` byte-for-byte unchanged, so
// the framed Tier-1/Tier-2 tests stay green untouched.
//
// It sends far less than the framed reporter: only `error`/`unhandledrejection`
// (no console wrapping, no fetch/XHR monkey-patching — §9's payload has no
// `console`/`network` kind at all) and four sampled web vitals, each as its own
// `navigator.sendBeacon` POST to same-origin `/telemetry/lite` (contract §1: on
// the same `demos.handsontable.com` zone as `/d` and `/embed` themselves, so this
// is same-origin regardless of who frames the page).

/** Same-origin beacon target (contract §9). */
export const LITE_ENDPOINT = "/telemetry/lite";

/** The injection idempotency marker — distinct from `MONITOR_MESSAGE_TYPE`
 *  (never sent in a beacon payload; §9's payload has no such field at all).
 *  Deliberately the same string as the reporter's own double-injection guard
 *  property (`window.__hotLiteMonitor`) below, so the marker costs no extra
 *  bytes in the shipped script — one string, two jobs, matched by the test
 *  that pins `injectLiteReporterIntoHtml`'s idempotency. */
export const LITE_REPORTER_MARKER = "__hotLiteMonitor";

/** §9: "Vitals are sampled at 10% per page view, decided once per page." */
export const LITE_VITALS_SAMPLE_RATE = 0.1;

/**
 * Client-side truncation caps, in **UTF-8 bytes** — deliberately tighter than
 * the contract's own per-field ceilings (`LITE_MESSAGE_MAX` 500 chars /
 * `LITE_STACK_MAX` 2000 chars, `telemetry/lite.ts`): that module's own doc
 * comment measures a maxed-out `st` alone at ~2150 bytes, already over
 * `LITE_PAYLOAD_MAX_BYTES` (2048) by itself, and says producing a payload
 * that actually fits is the *sender's* job. A first stack frame is enough
 * for a fingerprint; the rest is only volume this reporter would otherwise
 * have to trim away at send time anyway.
 *
 * Bytes, not characters, on purpose (T08-D, fix round I2): a JS string's
 * `.length` counts UTF-16 code units, and every non-ASCII character (a
 * non-English error message, an emoji, a curly quote) costs 2-4 UTF-8 bytes
 * for one `.length` unit — a char-count cap silently let a non-ASCII payload
 * grow past `LITE_PAYLOAD_MAX_BYTES` (2048), which the ingest route then
 * drops outright (`isValidLitePayload`'s own total-byte check), so a
 * non-English error was reported as "sent" client-side and never actually
 * stored. `reporterSource`'s `bt()` (byte-trim) enforces this in the shipped
 * ES5, and `bc()` (build+send) makes a final `bl()` (byte-length) check
 * against the whole serialized payload before ever calling `sendBeacon` —
 * belt and braces against JSON's own escaping (`"`/`\`/control characters
 * each cost 2+ output characters) pushing an already-trimmed payload back
 * over budget.
 */
export const LITE_CLIENT_NAME_MAX_BYTES = 100;
export const LITE_CLIENT_MESSAGE_MAX = 300;
export const LITE_CLIENT_STACK_MAX = 300;

/**
 * Size budget for the *injected script itself* — distinct from
 * `LITE_PAYLOAD_MAX_BYTES` (`telemetry/lite.ts`), which bounds one beacon
 * body.
 *
 * T08-D (see the task Outcome): the task's own Goal prose reads "a script
 * under 2 KB." Measured (`pipeline/lite-beacon.test.mjs`) at ~2.8 KB for the
 * `<script>` element's own content with a realistic config, after cutting
 * every inline comment and all non-essential whitespace from the shipped
 * string (the rationale that would normally sit beside this code moved to
 * `reporterSource`'s own doc comment instead, which costs no shipped bytes).
 * What is left is `sendBeacon` transport, truncation, the per-page-once
 * sampling coin flip, and three `PerformanceObserver` registrations (LCP,
 * CLS, INP) each wrapped in its own defensive `try`/`catch` — none of it
 * dead weight. Getting under 2 KB from here means either accepting a
 * correctness cut (documented alternatives considered and rejected: reading
 * `layout-shift`/`event`/`largest-contentful-paint` once via
 * `performance.getEntriesByType` instead of a live, buffered
 * `PerformanceObserver` is the standard *incorrect* shortcut — those entry
 * types are not reliably in the global timeline buffer without an active
 * observer, which this reporter cannot verify without a real browser) or a
 * minifier in the injection path, which this feature does not have. This
 * constant is set from the measured size with headroom for a longer
 * `demo`/`fw` string, not the Goal's literal figure — flagged for the
 * controller in the task's Outcome/Concerns.
 */
export const LITE_REPORTER_MAX_BYTES = 3072;

/** Baked into the injected script at the `share.ts` serve seam — one build's
 *  worth of context the client cannot otherwise know (its own demo id, pinned
 *  Handsontable major, and framework). */
export interface LiteReporterConfig {
  surface: LiteSurface;
  demo: string;
  ht: HtMajor;
  fw: Framework;
}

/** Defence in depth for embedding `config`'s (allow-listed, but not worth
 *  trusting blindly) strings inside an inline `<script>` body: a literal
 *  `</script` in the JSON would otherwise close the tag early. None of §9's
 *  `demo`/`ht`/`fw` values can contain this today (a `shortId()`, a closed
 *  `HT_MAJORS` member, a `config/frameworks.json` key) — this is a backstop
 *  against that staying true, not a defence this reporter currently needs. */
function escapeScriptClose(source: string): string {
  return source.replace(/<\/(script)/gi, "<\\/$1");
}

/**
 * The standalone reporter, as ES5 source — hand-written for the same reason
 * `REPORTER_SOURCE` is (`pipeline/lite-beacon.test.mjs` parses it with `acorn`
 * `ecmaVersion: 5` and *executes* it against a fake DOM, never just reads it).
 *
 * Every browser API it touches — `window`, `document`, `navigator`,
 * `performance`, `PerformanceObserver`, `Blob`, `Math`, `Date` — is referenced
 * as a bare global, exactly like `REPORTER_SOURCE`'s `window`/`parent`/etc.: in
 * production these resolve to the real globals; a test can shadow every one of
 * them with `new Function("window", "document", ..., SOURCE)(fakeWindow, ...)`,
 * which is what makes the sampling test able to fix `Math.random()` without
 * touching the real global `Math` (a shared, mutable, cross-test resource).
 *
 * Self-defence rules, same as `REPORTER_SOURCE`: every hook body is wrapped so
 * a throw cannot break the page it observes, and `__hotLiteMonitor` makes a
 * double injection a no-op.
 *
 * Written with no inline comments and minimal whitespace — the shipped script
 * itself has a size budget (`LITE_REPORTER_MAX_BYTES`, `pipeline/lite-beacon.
 * test.mjs`) distinct from the 2 KB *payload* cap; the rationale that would
 * normally sit beside this code lives here instead, where it costs no bytes:
 *
 * - **LCP**: reports the *last* `largest-contentful-paint` candidate observed
 *   before the page hides, not the first — candidates keep arriving until the
 *   first user interaction, and the first one is reliably an under-estimate.
 * - **CLS**: summed for the page's lifetime, not session-windowed. The real
 *   CLS algorithm groups shifts into gap/limit-bounded sessions and reports
 *   the worst window; this is a simpler running total, so it can overstate a
 *   page with several small, separated shifts.
 * - **INP approximation** (documented per the task's Outcome, ADR §C.5): the
 *   longest single `event`-timing entry's `duration` observed during the
 *   page's life, filtered to real interactions (`interactionId > 0`) at the
 *   same 40 ms `durationThreshold` the `web-vitals` library defaults to. This
 *   is *not* the spec metric — real INP groups one interaction's several
 *   events (pointerdown/pointerup/click) into a single duration and reports
 *   the 98th percentile across every interaction in the page's life; this
 *   reports one number, the single longest event seen, unweighted and
 *   ungrouped. It trends the same direction as real INP (a page with one slow
 *   handler shows a high value; a smooth page shows a low one) but is not
 *   comparable to a real-INP number from another source.
 * - **TTFB**: `PerformanceNavigationTiming.responseStart`, the one vital here
 *   that is not an observer/approximation — read once, synchronously, at
 *   report time.
 *
 * All four fire together, once, at `visibilitychange` (hidden) or `pagehide`
 * — never eagerly — because LCP and CLS are only final once the page is done
 * being looked at.
 */
function reporterSource(config: LiteReporterConfig): string {
  return `(function(){
try{if(window.__hotLiteMonitor)return;window.__hotLiteMonitor=true;}catch(e){return;}
var EP=${JSON.stringify(LITE_ENDPOINT)},SURF=${JSON.stringify(config.surface)},DEMO=${JSON.stringify(config.demo)},HTM=${JSON.stringify(config.ht)},FWK=${JSON.stringify(config.fw)};
var CEIL=${MONITOR_EVENT_CEILING},NMAX=${LITE_CLIENT_NAME_MAX_BYTES},MMAX=${LITE_CLIENT_MESSAGE_MAX},SMAX=${LITE_CLIENT_STACK_MAX},PMAX=${LITE_PAYLOAD_MAX_BYTES},RATE=${LITE_VITALS_SAMPLE_RATE};
var used=0,sent={};
function bl(s){try{return unescape(encodeURIComponent(s)).length;}catch(e){return 1e9;}}
function bt(s,n){while(bl(s)>n)s=s.slice(0,-1);return s;}
function dv(){var u="";try{u=(navigator&&navigator.userAgent)||"";}catch(e){}
return /ipad|tablet|playbook|silk/i.test(u)?"tablet":/mobi|iphone|ipod|android.*mobile|windows phone/i.test(u)?"mobile":"desktop";}
var DEV=dv();
function bc(t,f){try{
var p={v:1,t:t,s:SURF,demo:DEMO,ht:HTM,fw:FWK,dev:DEV,ts:Date.now()};
for(var k in f)p[k]=f[k];
var j=JSON.stringify(p);
if(bl(j)>PMAX)return;
if(navigator&&typeof navigator.sendBeacon==="function")navigator.sendBeacon(EP,j);
}catch(e){}}
function se(n,m,st){try{
if(used>=CEIL)return;
used+=1;
var f={n:bt(n||"Error",NMAX),m:bt(m||"unknown error",MMAX),val:null};
if(st)f.st=bt(st,SMAX);
bc("err",f);
}catch(e){}}
function sv(n,val){try{
if(sent[n])return;
if(typeof val!=="number"||!isFinite(val))return;
sent[n]=true;
bc("vital",{n:n,val:val});
}catch(e){}}
try{
window.addEventListener("error",function(ev){try{
if(!ev||(!ev.error&&ev.target&&ev.target!==window))return;
var er=ev.error;
se((er&&er.name)||"Error",(er&&er.message)||(ev&&ev.message)||"unknown error",er&&er.stack);
}catch(e){}},true);
window.addEventListener("unhandledrejection",function(ev){try{
var r=ev&&ev.reason;
se((r&&r.name)||"UnhandledRejection",r&&r.message?r.message:String(r),r&&r.stack);
}catch(e){}});
}catch(e){}
var smp=false;
try{smp=Math.random()<RATE;}catch(e){}
if(smp){
var lc=null,cls=0,inp=0,rep=false;
var ob=function(t,cb,dt){try{
var o=new PerformanceObserver(cb),op={type:t,buffered:true};
if(dt)op.durationThreshold=dt;
o.observe(op);
}catch(e){}};
ob("largest-contentful-paint",function(l){var es=l.getEntries();if(es.length)lc=es[es.length-1];});
ob("layout-shift",function(l){var es=l.getEntries();for(var i=0;i<es.length;i++){if(!es[i].hadRecentInput)cls+=es[i].value||0;}});
ob("event",function(l){var es=l.getEntries();for(var i=0;i<es.length;i++){var en=es[i];if(en.interactionId&&en.interactionId>0&&en.duration>inp)inp=en.duration;}},40);
var rp=function(){
if(rep)return;
rep=true;
try{if(lc)sv("LCP",lc.renderTime||lc.loadTime||0);}catch(e){}
sv("CLS",cls);
if(inp>0)sv("INP",inp);
try{
var nv=performance&&performance.getEntriesByType&&performance.getEntriesByType("navigation")[0];
if(nv&&typeof nv.responseStart==="number")sv("TTFB",nv.responseStart);
}catch(e){}
};
try{
document.addEventListener("visibilitychange",function(){try{if(document.visibilityState==="hidden")rp();}catch(e){}});
window.addEventListener("pagehide",rp);
}catch(e){}
}
})();
`;
}

/** True when `html` already carries the lite reporter (`LITE_REPORTER_MARKER`
 *  survives the JSON-escaping of the source, same as `MONITOR_MESSAGE_TYPE`
 *  does for the framed reporter — see `alreadyInjected` above). */
function liteAlreadyInjected(html: string): boolean {
  return html.indexOf(LITE_REPORTER_MARKER) !== -1;
}

/**
 * Insert the standalone lite reporter into a `/d`/`/embed` document, exactly
 * where `injectReporterIntoHtml` inserts the framed one (`insertInjectedTag`)
 * and with the same DEV-2580 self-removing tag (`injectedScriptTag`) — the
 * same Remix hydration constraint applies here: a `/d`/`/embed` build can be
 * any of the same SSR frameworks.
 *
 * Idempotent: returns `html` unchanged when already injected.
 */
export function injectLiteReporterIntoHtml(html: string, config: LiteReporterConfig): string {
  if (liteAlreadyInjected(html)) return html;
  return insertInjectedTag(html, injectedScriptTag(escapeScriptClose(reporterSource(config))));
}
