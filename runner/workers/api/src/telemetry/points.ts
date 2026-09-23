// One Analytics Engine write surface for the API worker (contract §4/§5),
// wrapping `toAePoint` (the contract module's own producer validation) around
// whichever sink `resource.ts#getSink` picks.
//
// Never blocks a response and never throws (ADR-0041 §D trap: "never block a
// response on Analytics Engine") — a bad call site here must degrade to a
// dropped point, not a 500.

import { toAePoint, type HotAttrs, type MetricName, type MetricValues } from "@handsontable/demo-runtime/telemetry";
import type { Env } from "../env.js";
import { commonAttrs, getSink } from "./resource.js";

/**
 * Build and write one point. Returns a promise a caller may hand to
 * `ctx.waitUntil()` so a local `clickhouseSink`'s HTTP write survives past the
 * response (the real `AnalyticsEngineDataset` binding is synchronous and
 * fire-and-forget either way) — callers that do not `waitUntil` it still never
 * throw, because every failure is caught here.
 */
export async function emitPoint(
  env: Env,
  metric: MetricName,
  values: MetricValues,
  attrs: HotAttrs,
): Promise<void> {
  try {
    const point = toAePoint(metric, values, { ...commonAttrs(env), ...attrs });
    await getSink(env).writeDataPoint(point);
  } catch (err) {
    // A malformed call site (T00-D10: an out-of-enum outcome/reason throws) or
    // a local ClickHouse hiccup must never surface as a 500 — see the module
    // doc. Sampled at Workers Logs' own rate, so this is a convenience, not
    // the record of the drop.
    console.warn(`[o11y] point "${metric}" dropped:`, err instanceof Error ? err.message : String(err));
  }
}
