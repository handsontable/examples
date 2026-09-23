// The o11y worker's entry point (observability contract §1). T00's scaffold
// (every route 501) is replaced here by real routing through `router.ts`
// (COMMON.md interface 2) for the routes this task owns —
// `POST /telemetry/collect`, `POST /telemetry/v1/logs`, `POST /telemetry/deploy`,
// `POST /telemetry/hooks/sentry` — every other contract path (`lite`, T08;
// `/grafana/*` and `reopen`, T01/T03) still answers `501` until its owning
// task registers a handler, exactly as the T00 scaffold did.
//
// Durable Object classes are exported from here, as Workers requires — each
// class itself lives in the file its owner's shared-file table row names
// (T00-D9): `GrafanaBox` in `box.ts` (T01), `InboxWriter` in
// `inbox/writer.ts` (T02, now real).

import type { Env } from "./env.js";
import { checkBrowserGates, checkPayloadEnvironment } from "./gates/browser.js";
import { checkDeployGate } from "./gates/oidc.js";
import { checkSentryHmac } from "./gates/sentry.js";
import { checkExportSecret } from "./gates/secret.js";
import { COLLECT_MAX_BYTES, OTLP_MAX_BYTES, SMALL_JSON_MAX_BYTES } from "./gates/limits.js";
import { inboxWriter } from "./inbox/accessor.js";
import { isDeployPayload, processDeployPayload } from "./normalise/deploy.js";
import { processFaroBody } from "./normalise/faro.js";
import { processOtlpBody } from "./normalise/otlp.js";
import { processSentryPayload } from "./normalise/sentry.js";
import { BodyTooLargeError, readCappedBytes, readCappedText } from "./normalise/read-body.js";
import { recordInvalidItem, recordOversizeDrop, respondDrop, respondIngested } from "./normalise/respond.js";
import { writePoint } from "./normalise/points.js";
import { findRoute, registerRoute } from "./router.js";
import { runAlerts } from "./alerts/index.js";
import { readHeartbeatReport } from "./heartbeat.js";

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
  { method: "POST", path: "/telemetry/lite" },
  { method: "GET", path: "/grafana/*" },
  { method: "POST", path: "/grafana/_o11y/reopen" },
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

  const receivedAtMs = Date.now();
  const service = {
    name: "demos-authoring" as const,
    version: (body as { meta?: { app?: { version?: string } } })?.meta?.app?.version ?? "unknown",
    environment: env.O11Y_ENV,
  };

  const processed = await processFaroBody(body, env, service, receivedAtMs);

  let accepted = 0;
  let duplicate = 0;
  const ingestItems = processed.filter((p) => p.ingestItem).map((p) => p.ingestItem!);

  for (const p of processed) {
    if (p.invalid) recordInvalidItem(env, ctx, p.invalid);
    if (p.oversize) recordOversizeDrop(env, ctx, "Faro record exceeds 256 KB");
    for (const point of p.aePoints) writePoint(env, ctx, point);
  }

  if (ingestItems.length > 0) {
    const result = await inboxWriter(env).ingest("browser", receivedAtMs, ingestItems);
    for (const r of result.results) r.outcome === "duplicate" ? duplicate++ : accepted++;
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

  // T04 PLACEHOLDER — remove at the feature-branch merge (COMMON.md
  // controller note: "Wire it into the scheduled handler minimally... When
  // you merge the feature branch at the end, call `runAlerts` from T03's
  // handler and remove yours"). T03 owns the real `*/10` cron handler
  // (backlog scan, `heartbeat.lastCron`, wake) — this exists only so
  // `runAlerts`/the watchdog have something to drive locally before T03
  // lands. `stampCronHeartbeat` here is likewise temporary: T03's real
  // backlog scan is what should stamp `lastCron` in production.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(inboxWriter(env).stampCronHeartbeat(Date.now()));
    ctx.waitUntil(runAlerts(env, ctx).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;
