// ADR-0041 §F.3's watchdog row: "`heartbeat()` on the o11y worker returns
// `lastCron`, `lastIngest` and the backlog" — a `WorkerEntrypoint` (this
// task's "Owns" row), directly unit-testable by constructing one over a fake
// `InboxWriterApi` (`pipeline/o11y-alerts.test.mjs`), the same
// "in-memory fakes for worker bindings" pattern every other DO/Worker class
// in this task uses.
//
// Fix round (finding A-M5): the API worker's `o11y-watchdog.ts` used to
// reach this over the `O11Y` service binding through `fetch()` at
// `/_internal/heartbeat`, wired directly into `index.ts`'s default `fetch()`
// handler — reachable by ANY request that reached this Worker, not only the
// service binding. `index.ts` no longer answers that path at all (it 404s,
// same as any other unregistered route); this report is now served ONLY
// through this class's own `heartbeat()` RPC method, reachable only by a
// caller bound to it BY NAME (`entrypoint: "O11yHeartbeat"` in the caller's
// `wrangler.jsonc`, the same pattern this Worker's own `API`/`O11yUsage`
// binding already uses). `fetch()` below still exists and still answers the
// report unconditionally (ignoring the request/path entirely) so a
// `Fetcher`-typed binding pointed at this named entrypoint keeps working
// with NO CODE CHANGE on the caller's side — only its `wrangler.jsonc`
// binding needs the `entrypoint` field added. `o11y-watchdog.ts` itself
// (workers/api/src/) is unowned by this task and was not changed.

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
   *  above is the real RPC surface); this `fetch()` exists so a
   *  `Fetcher`-typed binding pointed at THIS class (`entrypoint:
   *  "O11yHeartbeat"`) — the shape `o11y-watchdog.ts` needs — can still be
   *  answered over `.fetch(url)`. Ignores the request/path entirely and
   *  always returns the heartbeat report; the caller's URL (e.g. the old
   *  `/_internal/heartbeat`) is cosmetic only. */
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
