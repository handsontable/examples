// Observability contract §6 — the browser facade. The app never calls Faro
// directly (COMMON.md interface 4: `apps/authoring/src/telemetry/index.ts`
// exports `telemetry: Telemetry`, `noopTelemetry` until `initTelemetry()` runs,
// and T06 implements the Faro-backed one). No Faro import here — that stays in
// T06's module, so this file can be imported from `pipeline/` under plain Node.

import type { HotAttrs } from "./attrs.js";
import type { MetricName, MetricValues } from "./metrics.js";

/** Event names are open (`example.open` and friends, or any Faro `event`/`log`
 *  line) — never a closed set the way `MetricName` is. */
export type EventName = string;

export interface Telemetry {
  metric(name: MetricName, values: MetricValues, attrs: HotAttrs): void;
  event(name: EventName, attrs: HotAttrs & Record<string, string>): void;
  /** A handled error (§5 `error.handled`) — never an uncaught one; those stay on
   *  `window.onerror`/`unhandledrejection`/`Sentry.ErrorBoundary` (ADR §E.1). */
  error(err: unknown, context: string, attrs?: HotAttrs): void;
  /** The in-memory page-load id minted once at page load (§6, §3 `session.id`),
   *  identical across every call for the life of the page. */
  pageLoadId(): string;
}

function mintPageLoadId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Defensive fallback only — every runtime this module ships to (evergreen
  // browsers, workerd, Node 20+) has Web Crypto.
  return `plid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * The facade before `initTelemetry()` runs (or when reporting is gated off).
 * Every call is a no-op except `pageLoadId()`, which still mints and returns a
 * real, stable id — call sites that read it to tag `x-hot-session` before init
 * has run must not see an empty string.
 */
export const noopTelemetry: Telemetry = (() => {
  const pageLoadId = mintPageLoadId();
  return {
    metric() {},
    event() {},
    error() {},
    pageLoadId: () => pageLoadId,
  };
})();

export interface RecordedMetricCall {
  name: MetricName;
  values: MetricValues;
  attrs: HotAttrs;
}
export interface RecordedEventCall {
  name: EventName;
  attrs: HotAttrs & Record<string, string>;
}
export interface RecordedErrorCall {
  err: unknown;
  context: string;
  attrs?: HotAttrs;
}

export interface RecordingTelemetry extends Telemetry {
  readonly metrics: RecordedMetricCall[];
  readonly events: RecordedEventCall[];
  readonly errors: RecordedErrorCall[];
}

/** Test double: records every call instead of sending anything, so a test can
 *  assert on `.metrics`/`.events`/`.errors` directly. */
export function recordingTelemetry(pageLoadId: string = mintPageLoadId()): RecordingTelemetry {
  const metrics: RecordedMetricCall[] = [];
  const events: RecordedEventCall[] = [];
  const errors: RecordedErrorCall[] = [];
  return {
    metrics,
    events,
    errors,
    metric(name, values, attrs) {
      metrics.push({ name, values, attrs });
    },
    event(name, attrs) {
      events.push({ name, attrs });
    },
    error(err, context, attrs) {
      errors.push({ err, context, attrs });
    },
    pageLoadId: () => pageLoadId,
  };
}
