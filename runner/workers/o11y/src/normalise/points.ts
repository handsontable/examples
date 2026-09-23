// One place to (a) pick the Analytics Engine sink (real binding in
// production, the local ClickHouse shim in `O11Y_ENV === "local"`, per
// contract §10 — "No local emulation" for the real binding) and (b) fill in
// the eight §3 resource attributes every stored record must carry (T02-D, see
// the task Outcome: the contract's exit criterion 15 needs every key present,
// but several sources — a Cloudflare export line, a deploy event, a Sentry
// webhook — have no natural value for `hot.tier`/`hot.framework`/
// `hot.ht_major`/`hot.outcome`, and the contract itself never says what a
// worker-origin record's `hot.surface` should default to).

import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_HOT_FRAMEWORK,
  ATTR_HOT_HT_MAJOR,
  ATTR_HOT_OUTCOME,
  ATTR_HOT_SURFACE,
  ATTR_HOT_TIER,
  ATTR_SERVICE_NAME,
  bindingSink,
  clickhouseSink,
  type AeSink,
  type AePoint,
} from "@handsontable/demo-runtime/telemetry";
import type { Env } from "../env.js";

/** `service.name` → `hot.surface` default, for records with no other signal
 *  (worker-origin: Cloudflare export, deploy, Sentry). `demos-api` is the
 *  fallback for an unrecognised/absent `service.name` — the overwhelming
 *  majority of worker-origin export lines are the API worker's (the o11y
 *  worker exports none of its own, ADR §B.6). */
const SURFACE_BY_SERVICE_NAME: Readonly<Record<string, string>> = {
  "demos-authoring": "authoring",
  "demos-api": "api",
  "demos-o11y": "o11y",
  "demos-embed": "embed",
};

/**
 * Fills every §3 resource-attribute key `mutable` does not already carry with
 * a default, in place, and returns it. `"none"` for `hot.tier`/
 * `hot.framework`/`hot.ht_major` (all three list `"none"` as a real contract
 * value); `"none"` for `hot.outcome` too — `Outcome` has no closed set at the
 * OTLP-record level (only `toAePoint`'s per-metric check constrains it), so a
 * worker log line with no natural outcome carries a syntactically valid
 * placeholder rather than an absent label. `deployment.environment.name`
 * falls back to `env.O11Y_ENV`; `hot.surface` falls back to the
 * `service.name`-keyed table above.
 */
export function withResourceAttrDefaults(
  mutable: Record<string, string>,
  env: Env,
): Record<string, string> {
  mutable[ATTR_DEPLOYMENT_ENVIRONMENT_NAME] ??= env.O11Y_ENV;
  mutable[ATTR_HOT_SURFACE] ??= SURFACE_BY_SERVICE_NAME[mutable[ATTR_SERVICE_NAME] ?? ""] ?? "api";
  mutable[ATTR_HOT_TIER] ??= "none";
  mutable[ATTR_HOT_FRAMEWORK] ??= "none";
  mutable[ATTR_HOT_HT_MAJOR] ??= "none";
  mutable[ATTR_HOT_OUTCOME] ??= "none";
  return mutable;
}

// T02-D (see the task Outcome): keyed by the `env` object itself
// (`WeakMap`), not by `O11Y_ENV`'s string value — a first version cached by
// value alone, which is harmless in production (one Worker isolate's `env`
// binding is stable across the requests it serves) but silently made every
// test in one `node --test` process share a *single* fake `RUNNER_EVENTS`
// sink across every distinct `env` fixture with the same `O11Y_ENV`
// ("production"), so a later test's assertions read points an earlier
// test's request actually wrote. Caught by `o11y-routes.test.mjs`'s exit
// criterion 4 test failing for the wrong reason (a real duplicate point
// existed, just in a different test's sink) until this fix.
const sinkByEnv = new WeakMap<Env, AeSink>();

/** Production: `bindingSink(env.RUNNER_EVENTS)`. Local (`O11Y_ENV ===
 *  "local"`): `clickhouseSink` against `http://localhost:8123`
 *  (`AE_SQL_TOKEN` doubles as the ClickHouse password, matching
 *  `containers/o11y/compose.yml`'s `CLICKHOUSE_PASSWORD` default — T01's
 *  convention, `sink.ts`'s own doc comment). Cached per `env` object (cheap,
 *  and `clickhouseSink` holds no connection state to go stale). */
export function aeSink(env: Env): AeSink {
  const cached = sinkByEnv.get(env);
  if (cached) return cached;
  const sink =
    env.O11Y_ENV === "local"
      ? clickhouseSink("http://localhost:8123", { user: "default", password: env.AE_SQL_TOKEN })
      : bindingSink(env.RUNNER_EVENTS);
  sinkByEnv.set(env, sink);
  return sink;
}

/** Writes one point, never throwing into the caller: a local ClickHouse
 *  outage (or any sink failure) must not fail ingest (§B.1: "ingest never
 *  waits for the box" — the metrics path has the same obligation toward its
 *  own store). `ctx.waitUntil` keeps the write off the response's critical
 *  path; the `.catch` is what stops a rejected promise from becoming an
 *  unhandled rejection the runtime logs as an error on every local run. */
export function writePoint(env: Env, ctx: ExecutionContext, point: AePoint): void {
  ctx.waitUntil(
    Promise.resolve(aeSink(env).writeDataPoint(point)).catch((err: unknown) => {
      console.warn("[o11y] writeDataPoint failed:", err instanceof Error ? err.message : String(err));
    }),
  );
}
