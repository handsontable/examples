// Detached snapshot builds for the MCP service path.
//
// A cold tier-2 framework build (next/ng/astro/nuxt/remix) takes minutes, and the
// MCP clients calling POST /api/mcp/demos abort the tool call at ~60 seconds —
// which cancelled the whole request chain mid-build, every time, with nothing
// recorded. The route now records the demo as `building` and hands the build to
// this Durable Object; the caller gets its links back in milliseconds.
//
// Why a Durable Object alarm and not `ctx.waitUntil()`: waitUntil is capped at
// 30 seconds after the response is sent, while an alarm handler gets 15 minutes
// of wall time and at-least-once execution — the right envelope for "finish this
// build even though the caller is gone". One DO per demo id (`idFromName`), so a
// demo's builds serialize naturally and the object is empty except mid-build.
//
// The alarm deliberately reuses `updateDemo()` as its finalizer for creates and
// rebuilds alike: it already owns the build-or-copy decision, the R2 upload, the
// build_cache write, the source snapshot, and — since 0007 — flipping
// build_status back to 'ready'. Nothing here re-implements a build.

import * as Sentry from "@sentry/cloudflare";
import type { DurableObjectState } from "@cloudflare/workers-types";
import type { Env } from "./env.js";
import { BUILD_CONFIG } from "./frameworks.generated.js";
import { isAtCapacityFailure } from "./session-lifecycle.js";
import { BuildFailure, buildFailureTags, demoBuildState, getDemo, invalidateDemo, updateDemo } from "./share.js";

export interface SnapshotJob {
  demoId: string;
  framework: string;
  /** Resolved ref (never a dist-tag): the route resolves before scheduling. */
  htVersion: string;
  /**
   * R2 key holding the `{ framework, files }` payload to build:
   * `demos/<id>/__source.json` for a create (parked by `createPendingDemo`, and
   * identical to what a finished build would store), `demos/<id>/__job.json` for
   * a rebuild — kept apart so the stored source keeps matching the artifact that
   * is still being served until the rebuild actually succeeds.
   */
  filesKey: string;
  /** At-capacity retries burned so far (they cost nothing — no container booted). */
  attempt: number;
}

export const SCHEDULE_PATH = "/schedule";

/** Bounded: an at-capacity failure means no container booted, so waiting out the
 *  pool is free — but only a few times, or a saturated pool pins jobs forever. */
export const MAX_CAPACITY_ATTEMPTS = 3;
export const CAPACITY_RETRY_MS = 60_000;

/** Longest a failure cause may travel in the row. It is a one-line cause by
 *  construction (`describeBuildFailure`), never a log — the DEMOS-1Y rule. */
const BUILD_ERROR_MAX = 500;

/** Hand a build to the demo's BuildJob object. The job payload is tiny on
 *  purpose — the files wait in R2 under `filesKey`, not in DO storage. */
export async function scheduleSnapshotBuild(env: Env, job: Omit<SnapshotJob, "attempt">): Promise<void> {
  const ns = env.BUILD_JOBS;
  const stub = ns.get(ns.idFromName(job.demoId));
  const resp = await stub.fetch(`https://build-jobs${SCHEDULE_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(job),
  });
  if (!resp.ok) {
    throw new Error(`snapshot build for ${job.demoId} could not be scheduled (${resp.status})`);
  }
}

/**
 * Run one parked build to completion: read the payload from R2, build (or copy
 * the cached artifact) via `updateDemo()`, and clean up a rebuild's `__job.json`.
 * Throws on failure — `alarm()` below owns turning a throw into a failed row.
 */
export async function runSnapshotJob(env: Env, job: SnapshotJob): Promise<void> {
  const cfg = BUILD_CONFIG[job.framework];
  if (!cfg) throw new Error(`snapshot job for ${job.demoId}: unknown framework '${job.framework}'`);
  const obj = await env.ARTIFACTS.get(job.filesKey);
  if (!obj) {
    // The payload was written before the job was ever scheduled, so its absence
    // means one of two things: an at-least-once re-run of an alarm whose first
    // run finalized (and cleaned up) but was cut down before clearing its own
    // storage — the row says 'ready', and there is nothing left to do — or the
    // payload is genuinely gone, which is a failure. Deciding by the row is what
    // keeps a platform retry from marking a *successful* build failed (Bugbot,
    // PR #305).
    const row = await getDemo(env, job.demoId);
    if (row && demoBuildState(row, Date.now()) === "ready") return;
    throw new Error(`snapshot job for ${job.demoId}: no payload at ${job.filesKey}`);
  }
  const { files } = JSON.parse(await obj.text()) as { files?: Record<string, string> };
  if (!files || Object.keys(files).length === 0) {
    throw new Error(`snapshot job for ${job.demoId}: empty payload at ${job.filesKey}`);
  }
  await updateDemo(env, {
    id: job.demoId,
    entry: { framework: job.framework, ...cfg },
    files,
    htVersion: job.htVersion,
    // No title/description on purpose: absent means "leave the column alone",
    // so a rename committed while the build ran is never reverted (DEV-2495).
    now: new Date().toISOString(),
  });
  if (job.filesKey.endsWith("__job.json")) {
    // Best effort: the build has already succeeded, and a throw from cleanup
    // would route through alarm()'s catch and record that success as a failure
    // (Bugbot, PR #305). An orphaned __job.json is harmless — `__` paths are
    // never served, and the next rebuild overwrites it.
    try {
      await env.ARTIFACTS.delete(job.filesKey);
    } catch (err) {
      console.warn(`[build-job] could not clean up ${job.filesKey}:`, err);
    }
  }
}

/**
 * Record a build that will not finish. Never throws: a throw out of `alarm()`
 * would spend the platform's retry budget re-running a container build that
 * already failed deterministically.
 */
export async function markSnapshotFailed(env: Env, job: SnapshotJob, err: unknown): Promise<void> {
  const cause = err instanceof Error ? err.message : String(err);
  try {
    await env.DB.prepare("UPDATE demos SET build_status='failed', build_error=?, updated_at=? WHERE id=?")
      .bind(cause.slice(0, BUILD_ERROR_MAX), new Date().toISOString(), job.demoId)
      .run();
    await invalidateDemo(env, job.demoId);
  } catch (writeErr) {
    // The row stays 'building'; the stale rule in demoBuildState is the backstop
    // that eventually reads it as failed. Report, don't rethrow (see above).
    console.error(`[build-job] could not mark ${job.demoId} failed:`, writeErr);
    Sentry.captureException(writeErr);
  }
  if (err instanceof BuildFailure) {
    // Same shape as the synchronous path's report in index.ts, so both land in
    // the same Sentry groups.
    Sentry.captureException(err, {
      tags: buildFailureTags(err),
      fingerprint: ["snapshot-build", err.phase, err.code],
      ...(err.log ? { extra: { buildLog: err.log } } : {}),
    });
  } else {
    Sentry.captureException(err);
  }
}

/**
 * The Durable Object. Exported unwrapped for tests; index.ts exports the
 * Sentry-instrumented `BuildJob` that wrangler actually binds.
 */
export class BuildJobBase {
  // Written out rather than declared as constructor parameter properties: the
  // pipeline suites import this module through `--experimental-strip-types`,
  // which refuses them outright — same constraint `BuildFailure` documents.
  private readonly state: DurableObjectState;
  private readonly env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === SCHEDULE_PATH) {
      const job = (await request.json()) as Omit<SnapshotJob, "attempt">;
      // Last write wins by design: the routes refuse to schedule while a build
      // is running (the 409 in index.ts), so an overwrite here can only be a
      // reschedule of a job whose row is no longer 'building'.
      const stored: SnapshotJob = { ...job, attempt: 0 };
      await this.state.storage.put("job", stored);
      await this.state.storage.setAlarm(Date.now());
      return new Response(JSON.stringify({ scheduled: true }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    const job = await this.state.storage.get<SnapshotJob>("job");
    if (!job) return;
    try {
      await runSnapshotJob(this.env, job);
      await this.state.storage.deleteAll();
    } catch (err) {
      if (isAtCapacityFailure(err) && job.attempt + 1 < MAX_CAPACITY_ATTEMPTS) {
        await this.state.storage.put("job", { ...job, attempt: job.attempt + 1 });
        await this.state.storage.setAlarm(Date.now() + CAPACITY_RETRY_MS);
        return;
      }
      await markSnapshotFailed(this.env, job, err);
      await this.state.storage.deleteAll();
    }
  }
}
