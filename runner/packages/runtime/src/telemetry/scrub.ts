// Observability contract §3 / ADR §E.4 — the one scrubber, run in the browser
// (Faro's `beforeSend`) and authoritatively again at ingest, on the normalised
// OTLP record (ADR §B.2 step 1). Structural types only — no `@grafana/faro-core`
// import, so this module stays DOM/Cloudflare-free and importable from
// `pipeline/` under plain Node. Typechecked against the real
// `@grafana/faro-web-sdk` types with a temporary probe.

import { redactPreviewHosts, type MonitorKind } from "../monitor.js";
import { stripCodeFrame } from "./fingerprint.js";
import { browserOf, deviceOf } from "./classify.js";
import { ALLOWED_ATTRIBUTE_KEYS } from "./attrs.js";
import { INBOX_RECORD_MAX_BYTES } from "./inbox.js";

// ---- Structural mirrors of the Faro shapes we scrub ---------------------
// Match `@grafana/faro-core`'s `TransportItem<P>`/`Meta` closely enough that
// a real Faro item satisfies them structurally, without importing the
// package (verified against the real `@grafana/faro-web-sdk` types with a
// temporary probe). No `[key: string]: unknown` index signature: a real
// `TransportItem` carries none, and TS requires the source type to match.
// `type` is `string`, not `TransportItemType`'s literal union: TS does not
// consider an enum member assignable to an unrelated literal union.
export interface ScrubbableFaroStackFrame {
  filename?: string;
  /** ADR §C.3 drain-time symbolication: the real `ExceptionStackFrame`
   *  already carries these at runtime; `structuredClone` copies them
   *  through unchanged, only the type never declared them. `function` is a
   *  JS identifier, never a URL — no new redaction rule needed. */
  function?: string;
  lineno?: number;
  colno?: number;
}

export interface ScrubbableFaroPayload {
  /** `LogEvent.message` */
  message?: string;
  /** `ExceptionEvent.value` */
  value?: string;
  /** `ExceptionEvent.type` (the error class name, e.g. `TypeError`) */
  type?: string;
  /** `EventEvent.name` */
  name?: string;
  /** `MeasurementEvent.values` */
  values?: Record<string, number>;
  /** ISO 8601 — every Faro event shape carries its own `timestamp`. */
  timestamp?: string;
  /** `ExceptionEvent.stacktrace` */
  stacktrace?: { frames?: ScrubbableFaroStackFrame[] };
  /** `LogEvent.context` / `ExceptionEvent.context` / `MeasurementEvent.context` */
  context?: Record<string, string>;
  /** `EventEvent.attributes` */
  attributes?: Record<string, string>;
}

export interface ScrubbableFaroMeta {
  user?: unknown;
  page?: { url?: string };
  /** Faro's raw `userAgent` in; `reduceBrowserMeta` replaces the whole object
   *  with just `browser`/`device` on the way out (§3, "reduce any browser
   *  meta to the device and browser classes"). */
  browser?: { userAgent?: string; browser?: string; device?: string };
  /** Faro's `app` config — `name`/`version`/`environment` are exactly `service.name`
   *  / `service.version` / `deployment.environment.name` (§3) under Faro's own
   *  naming, set once at `initTelemetry()`. */
  app?: { name?: string; version?: string; environment?: string };
  os?: unknown;
  device?: unknown;
}

export interface ScrubbableFaroItem {
  /** `TransportItemType`'s runtime values (`"exception"`, `"log"`,
   *  `"measurement"`, `"trace"`, `"event"`), typed `string` rather than that
   *  literal union — see the file header. */
  type: string;
  payload: ScrubbableFaroPayload;
  meta: ScrubbableFaroMeta;
}

/** A normalised OTLP log record (§8), or near enough — the ingest-time shape
 *  produced by `convert.ts` before it is packed into the inbox. */
export interface ScrubbableOtlpRecord {
  body?: string;
  attributes?: Record<string, string>;
  resourceAttributes?: Record<string, string>;
}

export type Scrubbable = ScrubbableFaroItem | ScrubbableOtlpRecord;

function isFaroItem(record: Scrubbable): record is ScrubbableFaroItem {
  return (
    typeof (record as ScrubbableFaroItem).type === "string" &&
    typeof (record as ScrubbableFaroItem).payload === "object" &&
    (record as ScrubbableFaroItem).payload !== null &&
    typeof (record as ScrubbableFaroItem).meta === "object" &&
    (record as ScrubbableFaroItem).meta !== null
  );
}

/** §3: strip the query string and fragment off a URL-valued field. Absolute
 *  URLs are parsed properly; anything else (a bare path, or not a URL at all)
 *  falls back to cutting at the first `?`/`#`, so a malformed value from
 *  untrusted input degrades safely instead of throwing. */
export function stripQueryAndFragment(value: string): string {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    const cut = value.search(/[?#]/);
    return cut === -1 ? value : value.slice(0, cut);
  }
}

/** Faro's console instrumentation is disabled (ADR §E.4), but a demo-runtime
 *  `console-error`/`console-warn` relay (`monitor.ts`) can surface as a Faro
 *  log item, tagged via `context["hot.relay"]`. §3 forbids console output
 *  outright, so a matching item is dropped, not scrubbed. */
const CONSOLE_KINDS: ReadonlySet<MonitorKind> = new Set(["console-error", "console-warn"]);

function isConsoleItem(item: ScrubbableFaroItem): boolean {
  if (item.type !== "log") return false;
  const kind = item.payload.context?.["hot.relay"];
  return typeof kind === "string" && CONSOLE_KINDS.has(kind as MonitorKind);
}

/** §3: "reduce any browser meta to the device and browser classes" —
 *  replaces the rich `MetaBrowser`/`MetaOS`/`MetaDevice` objects with the
 *  same two coarse classes `classify.ts` computes for anonymous analytics. */
function reduceBrowserMeta(meta: ScrubbableFaroMeta): void {
  const ua = meta.browser?.userAgent;
  if (ua !== undefined || meta.browser !== undefined || meta.os !== undefined || meta.device !== undefined) {
    meta.browser = { browser: browserOf(ua ?? ""), device: deviceOf(ua ?? "") };
  }
  delete meta.os;
  delete meta.device;
}

function allowlistAttributes(attrs: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!attrs) return attrs;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (ALLOWED_ATTRIBUTE_KEYS.has(key)) out[key] = value;
  }
  return out;
}

/** §3: strips a query/fragment off a URL *embedded* inside a message/value
 *  string (unlike `stripQueryAndFragment`, which only handles a field that
 *  IS a URL). Exported so `text-scrub.ts` runs the same rule server-side.
 *  Matches after `redactPreviewHosts` (`scrubText` runs this last), so the
 *  pattern optionally consumes the `<preview>` placeholder first. */
const EMBEDDED_URL_PATTERN = /\bhttps?:\/\/(?:<preview>)?[^\s"'<>)]*/gi;

export function stripUrlQueriesInText(text: string): string {
  return text.replace(EMBEDDED_URL_PATTERN, (url) => {
    const cut = url.search(/[?#]/);
    return cut === -1 ? url : url.slice(0, cut);
  });
}

/**
 * Contract §3's "never sent" list includes "an IP" — applied browser-side
 * too, exported for `text-scrub.ts`'s server-side pass. Bounded quantifiers
 * throughout: no ReDoS backtrack regardless of input shape
 * (`pipeline/o11y-redos.test.mjs` pins the timing).
 *
 * The START boundary is a capturing alternation, never a lookbehind:
 * `new RegExp` with `(?<!...)` throws on Safari <16.4, and this module is
 * imported EAGERLY at browser boot — a throw here would fail the whole
 * telemetry import on any older Safari.
 */
const IPV4_OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d{2}|[1-9]?\\d)";
const IPV4_PATTERN = new RegExp(`(^|[^\\w.-])(?:${IPV4_OCTET}\\.){3}${IPV4_OCTET}(?![\\w-]|\\.\\d)`, "g");

/** IPv6, the standard bounded form (7 alternatives, all `{1,4}`/`{1,7}`-capped) —
 *  same lookbehind-avoidance boundary as IPv4 above. */
const IPV6_GROUP = "[0-9A-Fa-f]{1,4}";
const IPV6_PATTERN = new RegExp(
  "(^|[^\\w:])(?:" +
    `(?:${IPV6_GROUP}:){7}${IPV6_GROUP}` +
    `|(?:${IPV6_GROUP}:){1,7}:` +
    `|(?:${IPV6_GROUP}:){1,6}:${IPV6_GROUP}` +
    `|(?:${IPV6_GROUP}:){1,5}(?::${IPV6_GROUP}){1,2}` +
    `|(?:${IPV6_GROUP}:){1,4}(?::${IPV6_GROUP}){1,3}` +
    `|(?:${IPV6_GROUP}:){1,3}(?::${IPV6_GROUP}){1,4}` +
    `|(?:${IPV6_GROUP}:){1,2}(?::${IPV6_GROUP}){1,5}` +
    `|${IPV6_GROUP}:(?::${IPV6_GROUP}){1,6}` +
    `|:(?:(?::${IPV6_GROUP}){1,7}|:)` +
    ")(?![\\w:])",
  "g",
);

// IPv4 first, then IPv6: an IPv4-mapped IPv6 address's octets are
// hex-digit-shaped, so IPv6 alone can eat a leading fragment and leave a
// real piece of the address behind.
export function redactIpInText(text: string): string {
  return text
    .replace(IPV4_PATTERN, (_match, prefix: string) => `${prefix}<ip>`)
    .replace(IPV6_PATTERN, (_match, prefix: string) => `${prefix}<ip>`);
}

/**
 * ReDoS defense-in-depth: bound a free-text string to this length BEFORE any
 * scrub/redact regex in this module ever sees it, so an unidentified pattern
 * still has a bounded worst case.
 *
 * Set to {@link INBOX_RECORD_MAX_BYTES} (contract §8's 256 KB drop limit),
 * not a smaller number: `pipeline/o11y-normalise.test.mjs`'s 300 KB-message
 * oversize tests rely on the untruncated length surviving scrub far enough
 * that the record-level size check (which runs AFTER scrubbing) still
 * measures over the limit.
 */
export const SCRUB_TEXT_MAX_CHARS = INBOX_RECORD_MAX_BYTES;

export function truncateForScrub(value: string): string {
  return value.length > SCRUB_TEXT_MAX_CHARS ? value.slice(0, SCRUB_TEXT_MAX_CHARS) : value;
}

function scrubText(value: string | undefined): string | undefined {
  if (value === undefined) return value;
  return redactIpInText(stripUrlQueriesInText(stripCodeFrame(redactPreviewHosts(truncateForScrub(value)))));
}

/**
 * §3: "`redactPreviewHosts` on every string" — not only the fields the
 * targeted rules above cover. A preview URL is a session credential, so it
 * must never survive in an allowlisted attribute or resource attribute
 * (`hot.framework` becomes a Loki label). Walks every string leaf in place;
 * idempotent, so it can safely run last, after every targeted rule.
 */
function redactStringsDeep<V>(value: V): V {
  if (typeof value === "string") return redactPreviewHosts(truncateForScrub(value)) as V;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = redactStringsDeep(value[i]);
    return value;
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // Keys too, not only values: a `MeasurementEvent.values` object's keys
    // are metric names, JSON.stringify'd straight into the OTLP body
    // (`convert.ts#faroBody`) without ever passing back through a value
    // position this walk would otherwise reach.
    for (const key of Object.keys(obj)) {
      const redactedKey = redactPreviewHosts(truncateForScrub(key));
      const redactedValue = redactStringsDeep(obj[key]);
      if (redactedKey !== key) delete obj[key];
      obj[redactedKey] = redactedValue;
    }
    return value;
  }
  return value;
}

/**
 * The one scrubber (ADR §E.4). Never mutates its argument; returns a scrubbed
 * clone, or `null` when the whole record must be dropped (a console item).
 *
 * Applies, in this order: drop console items; drop `meta.user`; reduce browser
 * meta to device/browser classes; strip query/fragment and redact preview hosts
 * on the page URL and every stack-frame filename; redact preview hosts and strip
 * Babel code frames from message-bearing text; allowlist `attributes` /
 * `resourceAttributes` / `context` (§3's forbidden attributes — `url.full`, geo,
 * ASN, the user pseudonym, an email, an IP, a user-agent string — are simply
 * never on the allowlist); finally, `redactPreviewHosts` on every
 * remaining string in the record, not only the fields named above — an
 * allowlisted attribute value (`session.id`, `hot.framework`) is still
 * client-supplied and can carry a preview host too.
 */
export function scrubTelemetry<T extends Scrubbable>(record: T): T | null {
  const clone = structuredClone(record) as T;

  if (isFaroItem(clone)) {
    if (isConsoleItem(clone)) return null;

    delete clone.meta.user;
    reduceBrowserMeta(clone.meta);

    if (clone.meta.page?.url !== undefined) {
      clone.meta.page.url = redactPreviewHosts(stripQueryAndFragment(clone.meta.page.url));
    }

    for (const frame of clone.payload.stacktrace?.frames ?? []) {
      // An untrusted client can send a `null`/non-object entry inside
      // `stacktrace.frames` (`{"stacktrace": {"frames":[null]}}` is valid
      // JSON) — `frame.filename` on a `null` would throw a `TypeError` that
      // escapes as an uncaught `500`, contradicting this module's own
      // "never a 500" contract. Skipped, not scrubbed: there is nothing in
      // a non-object frame to redact.
      if (!frame || typeof frame !== "object") continue;
      // A stack frame's `filename` is a URL-valued field too (a bundler's
      // cache-busting `?t=`/`?v=` query string shows up here as often as on
      // `meta.page.url`), so it gets the same two rules.
      if (frame.filename !== undefined) {
        frame.filename = redactPreviewHosts(stripQueryAndFragment(frame.filename));
      }
    }

    clone.payload.message = scrubText(clone.payload.message);
    clone.payload.value = scrubText(clone.payload.value);
    clone.payload.context = allowlistAttributes(clone.payload.context);
    clone.payload.attributes = allowlistAttributes(clone.payload.attributes);

    redactStringsDeep(clone.payload);
    redactStringsDeep(clone.meta);
    return clone;
  }

  const otlp = clone as ScrubbableOtlpRecord;
  otlp.body = scrubText(otlp.body);
  otlp.attributes = allowlistAttributes(otlp.attributes);
  otlp.resourceAttributes = allowlistAttributes(otlp.resourceAttributes);
  redactStringsDeep(otlp);
  return clone;
}
