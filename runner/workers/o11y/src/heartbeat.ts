// ADR-0041 §F.3 watchdog: `heartbeat()` returns lastCron, lastIngest and the
// backlog age. RPC-only: callers bind to it by name
// (`entrypoint: "O11yHeartbeat"`); the default export does not serve it, so no
// public request can reach it.

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
}

export async function readHeartbeatReport(env: Env): Promise<HeartbeatReport> {
  const writer = inboxWriter(env);
  const [heartbeat, backlogOldestAgeMs] = await Promise.all([writer.heartbeat(), writer.backlogOldestAgeMs()]);
  return { lastCron: heartbeat.lastCron, lastIngest: heartbeat.lastIngest, backlogOldestAgeMs };
}
