// The Loki + Grafana box (ADR-0041 §A): gives `GrafanaBox` real behaviour
// (envVars, a fresh wakeId per start recorded in InboxWriter, readiness, the
// container-facing half of the stop protocol, onStop bookkeeping, and the
// /api/live/* defense-in-depth — see containers/o11y/grafana/grafana.ini).
// It does not decide *when* to wake (a Grafana visit through the login
// broker session vs. the backlog cron) or proxy Grafana's own routes.

import { Container } from "@cloudflare/containers";
import { o11ySelfIdentity } from "./normalise/respond.js";
import { writePointFromDo } from "./normalise/points.js";
import { toAePoint, type HotAttrs, type Tenant } from "@handsontable/demo-runtime/telemetry";
import { drainBatch, type DrainDeps } from "./drain/drain.js";
import { symbolicateResourceLogs } from "./drain/symbolicate.js";
import type { Env } from "./env.js";
import { AE_INTERNAL_HOST, aeInternalUrl, handleAeOutbound } from "./ae-outbound.js";
import { reportAwakeSeconds } from "./cost.js";
import { PUBLIC_ORIGIN } from "./gates/session.js";

/** Contract §1 bucket name; `env.LOKI_S3_BUCKET` overrides it (probes point
 *  it at their own bucket). An `R2Bucket` binding exposes no `.name`, so the
 *  name cannot come from `O11Y_LOKI_STATE`. */
const DEFAULT_LOKI_BUCKET_NAME = "handsontable-demos-o11y-loki";

const WAKE_STORAGE_KEY = "wake";
const LAST_STOP_STORAGE_KEY = "lastStop";
/** The wakeId this instance last asked to stop, so `isReady()` can skip
 *  probes during the SIGTERM→exit window (`stop()` doesn't change
 *  `getState()`'s status). Persisted and cleared at the start of `#doWake`. */
const STOPPING_FOR_STORAGE_KEY = "stoppingFor";
/** Separate from the base class's idle clock: renewed only by real
 *  `/grafana/*` traffic (via `noteVisitorActivity`), never by the drain's
 *  own Loki pushes, per ADR §A's quiet-stop rule. */
const LAST_GRAFANA_STORAGE_KEY = "lastGrafanaAt";
/** Guards `onStart`'s double-invocation (see its own doc comment) from
 *  scheduling `drainStep` twice for the same wake. */
const DRAIN_SCHEDULED_FOR_STORAGE_KEY = "drainScheduledFor";
/** `{ wakeId, tenants }`: tenants that hit Loki's stream limit in this wake,
 *  whose keys later steps skip, because the ingester keeps its streams until it stops. */
const STREAM_LIMITED_STORAGE_KEY = "streamLimitedTenants";
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
/** Objects drained per `drainStep` invocation (one `alarm()`): bounds its CPU,
 *  and its subrequests at 10 inbox GETs + 10 × `MAX_MAP_KEYS_PER_CALL` map GETs
 *  + ~200 push attempts, far under the Workers limit of 10,000. */
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

// Every await on the container is bounded: an accepted-but-silent port can
// hang `start()`/`isReady()` forever, since the library's healthy-state
// `containerFetch` goes straight to `tcpPort.fetch`.
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
/** One drain push to Loki's OTLP endpoint. Alarms are serialised, so an
 *  unanswered push would freeze every later schedule; a timeout gives the
 *  library's own 500-retry path a chance to run instead. */
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

/** Every path shape that must never reach `/api/live/*`: Grafana's own
 * `[live] max_connections = 0` only blocks its frontend, not a raw client
 * dialing the endpoint directly (grafana/grafana#72072). */
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

/** Grafana's legacy datasource proxy route — forwards `<rest>` verbatim to
 *  the datasource's configured `url`. Capture groups: 1 = uid, 2 = numeric
 *  id, 3 = `<rest>`. */
const DATASOURCE_PROXY_RE = /^\/(?:grafana\/)?api\/datasources\/proxy\/(?:uid\/([^/]+)|(\d+))\/(.*)$/i;

/** Grafana's modern resource-proxy route — reaches the Loki plugin's
 *  `CallResource` handler, which forwards everything under a fixed
 *  `/loki/api/v1/<rest>` prefix; the allowlist below is the real boundary. */
const DATASOURCE_RESOURCE_RE = /^\/(?:grafana\/)?api\/datasources\/(?:uid\/([^/]+)\/resources|(\d+)\/resources)\/(.*)$/i;

/** Loki's read/query API — everything a dashboard panel or Explore needs
 *  through the legacy proxy path. `tail` (websocket) is already refused
 *  above; kept here only so a non-upgrade hit isn't blocked for a second,
 *  more confusing reason. */
const LOKI_ALLOWED_QUERY_RE =
  /^loki\/api\/v1\/(?:query|query_range|labels|label\/[^/]+\/values|series|index\/stats|index\/volume(?:_range)?|patterns|detected_labels|detected_fields|tail|format_query)\/?$/i;

/** Same read/query set as {@link LOKI_ALLOWED_QUERY_RE}, without the
 *  `loki/api/v1/` prefix — the modern route's `<rest>` is the bare Go
 *  handler name. */
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

// @ts-expect-error `applyOutboundInterception` is private in the SDK typings and overridden below on purpose
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
   * durably, records it with `InboxWriter` BEFORE starting (fail closed),
   * then starts the container with a full, rebuilt `envVars` set.
   *
   * Idempotent: a wake already in flight or already running returns the
   * existing record, never minting a second wakeId (ADR-0041 §B.3).
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
      // `stop()` doesn't change `getState()`'s status while draining, so
      // this still reports running/healthy. Returning the existing record
      // (below) prevents minting a second wakeId here.
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
      await withDeadline(this.#startFailOpen(record.wakeId, envVars), this.startDeadlineMs, "GrafanaBox.start()");
    } catch (err) {
      if (err instanceof DeadlineExceeded) this.#resetWedgedInstance(record.wakeId, err);
      throw err;
    }
    // `start()` never calls `state.setHealthy()`, so `state.status` stays
    // `"running"`, and the base `containerFetch` re-verifies ports on every
    // call until it does — costing ~10ms to 160+s under contention. Fired
    // here, unawaited, so `wake()` itself still returns fast.
    void this.startAndWaitForPorts({ ports: this.requiredPorts }).catch(() => {});
    return record;
  }

  /**
   * The library's `start()` sets up outbound interception for `ae.internal`
   * before it starts the container and throws when that setup fails, but the
   * interception only serves the ClickHouse datasource, so Grafana, Loki and
   * the drain must still come up: retry once with interception off.
   */
  async #startFailOpen(wakeId: string, envVars: Record<string, string>): Promise<void> {
    const interception = this.usingInterception;
    this.#inStartFailOpen = true;
    try {
      await this.start({ envVars });
    } catch (err) {
      // A running container means the failure came after the interception
      // setup, so it is not ours to swallow.
      if (!interception || this.ctx.container?.running) throw err;
      this.#reportAeDegraded(wakeId, err, "start");
      this.usingInterception = false;
      try {
        await this.start({ envVars });
      } finally {
        this.usingInterception = interception;
      }
    } finally {
      this.#inStartFailOpen = false;
    }
  }

  /** True while `#startFailOpen` runs: it reports its own failure, so the
   *  `applyOutboundInterception` override stays quiet then. */
  #inStartFailOpen = false;

  /** Logs the event and writes the point the `ae-outbound-degraded` alert
   *  counts. The point goes through the Worker's own AE binding, not
   *  `ae.internal`, so it lands while the interception is down. */
  #reportAeDegraded(wakeId: string, err: unknown, reason: "start" | "reload"): void {
    console.error(JSON.stringify({ event: "o11y.ae_outbound.degraded", wakeId, message: String(err) }));
    writeBoxPoint(this.env, this.ctx, "o11y.ae_degraded", { count: 1 }, { reason });
  }

  /**
   * The SDK's constructor re-applies the interception for an already-running
   * container without awaiting or catching it, so a rejection there (after
   * `ctx.abort()` or a deploy) would be an unhandled rejection this class
   * cannot catch. Returns the SDK's own promise with a handler attached, so
   * `start()` and `refreshOutboundInterception()` still see the throw.
   * TS-private in the typings, a prototype method at runtime;
   * `o11y-box-ae-fail-open.test.mjs` pins that against the package.
   */
  applyOutboundInterception(): Promise<void> {
    // @ts-expect-error private in the SDK typings
    const applied: Promise<void> = super.applyOutboundInterception();
    if (!this.#inStartFailOpen) {
      applied.catch(async (err: unknown) => {
        const wake = await this.ctx.storage.get<WakeRecord>(WAKE_STORAGE_KEY).catch(() => undefined);
        this.#reportAeDegraded(wake?.wakeId ?? "unknown", err, "reload");
      });
    }
    return applied;
  }

  /**
   * `start()` did not settle within `startDeadlineMs`. The library's own
   * in-flight start promise means this instance cannot recover on its own,
   * so only the in-memory object is reset (`ctx.abort()`). Storage and the
   * container survive; the next request builds a fresh instance.
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
   * The reload path: an instance that did not start the container itself
   * never goes through `#doWake`'s start deadline, so a wedged
   * `startInFlight` would make every probe time out forever. Resets the
   * instance once probes have timed out for `startDeadlineMs` with none
   * settling; any settled probe clears the clock.
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

  /** `InboxWriter.resolveWakes`'s "is the box still running" signal.
   *  Backed by `getState()`, not the base class's private `container.running`
   *  flag. Can lag the real container by a few minutes after a host loss,
   *  until periodic reconciliation catches up — well within the cron's
   *  10-minute cadence. */
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
    // `allSettled`, with every body released: an unread body counts as in
    // flight and blocks the idle stop. Each probe is bounded twice — the
    // signal cancels the request, the deadline covers the library's own
    // start machinery before the request is even sent.
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
   * criterion 6), from `wake()` to the first successful `isReady()`.
   * Reported once per wake; `resolveWakes` carries it into the `o11y.wake`
   * point. Never fails `isReady()` — a failed RPC just leaves the guard
   * unset for the next probe to retry.
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
    // `getState()` can lag the real container by a few minutes after a
    // host loss (see `isAwake()`). A request in that stale window would
    // otherwise fall through to the base class's own `containerFetch`,
    // which restarts using `this.envVars` — never assigned by `#doWake` —
    // booting with no WAKE_ID/credentials at all. `this.ctx.container`
    // (the real, public field) is the live signal, so checking it here
    // refuses (503) instead of silently starting an unminted container.
    // Not self-healed here: that risks racing a real wake under the same
    // WAKE_ID; periodic reconciliation closes the window on its own.
    if (this.ctx.container?.running !== true) {
      return new Response("GrafanaBox is not running — call wake() first.", { status: 503 });
    }

    return super.containerFetch(requestOrUrl, portOrInit, portParam);
  }

  /**
   * The ONLY entry point the `/grafana/*` proxy uses (`stub.fetch`), not
   * the `containerFetch` RPC method: JS RPC serialises a body-bearing
   * `Request` as a stream, which a DO's `fetch()` avoids entirely (measured:
   * 33 stream errors per dashboard switch via RPC, 0 via fetch). Pinned to
   * port 3000 so a forwarded `cf-container-target-port` header can't steer
   * a client at Loki's 3100.
   */
  override async fetch(request: Request): Promise<Response> {
    return this.containerFetch(request, 3000);
  }

  override async onStart(): Promise<void> {
    // Fires as soon as the container process is issued, without waiting for
    // ports — `drainStep` gates its first push on `isReady()` instead.
    // Also fires a SECOND time once the background `startAndWaitForPorts()`
    // in `#doWake` resolves; the guard below skips scheduling `drainStep`
    // twice per wake (idempotent either way).
    const wake = await this.ctx.storage.get<WakeRecord>(WAKE_STORAGE_KEY);
    if (!wake) return; // defensive; wake() always sets this before start()
    if ((await this.ctx.storage.get<string>(DRAIN_SCHEDULED_FOR_STORAGE_KEY)) === wake.wakeId) return;
    await this.ctx.storage.put(DRAIN_SCHEDULED_FOR_STORAGE_KEY, wake.wakeId);
    await this.schedule(new Date(), DRAIN_STEP_SCHEDULE, { wakeId: wake.wakeId });
  }

  /**
   * One bounded batch of the drain (ADR §B.3/§A). Reschedules itself
   * {@link DRAIN_STEP_GAP_MS} later until the backlog is empty, then
   * decides whether to stop (`#finishDrain`). `seenHashes` is a fresh
   * `Set()` per invocation — Loki's query-time dedup already covers a
   * crash-and-replay.
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
    const limitedRecord = await this.ctx.storage.get<{ wakeId: string; tenants: Tenant[] }>(STREAM_LIMITED_STORAGE_KEY);
    const streamLimited = new Set<Tenant>(limitedRecord?.wakeId === payload.wakeId ? limitedRecord.tenants : []);
    const keys = await writer.nextWrittenKeys(DRAIN_BATCH_SIZE, [...streamLimited]);

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

    const limitedBefore = new Set(streamLimited);
    const result = await drainBatch(keys, new Set(), deps, streamLimited);
    const newlyLimited = [...streamLimited].filter((t) => !limitedBefore.has(t));
    if (newlyLimited.length > 0) {
      await this.ctx.storage.put(STREAM_LIMITED_STORAGE_KEY, { wakeId: payload.wakeId, tenants: [...streamLimited] });
    }
    // A stream-limit 429 means the Loki limit no longer covers the tenant's
    // label cardinality (config drift): one line per tenant per wake.
    for (const tenant of newlyLimited) {
      const hit = result.outcomes.find((o) => o.tenant === tenant && o.deferral === "stream_limit");
      console.warn(JSON.stringify({ event: "o11y.drain.stream_limit", wakeId: payload.wakeId, tenant, message: hit?.reason }));
    }

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
    // Deferred keys stay `written`; the rest of the batch still commits.
    const deferred = result.outcomes.filter((o) => o.outcome === "deferred");
    for (const d of deferred) {
      if (d.deferral !== "fetch_error") continue;
      console.error(JSON.stringify({ event: "o11y.drain.error", wakeId: payload.wakeId, key: d.key, message: d.reason }));
    }

    if (provisionalKeys.length > 0) await writer.markKeysProvisional(payload.wakeId, provisionalKeys);
    if (zeroByteKeys.length > 0) await writer.commitKeys(zeroByteKeys);
    for (const r of rejectedKeys) await writer.rejectKey(r.key, r.reason ?? "unknown");
    for (const r of partiallyRejected) await writer.recordPartialReject(r.key, r.reason ?? "unknown");

    writeBoxPoint(
      this.env,
      this.ctx,
      "o11y.drain",
      { count: result.outcomes.length - deferred.length, duration_ms: Date.now() - startedAt, bytes: bytesPushed, value: droppedOld },
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
        outcome:
          result.stoppedEarly || deferred.length > 0
            ? "error"
            : rejectedKeys.length > 0 || partiallyRejected.length > 0
              ? "partial"
              : "ok",
      },
    );

    // A batch of only deferred keys would come back unchanged on every step,
    // so it ends this wake's drain like a Loki outage does — unless a tenant
    // was just limited, whose exclusion lets the next step reach the other one.
    if (result.stoppedEarly || (deferred.length === result.outcomes.length && newlyLimited.length === 0)) {
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
   * Records exactly what the platform reported — claims nothing about
   * whether the stop was clean. The `state/wakes/<wakeId>/clean` marker in
   * the Loki bucket is the only thing the ledger trusts; this is
   * bookkeeping for exit criterion 12's measurement.
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

    // ADR-0041 §G: reports awake seconds to the API worker's usage meter —
    // good enough for a cost estimate until the nightly reconciliation.
    // Awaited directly (not `waitUntil`): `onStop` runs past the point
    // anything is waiting on a response, and `reportAwakeSeconds` never
    // throws.
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
 * `@cloudflare/containers` counts a response as in-flight until its body is
 * consumed or cancelled, and never runs the idle stop while that count is
 * above zero — cancelling ends that count at once. Never throws: a body
 * that is already consumed, locked or errored has nothing left to release.
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

// Assigned after the class (not a class field) so the SDK's inherited static
// setter registers it.
GrafanaBox.outboundByHost = {
  [AE_INTERNAL_HOST]: (req, env) => handleAeOutbound(req, env as unknown as Env),
};

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
    // The Analytics Engine SQL API is reached through the outbound handler
    // above, which adds the bearer token: no credential header enters the box.
    O11Y_CLICKHOUSE_URL: aeInternalUrl(accountId),
    O11Y_CLICKHOUSE_DATABASE: "",
    O11Y_CLICKHOUSE_HEADER1_NAME: "",
    O11Y_CLICKHOUSE_HEADER1_VALUE: "",
    O11Y_CLICKHOUSE_HEADER2_NAME: "",
    O11Y_CLICKHOUSE_HEADER2_VALUE: "",
    // Tuned for a same-host MinIO round trip; against real R2, a stop that
    // needs to flush a fresh index upload has been measured taking up to
    // 53.7s and exceeding a 30s grace. The platform's SIGTERM→SIGKILL grace
    // is 15 minutes, so there is ample headroom to raise this.
    O11Y_STOP_GRACE_SECONDS: "120",
    // SLACK_WEBHOOK_URL is deliberately never included — ADR-0041 §A: "The
    // Slack webhook never enters the box."
  };
}

/** Local-only envVars, gated like `DEV_ADMIN` (`O11Y_ENV === "local"`,
 *  fail-closed). Mirrors `compose.yml`'s MinIO/local-ClickHouse shape.
 *  `wrangler dev`'s local Container reaches host-published services via
 *  `host.docker.internal`; `scripts/o11y-dev.mjs` starts local
 *  MinIO/ClickHouse for this. */
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
