// ADR §B.5: "the Workers rate-limiting binding" gating `collect`/`lite`.
// T02-D (see the task Outcome): T00 left `RATE_LIMITER` out of
// `wrangler.jsonc`, believing it needed a dashboard-provisioned namespace id.
// Measured against `wrangler`'s own config schema (`ratelimits[].namespace_id`
// is a free-form string the deploy author picks, not a resource id fetched
// from anywhere) and a real `wrangler deploy --dry-run`: false. Added to
// `wrangler.jsonc` with a self-chosen id.

import type { Env } from "../env.js";
import { type GateResult, drop, ok } from "./types.js";

/** `wrangler.jsonc`'s `ratelimits[0].simple.period`. The binding does not
 *  expose its window at runtime, so it is restated here and a test keeps the
 *  two equal. A client that waits this long always gets a fresh window. */
export const RATE_LIMIT_PERIOD_SECONDS = 60;

/** One request per key per the configured window (`wrangler.jsonc`'s
 *  `simple.limit`/`simple.period`) — Cloudflare's binding does the counting,
 *  this just shapes the result into a `GateResult`. `key` is the caller's
 *  choice; the ingest routes use `cf-connecting-ip`. */
export async function checkRateLimit(env: Env, key: string): Promise<GateResult> {
  const outcome = await env.RATE_LIMITER.limit({ key });
  return outcome.success ? ok() : { ...drop("rate_limit", 429), retryAfterSeconds: RATE_LIMIT_PERIOD_SECONDS };
}
