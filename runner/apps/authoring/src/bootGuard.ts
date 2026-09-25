// Minor triage item 5. Split out import-free, same reason as `reportingGate.ts`'s
// own header and `eventGate.ts`'s: `main.tsx` pulls in React, `@sentry/react` and
// `import.meta.env`, and is a top-level module with real DOM side effects
// (`createRoot(...).render(...)` runs at import time) — nothing `node --test` can
// import or render. This file holds the actual guarding LOGIC `main.tsx` calls at
// its `initTelemetry()` call site; testing it here proves a throwing `init` can
// never propagate out and blank the app before `createRoot` ever runs — the call
// site itself is a thin, non-branching wrapper around exactly this function.

/**
 * Runs `init` and swallows any synchronous throw, reporting it to `onError`
 * instead of letting it propagate. `main.tsx` uses this for `initTelemetry()`:
 * telemetry is a best-effort side channel (`telemetry/index.js`'s own
 * `noopTelemetry` already models "not initialised" as a valid, harmless
 * state), so a construction failure must degrade to that state, not blank
 * the whole app before `createRoot` runs.
 */
export function safeInit(init: () => void, onError: (err: unknown) => void): void {
  try {
    init();
  } catch (err) {
    onError(err);
  }
}
