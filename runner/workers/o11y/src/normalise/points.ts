// One place to (a) pick the Analytics Engine sink (real binding in
// production, the local ClickHouse shim in `O11Y_ENV === "local"`, per
// contract §10 — "No local emulation" for the real binding) and (b) fill in
// the eight §3 resource attributes every stored record must carry
// (ADR-0041 §L.15 needs every key present; several sources have no natural
// value for `hot.tier`/`hot.framework`/`hot.ht_major`/`hot.outcome`).

import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_HOT_FRAMEWORK,
  ATTR_HOT_HT_MAJOR,
  ATTR_HOT_OUTCOME,
  ATTR_HOT_SURFACE,
  ATTR_HOT_TIER,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
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
 * Fills every §3 resource-attribute key `mutable` does not already carry
 * with a default, in place, and returns it. `"none"` for
 * `hot.tier`/`hot.framework`/`hot.ht_major`/`hot.outcome` (all four list
 * `"none"` as a real contract value). `deployment.environment.name` falls
 * back to `env.O11Y_ENV`; `hot.surface` falls back to the
 * `service.name`-keyed table above. `service.version` falls back to
 * `"unknown"`: a real Cloudflare invocation-log export carries
 * `service.name` but never `service.version`, so a worker-origin record
 * would otherwise store it empty though every metric row expects it filled.
 */
export function withResourceAttrDefaults(
  mutable: Record<string, string>,
  env: Env,
): Record<string, string> {
  mutable[ATTR_SERVICE_VERSION] ??= "unknown";
  mutable[ATTR_DEPLOYMENT_ENVIRONMENT_NAME] ??= env.O11Y_ENV;
  mutable[ATTR_HOT_SURFACE] ??= SURFACE_BY_SERVICE_NAME[mutable[ATTR_SERVICE_NAME] ?? ""] ?? "api";
  mutable[ATTR_HOT_TIER] ??= "none";
  mutable[ATTR_HOT_FRAMEWORK] ??= "none";
  mutable[ATTR_HOT_HT_MAJOR] ??= "none";
  mutable[ATTR_HOT_OUTCOME] ??= "none";
  return mutable;
}

// Keyed by the `env` object itself (`WeakMap`), not by `O11Y_ENV`'s string
// value: caching by value alone is harmless in production (one isolate's
// `env` binding is stable) but would make every test in one `node --test`
// process share a single fake `RUNNER_EVENTS` sink across every `env`
// fixture with the same `O11Y_ENV`, so a later test's assertions could
// read points an earlier test's request actually wrote.
const sinkByEnv = new WeakMap<Env, AeSink>();

/** Production: `bindingSink(env.RUNNER_EVENTS)`. Local: `clickhouseSink`
 *  against `env.RUNNER_EVENTS_CLICKHOUSE_URL`, falling back to
 *  `http://localhost:8123` — the same var/default
 *  `alerts/ae-query.ts#runAnalyticsEngineSqlApi` reads for the QUERY side.
 *  The write and query sides must agree, or a local ClickHouse on a
 *  non-default port silently receives zero points while alert queries read
 *  an empty table. `AE_SQL_TOKEN` doubles as the ClickHouse password
 *  (`containers/o11y/compose.yml`'s `CLICKHOUSE_PASSWORD`). Cached per
 *  `env` object (cheap; `clickhouseSink` holds no connection state). */
export function aeSink(env: Env): AeSink {
  const cached = sinkByEnv.get(env);
  if (cached) return cached;
  const sink =
    env.O11Y_ENV === "local"
      ? clickhouseSink(env.RUNNER_EVENTS_CLICKHOUSE_URL ?? "http://localhost:8123", {
          user: "default",
          password: env.AE_SQL_TOKEN,
        })
      : bindingSink(env.RUNNER_EVENTS);
  sinkByEnv.set(env, sink);
  return sink;
}

/** `aeSink(env).writeDataPoint(point)` can throw SYNCHRONOUSLY from the
 *  real binding (an over-limit point) before any `.then`/`.catch` can run,
 *  so it's wrapped in a `try` alongside the async-rejection `.catch` below
 *  — both must land in the same "never throws into the caller" contract
 *  this function's doc comment promises. */
function writeDataPointSafely(sink: AeSink, point: AePoint): Promise<void> {
  try {
    return Promise.resolve(sink.writeDataPoint(point)).catch((err: unknown) => {
      console.warn("[o11y] writeDataPoint failed:", err instanceof Error ? err.message : String(err));
    });
  } catch (err) {
    console.warn("[o11y] writeDataPoint threw synchronously:", err instanceof Error ? err.message : String(err));
    return Promise.resolve();
  }
}

/** Writes one point, never throwing into the caller: a local ClickHouse
 *  outage (or any sink failure) must not fail ingest (§B.1: "ingest never
 *  waits for the box" — the metrics path has the same obligation toward its
 *  own store). `ctx.waitUntil` keeps the write off the response's critical
 *  path; the `.catch` is what stops a rejected promise from becoming an
 *  unhandled rejection the runtime logs as an error on every local run. */
export function writePoint(env: Env, ctx: ExecutionContext, point: AePoint): void {
  ctx.waitUntil(writeDataPointSafely(aeSink(env), point));
}

/** The same fire-and-forget write, from inside a Durable Object
 *  (`InboxWriter`'s ledger, `GrafanaBox`'s wake/drain orchestration) rather
 *  than a route handler — a DO method has no `ExecutionContext`, but
 *  `DurableObjectState` (`this.ctx`) has its own `waitUntil` with the
 *  identical contract. Kept as a second, narrower-typed function rather
 *  than widening {@link writePoint}'s `ctx` to a structural union:
 *  `ExecutionContext` also declares `passThroughOnException`/`tracing`/
 *  `abort`, which `DurableObjectState` lacks. */
export function writePointFromDo(env: Env, ctx: DurableObjectState, point: AePoint): void {
  ctx.waitUntil(writeDataPointSafely(aeSink(env), point));
}
