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

/** Message length cap. Demo code is authored by anonymous visitors; a message can
 *  quote it, so it is truncated rather than relayed whole. */
export const MONITOR_MESSAGE_MAX = 500;

/** Stack cap. Enough for a fingerprint and a first frame, not a whole trace. */
export const MONITOR_STACK_MAX = 2000;

/** URL cap. A path this long is already unreadable; the rest is only volume. */
export const MONITOR_URL_MAX = 500;

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
    message: redactPreviewHosts(truncateMessage(payload.message, MONITOR_MESSAGE_MAX)),
  };
  if (payload.stack) {
    clean.stack = redactPreviewHosts(truncateMessage(payload.stack, MONITOR_STACK_MAX));
  }
  if (payload.url) {
    clean.url = redactPreviewHosts(truncateMessage(payload.url, MONITOR_URL_MAX));
  }
  return clean;
}

/** What the reporter observed. `stderr` is the only kind not raised in-page — it
 *  comes from the Tier-2 dev server via the session status poll. */
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
  /** Network events only: scheme + host + path, query stripped. */
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
 * rather than hundreds. Numbers, quoted strings and URLs are what differ between
 * two reports of the same fault (a row index, a version, a session id).
 *
 * Used for the Sentry fingerprint, not for the message the issue displays.
 */
export function normalizeMonitorMessage(message: string): string {
  return message
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/["'`][^"'`]*["'`]/g, "<str>")
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
  var CEILING = ${MONITOR_EVENT_CEILING};
  var MAX = ${MONITOR_MESSAGE_MAX};
  var STACK_MAX = ${MONITOR_STACK_MAX};
  var seen = {};
  var used = 0;

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
  function redact(s) {
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

  // Scheme + host + path. A query string can carry a token, and none of the
  // diagnostics here need one.
  function scrub(raw) {
    try {
      var a = document.createElement("a");
      a.href = String(raw);
      return a.protocol + "//" + a.host + a.pathname;
    } catch (e) {
      return "";
    }
  }

  function send(kind, message, stack, url) {
    try {
      if (used >= CEILING) return;
      var m = redact(truncate(message, MAX));
      var s = stack ? redact(truncate(stack, STACK_MAX)) : "";
      var k = kind + "|" + m + "|" + firstFrame(s);
      if (seen[k]) return;
      seen[k] = true;
      used++;
      var payload = { type: TYPE, kind: kind, message: m };
      if (s) payload.stack = s;
      if (url) payload.url = redact(url);
      parent.postMessage(payload, "*");
    } catch (e) { /* the reporter must never be the reason a demo breaks */ }
  }

  function argsToMessage(args) {
    var parts = [];
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      try {
        parts.push(a instanceof Error ? String(a && a.message) : typeof a === "string" ? a : String(a));
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
      send("console-error", argsToMessage(arguments), "");
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

/** True when `source` already carries the reporter. */
function alreadyInjected(source: string): boolean {
  return source.indexOf(MONITOR_MESSAGE_TYPE) !== -1;
}

/**
 * Insert the reporter into an HTML document, as early as the document allows: a
 * fault raised while the demo's own scripts evaluate is exactly the class we are
 * here for, so the reporter has to be hooked before them.
 *
 * Returns `html` unchanged when it is already injected.
 */
export function injectReporterIntoHtml(html: string): string {
  if (alreadyInjected(html)) return html;
  const tag = `<script>${REPORTER_SOURCE}</script>`;
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + "\n" + tag + html.slice(at);
  }
  const body = /<body\b[^>]*>/i.exec(html);
  if (body) {
    const at = body.index + body[0].length;
    return html.slice(0, at) + "\n" + tag + html.slice(at);
  }
  return tag + "\n" + html;
}

/**
 * Add the reporter to the file map the Tier-1 bundler will see.
 *
 * `entryPath` is the resolved sandbox entry — an HTML file for the `parcel` and
 * `static` environments (which is every Tier-1 example that has one), a JS module
 * otherwise. Both are handled, because a module entry still runs before the demo.
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
    : REPORTER_SOURCE + "\n" + source;
  return { ...files, [entryPath]: injected };
}
