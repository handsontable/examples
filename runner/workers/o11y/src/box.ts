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
// It does NOT decide *when* to wake (a Grafana visit through the login
// broker session, K1 — not Cloudflare Access — vs. the backlog cron) or
// proxy Grafana's own routes — those are T03's "wake and Grafana access"
// task, explicitly out of scope here.

import { Container } from "@cloudflare/containers";
import { o11ySelfIdentity } from "./normalise/respond.js";
import { writePointFromDo } from "./normalise/points.js";
import { toAePoint, type HotAttrs } from "@handsontable/demo-runtime/telemetry";
import { drainBatch, type DrainDeps } from "./drain/drain.js";
import { symbolicateResourceLogs } from "./drain/symbolicate.js";
import type { Env } from "./env.js";
import { reportAwakeSeconds } from "./cost.js";

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

/** Minor triage item 2: Grafana's LEGACY, frontend-driven datasource proxy
 *  route — `/api/datasources/proxy/uid/<uid>/<rest>` or the numeric-id form
 *  `/api/datasources/proxy/<id>/<rest>` — forwards `<rest>` VERBATIM to that
 *  datasource's configured `url`
 *  (`containers/o11y/grafana/provisioning/datasources/datasources.yaml`),
 *  with Grafana adding the datasource's own auth header. Every provisioned
 *  dashboard here (`containers/o11y/grafana/dashboards/*.json`) references
 *  its datasource by `uid` only (`o11y-box-config.test.mjs` pins this — see
 *  its new test below); nothing provisioned uses the numeric-id form, so a
 *  legitimate use of it is not something this box's own UI relies on.
 *  Capture groups: 1 = the `uid/<uid>` value if that form was used, 2 = the
 *  numeric id if that form was used, 3 = `<rest>`. */
const DATASOURCE_PROXY_RE = /^\/(?:grafana\/)?api\/datasources\/proxy\/(?:uid\/([^/]+)|(\d+))\/(.*)$/i;

/** A-I2: Grafana's MODERN resource-proxy route —
 *  `/api/datasources/uid/<uid>/resources/<rest>` or the numeric-id form
 *  `/api/datasources/<id>/resources/<rest>` — reaches the Loki datasource
 *  plugin's Go `CallResource` handler, which (confirmed live against this
 *  box's own real Grafana 11.4 + Loki plugin, COMMON.md port-block rule,
 *  project o11y-x1, see the task report) does NOT limit itself to a small
 *  registered set of names the way the earlier version of this comment
 *  claimed: reading the box's own container logs (`docker compose logs
 *  box`, `logger=tsdb.loki endpoint=callResource ... resourcePath=...`)
 *  shows the plugin builds the REAL outbound Loki request as literally
 *  `/loki/api/v1/<rest>` for whatever `<rest>` the client sent — e.g.
 *  `resources/config` really does reach Loki at `/loki/api/v1/config`
 *  (Loki's own 404, not Grafana's) — and forwards the response back
 *  verbatim. So this route is not "unregistered names can't reach Loki at
 *  all"; it is "everything is forwarded under the fixed `/loki/api/v1/`
 *  prefix". `resources/flush`/`resources/shutdown`/`resources/config` fail
 *  ONLY because Loki's real admin/config endpoints live OUTSIDE that
 *  prefix (Loki's bare root, e.g. `/flush`), a coincidence of Loki's own
 *  URL layout, not something Grafana enforces; `resources/push` reaches
 *  Loki's real `/loki/api/v1/push` and gets a genuine `405` from Loki
 *  itself (regardless of the client's own GET/POST — the plugin's
 *  outbound call does not appear to forward the client's HTTP method for
 *  this resource). A `--path-as-is` `../` traversal attempt at
 *  `resources/../otlp/v1/logs` (targeting the drain's own OTLP ingest
 *  path, which — unlike flush/shutdown — genuinely IS under Loki's root,
 *  not `/loki/api/v1/`) reached Loki as the literal, uncleaned string
 *  `/loki/api/v1/../otlp/v1/logs` and 404'd there too — Loki's own router
 *  does not resolve `..` segments either, so this specific escape did not
 *  work, but nothing about the mechanism *rules it out* for a future Loki
 *  version. Given all of this, the allowlist below is not defense in
 *  depth against something already structurally impossible — it is the
 *  actual boundary: this route is a real, live, working forward into
 *  Loki's `/loki/api/v1/*` namespace, gated here the same way the legacy
 *  proxy route is. */
const DATASOURCE_RESOURCE_RE = /^\/(?:grafana\/)?api\/datasources\/(?:uid\/([^/]+)\/resources|(\d+)\/resources)\/(.*)$/i;

/** Loki's own read/query HTTP API (`/loki/api/v1/*`) — everything a
 *  dashboard panel or Explore can legitimately need through the legacy
 *  proxy path (this box's own live check, `dev:full` against a real Grafana
 *  11, is the source for this set — see the task Outcome). `tail` streams
 *  over a websocket upgrade — already refused unconditionally above
 *  regardless of path — kept in this allowlist only so a non-upgrade
 *  request to the same path isn't blocked here for a second, more
 *  confusing reason. */
const LOKI_ALLOWED_QUERY_RE =
  /^loki\/api\/v1\/(?:query|query_range|labels|label\/[^/]+\/values|series|index\/stats|index\/volume(?:_range)?|patterns|detected_labels|detected_fields|tail|format_query)\/?$/i;

/** A-I2: the SAME logical read/query set as {@link LOKI_ALLOWED_QUERY_RE},
 *  without the `loki/api/v1/` prefix — the modern resource route's `<rest>`
 *  is the bare Go handler name (`labels`, `series`, `index/stats`, ...),
 *  confirmed live: `resources/query`/`resources/series`/`resources/labels`/
 *  `resources/index/stats`/`resources/detected_labels`/
 *  `resources/label/<name>/values`/`resources/query_range`/
 *  `resources/tail`/`resources/format_query` all answer normally against
 *  this box's real Grafana+Loki; `resources/patterns` 404s on THIS plugin
 *  build specifically (kept in the allowlist regardless — an
 *  unimplemented-but-allowed name is harmless, it still 404s inside
 *  Grafana; the risk this gate exists for is an implemented name that
 *  shouldn't be reachable, not the reverse). */
const LOKI_ALLOWED_RESOURCE_RE =
  /^(?:query|query_range|labels|label\/[^/]+\/values|series|index\/stats|index\/volume(?:_range)?|patterns|detected_labels|detected_fields|detected_fields\/[^/]+\/values|tail|format_query)\/?$/i;

/** `true` if `uid`/`numericId` (as extracted from either the legacy proxy
 *  or the modern resource route) identifies a request this gate must hold
 *  to an allowlist at all — a `loki-*` uid, or the numeric-id form
 *  (default-deny, see below). `false` (untouched by this gate) for any
 *  other uid, e.g. ClickHouse's `clickhouse-runner-events`. */
function isGatedDatasourceSelector(uid: string | undefined, numericId: string | undefined): boolean {
  if (uid !== undefined) return /^loki-/i.test(uid); // a non-Loki uid (e.g. ClickHouse) — untouched
  return numericId !== undefined; // the numeric-id form cannot be resolved back to an identity
  // here, so it gets the SAME strict allowlist unconditionally — nothing
  // provisioned needs it (see DATASOURCE_PROXY_RE's own doc comment), so
  // default-deny is the safe choice for it, including for what would
  // otherwise be a legitimate ClickHouse query issued through a numeric id
  // instead of its uid.
}

/** `true` for a datasource-proxy OR datasource-resource request that is not
 *  on the Loki read/query allowlist above (minor triage item 2; A-I2
 *  extends this to the modern `/resources/` route). Identification is by
 *  the SELECTOR, not by `<rest>` — the opposite of an allowlist keyed on the
 *  forwarded path would risk missing an unenumerated Loki endpoint (e.g.
 *  the drain's own ingest path, `/otlp/v1/logs`, is also served at Loki's
 *  bare root and is NOT under `/loki/...` — a `<rest>`-shape denylist would
 *  never catch it). */
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
      // Fix round (C1): this is also the branch that protects a still-
      // draining container from a second wake — `stop()` (SIGTERM) does NOT
      // change `getState()`'s status in the real `@cloudflare/containers`
      // library (`Container.prototype.stop` only signals the process and
      // awaits `syncPendingStoppedEvents`; it never calls
      // `setStatusAndupdate`), so `getState()` still reports
      // `"running"`/`"healthy"` for the whole window between calling
      // `stop()` and the process actually exiting. Falling through to
      // `#doWake` here would mint a second wakeId and call `recordWake`,
      // marking the still-draining wake `over: true` in InboxWriter's ledger
      // before its own marker exists — returning the EXISTING record
      // instead (below) is what actually prevents that, not a dedicated
      // `"stopping"` check.
      const existing = await this.ctx.storage.get<WakeRecord>(WAKE_STORAGE_KEY);
      if (existing) return existing;
      // Running with no persisted record is an inconsistent state this
      // class never produces itself — fail loudly rather than mint a
      // second wakeId for an already-running container.
      throw new Error(
        `GrafanaBox.wake: container state is "${state.status}" but no wake record is stored`,
      );
    }
    // Fix round (finding B-M1): a dedicated `state.status === "stopping"`
    // branch used to live here, refusing `wake()` while "stopping". The
    // real `@cloudflare/containers` library never actually reports that
    // status from `getState()` (its `ContainerState.setStopping()` method
    // exists but has no caller anywhere in the package — `stop()` above
    // confirms why: it never calls it), so the branch was dead code in
    // production; its own test only passed because the test stub's default
    // `stop()` hook invented the "stopping" state by hand
    // (`cloudflare-containers-stub.mjs`, now fixed to match the real
    // library and leave status untouched). Deleted rather than kept as
    // dead code — the "running"/"healthy" branch above already gives the
    // same protection for the real SIGTERM-pending window.
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
   *  after a request passes the session check (K1) — never by the drain's
   *  own Loki pushes. Also renews the base class's own idle clock (harmless — see
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
    if (!request || isBlockedContainerRequest(request)) {
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
    // F2 fix (final review, B-I4): `getState()` is this class's own
    // PERSISTED record and can lag the REAL container by up to a few
    // minutes after a host loss (see `isAwake()`'s own doc comment above —
    // the base class's periodic monitor reconciliation is what eventually
    // catches up). A request landing in that stale window (any open tab, or
    // `drainStep`'s own `isReady()` probe, firing every second) would pass
    // the check above and fall through to the base class's own
    // `containerFetch`, which restarts a container the moment it observes
    // `!this.container.running` — regardless of what THIS override decided
    // — using `this.envVars`, which `#doWake` never assigns (only `start()`'s
    // own `{ envVars }` parameter carries it), so that restart boots with NO
    // `WAKE_ID`/S3 credentials/datasource env at all. `this.ctx.container`
    // (a real, public `DurableObjectState` field — distinct from the base
    // library's own `this.container`, which is `private` and inaccessible
    // from a subclass at the type level) is the live signal, so checking it
    // here — in addition to the persisted `state.status` above — closes
    // that window: a request arriving during it is refused (503) rather
    // than silently starting an unminted container. Deliberately does NOT
    // try to self-heal by calling anything on `this.container`/`envVars`
    // here (T02's own note on the rejected fix: assigning `this.envVars` in
    // `#doWake` risks the base class's OWN restart racing a real wake and
    // booting a second process under the SAME `WAKE_ID`) — the base class's
    // periodic alarm/monitor reconciliation is what closes the stale window
    // on its own, well within the cron's 10-minute cadence.
    if (this.ctx.container?.running !== true) {
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

    const startedAt = Date.now();
    try {
      await this.#drainStepBody(payload, current, startedAt);
    } catch (err) {
      // B-M2 fix (minor triage item 4): any throw in `#drainStepBody` (an R2
      // `get`, an `InboxWriter` RPC, or a symbolication failure that isn't a
      // Loki-HTTP error) used to propagate straight out of `drainStep` and
      // silently end the drain for the rest of this wake — nothing
      // rescheduled it, nothing recorded the failure, and the box just sat
      // there (idle-timer-bound) having quietly given up mid-drain. Record
      // it exactly like a Loki outage already is (`outcome: "error"`, same
      // `o11y.drain` point shape `stoppedEarly` writes) and run the SAME
      // post-drain stop decision a Loki outage runs, so a later wake (the
      // cron backlog wake, or a fresh visit) retries these still-`written`
      // keys instead of losing the wake silently.
      try {
        writeBoxPoint(
          this.env,
          this.ctx,
          "o11y.drain",
          { count: 0, duration_ms: Date.now() - startedAt, bytes: 0, value: 0 },
          { reason: current.reason, outcome: "error" },
        );
        console.error(JSON.stringify({ event: "o11y.drain.error", wakeId: payload.wakeId, message: String(err) }));
        await this.#finishDrain(payload.wakeId);
      } catch (finishErr) {
        // `#finishDrain` (or the point write above it) throwing too — most
        // plausibly the SAME failure that took down `#drainStepBody` in the
        // first place (a DO storage/RPC outage affects every call in this
        // isolate, not just one). "always reschedule or finish" must hold
        // even here: fall back to a plain reschedule, the same one the
        // readiness gate above already uses, so this wake still gets
        // another chance rather than silently stalling forever.
        console.error(
          JSON.stringify({ event: "o11y.drain.error", wakeId: payload.wakeId, message: String(finishErr), stage: "finish" }),
        );
        await this.schedule(new Date(Date.now() + DRAIN_STEP_GAP_MS), DRAIN_STEP_SCHEDULE, payload);
      }
    }
  }

  /** The actual drain-batch work `drainStep` runs inside a try/finally-style
   *  guard (above) — split out so every throw inside it, from ANY step, is
   *  caught by the SAME handler (B-M2 fix, minor triage item 4). */
  async #drainStepBody(payload: { wakeId: string }, current: WakeRecord, startedAt: number): Promise<void> {
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

    // Fix round (finding B-M5): does this batch replay any reopened keys?
    // One-shot (the call also clears the markers) — see
    // `ledger.ts#takeReopenedFlag`'s own doc comment. Read BEFORE
    // `drainBatch` so the check reflects exactly the keys this batch is
    // about to push, not whatever the ledger looks like by the time the
    // point below is written.
    const replayedReopenedKeys = await writer.takeReopenedFlag(keys);

    const deps: DrainDeps = {
      fetchObject: async (key) => {
        const obj = await this.env.O11Y_INBOX.get(key);
        return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
      },
      pushToLoki: async (tenant, gzippedBody) => {
        const res = await this.containerFetch(
          new Request("http://box/otlp/v1/logs", {
            method: "POST",
            headers: { "content-type": "application/json", "content-encoding": "gzip", "X-Scope-OrgID": tenant },
            body: gzippedBody,
          }),
          3100,
        );
        const message = res.status >= 400 ? await res.text().catch(() => undefined) : undefined;
        return { status: res.status, message };
      },
      symbolicate: (records) => symbolicateResourceLogs(records, { getMap: (key) => this.#getMap(key) }),
    };

    const result = await drainBatch(keys, new Set(), deps);

    // B-M4 fix (minor triage item 3): a `provisional` key that pushed ZERO
    // bytes (every record was already deduped/too-old — `drain.ts#drainKey`'s
    // zero-chunk case) commits straight to `done:` instead of entering
    // `provisional:<wakeId>` — see `ledger.ts#commitKeys`'s own doc comment
    // for the endless-re-wake loop this avoids.
    const zeroByteKeys = result.outcomes.filter((o) => o.outcome === "provisional" && o.bytesPushed === 0).map((o) => o.key);
    const provisionalKeys = result.outcomes
      .filter((o) => o.outcome === "provisional" && o.bytesPushed > 0)
      .map((o) => o.key);
    const rejectedKeys = result.outcomes.filter((o) => o.outcome === "rejected");
    // G1 fix (row 19): a `provisional` outcome with a `reason` set is
    // `drain.ts#drainKey`'s partial-400 case — at least one chunk landed
    // 2xx (so it stays `provisional`, following the normal durability
    // path) but another permanently 400'd. That loss is real and must stay
    // operator-visible even though the key itself is not `rejected` — see
    // `InboxWriterApi#recordPartialReject`'s own doc comment.
    const partiallyRejected = result.outcomes.filter((o) => o.outcome === "provisional" && o.reason !== undefined);
    const bytesPushed = result.outcomes.reduce((sum, o) => sum + o.bytesPushed, 0);
    // F1: records dropped for being older than Loki's `reject_old_samples_max_age`
    // (ADR §G accepts this loss, but it must be counted, never silent) —
    // `value` (§4/§5) is otherwise unused by `o11y.drain`.
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
        // Fix round (finding B-M5): `"reopen"` (already a contract-allowed
        // `reason` value — `METRICS["o11y.drain"].values.reason`) instead of
        // the wake's own `backlog`/`visit` reason when this batch replayed
        // reopened keys — a wake can be TRIGGERED by a backlog/visit while
        // still draining backlogged manual-reopen data, and that is the
        // more informative fact about THIS batch.
        reason: replayedReopenedKeys ? "reopen" : current.reason,
        // NB4 (re-review 2): a mixed-outcome key (at least one chunk 2xx,
        // at least one permanently 400'd) stays `provisional` since row 19
        // — correct for durability — but that also meant it fell out of
        // `rejectedKeys` entirely, so this point reported `ok` for a drain
        // that permanently lost real data. `recordPartialReject` (above)
        // already logs the loss as its own event; this outcome must not
        // hide it too.
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
   * thing the ledger (T03) trusts; this is bookkeeping for exit criterion
   * 12's measurement, not a second source of truth.
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

    // T04 addition (ADR-0041 §G, "the o11y worker reports `GrafanaBox`
    // awake seconds over the `API` binding") — a small, necessary edit to
    // this file, not otherwise T04's own (see the T04 Outcome). `wake`'s
    // own `startedAt` to this stop's `at` is the same awake-window measure
    // `onStop`'s own doc comment already treats as "bookkeeping, not the
    // ledger's source of truth" — good enough for a cost estimate, exactly
    // like every other sku in `budget.ts` is an estimate until the nightly
    // reconciliation. No `wake` record (this class never produces that
    // itself, per `#wakeInner`'s own invariant) means nothing to report.
    //
    // Awaited directly rather than `this.ctx.waitUntil(...)` (T04-D, found
    // by this task's own test run — see the Outcome): `onStop` has already
    // run past the point anything is waiting on a response, so there is no
    // request to unblock, and `waitUntil` is not guaranteed to exist on
    // every `DurableObjectState` a caller (a test double, an older
    // workerd) hands this hook — `reportAwakeSeconds` itself never throws,
    // so awaiting it here costs nothing but a few milliseconds of `onStop`.
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
 *  (`docker compose -f containers/o11y/compose.yml up --wait minio
 *  clickhouse` — T1: no more separate `minio-init`, `minio` creates its own
 *  bucket — ports published to the host — the `box` service itself is
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
