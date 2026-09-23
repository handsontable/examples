// Resource attrs + Analytics Engine sink selection for the API worker
// (ADR-0041 §D, contract §2/§10). Kept dependency-light so
// `pipeline/api-telemetry-*.test.mjs` can import it directly, mirroring the
// `--experimental-strip-types`-safe style `sentry-gate.ts` and
// `preview-boot.ts` already use.

import { bindingSink, clickhouseSink, type AeSink, type CommonResourceAttrs } from "@handsontable/demo-runtime/telemetry";
import type { Env } from "../env.js";

/** `demos-api` (contract §3 `service.name`). */
export const SERVICE_NAME = "demos-api" as const;

/**
 * The one production host (`sentry-gate.ts#PRODUCTION_HOST`, copied rather
 * than imported): this module's own doc-comment goal is staying free of
 * cross-file value imports, the same "no DOM, no Cloudflare imports" style
 * `packages/runtime/src/telemetry` follows, for the same reason —
 * `pipeline/api-telemetry-signals.test.mjs` imports this file directly under
 * `--experimental-strip-types`, which does not resolve a sibling `.ts`
 * module's compiled `.js` specifier (confirmed: `sentry-gate.js` cannot be
 * found that way). A value re-export from `sentry-gate.ts` would reintroduce
 * exactly that failure.
 */
const PRODUCTION_HOST = "demos.handsontable.com";

/**
 * `service.version` (contract §2/§D): the full deploy `GITHUB_SHA`, supplied
 * only by the `deploy` script's `--var SERVICE_VERSION:$GITHUB_SHA`
 * (`package.json`) — never committed to `wrangler.jsonc`. `wrangler dev` and a
 * bare `wrangler deploy` therefore have none; the Cloudflare version id is a
 * reasonable stand-in there (still stable per-boot) rather than throwing or
 * emitting an empty blob. Mirrors the optional-chained fallback
 * `sentryOptions.release` already uses for the same reason.
 */
export function serviceVersion(env: Env): string {
  return env.SERVICE_VERSION || env.CF_VERSION_METADATA?.id || "dev";
}

/**
 * `deployment.environment.name` (contract §3): `production` only when deployed
 * under the real host, `local` otherwise — the same two-way distinction
 * `apiSentryDsn` already makes for Sentry, reused here rather than duplicated
 * (T05-D: this repo has no separate `O11Y_ENV` var for the API worker the way
 * the o11y worker does; `PREVIEW_HOST === PRODUCTION_HOST` is the existing,
 * already-load-bearing signal for "this is the real deploy").
 */
export function serviceEnvironment(env: Env): "production" | "local" {
  return env.PREVIEW_HOST === PRODUCTION_HOST ? "production" : "local";
}

export function commonAttrs(env: Env): CommonResourceAttrs {
  return {
    service_name: SERVICE_NAME,
    service_version: serviceVersion(env),
    environment: serviceEnvironment(env),
  };
}

/**
 * Analytics Engine sink (contract §10): the real `RUNNER_EVENTS` binding in
 * production, local ClickHouse otherwise — `wrangler dev`'s own AE binding
 * simulation accepts writes but they are not queryable, so local mode routes
 * around it the same way the o11y worker does (T00's `clickhouseSink`).
 *
 * T05-D: the contract's §2 "API worker additions" table does not name a local
 * ClickHouse URL/credential var for this worker (only the o11y worker's
 * `AE_SQL_TOKEN` is pinned there). `RUNNER_EVENTS_CLICKHOUSE_URL` and
 * `AE_SQL_TOKEN` are added to this worker's `env.ts` as `.dev.vars`-only
 * additions (never in the committed `wrangler.jsonc` `vars` block) for this
 * purpose — same credential header names T00 measured against T01's
 * container (`X-ClickHouse-User` / `X-ClickHouse-Key`).
 */
export function getSink(env: Env): AeSink {
  if (serviceEnvironment(env) === "production") {
    if (!env.RUNNER_EVENTS) {
      // No binding at all (e.g. a probe deploy) — write nowhere rather than throw.
      return { writeDataPoint() {} };
    }
    return bindingSink(env.RUNNER_EVENTS);
  }
  const url = env.RUNNER_EVENTS_CLICKHOUSE_URL || "http://localhost:8123";
  return clickhouseSink(url, {
    user: "default",
    password: env.AE_SQL_TOKEN,
  });
}
