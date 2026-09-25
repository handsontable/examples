// ADR-0041 §G: `GrafanaBox`'s awake seconds, reported to the API worker's
// `O11yUsage` `WorkerEntrypoint` over the `API` service binding (not an
// HTTP route — see `workers/api/src/o11y-usage.ts`'s header). Called from
// `box.ts#onStop` (T04-D, a small necessary edit to a file T01 owns — see
// this task's Outcome) and from the alert cron's cap check.

import type { Env } from "./env.js";

/** Structural mirror of `O11yUsage`'s RPC surface (T04-D, same reasoning
 *  `o11y-watchdog.ts`'s own doc comment gives on the API side: the two
 *  Workers are separate `tsconfig.json` projects, so this is a local cast
 *  target, not a cross-project type import). `env.API` stays typed
 *  `Fetcher` (T00's own declaration) — `workers/o11y/wrangler.jsonc` now
 *  binds it to the named `O11yUsage` entrypoint, so the RPC methods below
 *  are real at runtime even though the ambient type does not know it. */
interface O11yUsageRpc {
  recordAwakeSeconds(awakeSeconds: number): Promise<void>;
  o11ySpend(): Promise<{ spendUsd: number; capUsd: number }>;
}

function o11yUsage(env: Env): O11yUsageRpc {
  return env.API as unknown as O11yUsageRpc;
}

/** Best-effort — never throws. A failed usage report must not be the reason
 *  a container stop (or an alert tick) fails; the nightly reconciliation
 *  (`reconcile.ts`, ADR §G) is the backstop for drift the same way it is
 *  for the app's own estimates. */
export async function reportAwakeSeconds(env: Env, awakeSeconds: number): Promise<void> {
  if (!(awakeSeconds > 0)) return;
  try {
    await o11yUsage(env).recordAwakeSeconds(awakeSeconds);
  } catch (err) {
    console.warn("[o11y-cost] recordAwakeSeconds failed:", err instanceof Error ? err.message : String(err));
  }
}

/** Read for the spend-cap alert rule (`alerts/rules.ts#o11yCapRule`). Unlike
 *  {@link reportAwakeSeconds}, a failure here is NOT swallowed — the caller
 *  (`alerts/index.ts#runAlerts`) needs to know the read failed rather than
 *  silently treating "could not check" as "under budget". */
export async function readO11ySpend(env: Env): Promise<{ spendUsd: number; capUsd: number }> {
  return o11yUsage(env).o11ySpend();
}
