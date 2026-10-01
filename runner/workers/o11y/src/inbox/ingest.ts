// The deadline-and-backstop wrapper around `InboxWriter.ingest` for every
// ingest route (`collect`, `v1/logs`, `deploy`, `hooks/sentry`): a stuck or
// throwing Durable Object call becomes an accounted 503 with `Retry-After`
// instead of a hung request or an unhandled exception that writes no
// `o11y.ingest` point.

import type { Env, IngestItem, IngestResult } from "../env.js";
import type { GateDrop } from "../gates/types.js";
import { inboxWriter } from "./accessor.js";

/** A healthy commit is a few ms of DO SQLite work, so 10 s is far past
 *  normal while still answering the exporter before it gives up on its own. */
export const INGEST_DEADLINE_MS = 10_000;

/** Seconds the caller is told to wait before redelivering. */
export const INGEST_RETRY_AFTER_SECONDS = 30;

export type IngestOutcome = { ok: true; result: IngestResult } | { ok: false; drop: GateDrop };

/** Races `InboxWriter.ingest` against {@link INGEST_DEADLINE_MS}. An
 *  `AbortSignal` cannot cancel a DO RPC, so the losing call is abandoned, not
 *  stopped; its dedupe-by-hash makes the retry safe. */
export async function ingestWithDeadline(
  env: Env,
  tenant: "worker" | "browser",
  receivedAtMs: number,
  items: IngestItem[],
): Promise<IngestOutcome> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timedOut = Symbol("ingest_timeout");
  const deadline = new Promise<typeof timedOut>((resolve) => {
    timer = setTimeout(() => resolve(timedOut), INGEST_DEADLINE_MS);
  });
  try {
    const result = await Promise.race([inboxWriter(env).ingest(tenant, receivedAtMs, items), deadline]);
    if (result === timedOut) {
      return { ok: false, drop: { ok: false, reason: "ingest_timeout", status: 503, retryAfterSeconds: INGEST_RETRY_AFTER_SECONDS } };
    }
    return { ok: true, result };
  } catch (err) {
    console.warn("[o11y] ingest failed:", err instanceof Error ? err.message : String(err));
    return { ok: false, drop: { ok: false, reason: "ingest_error", status: 503, retryAfterSeconds: INGEST_RETRY_AFTER_SECONDS } };
  } finally {
    clearTimeout(timer);
  }
}
