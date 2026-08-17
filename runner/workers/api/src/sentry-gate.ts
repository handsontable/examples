// Whether the API Worker reports to Sentry, under which `environment`, and where
// the budget alerts land (DEV-2540).
//
// Dependency-free apart from a type-only import (erased by
// `--experimental-strip-types`) so `pipeline/sentry-gating.test.mjs` can import it
// directly — the same arrangement `pipeline/monitor-worker.test.mjs` already uses
// for `monitor-inject.ts`. Do not add a value import here.
import type { Env } from "./env.js";

/** The one production host. Doubles as the "am I deployed?" signal, and is the
 *  wildcard base for Tier-2 preview URLs — `index.ts` imports it from here rather
 *  than keeping a second copy. */
export const PRODUCTION_HOST = "demos.handsontable.com";

/**
 * The Worker's `environment`, supplied only by `--var SENTRY_ENVIRONMENT` in the
 * `deploy` script. Replaces the literal `"api-production"` that used to be
 * hardcoded at the init site.
 *
 * This is a LABELLING function only. `apiSentryDsn` deliberately does not call it
 * — it reads `env.SENTRY_ENVIRONMENT` itself — because the obvious future edit
 * here is a default for UI tidiness (`|| "api-production"`, so every event carries
 * an environment even on a bare `wrangler deploy`). Through a shared code path that
 * edit would silently reopen the DSN gate for every `wrangler dev` run and put the
 * original bug straight back. Keep the two independent.
 */
export function apiSentryEnvironment(env: Env): string | undefined {
  return env.SENTRY_ENVIRONMENT || undefined;
}

/**
 * The DSN, or undefined to leave the client inert.
 *
 * Two signals, both required, because either one alone fails OPEN:
 *
 * - `PREVIEW_HOST === PRODUCTION_HOST` was the original gate, and the committed
 *   `wrangler.jsonc` vars set `PREVIEW_HOST` to the production host. The only
 *   thing turning it off locally is the gitignored `workers/api/.dev.vars`, which
 *   a manual setup step creates (docs/run-and-deploy.md). Skip that step and
 *   `wrangler dev` files local runs into the production project as
 *   `api-production` — observed, with a wrangler-dev UUID release and a
 *   `.wrangler/tmp/` stack frame.
 * - `SENTRY_ENVIRONMENT` is supplied only by `--var` at deploy time. It is in no
 *   config file and in no `.dev.vars`, so `wrangler dev` cannot produce it. That
 *   inverts the failure direction: forgetting local setup now means silence.
 *
 * The trade is a real one and is documented — a bare `wrangler deploy` instead of
 * `pnpm run deploy` ships a Worker with reporting silently off.
 *
 * Returning `undefined` for the dsn (rather than having the caller return an
 * undefined options object) is load-bearing: `@sentry/cloudflare`'s
 * `getFinalOptions` treats a missing options object as empty and then falls back
 * to `env.SENTRY_DSN`. That fallback is also why the var is not named `SENTRY_DSN`.
 *
 * Reads `env.SENTRY_ENVIRONMENT` directly rather than through
 * `apiSentryEnvironment` — see the note there. Truthiness, not `!== undefined`:
 * `wrangler deploy --var SENTRY_ENVIRONMENT:` yields an empty string.
 */
export function apiSentryDsn(env: Env): string | undefined {
  if (!env.SENTRY_ENVIRONMENT) return undefined;
  return env.PREVIEW_HOST === PRODUCTION_HOST ? env.ERROR_REPORTING_DSN : undefined;
}

/** Where the nightly spend alerts are filed, so they can be filtered, muted and
 *  rate-limited apart from genuine Worker faults. This does NOT move them out of
 *  the project — Sentry still opens an issue; it only makes them separable. */
const BUDGET_ALERT_ENVIRONMENT = "budget-alerts";

/**
 * Re-home the nightly budget alerts (`reconcile.ts`) per event, mirroring how the
 * browser client re-homes relayed demo events — a client carries one `environment`
 * from init, so this is the only way one surface can file under two.
 *
 * Strict equality on the tag, never a prefix test: `reconcile.ts` files a genuine
 * failure of the alert job itself under `budget-alert-check`, and that must keep
 * its current routing and level.
 *
 * Generic in the event type so this module stays free of SDK imports while still
 * satisfying `beforeSend`'s `(event) => event | null` contract. It never returns
 * null — nothing here drops an event.
 */
export function rehomeBudgetAlert<
  T extends { environment?: string; tags?: Record<string, unknown> | undefined },
>(event: T): T {
  if (event.tags?.context === "budget-alert") {
    event.environment = BUDGET_ALERT_ENVIRONMENT;
  }
  return event;
}
