// One cron step, run in isolation (ADR-0041 §D "the cron handler", §E.1
// uncaught class). Split out of `index.ts` (fix round, T05 review) so it is
// directly testable: `emitPoolGauge`/`emitBudgetGauge` in `cron.ts` need
// `../budget.js` (a real D1/KV-touching file), which this does not, and
// keeping `cronStep` in a leaf file (only `lines.ts` → `resource.ts`, plus
// the real `@sentry/cloudflare` package) means a test can copy just these
// three files under `--experimental-strip-types` the way
// `pipeline/chat-sanitise.test.mjs` already copies `workers/api/src/*.ts` —
// see `pipeline/api-telemetry-cron-step.test.mjs`.

import * as Sentry from "@sentry/cloudflare";
import type { Env } from "../env.js";
import { logErrorLine } from "./lines.js";

/** The shape `Sentry.captureException` is called with — same injection
 *  pattern as `diagnostic.ts#CaptureExceptionFn`, so a test can assert a
 *  throwing step is actually captured instead of trusting the rethrow (fix
 *  round: T05-D8 found live that a throw inside `ctx.waitUntil(...)` is
 *  invisible to `Sentry.withSentry`'s own `scheduled` auto-capture — see this
 *  file's `cronStep` doc comment in the commit history / task Outcome). */
export type CronCaptureFn = (err: unknown, context: { tags: Record<string, string> }) => void;

const defaultCapture: CronCaptureFn = (err, context) => Sentry.captureException(err, context);

/**
 * Run one cron step in isolation: on failure, log our own structured line and
 * report to Sentry directly (uncaught class, §E.1, unconditional — never
 * gated by `SENTRY_SCOPE`), then swallow so a sibling step still runs.
 *
 * Explicit and ungated rather than "rethrow and let `Sentry.withSentry`'s own
 * `scheduled` wrapping catch it": measured against the SDK's own source
 * (`instrumentations/worker/instrumentScheduled.js`), that wrapper only
 * `try/catch`es the synchronous return of the `scheduled()` call itself, and
 * `utils/instrumentContext.js` does not also wrap `ctx.waitUntil` to catch a
 * rejection handed to it later — a throw inside a `ctx.waitUntil(...)`
 * promise (which every cron branch in `index.ts` runs under, so the response
 * is never blocked on cost reconciliation or gauge writes) never reaches
 * Sentry that way.
 */
export async function cronStep(
  env: Env,
  context: string,
  fn: () => Promise<void>,
  capture: CronCaptureFn = defaultCapture,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    logErrorLine(env, context, err);
    capture(err, { tags: { context } });
  }
}
