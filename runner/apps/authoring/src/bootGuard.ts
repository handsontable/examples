// Import-free, same reason as `reportingGate.ts`/`eventGate.ts`: `main.tsx`
// runs real DOM side effects at import time, so `node --test` can't import
// it — the guarding logic lives here instead.

/** Runs `init`, swallowing any synchronous throw into `onError` instead of
 *  letting it propagate — `initTelemetry()` is best-effort and must degrade
 *  to `noopTelemetry`, not blank the app. */
export function safeInit(init: () => void, onError: (err: unknown) => void): void {
  try {
    init();
  } catch (err) {
    onError(err);
  }
}
