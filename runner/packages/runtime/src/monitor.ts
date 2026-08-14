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

/** What the reporter observed. `stderr` is the only kind not raised in-page — it
 *  comes from the Tier-2 dev server via the session status poll. */
export type MonitorKind =
  | "error"
  | "rejection"
  | "console-error"
  | "console-warn"
  | "network"
  | "stderr";

export interface MonitorPayload {
  type: typeof MONITOR_MESSAGE_TYPE;
  kind: MonitorKind;
  message: string;
  /** Truncated. Absent for console and network events. */
  stack?: string;
  /** Network events only: scheme + host + path, query stripped. */
  url?: string;
}

/** True for a `message` event whose data is a well-formed reporter payload.
 *  Shape is validated here rather than at the callsite because the preview is
 *  cross-origin: anything on the page can post to us, so the sender check
 *  (`event.source === iframe.contentWindow`) and this are both required. */
export function isMonitorPayload(data: unknown): data is MonitorPayload {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return d["type"] === MONITOR_MESSAGE_TYPE
    && typeof d["kind"] === "string"
    && typeof d["message"] === "string";
}

/** Cap a message. Exported for the parent, which re-truncates rather than trusting
 *  a payload that crossed an origin boundary. */
export function truncateMessage(value: unknown, max: number = MONITOR_MESSAGE_MAX): string {
  const s = typeof value === "string" ? value : String(value);
  return s.length <= max ? s : s.slice(0, max) + "...";
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
      var m = truncate(message, MAX);
      var s = stack ? truncate(stack, STACK_MAX) : "";
      var k = kind + "|" + m + "|" + firstFrame(s);
      if (seen[k]) return;
      seen[k] = true;
      used++;
      var payload = { type: TYPE, kind: kind, message: m };
      if (s) payload.stack = s;
      if (url) payload.url = url;
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
          },
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
