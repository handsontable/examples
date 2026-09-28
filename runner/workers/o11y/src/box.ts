// The Loki + Grafana box (ADR-0041 §A): gives `GrafanaBox` real behaviour
// (envVars, a fresh wakeId per start recorded in InboxWriter, readiness, the
// container-facing half of the stop protocol, onStop bookkeeping, and the
// /api/live/* defense-in-depth — see containers/o11y/grafana/grafana.ini).
// It does not decide *when* to wake (a Grafana visit through the login
// broker session vs. the backlog cron) or proxy Grafana's own routes.

import { Container } from "@cloudflare/containers";
import { o11ySelfIdentity } from "./normalise/respond.js";
import { writePointFromDo } from "./normalise/points.js";
import { toAePoint, type HotAttrs } from "@handsontable/demo-runtime/telemetry";
import { drainBatch, type DrainDeps } from "./drain/drain.js";
import { symbolicateResourceLogs } from "./drain/symbolicate.js";
import type { Env } from "./env.js";
import { reportAwakeSeconds } from "./cost.js";
import { PUBLIC_ORIGIN } from "./gates/session.js";

/** Contract §1 bucket name; `env.LOKI_S3_BUCKET` overrides it (probes point
 *  it at their own bucket). An `R2Bucket` binding exposes no `.name`, so the
 *  name cannot come from `O11Y_LOKI_STATE`. */
const DEFAULT_LOKI_BUCKET_NAME = "handsontable-demos-o11y-loki";

const WAKE_STORAGE_KEY = "wake";
const LAST_STOP_STORAGE_KEY = "lastStop";
/** The wakeId THIS instance last asked to stop (`hardCapStop`,
 *  `#finishDrain`'s quiet check, or the base class's idle timeout), so
 *  {@link GrafanaBox.isReady} can skip its probes for that wake's
 *  SIGTERM→exit window: `stop()` does not change `getState()`'s status (see
 *  `#wakeInner`'s running/healthy branch). Persisted (the DO can be evicted
 *  during the stop grace) and scoped by wakeId, cleared at the start of
 *  `#doWake` so no marker survives into the next wake. */
const STOPPING_FOR_STORAGE_KEY = "stoppingFor";
/** Persisted separately from the base `Container` class's own idle clock
 *  (never read directly here — a real `containerFetch`, including the
 *  drain's own Loki pushes, always renews that clock too, harmless: it only
 *  protects an in-flight drain or open Grafana tab from the 15-minute idle
 *  stop). ADR §A's quiet-stop rule needs its own clock, driven only by real
 *  `/grafana/*` traffic via {@link GrafanaBox.noteVisitorActivity}. */
const LAST_GRAFANA_STORAGE_KEY = "lastGrafanaAt";
/** Guards `onStart`'s double-invocation (see its own doc comment) from
 *  scheduling `drainStep` twice for the same wake. */
const DRAIN_SCHEDULED_FOR_STORAGE_KEY = "drainScheduledFor";
/** The wakeId whose wake-to-ready time was already reported to InboxWriter,
 *  so only a wake's first successful `isReady()` reports it. */
const READY_RECORDED_FOR_STORAGE_KEY = "readyRecordedFor";
const HARD_CAP_SCHEDULE = "hardCapStop";
const DRAIN_STEP_SCHEDULE = "drainStep";
/** ADR §A: "after 4 hours awake regardless." */
const WAKE_HARD_CAP_MS = 4 * 60 * 60 * 1000;
/** ADR §A stop protocol: "if no Grafana request arrived in the last 10
 *  minutes the Worker calls `stop()`." */
const GRAFANA_QUIET_STOP_MS = 10 * 60 * 1000;
/** Objects drained per `drainStep` invocation: a starting value, not tuned
 *  against real per-object CPU cost, kept well under any plausible
 *  per-object cost times `limits.cpu_ms` so one invocation cannot blow the
 *  Worker's CPU budget. */
const DRAIN_BATCH_SIZE = 10;
/** Minimum gap before `drainStep` reschedules itself: the base
 *  `Container.alarm()` loop reads every due `container_schedules` row ONCE
 *  at the top of its own invocation and compares each row's `time` (whole
 *  seconds) against a `now` captured before the loop starts. A full 1000 ms
 *  gap is provably enough: `schedule()` floors the target time to whole
 *  seconds, so a row inserted at real time `T1 >= T0` with a 1000 ms offset
 *  floors to `> floor(T0) + 1 > T0` for any `T0` — it can never satisfy
 *  `row.time <= now` for the `now` captured at the start of the invocation
 *  that inserted it. */
const DRAIN_STEP_GAP_MS = 1000;

// Every await on the container, or on `@cloudflare/containers`' own start
// machinery, is bounded: a container port that accepts a connection and
// never answers can hang `start()` and `isReady()` forever, since the
// library's healthy-state `containerFetch` goes straight to `tcpPort.fetch`.
/** One `isReady()` probe (Loki `/ready`, Grafana `/api/health`). Both
 *  answer in milliseconds on a live box. */
const READY_PROBE_TIMEOUT_MS = 5_000;
/** How long a `wake()` CALLER waits for a start already in flight before it
 *  gets a rejection instead: `/grafana/*` then serves the waking page, whose
 *  own 3 s refresh asks again. The start itself keeps running. */
const WAKE_WAIT_MS = 15_000;
/** How long `start()` may take before this instance is treated as wedged.
 *  The library's own retry budget in `start()` is 27 attempts of up to
 *  5 s each plus 300 ms apart, about 143 s. */
const START_DEADLINE_MS = 180_000;
/** One drain push to Loki's OTLP endpoint. `drainStep` runs inside the base
 *  class's `alarm()`, and alarms are serialised, so an unanswered push would
 *  freeze every later schedule too: the next drain step, `hardCapStop`, and
 *  the idle-stop check. A timed-out push comes back as the library's 500,
 *  which `drain.ts` retries and then stops early on. */
const LOKI_PUSH_TIMEOUT_MS = 60_000;

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
 * normalized before matching: `[live] max_connections = 0` only stops
 * Grafana's OWN frontend from opening a socket — a raw client that dials the
 * endpoint directly still gets a full Centrifuge connection regardless of
 * that setting (reproduced on 11.4.0, grafana/grafana#72072). Case
 * insensitive: nothing about HTTP path matching guarantees a proxy or
 * client normalizes case before this ever sees the request. */
const LIVE_PATH_RE = /^\/(?:grafana\/)?api\/live(?:\/|$)/i;

/**
 * Percent-decodes each segment and collapses repeated slashes before
 * matching — a route matched on the raw, undecoded pathname is a known way
 * to smuggle a blocked path past a naive string/regex check. Returns `null`
 * on an unparseable percent-encoding: a caller must fail closed on that, not
 * fall back to a still-encoded pathname the regex could fail to match.
 */
function normalizedPathname(url: URL): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  return decoded.replace(/\/{2,}/g, "/");
}

/** Grafana's LEGACY, frontend-driven datasource proxy route —
 *  `/api/datasources/proxy/uid/<uid>/<rest>` or the numeric-id form
 *  `/api/datasources/proxy/<id>/<rest>` — forwards `<rest>` VERBATIM to that
 *  datasource's configured `url` (see
 *  `containers/o11y/grafana/provisioning/datasources/datasources.yaml`),
 *  with Grafana adding the datasource's own auth header. Every provisioned
 *  dashboard references its datasource by `uid` only; nothing provisioned
 *  uses the numeric-id form. Capture groups: 1 = the `uid/<uid>` value if
 *  that form was used, 2 = the numeric id if that form was used,
 *  3 = `<rest>`. */
const DATASOURCE_PROXY_RE = /^\/(?:grafana\/)?api\/datasources\/proxy\/(?:uid\/([^/]+)|(\d+))\/(.*)$/i;

/** Grafana's MODERN resource-proxy route —
 *  `/api/datasources/uid/<uid>/resources/<rest>` or the numeric-id form
 *  `/api/datasources/<id>/resources/<rest>` — reaches the Loki datasource
 *  plugin's Go `CallResource` handler, which forwards `<rest>` under a
 *  fixed `/loki/api/v1/<rest>` prefix to Loki's real API (confirmed live
 *  against this box's own Grafana 11.4 + Loki plugin). This route is not
 *  "unregistered names can't reach Loki"; everything is forwarded under
 *  that prefix, so the allowlist below is the real boundary, gated the same
 *  way as the legacy proxy route above. */
const DATASOURCE_RESOURCE_RE = /^\/(?:grafana\/)?api\/datasources\/(?:uid\/([^/]+)\/resources|(\d+)\/resources)\/(.*)$/i;

/** Loki's own read/query HTTP API (`/loki/api/v1/*`) — everything a
 *  dashboard panel or Explore can legitimately need through the legacy
 *  proxy path. `tail` streams over a websocket upgrade — already refused
 *  unconditionally above regardless of path — kept in this allowlist only
 *  so a non-upgrade request to the same path isn't blocked here for a
 *  second, more confusing reason. */
const LOKI_ALLOWED_QUERY_RE =
  /^loki\/api\/v1\/(?:query|query_range|labels|label\/[^/]+\/values|series|index\/stats|index\/volume(?:_range)?|patterns|detected_labels|detected_fields|tail|format_query)\/?$/i;

/** The same logical read/query set as {@link LOKI_ALLOWED_QUERY_RE}, without
 *  the `loki/api/v1/` prefix — the modern resource route's `<rest>` is the
 *  bare Go handler name (`labels`, `series`, `index/stats`, …). An
 *  unimplemented-but-allowed name is harmless (still 404s inside Grafana);
 *  the risk this gate exists for is an implemented name that shouldn't be
 *  reachable, not the reverse. */
const LOKI_ALLOWED_RESOURCE_RE =
  /^(?:query|query_range|labels|label\/[^/]+\/values|series|index\/stats|index\/volume(?:_range)?|patterns|detected_labels|detected_fields|detected_fields\/[^/]+\/values|tail|format_query)\/?$/i;

/** `true` if `uid`/`numericId` (as extracted from either the legacy proxy
 *  or the modern resource route) identifies a request this gate must hold
 *  to an allowlist at all — a `loki-*` uid, or the numeric-id form
 *  (default-deny: it cannot be resolved back to an identity, so it gets the
 *  same strict allowlist unconditionally). `false` (untouched by this gate)
 *  for any other uid, e.g. ClickHouse's `clickhouse-runner-events`. */
function isGatedDatasourceSelector(uid: string | undefined, numericId: string | undefined): boolean {
  if (uid !== undefined) return /^loki-/i.test(uid); // a non-Loki uid (e.g. ClickHouse) — untouched
  return numericId !== undefined;
}

/** `true` for a datasource-proxy OR datasource-resource request that is not
 *  on the Loki read/query allowlist above. Identification is by the
 *  SELECTOR, not by `<rest>` — a `<rest>`-shape denylist would risk missing
 *  an unenumerated Loki endpoint (e.g. the drain's own ingest path,
 *  `/otlp/v1/logs`, is also served at Loki's bare root and is NOT under
 *  `/loki/...`). */
function isBlockedLokiProxyPath(normalized: string): boolean {
  // `normalized` is already fully percent-decoded and slash-collapsed by
  // this function's one caller (`isBlockedContainerRequest`, via
  // `normalizedPathname`) — `uid`/`rest` below need no further decoding.
  const proxyMatch = DATASOURCE_PROXY_RE.exec(normalized);
  if (proxyMatch) {
    const [, uid, numericId, rest] = proxyMatch;
    if (!isGatedDatasourceSelector(uid, numericId)) return false;
    return !LOKI_ALLOWED_QUERY_RE.test(rest ?? "");
  }
  const resourceMatch = DATASOURCE_RESOURCE_RE.exec(normalized);
  if (resourceMatch) {
    const [, uid, numericId, rest] = resourceMatch;
    if (!isGatedDatasourceSelector(uid, numericId)) return false;
    return !LOKI_ALLOWED_RESOURCE_RE.test(rest ?? "");
  }
  return false;
}

function isBlockedContainerRequest(request: Request): boolean {
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    // Defense in depth beyond the path check: nothing this box legitimately
    // serves needs a websocket upgrade at all.
    return true;
  }
  const url = new URL(request.url);
  const normalized = normalizedPathname(url);
  // Fail closed: an unparseable path is refused, not let through.
  if (normalized === null) return true;
  return LIVE_PATH_RE.test(normalized) || isBlockedLokiProxyPath(normalized);
}

// Locally, workerd's Durable Object simulation throws the moment
// `.jurisdiction()` is called (`Error: Jurisdiction restrictions are not
// implemented in workerd`), so this mirrors `inbox/accessor.ts#inboxWriter`'s
// pattern: skip jurisdiction only under `O11Y_ENV === "local"`; production
// is unchanged.
function inboxWriterStub(env: Env) {
  const ns = env.O11Y_ENV === "local" ? env.INBOX_WRITER : env.INBOX_WRITER.jurisdiction("eu");
  return ns.getByName("main");
}

/** `o11y.*` self-metric write from inside `GrafanaBox` (a DO) — see
 *  `normalise/points.ts#writePointFromDo`'s own doc comment for why a
 *  separate DO-flavoured writer exists next to the route-handler one. */
function writeBoxPoint(
  env: Env,
  ctx: DurableObjectState,
  metric: Parameters<typeof toAePoint>[0],
  values: Parameters<typeof toAePoint>[1],
  attrs: HotAttrs,
): void {
  writePointFromDo(env, ctx, toAePoint(metric, values, { ...o11ySelfIdentity(env), ...attrs }));
}

/** Contract §2: one instance, name `box`, `.jurisdiction("eu")` in
 *  production (see `inboxWriterStub` for why not locally). Never address
 *  `GRAFANA_BOX` any other way, or a second box (and container) gets
 *  created. */
export function getGrafanaBoxStub(env: Env) {
  const ns = env.O11Y_ENV === "local" ? env.GRAFANA_BOX : env.GRAFANA_BOX.jurisdiction("eu");
  return ns.getByName("box");
}

export class GrafanaBox extends Container<Env> {
  // Grafana is the box's own default target; Loki (3100) is reached
  // explicitly (readiness probe) — see docs/observability-contract.md §1's
  // port table.
  defaultPort = 3000;
  requiredPorts = [3000, 3100];
  // ADR-0041 §A: 15 idle minutes, renewed only by real traffic. `stop()`
  // stays the inherited default (sends SIGTERM), which
  // `containers/o11y/supervisor/entrypoint.sh` traps to run the real stop
  // protocol.
  sleepAfter = "15m";

  #startingPromise: Promise<WakeRecord> | null = null;

  // Instance fields only so tests can shrink these bounds; production never
  // assigns them.
  readyProbeTimeoutMs = READY_PROBE_TIMEOUT_MS;
  wakeWaitMs = WAKE_WAIT_MS;
  startDeadlineMs = START_DEADLINE_MS;
  lokiPushTimeoutMs = LOKI_PUSH_TIMEOUT_MS;
  /** When an `isReady()` probe first ran out of time with no probe settling
   *  since. In memory only: a fresh instance starts clean. */
  #probesStuckSince: number | null = null;

  /**
   * The only way to start this container. Mints a fresh wakeId, persists it
   * durably (this DO can be evicted between `wake()` and `onStop()`),
   * records it with `InboxWriter` BEFORE starting (fail closed: if that
   * call throws, the container never starts), then starts the container
   * with a full, rebuilt `envVars` set carrying the new wakeId.
   *
   * Idempotent: a wake already in flight or already running returns the
   * existing record instead of minting a second wakeId and calling
   * `recordWake` again, which would mark the still-running wake `over: true`
   * in InboxWriter's ledger while it is still draining (ADR-0041 §B.3).
   */
  async wake(reason: WakeReason): Promise<WakeRecord> {
    // Set the in-flight promise SYNCHRONOUSLY, before any `await` — two
    // `wake()` calls issued back-to-back (no await between them) must both
    // observe the same promise; latching after checking `getState()` first
    // would leave both calls to mint a wakeId and call `start()`.
    if (!this.#startingPromise) {
      this.#startingPromise = this.#wakeInner(reason).finally(() => {
        this.#startingPromise = null;
      });
    }
    // A caller waits at most `wakeWaitMs` for the shared promise, so one
    // start that never settles cannot pin every later caller.
    return withDeadline(this.#startingPromise, this.wakeWaitMs, "GrafanaBox.wake: container start still in flight");
  }

  async #wakeInner(reason: WakeReason): Promise<WakeRecord> {
    const state = await this.getState();
    if (state.status === "running" || state.status === "healthy") {
      // Also protects a still-draining container from a second wake:
      // `stop()` (SIGTERM) does not change `getState()`'s status in the
      // real `@cloudflare/containers` library, so this still reports
      // running/healthy for the whole window between calling `stop()` and
      // the process actually exiting. Returning the existing record
      // (below) is what prevents minting a second wakeId here.
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
    const wakeId = crypto.randomUUID();
    // envVars are built and validated first, as a pure synchronous step: a
    // missing required secret throws here, before any storage write and
    // before InboxWriter.recordWake, so a failed wake never leaves the
    // ledger believing a wake started that never will.
    const envVars = buildEnvVars(this.env, wakeId);
    const record: WakeRecord = { wakeId, reason, startedAt: Date.now() };
    await this.ctx.storage.put(WAKE_STORAGE_KEY, record);
    // Not scoped by wakeId: without this reset, a previous wake's visitor
    // activity would survive into this one, letting `#finishDrain`'s quiet
    // check read it as "recent" even with no visitor yet this wake — ADR
    // §A's quiet-stop rule needs a genuinely quiet backlog-only wake.
    await this.ctx.storage.delete(LAST_GRAFANA_STORAGE_KEY);
    // A previous wake's "stopping" marker must never survive into this one
    // (see STOPPING_FOR_STORAGE_KEY's doc comment); wakeId scoping already
    // prevents a stale marker from matching, this just avoids a dead key.
    await this.ctx.storage.delete(STOPPING_FOR_STORAGE_KEY);
    // Fail closed: InboxWriter is the ledger's one owner (ADR-0041 §B.3);
    // if it cannot record this wake, the container must not start with a
    // wakeId nothing else knows about.
    await inboxWriterStub(this.env).recordWake(record.wakeId, reason);
    // ADR §A: "after 4 hours awake regardless." Scheduled before `start()`,
    // not after: when `start()` hangs or throws after the container was
    // already issued, that container still runs under this wakeId and
    // still needs its cap.
    await this.schedule(new Date(Date.now() + WAKE_HARD_CAP_MS), HARD_CAP_SCHEDULE, { wakeId: record.wakeId });
    try {
      await withDeadline(this.start({ envVars }), this.startDeadlineMs, "GrafanaBox.start()");
    } catch (err) {
      if (err instanceof DeadlineExceeded) this.#resetWedgedInstance(record.wakeId, err);
      throw err;
    }
    // `start()` never calls `state.setHealthy()` (only
    // `startAndWaitForPorts()` does), so `state.status` stays `"running"`.
    // The base `Container.containerFetch` checks that field to decide
    // whether to re-verify ports, so leaving it false makes every later
    // `containerFetch` call this wake (every drain push, every
    // `/grafana/*` proxy request) re-run the full port-polling machinery
    // from scratch — anywhere from ~10ms to 160+ seconds depending on
    // contention. Fired here, deliberately not awaited: `wake()` itself
    // must still return fast, so this just gets `state.status` to
    // `"healthy"` in the background. Harmless if it never resolves.
    void this.startAndWaitForPorts({ ports: this.requiredPorts }).catch(() => {});
    return record;
  }

  /**
   * `start()` did not settle within `startDeadlineMs`. The library keeps
   * its own in-flight start promise, and every later start path joins it,
   * so this instance cannot recover on its own. Only the in-memory object
   * is reset (`ctx.abort()`, the same recovery the library uses for a lost
   * container connection). Storage and the container survive: the next
   * request builds a fresh instance, `wake()` returns this wake's stored
   * record while the container runs, and the first `containerFetch` runs
   * `startAndWaitForPorts`, whose `onStart` schedules this wake's drain.
   */
  #resetWedgedInstance(wakeId: string, err: Error): void {
    console.error(JSON.stringify({ event: "o11y.box.start_wedged", wakeId, message: err.message }));
    try {
      this.ctx.abort?.(err.message);
    } catch {
      // `abort()` throws into the calling context by design, and the caller
      // rethrows the deadline error right after this anyway.
    }
  }

  /**
   * The reload path: an instance that did not start the container itself (a
   * hot reload, deploy or eviction while the box kept running) never goes
   * through `#doWake`'s start deadline — it only reaches the library's
   * start machinery through `containerFetch` → `startAndWaitForPorts`,
   * where a wedged `startInFlight` would make every probe time out forever.
   * Probes that have timed out without a single one settling for
   * `startDeadlineMs` reset the instance once, like a wedged `start()`
   * does; any settled probe, ready or not, clears the clock.
   */
  #escalateStuckProbes(probes: PromiseSettledResult<Response>[]): void {
    const timedOut = probes.find(
      (p): p is PromiseRejectedResult => p.status === "rejected" && p.reason instanceof DeadlineExceeded,
    );
    const settledOnItsOwn = probes.some((p) => p.status === "fulfilled" || !(p.reason instanceof DeadlineExceeded));
    if (!timedOut || settledOnItsOwn) {
      this.#probesStuckSince = null;
      return;
    }
    const now = Date.now();
    this.#probesStuckSince ??= now;
    if (now - this.#probesStuckSince < this.startDeadlineMs) return;
    this.#probesStuckSince = null;
    void this.ctx.storage
      .get<WakeRecord>(WAKE_STORAGE_KEY)
      .then((wake) => this.#resetWedgedInstance(wake?.wakeId ?? "unknown", timedOut.reason as Error))
      .catch(() => {});
  }

  /** Overriding `stop()` itself — rather than each of its three real callers
   *  individually — also covers the base class's OWN idle-timeout path
   *  (`onActivityExpired` → `this.stop()`). Sets the marker BEFORE calling
   *  through, so a probe racing this call never runs unmarked. Cleared on a
   *  throw: a `stop()` that did not actually happen must not leave
   *  `isReady()` reporting not-ready for a wake that is still up. */
  override async stop(...args: Parameters<Container<Env>["stop"]>): Promise<void> {
    const wake = await this.ctx.storage.get<WakeRecord>(WAKE_STORAGE_KEY);
    if (wake) await this.ctx.storage.put(STOPPING_FOR_STORAGE_KEY, wake.wakeId);
    try {
      await super.stop(...args);
    } catch (err) {
      await this.ctx.storage.delete(STOPPING_FOR_STORAGE_KEY);
      throw err;
    }
  }

  /** {@link HARD_CAP_SCHEDULE}'s callback. A no-op if a newer wake has
   *  already started (a fresh wakeId in storage) or the container already
   *  stopped on its own. */
  async hardCapStop(payload: { wakeId: string }): Promise<void> {
    const current = await this.ctx.storage.get<WakeRecord>(WAKE_STORAGE_KEY);
    if (current?.wakeId !== payload.wakeId) return;
    const state = await this.getState();
    if (state.status === "running" || state.status === "healthy") await this.stop();
  }

  /** ADR §A: "The Worker renews the activity timer only on HTTP requests to
   *  `/grafana/*`." Called by the `/grafana/*` proxy after a request passes
   *  the session check, never by the drain's own Loki pushes. Also renews
   *  the base class's own idle clock (harmless — see
   *  {@link LAST_GRAFANA_STORAGE_KEY}'s doc comment). */
  async noteVisitorActivity(): Promise<void> {
    await this.ctx.storage.put(LAST_GRAFANA_STORAGE_KEY, Date.now());
    this.renewActivityTimeout();
  }

  async lastGrafanaActivityMs(): Promise<number | null> {
    return (await this.ctx.storage.get<number>(LAST_GRAFANA_STORAGE_KEY)) ?? null;
  }

  /** `InboxWriter.resolveWakes`'s "is the box still running" signal
   *  (`ledger.ts#LedgerDeps.isBoxRunning`). Backed by the public
   *  `getState()` rather than the base class's own `this.container.running`
   *  flag, which is `private` in `@cloudflare/containers`' own types and
   *  inaccessible from a subclass at the type level. `getState()` can be
   *  stale immediately after a host loss while this DO was evicted, until
   *  the base class's own periodic alarm/monitor reconciliation catches up
   *  — bounded to a few minutes (measured under SIGKILL testing),
   *  self-healing well within the cron's own 10-minute cadence. */
  async isAwake(): Promise<boolean> {
    const state = await this.getState();
    return state.status === "running" || state.status === "healthy";
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
    // `getState()` above cannot see a stop in flight (see `stop()`'s doc
    // comment for why it still reports running/healthy through the
    // SIGTERM→exit window). Skip the probes entirely once this instance has
    // asked to stop the wake it is tracking, rather than hitting the
    // container on every tick until the process actually exits.
    const [wake, stoppingFor] = await Promise.all([
      this.ctx.storage.get<WakeRecord>(WAKE_STORAGE_KEY),
      this.ctx.storage.get<string>(STOPPING_FOR_STORAGE_KEY),
    ]);
    if (wake && stoppingFor === wake.wakeId) {
      this.#probesStuckSince = null; // nothing was attempted — nothing to escalate
      return false;
    }
    // `allSettled`, and every body released on every path:
    // `@cloudflare/containers` counts a `containerFetch` as in flight until
    // its response body is consumed or cancelled (see {@link releaseBody}),
    // and never runs the `sleepAfter` idle stop while that count is above
    // zero. Reading only `.status` would leave requests in flight per call
    // — this runs on every `/grafana/*` request and every `drainStep` — so
    // a visit wake would never idle out. `Promise.all` would also drop the
    // other probe's response unreleased when one of them throws.
    //
    // Each probe is bounded twice: the signal cancels the container request
    // itself, and the deadline covers the library's own start machinery
    // before that request is even sent. A probe answering after its
    // deadline still gets its body released.
    const probe = (url: string, port: number) =>
      boundedProbe(
        this.containerFetch(new Request(url, { signal: AbortSignal.timeout(this.readyProbeTimeoutMs) }), port),
        this.readyProbeTimeoutMs,
        `isReady probe ${url}`,
      );
    const probes = await Promise.allSettled([probe("http://box/ready", 3100), probe("http://box/grafana/api/health", 3000)]);
    const responses = probes.flatMap((p) => (p.status === "fulfilled" ? [p.value] : []));
    await Promise.all(responses.map(releaseBody));
    this.#escalateStuckProbes(probes);
    const ready = responses.length === probes.length && responses.every((r) => r.status === 200);
    if (ready) await this.#recordReadyOnce();
    return ready;
  }

  /**
   * Contract §5's `o11y.wake` `duration_ms` is wake-to-ready (exit
   * criterion 6): from `wake()` minting the wake to the first successful
   * `isReady()`, whichever caller gets there first. Resolution is that
   * poll's cadence (`DRAIN_STEP_GAP_MS`), so expect up to ~2 s of slack
   * against criterion 6's 90 s budget. Reported once per wake
   * (`READY_RECORDED_FOR_STORAGE_KEY`); `InboxWriter.resolveWakes` writes
   * it on the `o11y.wake` point when the wake resolves, clean or unclean.
   * Never fails `isReady()`: if the RPC throws, the guard is not set and
   * the next successful probe retries.
   */
  async #recordReadyOnce(): Promise<void> {
    const wake = await this.ctx.storage.get<WakeRecord>(WAKE_STORAGE_KEY);
    if (!wake) return;
    if ((await this.ctx.storage.get<string>(READY_RECORDED_FOR_STORAGE_KEY)) === wake.wakeId) return;
    try {
      await inboxWriterStub(this.env).recordWakeReady(wake.wakeId, Math.max(0, Date.now() - wake.startedAt));
      await this.ctx.storage.put(READY_RECORDED_FOR_STORAGE_KEY, wake.wakeId);
    } catch (err) {
      console.error(JSON.stringify({ event: "o11y.wake.ready_record_failed", wakeId: wake.wakeId, message: String(err) }));
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
    // Fail closed: if the request cannot even be inspected, it cannot be
    // proven safe.
    if (!request || isBlockedContainerRequest(request)) {
      // Refused before touching container state or renewing the activity
      // timer — an idle tab hammering this path must not count as activity
      // even though Live cannot be disabled at the Grafana-config layer.
      return new Response("Not Found", { status: 404 });
    }

    const state = await this.getState();
    if (state.status !== "running" && state.status !== "healthy") {
      // The base class's `containerFetch` auto-starts on any request — an
      // unrelated request arriving while the box is asleep must never
      // silently mint a wake. Only `wake()` may start the container; the
      // waking page is what a caller serves instead of retrying blindly.
      return new Response("GrafanaBox is not running — call wake() first.", { status: 503 });
    }
    // `getState()` is this class's own persisted record and can lag the
    // real container by up to a few minutes after a host loss (see
    // `isAwake()`'s doc comment). A request landing in that stale window
    // would pass the check above and fall through to the base class's own
    // `containerFetch`, which restarts a container the moment it observes
    // `!this.container.running`, using `this.envVars` — which `#doWake`
    // never assigns — so that restart would boot with no WAKE_ID/S3
    // credentials/datasource env at all. `this.ctx.container` (a real,
    // public `DurableObjectState` field, distinct from the base library's
    // own private `this.container`) is the live signal, so checking it
    // here closes that window: a request arriving during it is refused
    // (503) rather than silently starting an unminted container. This does
    // not try to self-heal by assigning `envVars` here — that risks the
    // base class's own restart racing a real wake and booting a second
    // process under the same WAKE_ID — the base class's periodic
    // alarm/monitor reconciliation closes the stale window on its own.
    if (this.ctx.container?.running !== true) {
      return new Response("GrafanaBox is not running — call wake() first.", { status: 503 });
    }

    return super.containerFetch(requestOrUrl, portOrInit, portParam);
  }

  /**
   * The ONLY entry point the `/grafana/*` proxy route uses
   * (`stub.fetch(request)`), not the `containerFetch` RPC method: JS RPC
   * serialises a `Request` body as an RPC stream, and the RPC method threw
   * `ReadableStream received over RPC disconnected prematurely` on every
   * body-bearing request (GETs, with no body, never printed it). A DO's
   * `fetch()` handler is carried as plain HTTP, so it has no such stream
   * (measured live: 33 errors for 33 POSTs before, 0 after).
   *
   * Delegates to the `containerFetch` override above, so every gate still
   * applies. Pinned to Grafana's port 3000: `/grafana/*` forwards client
   * headers, and the base class's `fetch()` honours a
   * `cf-container-target-port` header, so inheriting that would let a
   * browser pick Loki's port 3100 instead.
   */
  override async fetch(request: Request): Promise<Response> {
    return this.containerFetch(request, 3000);
  }

  override async onStart(): Promise<void> {
    // Fires as soon as the container process is issued (`start()` — the
    // path `wake()` uses — calls it right after
    // `startContainerIfNotRunning`, without waiting for ports). Loki/Grafana
    // are very likely still booting, so `drainStep` gates its first real
    // push on `isReady()` rather than trusting this hook's timing. Uses
    // `this.schedule` rather than overriding `alarm()` directly: the base
    // class already owns the idle-timeout/`schedule()` machinery.
    //
    // Fires a SECOND time for the same wake: `#doWake` also fires
    // (unawaited) `startAndWaitForPorts()` in the background to flip
    // `state.status` to `"healthy"`, and the base class calls `onStart()`
    // again once that resolves. The guard below skips scheduling
    // `drainStep` twice per wake (idempotent either way, since the DO
    // alarm loop only fetches one snapshot per invocation regardless).
    const wake = await this.ctx.storage.get<WakeRecord>(WAKE_STORAGE_KEY);
    if (!wake) return; // defensive; wake() always sets this before start()
    if ((await this.ctx.storage.get<string>(DRAIN_SCHEDULED_FOR_STORAGE_KEY)) === wake.wakeId) return;
    await this.ctx.storage.put(DRAIN_SCHEDULED_FOR_STORAGE_KEY, wake.wakeId);
    await this.schedule(new Date(), DRAIN_STEP_SCHEDULE, { wakeId: wake.wakeId });
  }

  /**
   * One bounded batch of the drain (ADR §B.3/§A "Drain" scope). Reschedules
   * itself {@link DRAIN_STEP_GAP_MS} later until
   * `InboxWriter.nextWrittenKeys` returns empty, then decides whether to
   * stop (see `#finishDrain`). A no-op if a newer wake has already
   * superseded `payload.wakeId`.
   *
   * `seenHashes` is a fresh `Set()` per invocation, not persisted: ADR
   * §B.3's own "what an unclean stop costs" already accepts duplicate
   * storage from a crash-and-replay, relying on Loki's query-time dedup to
   * collapse it back to one result — the same mechanism covers a retried
   * step re-pushing a key whose ledger commit did not land before a crash.
   */
  async drainStep(payload: { wakeId: string }): Promise<void> {
    const current = await this.ctx.storage.get<WakeRecord>(WAKE_STORAGE_KEY);
    if (current?.wakeId !== payload.wakeId) return;

    if (!(await this.isReady())) {
      await this.schedule(new Date(Date.now() + DRAIN_STEP_GAP_MS), DRAIN_STEP_SCHEDULE, payload);
      return;
    }

    const startedAt = Date.now();
    // Fills in whether this batch replayed a reopened key, read back in the
    // catch below so an error point reports `reason: "reopen"` too (not
    // just the success path further down). `takeReopenedFlag` is one-shot,
    // so this is the only chance to observe it once anything below throws.
    const reopenState: { replayed: boolean } = { replayed: false };
    try {
      await this.#drainStepBody(payload, current, startedAt, reopenState);
    } catch (err) {
      // Any throw here (an R2 get, an InboxWriter RPC, or a symbolication
      // failure) would otherwise propagate straight out of `drainStep` and
      // silently end the drain for the rest of this wake. Record it like a
      // Loki outage already is, and run the same post-drain stop decision,
      // so a later wake retries these still-`written` keys instead of
      // losing the wake silently.
      try {
        writeBoxPoint(
          this.env,
          this.ctx,
          "o11y.drain",
          { count: 0, duration_ms: Date.now() - startedAt, bytes: 0, value: 0 },
          // Same `"reopen"` override the success path applies: a batch
          // that replayed reopened keys and then threw must not report the
          // wake's own backlog/visit reason instead.
          { reason: reopenState.replayed ? "reopen" : current.reason, outcome: "error" },
        );
        console.error(JSON.stringify({ event: "o11y.drain.error", wakeId: payload.wakeId, message: String(err) }));
        await this.#finishDrain(payload.wakeId);
      } catch (finishErr) {
        // `#finishDrain` (or the point write above) throwing too is most
        // plausibly the same failure that took down `#drainStepBody`.
        // "Always reschedule or finish" must hold even here: fall back to a
        // plain reschedule so this wake still gets another chance.
        console.error(
          JSON.stringify({ event: "o11y.drain.error", wakeId: payload.wakeId, message: String(finishErr), stage: "finish" }),
        );
        await this.schedule(new Date(Date.now() + DRAIN_STEP_GAP_MS), DRAIN_STEP_SCHEDULE, payload);
      }
    }
  }

  /** The actual drain-batch work `drainStep` runs inside a try/catch guard
   *  above — split out so every throw inside it is caught by that same
   *  handler. */
  async #drainStepBody(
    payload: { wakeId: string },
    current: WakeRecord,
    startedAt: number,
    reopenState: { replayed: boolean },
  ): Promise<void> {
    const writer = inboxWriterStub(this.env);
    // ADR §B.3: "at each cron tick and at the start of each wake" — this is
    // the wake-start call (idempotent to run again on every step: cheap,
    // and self-correcting if a wake elsewhere just went `over`).
    await writer.resolveWakes();
    // ADR §G: over the o11y spend cap "drains pause, visit wakes still
    // work". The box still serves Grafana; it just pushes nothing to Loki.
    // Checked on every step, so a pause set mid-drain stops at the next
    // batch, and a backlog wake that started before the pause stops the box
    // once it is quiet (`#finishDrain`), exactly like an empty backlog.
    if (await writer.drainsPaused()) {
      await this.#finishDrain(payload.wakeId);
      return;
    }
    const keys = await writer.nextWrittenKeys(DRAIN_BATCH_SIZE);

    if (keys.length === 0) {
      await this.#finishDrain(payload.wakeId);
      return;
    }

    // Does this batch replay any reopened keys? One-shot (also clears the
    // markers, see `ledger.ts#takeReopenedFlag`). Read BEFORE `drainBatch`
    // so the check reflects exactly the keys this batch is about to push.
    const replayedReopenedKeys = await writer.takeReopenedFlag(keys);
    // Set immediately, before anything below (a real R2/InboxWriter RPC)
    // can throw — this is the outer catch's only chance to see it, since
    // `takeReopenedFlag` already consumed the markers.
    reopenState.replayed = replayedReopenedKeys;

    const deps: DrainDeps = {
      fetchObject: async (key) => {
        const obj = await this.env.O11Y_INBOX.get(key);
        return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
      },
      pushToLoki: async (tenant, gzippedBody) => {
        const res = await this.containerFetch(
          new Request("http://box/otlp/v1/logs", {
            method: "POST",
            // See LOKI_PUSH_TIMEOUT_MS.
            signal: AbortSignal.timeout(this.lokiPushTimeoutMs),
            headers: { "content-type": "application/json", "content-encoding": "gzip", "X-Scope-OrgID": tenant },
            body: gzippedBody,
          }),
          3100,
        );
        // A 2xx body is released too, not only read on >=400 — an unread
        // body keeps this push "in flight" for the idle stop (see
        // `releaseBody`). Loki's OTLP push usually answers 204, but nothing
        // guarantees it.
        if (res.status < 400) {
          await releaseBody(res);
          return { status: res.status, message: undefined };
        }
        const message = await res.text().catch(() => undefined);
        await releaseBody(res); // no-op once `text()` consumed it; releases it if `text()` threw early
        return { status: res.status, message };
      },
      symbolicate: (records) => symbolicateResourceLogs(records, { getMap: (key) => this.#getMap(key) }),
    };

    const result = await drainBatch(keys, new Set(), deps);

    // A `provisional` key that pushed ZERO bytes (every record already
    // deduped/too-old — `drain.ts#drainKey`'s zero-chunk case) commits
    // straight to `done:` instead of entering `provisional:<wakeId>` — see
    // `ledger.ts#commitKeys`'s doc comment for the endless-re-wake loop
    // this avoids.
    const zeroByteKeys = result.outcomes.filter((o) => o.outcome === "provisional" && o.bytesPushed === 0).map((o) => o.key);
    const provisionalKeys = result.outcomes
      .filter((o) => o.outcome === "provisional" && o.bytesPushed > 0)
      .map((o) => o.key);
    const rejectedKeys = result.outcomes.filter((o) => o.outcome === "rejected");
    // A `provisional` outcome with a `reason` set is `drain.ts#drainKey`'s
    // partial-400 case: at least one chunk landed 2xx (so it stays
    // `provisional`, following the normal durability path) but another
    // permanently 400'd. That loss is real and must stay operator-visible
    // even though the key itself is not `rejected` — see
    // `InboxWriterApi#recordPartialReject`'s doc comment.
    const partiallyRejected = result.outcomes.filter((o) => o.outcome === "provisional" && o.reason !== undefined);
    const bytesPushed = result.outcomes.reduce((sum, o) => sum + o.bytesPushed, 0);
    // Records dropped for being older than Loki's
    // `reject_old_samples_max_age` (ADR §G accepts this loss, but it must
    // be counted, never silent) — `value` is otherwise unused by
    // `o11y.drain`.
    const droppedOld = result.outcomes.reduce((sum, o) => sum + o.droppedOld, 0);

    if (provisionalKeys.length > 0) await writer.markKeysProvisional(payload.wakeId, provisionalKeys);
    if (zeroByteKeys.length > 0) await writer.commitKeys(zeroByteKeys);
    for (const r of rejectedKeys) await writer.rejectKey(r.key, r.reason ?? "unknown");
    for (const r of partiallyRejected) await writer.recordPartialReject(r.key, r.reason ?? "unknown");

    writeBoxPoint(
      this.env,
      this.ctx,
      "o11y.drain",
      { count: result.outcomes.length, duration_ms: Date.now() - startedAt, bytes: bytesPushed, value: droppedOld },
      {
        // Already a contract-allowed `reason` value
        // (`METRICS["o11y.drain"].values.reason`) — used instead of the
        // wake's own backlog/visit reason when this batch replayed
        // reopened keys: a wake can be triggered by a backlog/visit while
        // still draining backlogged manual-reopen data, which is the more
        // informative fact about THIS batch.
        reason: replayedReopenedKeys ? "reopen" : current.reason,
        // A mixed-outcome key (at least one chunk 2xx, at least one
        // permanently 400'd) stays `provisional` for durability, but that
        // also meant it fell out of `rejectedKeys` entirely, reporting `ok`
        // for a drain that permanently lost real data.
        // `recordPartialReject` above already logs the loss; this outcome
        // must not hide it too.
        outcome: result.stoppedEarly ? "error" : rejectedKeys.length > 0 || partiallyRejected.length > 0 ? "partial" : "ok",
      },
    );

    if (result.stoppedEarly) {
      // Everything from here on stays `written` for the next wake to
      // retry (a possibly-recovered Loki by then) — but this wake itself
      // is done trying, so run the same post-drain stop decision.
      await this.#finishDrain(payload.wakeId);
      return;
    }

    await this.schedule(new Date(Date.now() + DRAIN_STEP_GAP_MS), DRAIN_STEP_SCHEDULE, payload);
  }

  /** ADR §A stop protocol: "the drain finishes; if no Grafana request
   *  arrived in the last 10 minutes the Worker calls `stop()` (otherwise
   *  the idle timer does, later, so a drain never SIGTERMs someone reading
   *  a dashboard)." A no-op if a newer wake has already superseded
   *  `wakeId`. */
  async #finishDrain(wakeId: string): Promise<void> {
    const current = await this.ctx.storage.get<WakeRecord>(WAKE_STORAGE_KEY);
    if (current?.wakeId !== wakeId) return;

    const lastGrafana = await this.lastGrafanaActivityMs();
    const quiet = lastGrafana === null || Date.now() - lastGrafana >= GRAFANA_QUIET_STOP_MS;
    if (!quiet) return; // an active Grafana user — leave it to the idle timer / hard cap

    const state = await this.getState();
    if (state.status === "running" || state.status === "healthy") await this.stop();
  }

  async #getMap(key: string): Promise<string | null> {
    const obj = await this.env.O11Y_MAPS.get(key);
    return obj ? obj.text() : null;
  }

  /**
   * Records exactly what the platform reported, tagged with the wakeId this
   * instance was tracking — and claims nothing about whether the stop was
   * clean. `onStop`'s own report is indistinguishable from a host loss
   * (ADR-0041 §A: `{ exitCode: 0, reason: "exit" }` either way) — the
   * `state/wakes/<wakeId>/clean` marker in the Loki bucket is the only
   * thing the ledger trusts; this is bookkeeping for exit criterion 12's
   * measurement, not a second source of truth.
   */
  override async onStop(params: { exitCode?: number; reason?: string }): Promise<void> {
    const wake = await this.ctx.storage.get<WakeRecord>(WAKE_STORAGE_KEY);
    const at = Date.now();
    const record: StopRecord = {
      wakeId: wake?.wakeId ?? null,
      exitCode: params.exitCode,
      reason: params.reason,
      at,
    };
    await this.ctx.storage.put(LAST_STOP_STORAGE_KEY, record);

    // ADR-0041 §G: the o11y worker reports `GrafanaBox` awake seconds over
    // the `API` binding. `wake`'s own `startedAt` to this stop's `at` is
    // the same awake-window measure `onStop`'s doc comment already treats
    // as bookkeeping, not the ledger's source of truth — good enough for a
    // cost estimate, like every other sku in `budget.ts` until the nightly
    // reconciliation. No `wake` record means nothing to report.
    //
    // Awaited directly rather than `waitUntil`: `onStop` runs past the
    // point anything is waiting on a response, so there's no request to
    // unblock, and `waitUntil` is not guaranteed to exist on every
    // `DurableObjectState` — `reportAwakeSeconds` never throws, so awaiting
    // it here costs nothing but a few milliseconds.
    if (wake) {
      const awakeSeconds = Math.max(0, (at - wake.startedAt) / 1000);
      await reportAwakeSeconds(this.env, awakeSeconds);
    }
  }

  /** For the sandbox probe and any future diagnostic route — not part of
   *  the stop protocol's own trust chain (see `onStop`'s own doc comment). */
  async lastStop(): Promise<StopRecord | undefined> {
    return this.ctx.storage.get<StopRecord>(LAST_STOP_STORAGE_KEY);
  }
}

/** A bounded wait failed. Its own class so `#doWake` can tell a wedged
 *  `start()` apart from a start that failed on its own. */
class DeadlineExceeded extends Error {}

/** `promise`, or a {@link DeadlineExceeded} rejection after `ms`, whichever
 *  comes first. The timer is cleared as soon as either settles, and
 *  `promise` keeps its handler, so a late rejection is never an unhandled
 *  one. */
function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceeded(`${what}: no answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** {@link withDeadline} for a container probe whose body must still be
 *  released when it answers after the deadline (an unreleased body counts
 *  as in flight and blocks the idle stop). */
function boundedProbe(response: Promise<Response>, ms: number, what: string): Promise<Response> {
  return withDeadline(response, ms, what).catch((err: unknown) => {
    if (err instanceof DeadlineExceeded) void response.then(releaseBody, () => {});
    throw err;
  });
}

/**
 * Releases a container response whose body the caller does not need.
 * `@cloudflare/containers@0.3.7` (`dist/lib/container.js`)
 * increments `inflightRequests` in `containerFetch` (:887) and, for a
 * response with a body, returns `new Response(readable, res)` after
 * `res.body.pipeTo(writable).finally(() => this.decrementInflight())`
 * through an `IdentityTransformStream` (:955-960). The pipe, and so the
 * decrement, only finishes once the reader consumes or cancels `readable`.
 * `isActivityExpired()` (:1687-1692) returns false while the count is above
 * zero, so the base `alarm()` loop never reaches `onActivityExpired()` →
 * `stop()` (:1566). Cancelling ends the pipe at once (the transform's
 * writable side errors, `pipeTo` rejects, `finally` runs). Never throws:
 * a body that is already consumed, locked or errored has nothing left to
 * release.
 */
async function releaseBody(res: Response): Promise<void> {
  if (!res.body || res.bodyUsed) return;
  try {
    await res.body.cancel();
  } catch {
    // already locked or errored — nothing left to release
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
 * start — never merged with a previous call's values: a stale value
 * surviving between wakes is exactly the failure this guards against.
 * Fails closed (throws, so `wake()` never calls `start()`) when a required
 * secret is missing — a box that cannot reach its own storage must not
 * boot.
 */
function buildEnvVars(env: Env, wakeId: string): Record<string, string> {
  if (env.O11Y_ENV === "local") return buildLocalEnvVars(env, wakeId);

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
    LOKI_S3_BUCKET: env.LOKI_S3_BUCKET || DEFAULT_LOKI_BUCKET_NAME,
    // Real R2, real TLS — "true" is only ever correct for local MinIO
    // (containers/o11y/compose.yml).
    LOKI_S3_INSECURE: "false",
    GF_SERVER_ROOT_URL: `${PUBLIC_ORIGIN}/grafana/`,
    // vertamedia-clickhouse-datasource against the real Analytics Engine
    // SQL API: a single custom `Authorization: Bearer <token>` header,
    // never host/port/user/password fields — see
    // grafana/provisioning/datasources/datasources.yaml's own comment.
    // HEADER2 stays unused in production (local-only, ClickHouse's
    // two-header X-ClickHouse-User/-Key shape).
    O11Y_CLICKHOUSE_URL: `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
    O11Y_CLICKHOUSE_DATABASE: "",
    O11Y_CLICKHOUSE_HEADER1_NAME: "Authorization",
    O11Y_CLICKHOUSE_HEADER1_VALUE: env.AE_SQL_TOKEN ? `Bearer ${env.AE_SQL_TOKEN}` : "",
    O11Y_CLICKHOUSE_HEADER2_NAME: "",
    O11Y_CLICKHOUSE_HEADER2_VALUE: "",
    // `shutdown.sh`'s default `STOP_GRACE_SECONDS` (30, matching
    // `compose.yml`'s own local default) is tuned for a same-host MinIO
    // round trip. Against a real R2 endpoint over the real network, a stop
    // that genuinely needs to flush a fresh index upload has been observed
    // exceeding 30s and reporting `exitCode: 1` even with correct
    // credentials and a confirmed-successful periodic shipper upload
    // earlier in the same wake — `stop()` has been measured taking up to
    // 53.7s on this platform with dummy credentials, and the platform's
    // documented SIGTERM→SIGKILL grace is 15 minutes, so there is ample
    // headroom to raise this. `compose.yml`'s local default (30) is
    // untouched — local MinIO genuinely does not need this.
    O11Y_STOP_GRACE_SECONDS: "120",
    // SLACK_WEBHOOK_URL is deliberately never included — ADR-0041 §A: "The
    // Slack webhook never enters the box."
  };
}

/** Local-only envVars, gated exactly like `DEV_ADMIN` (`O11Y_ENV ===
 *  "local"`, fail-closed: production always sets `O11Y_ENV: "production"`
 *  from `wrangler.jsonc`'s `vars` block, never a secret). Mirrors
 *  `containers/o11y/compose.yml`'s own MinIO/local-ClickHouse shape.
 *  `wrangler dev`'s local Container orchestration runs `GrafanaBox`'s
 *  container via real Docker, reaching host-published services via
 *  Docker's own `host.docker.internal` DNS name — `scripts/o11y-dev.mjs`
 *  starts local MinIO/ClickHouse for this (`docker compose -f
 *  containers/o11y/compose.yml up --wait minio clickhouse`); the `box`
 *  service itself is never started locally that way, `wrangler dev` IS
 *  the box. */
function buildLocalEnvVars(env: Env, wakeId: string): Record<string, string> {
  const minioPort = env.O11Y_LOCAL_MINIO_PORT || "4402";
  const clickhousePort = env.O11Y_LOCAL_CLICKHOUSE_PORT || "4404";
  const publicOrigin = env.O11Y_LOCAL_PUBLIC_ORIGIN || "http://localhost:4400";

  return {
    WAKE_ID: wakeId,
    STORAGE: "s3",
    LOKI_S3_ENDPOINT: `host.docker.internal:${minioPort}`,
    LOKI_S3_REGION: "auto",
    LOKI_S3_ACCESS_KEY_ID: env.LOKI_S3_ACCESS_KEY_ID || "minioadmin",
    LOKI_S3_SECRET_ACCESS_KEY: env.LOKI_S3_SECRET_ACCESS_KEY || "minioadmin",
    LOKI_S3_BUCKET: env.LOKI_S3_BUCKET || "loki",
    LOKI_S3_INSECURE: "true",
    GF_SERVER_ROOT_URL: `${publicOrigin}/grafana/`,
    O11Y_CLICKHOUSE_URL: `http://host.docker.internal:${clickhousePort}`,
    O11Y_CLICKHOUSE_DATABASE: "default",
    O11Y_CLICKHOUSE_HEADER1_NAME: "X-ClickHouse-User",
    O11Y_CLICKHOUSE_HEADER1_VALUE: "default",
    O11Y_CLICKHOUSE_HEADER2_NAME: "X-ClickHouse-Key",
    O11Y_CLICKHOUSE_HEADER2_VALUE: env.AE_SQL_TOKEN || "local-dev-token",
    O11Y_STOP_GRACE_SECONDS: "30",
  };
}
