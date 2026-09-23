// Observability contract §3 / ADR §E.4 — the one scrubber, run in the browser
// (Faro's `beforeSend`) and authoritatively again at ingest, on the normalised
// OTLP record (ADR §B.2 step 1). Structural types only — no `@grafana/faro-core`
// import, so this module stays DOM/Cloudflare-free and importable from
// `pipeline/` under plain Node (index.ts's header rule).
//
// Typechecked against the real `@grafana/faro-web-sdk` types (`apps/authoring`'s
// actual dependency) with a temporary probe, not just read by eye: a concrete,
// narrowed `TransportItem<LogEvent>` / `TransportItem<ExceptionEvent>` / etc.
// passes into and back out of `scrubTelemetry` with zero casts — the shape
// every real `pushLog`/`pushError`/`pushEvent`/`pushMeasurement` call site
// produces. The one place a cast is unavoidable is wiring an actual `Config`'s
// `beforeSend`: Faro types that hook generically over the *whole* item union,
// `TraceEvent` included, and this module does not model traces (none are
// exported, ADR §C.4) — modeling it would mean either importing Faro's types
// here (against this file's own rule) or handling a kind nothing ever sends.
// T06's wiring is expected to be:
//
//   const beforeSend: BeforeSendHook = (item) =>
//     scrubTelemetry(item as unknown as ScrubbableFaroItem) as TransportItem | null;

import { redactPreviewHosts, type MonitorKind } from "../monitor.js";
import { stripCodeFrame } from "./fingerprint.js";
import { browserOf, deviceOf } from "./classify.js";
import { ALLOWED_ATTRIBUTE_KEYS } from "./attrs.js";

// ---- Structural mirrors of the Faro shapes we scrub -----------------------------
//
// These match `@grafana/faro-core`'s `TransportItem<P>` / `Meta` closely enough
// that a real Faro item satisfies them structurally, without importing the
// package — verified against the installed `@grafana/faro-web-sdk` types
// (`apps/authoring`'s real dependency) with a temporary typecheck probe, not
// just by reading the source. Two things a first draft got wrong, both fixed
// here:
//
// 1. **No `[key: string]: unknown` index signatures.** A real `TransportItem`
//    (and its nested `LogEvent`/`ExceptionEvent`/`Meta`/`ExceptionStackFrame`)
//    carries none, and TS requires the *source* type to also have a matching
//    index signature when the *target* parameter type has one — so a real
//    Faro item failed to satisfy these interfaces even though every field it
//    needs is declared. Only the fields the scrubber reads or removes are
//    declared; passing a richer real object still works (TS's excess-property
//    check only applies to object literals, not to a variable of a wider
//    type), it just cannot be read back through the removed signature.
// 2. **`type` is `string`, not a literal union.** Faro's own `type` is the
//    string *enum* `TransportItemType`, not a plain string-literal union —
//    TS does not consider an enum member assignable to an unrelated literal
//    union even though the runtime values are identical strings. Every
//    runtime check here (`item.type === "log"`) still works against a plain
//    `string`; only the type-level union is gone.
export interface ScrubbableFaroStackFrame {
  filename?: string;
  /** T03 addition (drain-time symbolication, ADR §C.3): the real
   *  `@grafana/faro-core` `ExceptionStackFrame` (`api/exceptions/types.d.ts`)
   *  already carries `function`/`lineno`/`colno` on every frame at runtime —
   *  `structuredClone` in `scrubTelemetry` below has always copied them
   *  through unchanged, only this *type* never declared them, so nothing
   *  downstream could read them. Without these three fields a symbolicator
   *  has no line/column to resolve and no minified function name to fall
   *  back to — `convert.ts#faroItemToRecord` needs all three to embed a
   *  stack trace in the record body at all (T03-D, see that task's Outcome
   *  for the full reasoning: the pre-T03 `faroBody()` dropped
   *  `payload.stacktrace` entirely, so a Faro exception record carried no
   *  frame data anywhere and criterion 5 could not be satisfied by any
   *  drain-time code). No new redaction rule needed: `function` is a JS
   *  identifier (or empty string for an anonymous frame), never a URL;
   *  `lineno`/`colno` are numbers. `filename` already goes through
   *  `redactPreviewHosts`/`stripQueryAndFragment` a few lines below,
   *  unchanged. */
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
   *  naming, set once at `initTelemetry()` (T06). */
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
 *  `console-error`/`console-warn` relay (`monitor.ts`) can still surface as a
 *  Faro log item, tagged by whoever pushes it with `context["hot.relay"]` set
 *  to one of those two `MonitorKind`s (T00-D4 — the tagging convention
 *  T06/T07 must use for this check to find them). Deliberately **not**
 *  `context["hot.kind"]`: that key's contract value set is the Faro item kind
 *  (`exception`/`log`/`event`/`measurement`, §3) and `convert.ts` always
 *  overwrites it with `item.type` regardless of what the client sent — a
 *  console-tagged value there would never survive to be checked. `hot.relay`
 *  is also not on `ALLOWED_ATTRIBUTE_KEYS`, so even if this check somehow
 *  missed one, the marker itself is scrubbed away, never stored.
 *
 *  §3 forbids console output outright, so a matching item is dropped, not
 *  scrubbed. */
const CONSOLE_KINDS: ReadonlySet<MonitorKind> = new Set(["console-error", "console-warn"]);

function isConsoleItem(item: ScrubbableFaroItem): boolean {
  if (item.type !== "log") return false;
  const kind = item.payload.context?.["hot.relay"];
  return typeof kind === "string" && CONSOLE_KINDS.has(kind as MonitorKind);
}

/** §3: "reduce any browser meta to the device and browser classes
 *  `analytics.ts` uses" — replaces the rich `MetaBrowser`/`MetaOS`/`MetaDevice`
 *  objects (raw user-agent string, OS build id, device model — all
 *  fingerprint-shaped) with the same two coarse classes `classify.ts` computes
 *  for the API worker's anonymous analytics. */
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

function scrubText(value: string | undefined): string | undefined {
  if (value === undefined) return value;
  return stripCodeFrame(redactPreviewHosts(value));
}

/**
 * §3: "`redactPreviewHosts` on every string" — not only the message/URL
 * fields the targeted rules above already cover. A preview URL is a session
 * credential (`monitor.ts`'s own words), so it must never survive in an
 * allowlisted attribute value, a resource attribute (`hot.framework` is
 * client-supplied and becomes a Loki label), or any other string this
 * scrubber does not name individually. Walks every string leaf of a plain
 * object/array tree in place; `redactPreviewHosts` is a pure regex replace,
 * so re-applying it to a string already handled above is a no-op — this can
 * safely run last, after every targeted rule, regardless of order.
 */
function redactStringsDeep<V>(value: V): V {
  if (typeof value === "string") return redactPreviewHosts(value) as V;
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
      const redactedKey = redactPreviewHosts(key);
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
 * never on the allowlist, T00-D1); finally, `redactPreviewHosts` on every
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
