// COMMON.md interface 4 — the browser facade path; callers import ONLY
// from here, never `./faro.js` directly. `telemetry` starts as
// `noopTelemetry` (mints a real page-load id) and becomes the Faro-backed
// impl once `initTelemetry()` runs, reusing the SAME id. Does NOT import
// `../sentry.js` — `resolveReporting` is called here directly on the same
// pure inputs, so the two modules have no cycle and always agree.

import { noopTelemetry, type Telemetry } from "@handsontable/demo-runtime/telemetry";
import { resolveReporting } from "../reportingGate.js";
import { initFaroTelemetry, reportUncaughtError } from "./faro.js";

export let telemetry: Telemetry = noopTelemetry;

/** Call once, from `main.tsx`, after `Sentry.init()` (order doesn't matter
 *  for correctness — this module computes its own gate). */
export function initTelemetry(): void {
  const reporting = resolveReporting({
    dsn: import.meta.env.VITE_SENTRY_DSN as string | undefined,
    hostname: typeof window !== "undefined" ? window.location.hostname : undefined,
    webdriver: typeof navigator !== "undefined" ? navigator.webdriver : undefined,
  });
  const impl = initFaroTelemetry({
    pageLoadId: noopTelemetry.pageLoadId(),
    productionReportingEnabled: reporting.enabled,
    release: (import.meta.env.VITE_SENTRY_RELEASE as string | undefined) || undefined,
  });
  if (impl) telemetry = impl;
}

/**
 * COMMON.md interface 4. Every API `fetch` merges these headers in, so
 * `x-hot-session` rides along regardless of whether telemetry is enabled.
 * `/d`/`/embed` asset requests don't call this — static fetches, not API calls.
 */
export function apiHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init);
  headers.set("x-hot-session", telemetry.pageLoadId());
  return headers;
}

/** Whether the Faro-backed facade is live — the gate a browser-side event obeys,
 *  exposed for a count the API worker writes on the browser's behalf. */
export function telemetryEnabled(): boolean {
  return telemetry !== noopTelemetry;
}

export { reportUncaughtError };
