// Import-free, same reason as `reportingGate.ts`/`eventGate.ts`:
// `main.tsx` pulls in React, `@sentry/react` and `import.meta.env`, and
// runs real DOM side effects at import time — nothing `node --test` can
// import. This file holds the guarding LOGIC `main.tsx` calls at its
// `initTelemetry()` site, proving a throwing `init` can never blank the
// app before `createRoot` runs.

/**
 * Runs `init` and swallows any synchronous throw, reporting it to
 * `onError` instead of letting it propagate. `main.tsx` uses this for
 * `initTelemetry()`: telemetry is a best-effort side channel, so a
 * construction failure must degrade to `noopTelemetry`, not blank the app.
 */
export function safeInit(init: () => void, onError: (err: unknown) => void): void {
  try {
    init();
  } catch (err) {
    onError(err);
  }
}
