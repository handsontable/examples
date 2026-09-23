// ADR-0041 §G: "the o11y worker reports `GrafanaBox` awake seconds over the
// `API` binding to an internal entrypoint (not an HTTP route)". A real
// `WorkerEntrypoint`, never a path on this Worker's own `fetch()` handler —
// this Worker's own deploy routes are the wildcard
// `*.demos.handsontable.com/*` (every Tier-2 preview subdomain), so any path
// added to the default export's `fetch()` is reachable externally by
// construction. A named RPC entrypoint is not: `workers/o11y/wrangler.jsonc`
// binds `API` with `"entrypoint": "O11yUsage"`, and a named entrypoint has
// no HTTP route at all, on any host — only a service binding can reach it.
//
// "register the usage entrypoint" (this task's Shared row on
// `workers/api/src/index.ts`) means exporting this class from `index.ts`
// alongside the default fetch/scheduled handler — see the export there.

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env.js";
import { computeO11ySpend, recordContainerUsage, SESSION_INSTANCE_TYPE } from "./budget.js";

export class O11yUsage extends WorkerEntrypoint<Env> {
  /** `GrafanaBox`'s awake seconds for one wake (`box.ts#onStop`, T04-D — see
   *  the task Outcome). Recorded under the `o11y_container` sku, additive
   *  per (day, sku) the same way the app's own session meter is (never
   *  overwrites it — distinct sku, same table). */
  async recordAwakeSeconds(awakeSeconds: number): Promise<void> {
    await recordContainerUsage(this.env, {
      instanceType: SESSION_INSTANCE_TYPE,
      awakeSeconds,
      sku: "o11y_container",
    });
  }

  /** Month-to-date `o11y_container` + `o11y_workers` spend and the
   *  ADR-0041 §G cap (`settings.ts#o11yBudgetUsd`) — read by the o11y
   *  worker's own ten-minute alert cron (`alerts/rules.ts#o11yCapRule`) to
   *  decide whether to pause backlog drains. */
  async o11ySpend(): Promise<{ spendUsd: number; capUsd: number }> {
    return computeO11ySpend(this.env);
  }
}
