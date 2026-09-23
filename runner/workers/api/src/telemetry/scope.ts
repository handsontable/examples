// The Sentry scope switch's decision, alone (ADR-0041 §E.3, contract §11) —
// split out of `diagnostic.ts` so it has zero imports (not even the real
// `@sentry/cloudflare` package) and `pipeline/api-telemetry-signals.test.mjs`
// can pin it directly. `diagnostic.ts` is the wiring: it imports this file
// and gates its `Sentry.captureException` call on the result.

import type { Env } from "../env.js";

/** `full` (default, absent) sends diagnostic reports to Sentry too; `uncaught`
 *  keeps them in the new stack only. Contract §11. */
export function sentryScopeIsFull(env: Env): boolean {
  return env.SENTRY_SCOPE !== "uncaught";
}
