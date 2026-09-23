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
import { o11ySelfIdentity } from "./normalise/respond.js";
import { writePointFromDo } from "./normalise/points.js";
import { toAePoint, type HotAttrs } from "@handsontable/demo-runtime/telemetry";
import { drainBatch, type DrainDeps } from "./drain/drain.js";
import { symbolicateResourceLogs } from "./drain/symbolicate.js";
import type { Env } from "./env.js";

/** ADR-0041 §B.1: every request reaches the o11y worker on this hostname,
 *  never a per-deploy variable — hardcoded rather than a new `vars` entry
 *  (unlike `CLOUDFLARE_ACCOUNT_ID`, which genuinely differs per account and
 *  has no other source at runtime, this string never varies). */
const PUBLIC_ORIGIN = "https://demos.handsontable.com";

/** Matches the observability contract §1's bucket-name table. Used as the
 *  DEFAULT only (fix round I4) — `env.LOKI_S3_BUCKET` overrides it when
 *  set. Not read from the `O11Y_LOKI_STATE` R2 binding: an `R2Bucket`
 *  object has no `.name` the Worker can read at runtime, the same reason
 *  `containers/o11y/compose.yml` hardcodes its own MinIO bucket name.
 *  Before this fix the name was hardcoded outright, so a sandbox probe's
 *  container silently targeted the PRODUCTION bucket name instead of the
 *  probe bucket it actually created — see the T01 report's fix-round
 *  section for what that confounded. A future probe (T03's, say) sets
 *  `vars.LOKI_S3_BUCKET` in its own throwaway `wrangler.probe.jsonc` to
 *  its own bucket (e.g. `o11y-probe-t03-loki`) instead. */
const DEFAULT_LOKI_BUCKET_NAME = "handsontable-demos-o11y-loki";

const WAKE_STORAGE_KEY = "wake";
const LAST_STOP_STORAGE_KEY = "lastStop";
/** T03 addition: persisted separately from the base `Container` class's own
 *  opaque `sleepAfterMs` idle clock (never read directly here — a real
 *  `containerFetch` call, including the drain's own Loki pushes, always
 *  renews that clock too, which is harmless: it only protects an in-flight
 *  drain or an open Grafana tab from the 15-minute idle stop firing
 *  mid-work). ADR §A's actual rule — "if no Grafana request arrived in the
 *  last 10 minutes the Worker calls `stop()`" after a drain — needs its OWN
 *  clock, driven only by real `/grafana/*` traffic through
 *  {@link GrafanaBox.noteVisitorActivity}, never by the drain's own Loki
 *  traffic. */
const LAST_GRAFANA_STORAGE_KEY = "lastGrafanaAt";
/** Guards `onStart`'s double-invocation (see its own doc comment) from
 *  scheduling `drainStep` twice for the same wake. */
const DRAIN_SCHEDULED_FOR_STORAGE_KEY = "drainScheduledFor";
const HARD_CAP_SCHEDULE = "hardCapStop";
const DRAIN_STEP_SCHEDULE = "drainStep";
/** ADR §A: "after 4 hours awake regardless." */
const WAKE_HARD_CAP_MS = 4 * 60 * 60 * 1000;
/** ADR §A stop protocol: "if no Grafana request arrived in the last 10
 *  minutes the Worker calls `stop()`." */
const GRAFANA_QUIET_STOP_MS = 10 * 60 * 1000;
/** Objects drained per `drainStep` invocation. T03-D (see the task
 *  Outcome): a starting value, not yet tuned against real per-object CPU —
 *  exit criterion 7's sandbox probe measures real per-object cost and
 *  whether this needs to change; kept well under any plausible per-object
 *  cost times `limits.cpu_ms` so a single invocation cannot blow the
 *  Worker's CPU budget even before that measurement exists. */
const DRAIN_BATCH_SIZE = 10;
/** Minimum gap before `drainStep` reschedules itself (T03-D, see the task
 *  Outcome for the full derivation): the base `Container.alarm()` loop
 *  fetches every due `container_schedules` row ONCE at the top of its own
 *  invocation (`const result = this.sql\`SELECT * FROM
 *  container_schedules\`;`) and compares each row's `time` (whole seconds)
 *  against a `now` captured before the loop starts; scheduling the next
 *  step for "now" risks the SAME invocation picking it back up if that
 *  query is ever re-evaluated live rather than read from the snapshot,
 *  which would defeat "a bounded number of objects per invocation" (exit
 *  criterion 7 measures exactly this). A full 1000 ms gap is provably
 *  enough regardless of that ambiguity: `schedule()` floors the target time
 *  to whole seconds, so a row inserted at real time `T1 >= T0` (`T0` being
 *  the loop's captured `now`) with a 1000 ms offset floors to a value
 *  `> floor(T0) + 1 > T0`, true for any `T0` regardless of its fractional
 *  part — a schedule 1000 ms out can never satisfy `row.time <= now` for
 *  the `now` captured at the START of the invocation that inserted it. */
const DRAIN_STEP_GAP_MS = 1000;

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
 * This is therefore the one place that actually refuses it. Case
 * insensitive (fix round I3): nothing about HTTP path matching guarantees
 * a proxy or client normalizes case before this ever sees the request. */
const LIVE_PATH_RE = /^\/(?:grafana\/)?api\/live(?:\/|$)/i;

/**
 * Percent-decodes each segment and collapses repeated slashes before
 * matching — a route matched on the raw, undecoded pathname is a known way
 * to smuggle a blocked path past a naive string/regex check. Returns
 * `null` on an unparseable percent-encoding (fix round I3: the previous
 * version returned the RAW, still-encoded pathname on failure, which the
 * regex then tested and typically did NOT match — e.g.
 * `/grafana/api/%6Cive%ZZ/ws` decodes as a whole to neither a valid string
 * nor anything containing literal "live", so it slipped through unblocked.
 * `null` is a distinct sentinel the caller fails closed on, not a
 * fallback value that happens to usually still match.)
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

function isBlockedLiveRequest(request: Request): boolean {
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    // Defense in depth beyond the path check: nothing this box legitimately
    // serves needs a websocket upgrade at all.
    return true;
  }
  const url = new URL(request.url);
  const normalized = normalizedPathname(url);
  // Fail closed: an unparseable path is refused, not let through.
  if (normalized === null) return true;
  return LIVE_PATH_RE.test(normalized);
}

// T03-D (see the task Outcome): both stubs below used to call
// `.jurisdiction("eu")` unconditionally. T02-D11 (inbox/accessor.ts)
// already measured, against a real `wrangler dev`, that Miniflare/workerd's
// local Durable Object simulation THROWS the moment `.jurisdiction()` is
// called at all (`Error: Jurisdiction restrictions are not implemented in
// workerd`) — not a silent no-op. Since `wake()` calls `inboxWriterStub`
// (via `recordWake`) on every wake, this meant `wake()` itself 500'd under
// local dev before this fix, the same failure mode T02-D11 fixed for the
// ingest routes. Mirrors `inbox/accessor.ts#inboxWriter`'s exact pattern —
// production (`O11Y_ENV === "production"`) is unchanged.
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
 *  production (see the T03-D note on `inboxWriterStub` above for why not
 *  locally). Exported for T03's wake-trigger callers (the Grafana-visit
 *  route, the backlog cron) and `InboxWriter.resolveWakes` (ledger.ts) —
 *  never address `GRAFANA_BOX` any other way, or a second box (and a
 *  second container) gets created. */
export function getGrafanaBoxStub(env: Env) {
  const ns = env.O11Y_ENV === "local" ? env.GRAFANA_BOX : env.GRAFANA_BOX.jurisdiction("eu");
  return ns.getByName("box");
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
    if (state.status === "stopping") {
      // Fix round (C1): falling through to #doWake here mints a wakeId and
      // calls recordWake — marking the still-draining wake `over: true` in
      // InboxWriter's ledger before its own marker exists — while
      // @cloudflare/containers' own start() fast path may not actually
      // restart a process that is mid-shutdown, or deliver the new
      // WAKE_ID to it. The eventual onStop for the OLD process then tags
      // its report with the NEW wakeId, since onStop reads whatever is
      // currently in WAKE_STORAGE_KEY. Refuse instead: the caller (T03's
      // waking page) already polls/refreshes, so a rejected wake here is
      // retried by the next request rather than corrupting the ledger.
      throw new Error("GrafanaBox.wake: container is stopping — retry shortly");
    }
    return this.#doWake(reason);
  }

  async #doWake(reason: WakeReason): Promise<WakeRecord> {
    const wakeId = crypto.randomUUID();
    // Fix round (I2): build AND VALIDATE envVars first, as a pure
    // synchronous step with no side effects yet. If a required secret is
    // missing this throws here — before any storage write and before
    // InboxWriter.recordWake — so a failed wake never leaves the ledger
    // believing a wake started that never actually will.
    const envVars = buildEnvVars(this.env, wakeId);
    const record: WakeRecord = { wakeId, reason, startedAt: Date.now() };
    await this.ctx.storage.put(WAKE_STORAGE_KEY, record);
    // Fix round (I1): `LAST_GRAFANA_STORAGE_KEY` is not scoped by wakeId —
    // without this reset, a visitor's activity from the PREVIOUS wake
    // survives into this fresh one, and `#finishDrain`'s quiet check
    // (10 minutes) can read it as "recent" even though nothing has
    // visited /grafana/* yet this wake, refusing to self-stop a
    // backlog-only wake that has no visitors at all (ADR §A's quiet-stop
    // rule, and exit criterion 7's awake-time cost). Deleted here, before
    // `start()`, so a wake with a real visitor still renews it normally
    // via `noteVisitorActivity()` once that visitor actually arrives, but
    // a wake with none starts genuinely quiet.
    await this.ctx.storage.delete(LAST_GRAFANA_STORAGE_KEY);
    // Fail closed: InboxWriter is the ledger's one owner (ADR-0041 §B.3);
    // if it cannot record this wake, the container must not start with a
    // wakeId nothing else knows about.
    await inboxWriterStub(this.env).recordWake(record.wakeId, reason);
    await this.start({ envVars });
    // T03-D (see the task Outcome — found running a real `wrangler dev`
    // locally, not guessed): `start()` never calls `state.setHealthy()`
    // (only `startAndWaitForPorts()` does), so `state.status` stays
    // `"running"`, never `"healthy"`. The base `Container.containerFetch`
    // checks exactly that field (`state.status !== 'healthy'`) to decide
    // whether to re-verify ports — with it permanently false, EVERY single
    // `containerFetch` call for the rest of this wake (every drain push,
    // every `/grafana/*` proxy request) re-ran the full
    // `startAndWaitForPorts` port-polling machinery from scratch, observed
    // to cost anywhere from ~10ms to 160+ SECONDS depending on contention.
    // Fired here, deliberately NOT awaited: `wake()` itself must still
    // return fast (the waking page's whole point is a quick response while
    // the box boots in the background) — this just gets `state.status` to
    // `"healthy"` in the background, once, so subsequent calls take the
    // cheap path. Harmless if it never resolves (a wake that fails/stops
    // before ports ever come up) — nothing awaits it, and it targets THIS
    // wake's own container instance state, never a later wake's.
    void this.startAndWaitForPorts({ ports: this.requiredPorts }).catch(() => {});
    // ADR §A: "after 4 hours awake regardless." `hardCapStop` re-checks the
    // wakeId when it fires — a wake that already stopped on its own (idle
    // timeout, or the post-drain quiet stop) leaves nothing for this to do.
    await this.schedule(new Date(Date.now() + WAKE_HARD_CAP_MS), HARD_CAP_SCHEDULE, { wakeId: record.wakeId });
    return record;
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
   *  `/grafana/*`." Called by the `/grafana/*` proxy (`grafana/proxy.ts`)
   *  after a request passes Access — never by the drain's own Loki pushes.
   *  Also renews the base class's own idle clock (harmless — see
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
   *  `getState()` (the same check `isReady()`/`containerFetch` already use)
   *  rather than the base class's own live `this.container.running` flag —
   *  that field is marked `private` in `@cloudflare/containers`' own types,
   *  genuinely inaccessible from a subclass at the type level, not merely a
   *  style choice. T03-D (see the task Outcome): `getState()` can be stale
   *  immediately after a host loss while this DO was evicted, until the
   *  base class's own periodic `alarm()`/monitor reconciliation
   *  (`syncPendingStoppedEvents`, called on every alarm tick, which this
   *  class always has scheduled — see the base class's own "container DOs
   *  ALWAYS need an alarm right now" comment) catches up — empirically
   *  bounded to a few minutes in this task's SIGKILL testing (see the
   *  Outcome), self-healing well within the cron's own 10-minute cadence. */
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
    // Fail closed (fix round I3): the old `request &&` check let a request
    // this code couldn't even construct into a `Request` to inspect skip
    // the block entirely — silence read as "not live" instead of "unknown,
    // so refuse". If it cannot be inspected, it cannot be proven safe.
    if (!request || isBlockedLiveRequest(request)) {
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

  override async onStart(): Promise<void> {
    // T03-D (see the task Outcome): `onStart` fires as soon as the
    // container process is issued (the base `start()` — the path `wake()`
    // uses — calls it right after `startContainerIfNotRunning`, WITHOUT
    // waiting for ports; only `startAndWaitForPorts` calls `setHealthy()`
    // first). Loki/Grafana are very likely still booting at this point, so
    // `drainStep` itself gates its first real push on `isReady()` rather
    // than trusting this hook's timing. `this.schedule` (not overriding
    // `alarm()` directly) is deliberate — the base class's own `alarm()`
    // already owns the idle-timeout/`schedule()` machinery, and fighting it
    // with a second `alarm()` override would be exactly the class of bug
    // this task's own "riskiest" billing warrants avoiding.
    //
    // `onStart` fires a SECOND time for the same wake: `#doWake` also fires
    // (unawaited) `startAndWaitForPorts()` in the background purely to flip
    // `state.status` to `"healthy"` (see its own doc comment), and the base
    // class calls `onStart()` again once THAT resolves. Without the guard
    // below this would schedule `drainStep` twice per wake — harmless
    // (idempotent, and the DO alarm loop only fetches one snapshot per
    // invocation regardless — see `DRAIN_STEP_GAP_MS`'s doc comment) but
    // wasteful, so skip it once already scheduled for this wakeId.
    const wake = await this.ctx.storage.get<WakeRecord>(WAKE_STORAGE_KEY);
    if (!wake) return; // defensive; wake() always sets this before start()
    if ((await this.ctx.storage.get<string>(DRAIN_SCHEDULED_FOR_STORAGE_KEY)) === wake.wakeId) return;
    await this.ctx.storage.put(DRAIN_SCHEDULED_FOR_STORAGE_KEY, wake.wakeId);
    await this.schedule(new Date(), DRAIN_STEP_SCHEDULE, { wakeId: wake.wakeId });
  }

  /**
   * One bounded batch of the drain (ADR §B.3/§A "Drain" scope). Reschedules
   * itself {@link DRAIN_STEP_GAP_MS} later (see that constant's own doc
   * comment for why a full-second gap, not "now") until
   * `InboxWriter.nextWrittenKeys` returns empty, then decides whether to
   * stop (see `#finishDrain`). A no-op if a newer wake has already
   * superseded `payload.wakeId`.
   *
   * `seenHashes` is a fresh `Set()` per invocation, not persisted across
   * steps or across the wake: ADR §B.3's own "What an unclean stop costs"
   * paragraph already accepts duplicate STORAGE from a crash-and-replay,
   * relying on Loki's query-time dedup (identical timestamp + labels +
   * structured metadata) to collapse it back to one result — the exact
   * same mechanism covers a retried step re-pushing a key whose ledger
   * commit did not land before a crash. A per-step set only needs to guard
   * against double-processing WITHIN one call (defensive; ingest-time
   * dedup, §B.2 step 4, already prevents the same record existing in two
   * different packed objects under normal operation).
   */
  async drainStep(payload: { wakeId: string }): Promise<void> {
    const current = await this.ctx.storage.get<WakeRecord>(WAKE_STORAGE_KEY);
    if (current?.wakeId !== payload.wakeId) return;

    if (!(await this.isReady())) {
      await this.schedule(new Date(Date.now() + DRAIN_STEP_GAP_MS), DRAIN_STEP_SCHEDULE, payload);
      return;
    }

    const writer = inboxWriterStub(this.env);
    // ADR §B.3: "at each cron tick and at the start of each wake" — this is
    // the wake-start call (idempotent to run again on every step: cheap,
    // and self-correcting if a wake elsewhere just went `over`).
    await writer.resolveWakes();
    const keys = await writer.nextWrittenKeys(DRAIN_BATCH_SIZE);

    if (keys.length === 0) {
      await this.#finishDrain(payload.wakeId);
      return;
    }

    const startedAt = Date.now();
    const deps: DrainDeps = {
      fetchObject: async (key) => {
        const obj = await this.env.O11Y_INBOX.get(key);
        return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
      },
      pushToLoki: async (tenant, gzippedNdjson) => {
        const res = await this.containerFetch(
          new Request("http://box/otlp/v1/logs", {
            method: "POST",
            headers: { "content-type": "application/json", "content-encoding": "gzip", "X-Scope-OrgID": tenant },
            body: gzippedNdjson,
          }),
          3100,
        );
        const message = res.status >= 400 ? await res.text().catch(() => undefined) : undefined;
        return { status: res.status, message };
      },
      symbolicate: (records) => symbolicateResourceLogs(records, { getMap: (key) => this.#getMap(key) }),
    };

    const result = await drainBatch(keys, new Set(), deps);

    const provisionalKeys = result.outcomes.filter((o) => o.outcome === "provisional").map((o) => o.key);
    const rejectedKeys = result.outcomes.filter((o) => o.outcome === "rejected");
    const bytesPushed = result.outcomes.reduce((sum, o) => sum + o.bytesPushed, 0);

    if (provisionalKeys.length > 0) await writer.markKeysProvisional(payload.wakeId, provisionalKeys);
    for (const r of rejectedKeys) await writer.rejectKey(r.key, r.reason ?? "unknown");

    writeBoxPoint(
      this.env,
      this.ctx,
      "o11y.drain",
      { count: result.outcomes.length, duration_ms: Date.now() - startedAt, bytes: bytesPushed },
      { reason: current.reason, outcome: result.stoppedEarly ? "error" : rejectedKeys.length > 0 ? "partial" : "ok" },
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
    // T03-D (see the task Outcome — found on the real sandbox platform, not
    // guessed): `shutdown.sh`'s default `STOP_GRACE_SECONDS` (30, matching
    // `compose.yml`'s own local default) is tuned for a same-host MinIO
    // round trip. Against a REAL R2 endpoint over the real network, a stop
    // that genuinely needed to flush a fresh index upload was repeatedly
    // observed exceeding 30s and reporting `exitCode: 1` (shutdown.sh's own
    // "loki did not exit within ${STOP_GRACE_SECONDS}s… giving up on a
    // clean marker" path) even with correct credentials and a real,
    // confirmed-successful periodic shipper upload earlier in the same
    // wake. T01's own T01-D8 already measured `stop()` taking up to 53.7s
    // on this same platform with dummy credentials; the platform's own
    // documented SIGTERM→SIGKILL grace is 15 minutes (T01 Outcome), so
    // there is ample headroom to raise this without risking an
    // escalation. `compose.yml`'s local default (30) is untouched —
    // local MinIO genuinely does not need this.
    O11Y_STOP_GRACE_SECONDS: "120",
    // SLACK_WEBHOOK_URL is deliberately never included — ADR-0041 §A: "The
    // Slack webhook never enters the box."
  };
}

/** T03-D (see the task Outcome): local-only envVars, gated exactly like
 *  `DEV_ADMIN` (`O11Y_ENV === "local"`, fail-closed the same way — this
 *  branch is unreachable in production, which always sets
 *  `O11Y_ENV: "production"` from `wrangler.jsonc`'s `vars` block, never a
 *  secret). Mirrors `containers/o11y/compose.yml`'s own MinIO/local-
 *  ClickHouse shape. `wrangler dev`'s local Container orchestration runs
 *  `GrafanaBox`'s container via real Docker, independently of any
 *  `compose.yml` network — it reaches host-published services via Docker's
 *  own `host.docker.internal` DNS name, which `scripts/o11y-dev.mjs`'s own
 *  README section documents starting local MinIO/ClickHouse for
 *  (`docker compose -f containers/o11y/compose.yml up minio minio-init
 *  clickhouse`, ports published to the host — the `box` service itself is
 *  never started locally that way; `wrangler dev` IS the box). */
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
