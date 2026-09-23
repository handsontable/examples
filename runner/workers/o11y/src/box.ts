// The Loki + Grafana box (ADR-0041 §A). Owned by T01 (COMMON.md shared-file
// table: "workers/o11y/src/box.ts | T01"; T03 wires wake/stop orchestration
// on top of this in a later task, per the same table's merge order
// "T01 → T03").
//
// Scope, matching the task file's "Out" line exactly: this file gives
// `GrafanaBox` real behaviour (envVars, a fresh wakeId per start recorded in
// InboxWriter, readiness, the container-facing half of the stop protocol,
// onStop bookkeeping, and the /api/live/* defense-in-depth the controller
// ruled required — see the T01-D1 note in containers/o11y/grafana/grafana.ini).
// It does NOT decide *when* to wake (a Grafana visit through Access vs. the
// backlog cron) or proxy Grafana's own routes — those are T03's "wake and
// Grafana access" task, explicitly out of scope here.

import { Container } from "@cloudflare/containers";
import type { Env } from "./env.js";

/** ADR-0041 §B.1: every request reaches the o11y worker on this hostname,
 *  never a per-deploy variable — hardcoded rather than a new `vars` entry
 *  (unlike `CLOUDFLARE_ACCOUNT_ID`, which genuinely differs per account and
 *  has no other source at runtime, this string never varies). */
const PUBLIC_ORIGIN = "https://demos.handsontable.com";

/** Matches the observability contract §1's bucket-name table; also
 *  hardcoded rather than read from the `O11Y_LOKI_STATE` R2 binding (an
 *  `R2Bucket` object has no `.name` the Worker can read at runtime) — the
 *  same pattern `containers/o11y/compose.yml` already uses for its own
 *  MinIO bucket name. */
const LOKI_BUCKET_NAME = "handsontable-demos-o11y-loki";

const WAKE_STORAGE_KEY = "wake";
const LAST_STOP_STORAGE_KEY = "lastStop";

type WakeReason = "backlog" | "visit";

interface WakeRecord {
  wakeId: string;
  reason: WakeReason;
  startedAt: number;
}

interface StopRecord {
  wakeId: string | null;
  exitCode?: number;
  reason?: string;
  at: number;
}

/** Every path shape that must never reach a raw `/api/live/*` handshake,
 * normalized before matching (T01 fix-round-1 finding I1's follow-through):
 * `[live] max_connections = 0` only stops Grafana's OWN frontend from
 * opening a socket (confirmed via `liveEnabled: false`); a raw client that
 * dials the endpoint directly still gets a full Centrifuge connection
 * regardless of that setting (reproduced on 11.4.0, grafana/grafana#72072).
 * This is therefore the one place that actually refuses it. */
const LIVE_PATH_RE = /^\/(?:grafana\/)?api\/live(?:\/|$)/;

function normalizedPathname(url: URL): string {
  // Percent-decode each segment and collapse repeated slashes before
  // matching — a route matched on the raw, undecoded pathname is a known
  // way to smuggle a blocked path past a naive string/regex check.
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    // An unparseable percent-encoding is suspicious on its own; treat it as
    // matching (fail closed) rather than let it through un-normalized.
    return url.pathname;
  }
  return decoded.replace(/\/{2,}/g, "/");
}

function isBlockedLiveRequest(request: Request): boolean {
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    // Defense in depth beyond the path check: nothing this box legitimately
    // serves needs a websocket upgrade at all.
    return true;
  }
  const url = new URL(request.url);
  return LIVE_PATH_RE.test(normalizedPathname(url));
}

function inboxWriterStub(env: Env) {
  return env.INBOX_WRITER.jurisdiction("eu").getByName("main");
}

/** Contract §2: one instance, name `box`, `.jurisdiction("eu")`. Exported
 *  for T03's future wake-trigger callers (the Grafana-visit route, the
 *  backlog cron) — never address `GRAFANA_BOX` any other way, or a second
 *  box (and a second container) gets created. */
export function getGrafanaBoxStub(env: Env) {
  return env.GRAFANA_BOX.jurisdiction("eu").getByName("box");
}

export class GrafanaBox extends Container<Env> {
  // Grafana is the box's own default target; Loki (3100) is reached
  // explicitly (readiness probe, and any future direct Loki proxy T03
  // adds) — see docs/observability-contract.md §1's port table.
  defaultPort = 3000;
  requiredPorts = [3000, 3100];
  // ADR-0041 §A: 15 idle minutes, renewed only by real traffic — `stop()`
  // stays the inherited default (sends SIGTERM), which is what
  // `containers/o11y/supervisor/entrypoint.sh` traps to run the real stop
  // protocol. The 4-hour awake cap is T03's job (it owns the wake/stop
  // orchestration this class hands the mechanism to).
  sleepAfter = "15m";

  #startingPromise: Promise<WakeRecord> | null = null;

  /**
   * The only way to start this container. Mints a fresh wakeId, persists it
   * (durably — this DO can be evicted between `wake()` and `onStop()`, so
   * the wakeId must never live only in memory), records it with
   * `InboxWriter` BEFORE starting (fail closed: if that call throws, the
   * container never starts), then starts the container with a full,
   * rebuilt `envVars` set carrying the new wakeId.
   *
   * Idempotent: a wake already in flight (this instance) or already running
   * (state survives an eviction) returns the existing record instead of
   * minting a second wakeId and calling `recordWake` again — a second call
   * would mark the still-running wake `over: true` in InboxWriter's ledger
   * while it is still draining (ADR-0041 §B.3).
   */
  async wake(reason: WakeReason): Promise<WakeRecord> {
    // Set the in-flight promise SYNCHRONOUSLY, before any `await` — two
    // `wake()` calls issued back-to-back (no await between them, the only
    // shape that matters for a single-threaded isolate) must both observe
    // the same promise. Checking `getState()` first and only latching the
    // guard afterward would leave a window between the two calls' `await`s
    // where neither has set it yet, and both would go on to mint a wakeId
    // and call `start()`.
    if (!this.#startingPromise) {
      this.#startingPromise = this.#wakeInner(reason).finally(() => {
        this.#startingPromise = null;
      });
    }
    return this.#startingPromise;
  }

  async #wakeInner(reason: WakeReason): Promise<WakeRecord> {
    const state = await this.getState();
    if (state.status === "running" || state.status === "healthy") {
      const existing = await this.ctx.storage.get<WakeRecord>(WAKE_STORAGE_KEY);
      if (existing) return existing;
      // Running with no persisted record is an inconsistent state this
      // class never produces itself — fail loudly rather than mint a
      // second wakeId for an already-running container.
      throw new Error(
        `GrafanaBox.wake: container state is "${state.status}" but no wake record is stored`,
      );
    }
    return this.#doWake(reason);
  }

  async #doWake(reason: WakeReason): Promise<WakeRecord> {
    const record: WakeRecord = { wakeId: crypto.randomUUID(), reason, startedAt: Date.now() };
    await this.ctx.storage.put(WAKE_STORAGE_KEY, record);
    // Fail closed: InboxWriter is the ledger's one owner (ADR-0041 §B.3);
    // if it cannot record this wake, the container must not start with a
    // wakeId nothing else knows about.
    await inboxWriterStub(this.env).recordWake(record.wakeId, reason);
    await this.start({ envVars: buildEnvVars(this.env, record.wakeId) });
    return record;
  }

  /**
   * `/ready` (Loki) and `/grafana/api/health` (Grafana) both answering,
   * checked over HTTP — not just "the TCP port accepts a connection", which
   * is all `requiredPorts`/`startAndWaitForPorts` prove (their own
   * `pingEndpoint` check only requires the fetch not to throw, not a 2xx).
   * This is what wake-to-ready timing (exit criterion 6) is measured
   * against.
   */
  async isReady(): Promise<boolean> {
    const state = await this.getState();
    if (state.status !== "running" && state.status !== "healthy") return false;
    try {
      const [loki, grafana] = await Promise.all([
        this.containerFetch(new Request("http://box/ready"), 3100),
        this.containerFetch(new Request("http://box/grafana/api/health"), 3000),
      ]);
      return loki.status === 200 && grafana.status === 200;
    } catch {
      return false;
    }
  }

  /**
   * The container-facing half of ADR-0041's stop protocol: refuse (never
   * auto-start), block live sockets, and otherwise proxy. The protocol
   * itself (stop Loki, confirm the index upload, write the marker, stop
   * Grafana) runs inside the container on SIGTERM
   * (`containers/o11y/supervisor/shutdown.sh`) — `stop()` is left as the
   * inherited default specifically so it keeps sending that signal.
   */
  override async containerFetch(
    requestOrUrl: Request | string | URL,
    portOrInit?: number | RequestInit,
    portParam?: number,
  ): Promise<Response> {
    const request = toInspectableRequest(requestOrUrl, portOrInit);
    if (request && isBlockedLiveRequest(request)) {
      // Refused before touching container state or renewing the activity
      // timer — an idle tab hammering this path must not count as activity
      // even though Live cannot be disabled at the Grafana-config layer.
      return new Response("Not Found", { status: 404 });
    }

    const state = await this.getState();
    if (state.status !== "running" && state.status !== "healthy") {
      // The base class's `containerFetch` auto-starts on any request; that
      // is exactly the WAKE_ID-fails-open bug from the Phase 1 review
      // (T01-D, compose.yml's WAKE_ID) one layer up — an unrelated request
      // arriving while the box is asleep must never silently mint a wake.
      // Only `wake()` may start the container; the waking page (T03) is
      // what a caller serves instead of retrying this blindly.
      return new Response("GrafanaBox is not running — call wake() first.", { status: 503 });
    }

    return super.containerFetch(requestOrUrl, portOrInit, portParam);
  }

  override onStart(): void | Promise<void> {
    // Nothing further to do here: `wake()` already persisted the wake
    // record and called `recordWake` before `start()` was issued. Present
    // so the lifecycle hook is visibly accounted for, not silently unused.
  }

  /**
   * Records exactly what the platform reported, tagged with the wakeId this
   * instance was tracking — and claims nothing about whether the stop was
   * clean. `onStop`'s own report is indistinguishable from a host loss
   * (ADR-0041 §A: `{ exitCode: 0, reason: "exit" }` either way) — the
   * `state/wakes/<wakeId>/clean` marker in the Loki bucket is the only
   * thing the ledger (T03) trusts; this is bookkeeping for exit criterion
   * 12's measurement, not a second source of truth.
   */
  override async onStop(params: { exitCode?: number; reason?: string }): Promise<void> {
    const wake = await this.ctx.storage.get<WakeRecord>(WAKE_STORAGE_KEY);
    const record: StopRecord = {
      wakeId: wake?.wakeId ?? null,
      exitCode: params.exitCode,
      reason: params.reason,
      at: Date.now(),
    };
    await this.ctx.storage.put(LAST_STOP_STORAGE_KEY, record);
  }

  /** For the sandbox probe and any future diagnostic route — not part of
   *  the stop protocol's own trust chain (see `onStop`'s own doc comment). */
  async lastStop(): Promise<StopRecord | undefined> {
    return this.ctx.storage.get<StopRecord>(LAST_STOP_STORAGE_KEY);
  }
}

function toInspectableRequest(
  requestOrUrl: Request | string | URL,
  portOrInit?: number | RequestInit,
): Request | null {
  if (requestOrUrl instanceof Request) return requestOrUrl;
  try {
    const init = typeof portOrInit === "object" ? portOrInit : undefined;
    return new Request(requestOrUrl.toString(), init);
  } catch {
    return null;
  }
}

/**
 * Every env var the container receives, rebuilt from scratch on every
 * start — never merged with a previous call's values (T01 fix-round-1's
 * WAKE_ID lesson one layer up: a stale value surviving between wakes is
 * exactly the failure the compose.yml default was fixed for). Fails closed
 * (throws, so `wake()` never calls `start()`) when a required secret is
 * missing — a box that cannot reach its own storage must not boot.
 */
function buildEnvVars(env: Env, wakeId: string): Record<string, string> {
  const missing = (["LOKI_S3_ACCESS_KEY_ID", "LOKI_S3_SECRET_ACCESS_KEY"] as const).filter(
    (key) => !env[key],
  );
  if (missing.length > 0) {
    throw new Error(`GrafanaBox: cannot start without ${missing.join(", ")}`);
  }
  if (!env.CLOUDFLARE_ACCOUNT_ID) {
    throw new Error("GrafanaBox: cannot start without CLOUDFLARE_ACCOUNT_ID");
  }

  const accountId = env.CLOUDFLARE_ACCOUNT_ID;

  return {
    WAKE_ID: wakeId,
    STORAGE: "s3",
    LOKI_S3_ENDPOINT: `${accountId}.eu.r2.cloudflarestorage.com`,
    LOKI_S3_REGION: "auto",
    LOKI_S3_ACCESS_KEY_ID: env.LOKI_S3_ACCESS_KEY_ID as string,
    LOKI_S3_SECRET_ACCESS_KEY: env.LOKI_S3_SECRET_ACCESS_KEY as string,
    LOKI_S3_BUCKET: LOKI_BUCKET_NAME,
    // Real R2, real TLS — "true" is only ever correct for local MinIO
    // (containers/o11y/compose.yml).
    LOKI_S3_INSECURE: "false",
    GF_SERVER_ROOT_URL: `${PUBLIC_ORIGIN}/grafana/`,
    // vertamedia-clickhouse-datasource against the real Analytics Engine
    // SQL API (T01 fix-round-1 finding I1/P2): a single custom
    // `Authorization: Bearer <token>` header, never host/port/user/password
    // fields — see grafana/provisioning/datasources/datasources.yaml's own
    // comment. HEADER2 stays unused in production (local-only, ClickHouse's
    // two-header X-ClickHouse-User/-Key shape).
    O11Y_CLICKHOUSE_URL: `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
    O11Y_CLICKHOUSE_DATABASE: "",
    O11Y_CLICKHOUSE_HEADER1_NAME: "Authorization",
    O11Y_CLICKHOUSE_HEADER1_VALUE: env.AE_SQL_TOKEN ? `Bearer ${env.AE_SQL_TOKEN}` : "",
    O11Y_CLICKHOUSE_HEADER2_NAME: "",
    O11Y_CLICKHOUSE_HEADER2_VALUE: "",
    // SLACK_WEBHOOK_URL is deliberately never included — ADR-0041 §A: "The
    // Slack webhook never enters the box."
  };
}
