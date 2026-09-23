// ADR-0041 §F.3's watchdog row: "`heartbeat()` on the o11y worker returns
// `lastCron`, `lastIngest` and the backlog" — a `WorkerEntrypoint` (this
// task's "Owns" row), directly unit-testable by constructing one over a fake
// `InboxWriterApi` (`pipeline/o11y-alerts.test.mjs`), the same
// "in-memory fakes for worker bindings" pattern every other DO/Worker class
// in this task uses.
//
// The API worker's `o11y-watchdog.ts` reaches this over the `O11Y` service
// binding through `fetch()` at `/_internal/heartbeat` (index.ts wires that
// path directly, never through `router.ts` — see the comment there for why
// that is safe here but would NOT be safe on the API worker's own default
// export, which is bound behind this class's own `heartbeat()` RPC method
// for exactly that reason). Both surfaces read the same report; `fetch()` is
// the one a cross-worker `Fetcher` binding can actually call without a
// cross-project type import (see `o11y-watchdog.ts`'s own doc comment).

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env.js";
import { inboxWriter } from "./inbox/accessor.js";

export interface HeartbeatReport {
  lastCron: number;
  lastIngest: number;
  backlogOldestAgeMs: number | null;
}

export class O11yHeartbeat extends WorkerEntrypoint<Env> {
  async heartbeat(): Promise<HeartbeatReport> {
    return readHeartbeatReport(this.env);
  }

  /** Named-entrypoint calls do not carry an HTTP route (`heartbeat()`
   *  above is the real RPC surface); this `fetch()` exists only so a
   *  `Fetcher`-typed binding to the WORKER'S DEFAULT export (not this
   *  class) can still be answered if ever bound that way. Not the path
   *  `o11y-watchdog.ts` actually calls — see `index.ts`'s own
   *  `/_internal/heartbeat` handler for that. Present for completeness /
   *  symmetry with `WorkerEntrypoint`'s optional `fetch` hook only. */
  override async fetch(): Promise<Response> {
    return new Response(JSON.stringify(await this.heartbeat()), {
      headers: { "content-type": "application/json" },
    });
  }
}

export async function readHeartbeatReport(env: Env): Promise<HeartbeatReport> {
  const writer = inboxWriter(env);
  const [heartbeat, backlogOldestAgeMs] = await Promise.all([writer.heartbeat(), writer.backlogOldestAgeMs()]);
  return { lastCron: heartbeat.lastCron, lastIngest: heartbeat.lastIngest, backlogOldestAgeMs };
}
