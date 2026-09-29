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

/** `service.name` → `hot.surface` default for records with no other
 *  signal. `demos-api` is the fallback (o11y worker exports none of its
 *  own, ADR §B.6). */
const SURFACE_BY_SERVICE_NAME: Readonly<Record<string, string>> = {
  "demos-authoring": "authoring",
  "demos-api": "api",
  "demos-o11y": "o11y",
  "demos-embed": "embed",
};

/**
 * Fills every §3 resource-attribute key `mutable` lacks, in place.
 * `"none"` for `hot.tier`/`hot.framework`/`hot.ht_major`/`hot.outcome`.
 * `deployment.environment.name` falls back to `env.O11Y_ENV`; `hot.surface`
 * to the table above; `service.version` to `"unknown"` (a real Cloudflare
 * export carries `service.name` but never `service.version`).
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

// Keyed by `env` object identity (`WeakMap`), not `O11Y_ENV`'s string
// value: caching by value would make every test in one process share a
// fake sink across every `env` fixture with the same `O11Y_ENV`.
const sinkByEnv = new WeakMap<Env, AeSink>();

/** Production: `bindingSink(env.RUNNER_EVENTS)`. Local: `clickhouseSink`
 *  against `env.RUNNER_EVENTS_CLICKHOUSE_URL`, falling back to
 *  `http://localhost:8123` — must agree with
 *  `alerts/ae-query.ts#runAnalyticsEngineSqlApi`'s own default, or a
 *  non-default local ClickHouse silently gets zero points while alert
 *  queries read an empty table. Cached per `env` (cheap; stateless). */
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
 *  outage must not fail ingest (§B.1 "ingest never waits for the box").
 *  `ctx.waitUntil` keeps the write off the critical path; `.catch` stops
 *  an unhandled-rejection log on every local run. */
export function writePoint(env: Env, ctx: ExecutionContext, point: AePoint): void {
  ctx.waitUntil(writeDataPointSafely(aeSink(env), point));
}

/** The same fire-and-forget write, from inside a Durable Object rather
 *  than a route handler — a DO method has no `ExecutionContext`, but
 *  `DurableObjectState` has its own `waitUntil`. Kept as a second,
 *  narrower-typed function rather than widening {@link writePoint}'s
 *  `ctx`: `ExecutionContext` also declares
 *  `passThroughOnException`/`tracing`/`abort`, which `DurableObjectState`
 *  lacks. */
export function writePointFromDo(env: Env, ctx: DurableObjectState, point: AePoint): void {
  ctx.waitUntil(writeDataPointSafely(aeSink(env), point));
}
