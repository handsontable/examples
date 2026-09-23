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
 *
 * T02-D — the id is minted lazily, on the first `pageLoadId()` call, not
 * eagerly at module scope (see T02's task Outcome, discovered running a real
 * `wrangler dev` for `workers/o11y`, which imports this barrel transitively
 * through `@handsontable/demo-runtime/telemetry`): an eager
 * `mintPageLoadId()` at module-evaluation time called `crypto.randomUUID()`
 * before any request handler ran, and Workers refuses "asynchronous I/O …
 * and generating random values … within global scope," failing the whole
 * Worker's startup with `Disallowed operation called within global scope`.
 * Outside a Worker (the browser, plain Node) this only changes *when* the id
 * is minted, not its value or stability — `pageLoadId()` still returns the
 * same id on every call for the life of the module, per its own doc comment
 * above. This is a fix to a file outside T02's own "Owns" row
 * (`packages/runtime/src/telemetry/facade.ts`, T00's), kept minimal and
 * reported explicitly, per COMMON.md's allowance for exactly this case: a
 * real bug that blocks T02's own required `wrangler dev` verification.
 */
let lazyPageLoadId: string | undefined;
export const noopTelemetry: Telemetry = {
  metric() {},
  event() {},
  error() {},
  pageLoadId: () => (lazyPageLoadId ??= mintPageLoadId()),
};

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
