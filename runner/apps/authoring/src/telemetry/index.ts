// COMMON.md interface 4 — the browser facade path. T07 and T12 import ONLY
// from this path, never `./faro.js` directly.
//
// `telemetry` starts as the contract's own `noopTelemetry` (which still mints
// a real, stable page-load id) and becomes the Faro-backed implementation once
// `initTelemetry()` runs; both share the SAME id (`initFaroTelemetry` reuses
// `noopTelemetry.pageLoadId()`, never re-mints), so `apiHeaders()` tags every
// request with one stable id for the life of the page whether it is called
// before or after init.
//
// Deliberately does NOT import `../sentry.js` — `resolveReporting` is called
// here directly (same pure inputs sentry.ts itself resolves: `VITE_SENTRY_DSN`,
// `window.location.hostname`, `navigator.webdriver`) rather than reading
// `sentry.ts`'s already-computed `reportingEnabled`, so this module and
// `sentry.ts` have no import cycle between them. Both calls are pure functions
// of the same inputs, so they always agree.

import { noopTelemetry, type Telemetry } from "@handsontable/demo-runtime/telemetry";
import { resolveReporting } from "../reportingGate.js";
import { initFaroTelemetry, reportUncaughtError } from "./faro.js";

export let telemetry: Telemetry = noopTelemetry;

/** Call once, from `main.tsx`, after `Sentry.init()` (order does not matter
 *  for correctness here — this module computes its own gate — but keeping it
 *  right after mirrors the "init reporting first" convention `main.tsx`
 *  already documents). */
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
 * COMMON.md interface 4. Every API `fetch` site merges these headers in, so
 * `x-hot-session` (the page-load id) rides along regardless of whether
 * telemetry ended up enabled — the o11y worker can join a request log to a
 * browser session either way. `/d` and `/embed` asset requests don't call
 * this (task acceptance criteria): those are static artifact fetches, not API
 * calls, and the id would be dead weight on them.
 */
export function apiHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init);
  headers.set("x-hot-session", telemetry.pageLoadId());
  return headers;
}

export { reportUncaughtError };
