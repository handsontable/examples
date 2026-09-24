// The o11y worker's entry point (observability contract §1). T00's scaffold
// (every route 501) is replaced here by real routing through `router.ts`
// (COMMON.md interface 2) for the routes this task owns —
// `POST /telemetry/collect`, `POST /telemetry/v1/logs`, `POST /telemetry/deploy`,
// `POST /telemetry/hooks/sentry` — plus `/grafana/*` and
// `POST /grafana/_o11y/reopen` (T03, registered below). Only
// `GET /grafana/_o11y/admin/*` (ADR-0043, after launch) is still a `501`
// stub, exactly like the T00 scaffold, until its owning task registers a
// handler.
//
// `POST /telemetry/lite` (T08, ADR §C.5) registers itself: `./lite.ts` calls
// `registerRoute` at module load, the same COMMON.md interface 2 every other
// route here uses, and is pulled in below by its side-effect import — kept in
// its own file (T08's "Owns" row) rather than folded into this one's handler
// functions, since T03/T04 also touch this file and a merge conflict on a
// route this large is worse than one extra import line.
//
// Durable Object classes are exported from here, as Workers requires — each
// class itself lives in the file its owner's shared-file table row names
// (T00-D9): `GrafanaBox` in `box.ts` (T01), `InboxWriter` in
// `inbox/writer.ts` (T02, now real).

import { toAePoint } from "@handsontable/demo-runtime/telemetry";
import type { Env } from "./env.js";
import "./lite.js";
import { checkBrowserGates, checkPayloadEnvironment } from "./gates/browser.js";
import { checkDeployGate } from "./gates/oidc.js";
import { checkSentryHmac } from "./gates/sentry.js";
import { checkExportSecret } from "./gates/secret.js";
import { COLLECT_MAX_BYTES, OTLP_MAX_BYTES, SMALL_JSON_MAX_BYTES } from "./gates/limits.js";
import { inboxWriter } from "./inbox/accessor.js";
import { isDeployPayload, processDeployPayload } from "./normalise/deploy.js";
import { countFaroItems, MAX_FARO_ITEMS_PER_BODY, processFaroBody } from "./normalise/faro.js";
import { processOtlpBody } from "./normalise/otlp.js";
import { processSentryPayload } from "./normalise/sentry.js";
import { BodyTooLargeError, readCappedBytes, readCappedText } from "./normalise/read-body.js";
import { recordInvalidItem, recordOversizeDrop, respondDrop, respondIngested, o11ySelfIdentity } from "./normalise/respond.js";
import { writePoint } from "./normalise/points.js";
import { findRoute, registerRoute } from "./router.js";
import { runAlerts } from "./alerts/index.js";
import { readHeartbeatReport } from "./heartbeat.js";
import { getGrafanaBoxStub } from "./box.js";
import { handleGrafana } from "./grafana/proxy.js";
import { handleReopen } from "./grafana/reopen.js";
import { handleCallback, handleLogin, handleLogout, handleLogoutPage, handleSession } from "./grafana/login.js";

export { GrafanaBox } from "./box.js";
export { InboxWriter } from "./inbox/writer.js";
export { O11yHeartbeat } from "./heartbeat.js";

interface RouteStub {
  method: "GET" | "POST";
  /** Exact path, or a prefix when it ends in `/*` — same convention
   *  `router.ts` uses. */
  path: string;
}

/** Every contract §1 route not yet backed by a real handler — still a 501
 *  stub, exactly like the T00 scaffold, until its owning task registers one
 *  through `router.ts`. */
const UNIMPLEMENTED_ROUTES: readonly RouteStub[] = [
  { method: "GET", path: "/grafana/_o11y/admin/*" },
];

function matchesStub(route: RouteStub, method: string, pathname: string): boolean {
  if (route.method !== method) return false;
  if (route.path.endsWith("/*")) return pathname.startsWith(route.path.slice(0, -1));
  return pathname === route.path;
}

// ---- POST /telemetry/collect — Faro payloads from the authoring app ------------

async function handleCollect(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const gate = await checkBrowserGates(req, env, COLLECT_MAX_BYTES);
  if (!gate.ok) return respondDrop(env, ctx, gate);

  let bytes: Uint8Array;
  try {
    bytes = await readCappedBytes(req, COLLECT_MAX_BYTES);
  } catch (err) {
    if (err instanceof BodyTooLargeError) return respondDrop(env, ctx, { ok: false, reason: "size", status: 413 });
    return respondDrop(env, ctx, { ok: false, reason: "parse", status: 400 });
  }

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return respondDrop(env, ctx, { ok: false, reason: "parse", status: 400 });
  }

  const declaredEnv = (body as { meta?: { app?: { environment?: string } } })?.meta?.app?.environment;
  const envGate = checkPayloadEnvironment(declaredEnv, env);
  if (!envGate.ok) return respondDrop(env, ctx, envGate);

  // Fix round (finding A-I4): bound the whole batch before doing any real
  // work on it — a real Faro `TransportBody` never approaches this many
  // items (the SDK's own batch limit is 50); an unbounded batch is what let
  // one 1 MB body inflate to ~16.7k stored records and AE points.
  if (countFaroItems(body) > MAX_FARO_ITEMS_PER_BODY) {
    return respondDrop(env, ctx, { ok: false, reason: "too_many_items", status: 400 });
  }

  const receivedAtMs = Date.now();
  const rawVersion = (body as { meta?: { app?: { version?: string } } })?.meta?.app?.version;
  const service = {
    name: "demos-authoring" as const,
    // Fix round (finding A-M1): `meta.app.version` is client-supplied and
    // was unbounded — it becomes `service.version`, a Loki-queried (if not
    // labeled) field and an AE blob, and `writePoint`'s "never throws" gap
    // was reachable through exactly this kind of unbounded string turning a
    // point over Analytics Engine's per-point size limit.
    version: typeof rawVersion === "string" && rawVersion.length > 0 ? rawVersion.slice(0, 64) : "unknown",
    environment: env.O11Y_ENV,
  };

  let accepted = 0;
  let duplicate = 0;
  try {
    const processed = await processFaroBody(body, env, service, receivedAtMs);

    const ingestItems = processed.filter((p) => p.ingestItem).map((p) => p.ingestItem!);

    for (const p of processed) {
      if (p.invalid) recordInvalidItem(env, ctx, p.invalid);
      if (p.oversize) recordOversizeDrop(env, ctx, "Faro record exceeds 256 KB");
      // Fix round (finding A-I4; NB3 correction, re-review 2): an item with
      // no `ingestItem` AT ALL never reached even hash-only ingest (it was
      // already fully handled above — invalid, oversize, or the "log"/non-
      // "example." case that stores a record with no AE point) — those, and
      // only those, write their points unconditionally. An `example.*`
      // event is NOT one of these any more (A-I4 remainder, closed second
      // wave): it carries a hash-only `ingestItem` (no `record`) purely so
      // it goes through InboxWriter's dedupe transaction like everything
      // else, and its points are gated below on the actual dedupe outcome,
      // the same as a stored record's — a retried/redelivered batch cannot
      // double-count either kind.
      if (!p.ingestItem) {
        for (const point of p.aePoints) writePoint(env, ctx, point);
      }
    }

    if (ingestItems.length > 0) {
      const result = await inboxWriter(env).ingest("browser", receivedAtMs, ingestItems);
      const outcomeByHash = new Map(result.results.map((r) => [r.hash, r.outcome]));
      // NB3 (re-review 2): only count hashes that carry a STORED `record`
      // toward this route's own `o11y.ingest accepted`/`duplicate`
      // self-metric. An `example.*` event's hash-only `ingestItem` (no
      // `record`, above) is real for InboxWriter's dedupe bookkeeping and
      // ADR-0042's counts, but it never produces a `row:` — counting it
      // here too would skew the ingest-volume panels upward by however
      // much `example.*` traffic this batch carried, panels that exist to
      // track stored-record volume.
      const recordHashes = new Set(processed.filter((p) => p.ingestItem?.record !== undefined).map((p) => p.ingestItem!.hash));
      for (const r of result.results) {
        if (!recordHashes.has(r.hash)) continue;
        r.outcome === "duplicate" ? duplicate++ : accepted++;
      }
      for (const p of processed) {
        if (!p.ingestItem) continue;
        if (outcomeByHash.get(p.ingestItem.hash) === "accepted") {
          for (const point of p.aePoints) writePoint(env, ctx, point);
        }
      }
    }
  } catch (err) {
    // Fix round (finding A-M1): `handleCollect` had no boundary of its own
    // around body processing — any exception that escaped `processFaroBody`
    // or `InboxWriter.ingest` became an uncaught `500`. Every known throw
    // site is fixed at its root (see `normalise/faro.ts`/`scrub.ts`), but
    // this stays as the route's own backstop, so a still-unknown shape
    // degrades to one accounted drop, never an unhandled exception.
    console.warn("[o11y] handleCollect failed:", err instanceof Error ? err.message : String(err));
    recordInvalidItem(env, ctx, "handleCollect: unhandled batch failure");
    // N3 (re-review 2): reaching this catch means nothing in this batch
    // reached `InboxWriter.ingest` successfully — `accepted`/`duplicate`
    // are still their zero initial values, since both are only incremented
    // after `ingest()` resolves (above). Answering 2xx here would claim a
    // commit that never happened (ADR §B.2: "2xx only after commit"), and
    // — because Faro clients only retry on a non-2xx — would also silently
    // and permanently drop this batch instead of it being retried. This is
    // distinct from a batch that legitimately commits nothing because every
    // item was already a duplicate: that path never throws, so it still
    // reaches the ordinary `respondIngested` 204 below, unchanged — an
    // idempotent replay must stay 2xx.
    return new Response(JSON.stringify({ error: "unhandled_batch_failure" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  return respondIngested(env, ctx, "collect", { accepted, duplicate }, bytes.byteLength);
}

// ---- POST /telemetry/v1/logs — Cloudflare OTLP log export ---------------------

async function handleOtlpLogs(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const secretGate = checkExportSecret(req, env);
  if (!secretGate.ok) return respondDrop(env, ctx, secretGate);

  let bytes: Uint8Array;
  try {
    bytes = await readCappedBytes(req, OTLP_MAX_BYTES);
  } catch {
    return respondDrop(env, ctx, { ok: false, reason: "size", status: 413 });
  }

  const contentType = req.headers.get("content-type") ?? "application/json";
  const receivedAtMs = Date.now();

  let processed;
  try {
    processed = await processOtlpBody(bytes, contentType, env, receivedAtMs);
  } catch {
    return respondDrop(env, ctx, { ok: false, reason: "parse", status: 400 });
  }

  let accepted = 0;
  let duplicate = 0;
  if (processed.droppedOversize > 0) {
    for (let i = 0; i < processed.droppedOversize; i++) {
      recordOversizeDrop(env, ctx, "OTLP record exceeds 256 KB");
    }
  }
  if (processed.items.length > 0) {
    const result = await inboxWriter(env).ingest("worker", receivedAtMs, processed.items);
    for (const r of result.results) r.outcome === "duplicate" ? duplicate++ : accepted++;
  }

  return respondIngested(env, ctx, "v1/logs", { accepted, duplicate }, bytes.byteLength);
}

// ---- POST /telemetry/deploy — CI deploy events ---------------------------------

async function handleDeploy(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const gate = await checkDeployGate(req, env);
  if (!gate.ok) return respondDrop(env, ctx, gate);

  let text: string;
  try {
    text = await readCappedText(req, SMALL_JSON_MAX_BYTES);
  } catch {
    return respondDrop(env, ctx, { ok: false, reason: "size", status: 413 });
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return respondDrop(env, ctx, { ok: false, reason: "parse", status: 400 });
  }
  if (!isDeployPayload(body)) return respondDrop(env, ctx, { ok: false, reason: "parse", status: 400 });

  const receivedAtMs = Date.now();
  const item = await processDeployPayload(body, env, receivedAtMs);
  const result = await inboxWriter(env).ingest("worker", receivedAtMs, [item]);
  const accepted = result.results.filter((r) => r.outcome === "accepted").length;
  const duplicate = result.results.filter((r) => r.outcome === "duplicate").length;

  return respondIngested(env, ctx, "deploy", { accepted, duplicate }, text.length);
}

// ---- POST /telemetry/hooks/sentry — Sentry issue-alert webhook ----------------

async function handleSentryHook(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  let text: string;
  try {
    text = await readCappedText(req, SMALL_JSON_MAX_BYTES);
  } catch {
    return respondDrop(env, ctx, { ok: false, reason: "size", status: 413 });
  }

  const gate = await checkSentryHmac(req, env, text);
  if (!gate.ok) return respondDrop(env, ctx, gate);

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return respondDrop(env, ctx, { ok: false, reason: "parse", status: 400 });
  }

  const receivedAtMs = Date.now();
  const item = await processSentryPayload(body, env, receivedAtMs);
  const result = await inboxWriter(env).ingest("worker", receivedAtMs, [item]);
  const accepted = result.results.filter((r) => r.outcome === "accepted").length;
  const duplicate = result.results.filter((r) => r.outcome === "duplicate").length;

  return respondIngested(env, ctx, "hooks/sentry", { accepted, duplicate }, text.length);
}

registerRoute("POST", "/telemetry/collect", handleCollect);
registerRoute("POST", "/telemetry/v1/logs", handleOtlpLogs);
registerRoute("POST", "/telemetry/deploy", handleDeploy);
registerRoute("POST", "/telemetry/hooks/sentry", handleSentryHook);
// T03: `"*"`, not `"GET"` — Grafana's own frontend queries through
// `POST /api/ds/query`, `POST /api/live/*` (blocked one layer down in
// `box.ts`, never reaching here) and others under `/grafana/*`, not only
// GET page loads. `POST /grafana/_o11y/reopen` is registered as an exact
// route below it; `router.ts`'s own precedence rule (T02-D10: exact beats
// prefix) means it always wins over this catch-all regardless of
// registration order.
// K1: the broker login round trip that replaces Cloudflare Access — exact
// routes, so `router.ts`'s own precedence rule (exact beats prefix) means
// they always win over the `/grafana/*` catch-all below regardless of
// registration order. None of these five ever wakes the box (login.ts's own
// header). `GET .../logout` (fix round M5) is a same-origin sign-out PAGE —
// the actual state-clearing action stays the CSRF-protected `POST` below it.
registerRoute("GET", "/grafana/_o11y/login", handleLogin);
registerRoute("GET", "/grafana/_o11y/callback", handleCallback);
registerRoute("POST", "/grafana/_o11y/session", handleSession);
registerRoute("GET", "/grafana/_o11y/logout", handleLogoutPage);
registerRoute("POST", "/grafana/_o11y/logout", handleLogout);
registerRoute("*", "/grafana/*", handleGrafana);
registerRoute("POST", "/grafana/_o11y/reopen", handleReopen);

/** ADR §A/§B.1's ten-minute cron (`wrangler.jsonc`'s `triggers.crons`, T03's
 *  row): reads the
 *  backlog (which resolves over-wakes as a side effect, ADR §B.3), writes
 *  the `o11y.backlog` self-metric, and wakes the box when the backlog is
 *  old or large enough — never while `drainsPaused` (T04's cost cap; this
 *  cron only reads the flag, never writes it). T03-D: `scheduled()` did not
 *  exist on this Worker's default export before this task — a minimal,
 *  justified addition to `index.ts` (not in this task's literal "Owns"
 *  row, but the same class of shared-file addition T02's own route
 *  registrations already are); T04 extends the same handler for its own
 *  alert-evaluation cron rather than adding a second `scheduled` export
 *  (Workers allows only one). */
async function handleScheduled(env: Env, ctx: ExecutionContext): Promise<void> {
  const writer = inboxWriter(env);
  const backlog = await writer.backlog();

  writePoint(
    env,
    ctx,
    toAePoint(
      "o11y.backlog",
      { value: backlog.oldestWrittenAgeMs / 1000, bytes: backlog.totalBytes },
      o11ySelfIdentity(env),
    ),
  );

  // ADR §A/§G: "never when drainsPaused" — `backlog.drainsPaused` is
  // `writer.backlog()`'s own read of the same `drainsPaused` storage flag
  // `alerts/index.ts#canWakeForBacklog` exposes (T04's cap rule sets it via
  // `InboxWriter.setDrainsPaused`); read here inline rather than through a
  // second RPC round trip to the same DO, since `backlog()` already fetched
  // it in the same call. A Grafana VISIT wake (`grafana/proxy.ts`) never
  // reads this flag at all — unaffected by the cap, by design.
  if (backlog.drainsPaused) return;

  const oneHourMs = 60 * 60 * 1000;
  const sixtyFourMb = 64 * 1024 * 1024;
  if (backlog.oldestWrittenAgeMs <= oneHourMs && backlog.totalBytes <= sixtyFourMb) return;

  try {
    await getGrafanaBoxStub(env).wake("backlog");
  } catch (err) {
    // A wake failure (e.g. the box is mid-`stopping`) is retried by the
    // very next tick — nothing here needs to escalate.
    console.warn("[o11y] cron wake failed:", err instanceof Error ? err.message : String(err));
  }
}

// T04: the API worker's watchdog reaches this path over the `O11Y` service
// binding (`o11y-watchdog.ts`). Deliberately never passed to
// `registerRoute` — this Worker's own `--routes` flags (package.json's
// `deploy` script) are `demos.handsontable.com/telemetry/*` and
// `/grafana/*` only, so `/_internal/heartbeat` is unreachable from outside
// this binding by construction, unlike the API worker's wildcard
// `*.demos.handsontable.com/*` (see `heartbeat.ts`'s own header for why
// that distinction matters and why the API-side entrypoint is a real named
// `WorkerEntrypoint` instead of the same trick).
const HEARTBEAT_INTERNAL_PATH = "/_internal/heartbeat";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === HEARTBEAT_INTERNAL_PATH) {
      const report = await readHeartbeatReport(env);
      return new Response(JSON.stringify(report), { headers: { "content-type": "application/json" } });
    }

    const handler = findRoute(request.method, url.pathname);
    if (handler) return handler(request, env, ctx);

    const stub = UNIMPLEMENTED_ROUTES.some((route) => matchesStub(route, request.method, url.pathname));
    if (stub) {
      return new Response("Not Implemented — route logic lands in a later o11y task.", { status: 501 });
    }
    return new Response("Not Found", { status: 404 });
  },

  // Merge (T04 phase 2): T04's own placeholder `scheduled()` is gone —
  // T03's ten-minute cron handler (`handleScheduled`, above) is the one
  // real `scheduled` export, per Workers' "exactly one" limit. This single
  // tick does three things, each independent of the other two (a failure
  // in one must not skip the others): stamps `heartbeat.lastCron` exactly
  // once (still `InboxWriter.stampCronHeartbeat`, T04's own RPC method —
  // T03's backlog/wake logic never wrote this key, so the watchdog would
  // read a stale `lastCron` forever without this call); runs the backlog
  // scan/wake (`handleScheduled`, which already refuses a backlog wake
  // while `drainsPaused` — see that function's own `if (backlog
  // .drainsPaused) return;`); and evaluates every ADR §F.3 alert
  // (`runAlerts`, T04's own cron entry, COMMON.md's "call `runAlerts` from
  // T03's handler" instruction).
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(inboxWriter(env).stampCronHeartbeat(Date.now()));
    ctx.waitUntil(handleScheduled(env, ctx));
    ctx.waitUntil(runAlerts(env, ctx).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;
