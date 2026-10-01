// The o11y worker's entry point (observability contract §1): real routing
// through `router.ts` for `POST /telemetry/collect|v1/logs|deploy|hooks/
// sentry`, plus `/grafana/*` and `POST /grafana/_o11y/reopen` (below).
// `POST /telemetry/lite` registers itself via `./lite.ts`'s side-effect
// import. Durable Object classes are exported from here (Workers requires
// it) but defined in `box.ts`/`inbox/writer.ts`.

import { toAePoint } from "@handsontable/demo-runtime/telemetry";
import type { Env, IngestResult } from "./env.js";
import "./lite.js";
import { checkBrowserGates, checkPayloadEnvironment } from "./gates/browser.js";
import { checkDeployGate } from "./gates/oidc.js";
import { checkSentryHmac } from "./gates/sentry.js";
import { checkExportSecret } from "./gates/secret.js";
import { COLLECT_MAX_BYTES, OTLP_MAX_BYTES, SMALL_JSON_MAX_BYTES } from "./gates/limits.js";
import { inboxWriter } from "./inbox/accessor.js";
import { ingestWithDeadline } from "./inbox/ingest.js";
import { isDeployPayload, processDeployPayload } from "./normalise/deploy.js";
import { countFaroItems, MAX_FARO_ITEMS_PER_BODY, processFaroBody } from "./normalise/faro.js";
import { processOtlpBody } from "./normalise/otlp.js";
import { processSentryPayload } from "./normalise/sentry.js";
import { BodyTooLargeError, readCappedBytes, readCappedText } from "./normalise/read-body.js";
import { recordInvalidItem, recordOversizeDrop, respondDrop, respondIngested, o11ySelfIdentity } from "./normalise/respond.js";
import { writePoint } from "./normalise/points.js";
import { findRoute, registerRoute } from "./router.js";
import { runAlerts } from "./alerts/index.js";
import { getGrafanaBoxStub } from "./box.js";
import { handleGrafana } from "./grafana/proxy.js";
import { handleReopen } from "./grafana/reopen.js";
import { handleCallback, handleLogin, handleLogout, handleLogoutPage, handleSession } from "./grafana/login.js";

export { ContainerProxy } from "@cloudflare/containers";
export { GrafanaBox } from "./box.js";
export { InboxWriter } from "./inbox/writer.js";
export { O11yHeartbeat } from "./heartbeat.js";

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

  // Bound the whole batch before doing any real work — a real Faro batch
  // never approaches this many items (SDK limit 50); unbounded, one 1 MB
  // body inflated to ~16.7k stored records and AE points.
  if (countFaroItems(body) > MAX_FARO_ITEMS_PER_BODY) {
    return respondDrop(env, ctx, { ok: false, reason: "too_many_items", status: 400 });
  }

  const receivedAtMs = Date.now();
  const rawVersion = (body as { meta?: { app?: { version?: string } } })?.meta?.app?.version;
  const service = {
    name: "demos-authoring" as const,
    // `meta.app.version` is client-supplied and unbounded — it becomes
    // `service.version`, an AE blob, so it must be capped or it can push a
    // point over Analytics Engine's per-point size limit.
    version: typeof rawVersion === "string" && rawVersion.length > 0 ? rawVersion.slice(0, 64) : "unknown",
    environment: env.O11Y_ENV,
  };

  let accepted = 0;
  let duplicate = 0;
  try {
    const processed = await processFaroBody(body, env, service, receivedAtMs);

    // `withItem[i].ingestItem` is `ingestItems[i]`, and `IngestResult.results`
    // is index-aligned with `ingestItems` (see below).
    const withItem = processed.filter((p) => p.ingestItem);
    const ingestItems = withItem.map((p) => p.ingestItem!);

    for (const p of processed) {
      if (p.invalid) recordInvalidItem(env, ctx, p.invalid);
      if (p.oversize) recordOversizeDrop(env, ctx, "Faro record exceeds 256 KB");
      // An item with no `ingestItem` writes its points unconditionally (it
      // was already fully handled above). An `example.*` event carries a
      // hash-only `ingestItem` so it goes through the dedupe transaction
      // too, gated below on the actual outcome — no kind can double-count.
      if (!p.ingestItem) {
        for (const point of p.aePoints) writePoint(env, ctx, point);
      }
    }

    if (ingestItems.length > 0) {
      // Invalid/oversize records and AE points for items without an
      // `ingestItem` are written above, before ingest, so a Faro retry after
      // a timeout can double-count them (acceptable).
      const ingested = await ingestWithDeadline(env, "browser", receivedAtMs, ingestItems);
      // Writes the points of exactly the accepted items. Outcomes are matched
      // to items BY INDEX, never by hash: two identical items can share a hash
      // but get different outcomes.
      const writeAcceptedPoints = (result: IngestResult) => {
        withItem.forEach((p, idx) => {
          if (result.results[idx]?.outcome === "accepted") {
            for (const point of p.aePoints) writePoint(env, ctx, point);
          }
        });
      };
      if (!ingested.ok) {
        // A call that commits after the deadline still owes its points: the
        // client's retry comes back `duplicate` and writes none.
        if (ingested.settled) {
          ctx.waitUntil(
            ingested.settled.then((late) => {
              if (late) writeAcceptedPoints(late);
            }),
          );
        }
        return respondDrop(env, ctx, ingested.drop);
      }
      const result = ingested.result;
      // Every hash `InboxWriter.ingest` reports counts toward this route's
      // `o11y.ingest` self-metric, whether or not it carries a stored
      // `record`: an AE-only item is still a record the pipeline accepted.
      withItem.forEach((_p, idx) => {
        const outcome = result.results[idx]?.outcome;
        if (outcome === undefined) return;
        outcome === "duplicate" ? duplicate++ : accepted++;
      });
      writeAcceptedPoints(result);
    }
  } catch (err) {
    // `handleCollect`'s own backstop: every known throw site is fixed at
    // its root, but a still-unknown shape here degrades to one accounted
    // drop, never an unhandled exception.
    console.warn("[o11y] handleCollect failed:", err instanceof Error ? err.message : String(err));
    recordInvalidItem(env, ctx, "handleCollect: unhandled batch failure");
    // Reaching this catch means nothing in this batch committed —
    // `accepted`/`duplicate` stay zero. Answering 2xx here would claim a
    // commit that never happened (ADR §B.2), and since Faro only retries
    // on non-2xx, would silently drop the batch instead. A batch that
    // legitimately commits nothing (all duplicates) never throws, so it
    // still reaches the ordinary 204 below.
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
    const outcome = await ingestWithDeadline(env, "worker", receivedAtMs, processed.items);
    if (!outcome.ok) return respondDrop(env, ctx, outcome.drop);
    for (const r of outcome.result.results) r.outcome === "duplicate" ? duplicate++ : accepted++;
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
  const outcome = await ingestWithDeadline(env, "worker", receivedAtMs, [item]);
  if (!outcome.ok) return respondDrop(env, ctx, outcome.drop);
  const result = outcome.result;
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
  const item = await processSentryPayload(body, env, receivedAtMs, req.headers.get("sentry-hook-timestamp"));
  const outcome = await ingestWithDeadline(env, "worker", receivedAtMs, [item]);
  if (!outcome.ok) return respondDrop(env, ctx, outcome.drop);
  const result = outcome.result;
  const accepted = result.results.filter((r) => r.outcome === "accepted").length;
  const duplicate = result.results.filter((r) => r.outcome === "duplicate").length;

  return respondIngested(env, ctx, "hooks/sentry", { accepted, duplicate }, text.length);
}

registerRoute("POST", "/telemetry/collect", handleCollect);
registerRoute("POST", "/telemetry/v1/logs", handleOtlpLogs);
registerRoute("POST", "/telemetry/deploy", handleDeploy);
registerRoute("POST", "/telemetry/hooks/sentry", handleSentryHook);
// `"*"`, not `"GET"` — Grafana's frontend also queries via POST under
// `/grafana/*`. `POST /grafana/_o11y/reopen` is an exact route, which
// `router.ts`'s precedence (exact beats prefix) always wins over this
// catch-all. The five login/session/logout routes below are also exact
// routes for the same reason, and none of them ever wakes the box.
registerRoute("GET", "/grafana/_o11y/login", handleLogin);
registerRoute("GET", "/grafana/_o11y/callback", handleCallback);
registerRoute("POST", "/grafana/_o11y/session", handleSession);
registerRoute("GET", "/grafana/_o11y/logout", handleLogoutPage);
registerRoute("POST", "/grafana/_o11y/logout", handleLogout);
registerRoute("*", "/grafana/*", handleGrafana);
registerRoute("POST", "/grafana/_o11y/reopen", handleReopen);

/** ADR §A/§B.1's ten-minute cron (`wrangler.jsonc`'s `triggers.crons`):
 *  reads the backlog (which resolves over-wakes as a side effect, ADR
 *  §B.3), writes the `o11y.backlog` self-metric, and wakes the box when the
 *  backlog is old or large enough — never while `drainsPaused` (the cost
 *  cap; this cron only reads the flag, never writes it). The alert
 *  evaluation cron shares the same `scheduled` handler rather than adding a
 *  second export (Workers allows only one). */
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

  // ADR §A/§G: "never when drainsPaused" — reads the same flag
  // `alerts/index.ts#canWakeForBacklog` exposes, inline rather than a
  // second RPC round trip. A Grafana VISIT wake never reads this flag; the
  // box still serves Grafana, and `box.ts#drainStep` refuses to drain.
  if (backlog.drainsPaused) return;

  const oneHourMs = 60 * 60 * 1000;
  const sixtyFourMb = 64 * 1024 * 1024;
  if (backlog.oldestWrittenAgeMs <= oneHourMs && backlog.totalBytes <= sixtyFourMb) return;

  try {
    await getGrafanaBoxStub(env).wake("backlog");
  } catch (err) {
    // A wake failure (e.g. `recordWake` throwing) is retried by the very
    // next tick — nothing here needs to escalate.
    console.warn("[o11y] cron wake failed:", err instanceof Error ? err.message : String(err));
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    const handler = findRoute(request.method, url.pathname);
    if (handler) return handler(request, env, ctx);

    return new Response("Not Found", { status: 404 });
  },

  // `handleScheduled` is the one real `scheduled` export (Workers allows
  // only one). This tick does three independent things: stamps
  // `heartbeat.lastCron`, runs the backlog scan/wake, and evaluates every
  // alert. The backlog wake runs AFTER the alerts — `runAlerts` is what
  // sets `drainsPaused` from this tick's spend-cap result, so running them
  // side by side could let the crossing tick still wake and drain.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(inboxWriter(env).stampCronHeartbeat(Date.now()));
    ctx.waitUntil(
      runAlerts(env, ctx)
        .catch((err) => {
          console.error(JSON.stringify({ event: "o11y.cron.alerts_failed", message: String(err) }));
        })
        .then(() => handleScheduled(env, ctx)),
    );
  },
} satisfies ExportedHandler<Env>;
