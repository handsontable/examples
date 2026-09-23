// ADR §B.5's `collect`/`lite` gate row, minus the server-side scrubber (that
// runs in `normalise/`, not here) and the per-item kind allowlist (that drops
// one item out of a batch, not the whole request — applied in
// `normalise/faro.ts`). This file is the request-level half: host/env, bot
// filter, size cap, rate limit. `navigator.webdriver` is explicitly a
// browser-side check only (ADR §B.5) — nothing here re-implements it.

import { BOT_RE } from "@handsontable/demo-runtime/telemetry";
import type { Env } from "../env.js";
import { contentLengthExceeds } from "./limits.js";
import { checkRateLimit } from "./rate-limit.js";
import { type GateResult, drop, ok } from "./types.js";
import { isAllowedHost, requestHost } from "./util.js";

export async function checkBrowserGates(req: Request, env: Env, maxBytes: number): Promise<GateResult> {
  const host = requestHost(req);
  if (!isAllowedHost(host, env.O11Y_ENV)) return drop("host", 403, `host=${host ?? "(none)"}`);

  const ua = req.headers.get("user-agent") ?? "";
  if (BOT_RE.test(ua)) return drop("bot", 403);

  if (contentLengthExceeds(req, maxBytes)) return drop("size", 413);

  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  const rate = await checkRateLimit(env, ip);
  if (!rate.ok) return rate;

  return ok();
}

/** ADR §B.5: "payload environment matches" — the body's own declared
 *  environment (Faro's `meta.app.environment`, set by `initTelemetry()`, T06)
 *  must agree with this Worker's `O11Y_ENV`. Checked after the body is parsed
 *  (host/env above only looks at headers), so it is a separate function, not
 *  part of `checkBrowserGates`. `undefined` (an item shape that never set it)
 *  passes — the environment tag is meant to catch a *misconfigured* build
 *  pointing at the wrong stack, not to require every payload to carry one. */
export function checkPayloadEnvironment(declared: string | undefined, env: Env): GateResult {
  if (declared === undefined) return ok();
  return declared === env.O11Y_ENV ? ok() : drop("environment", 400, `declared=${declared}`);
}
