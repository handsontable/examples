// Orchestration + sharing Worker for the Handsontable demo runner.
//
// Tier-2 live editing: per-session Cloudflare Sandbox container running the real
// framework dev server with HMR. proxyToSandbox() transparently proxies the
// preview URL (HTTP + WebSocket/HMR) back through this Worker.
//
// Sharing endpoints (POST/GET/PATCH/DELETE /api/demos) land in Deliverable 5.

import { getSandbox, proxyToSandbox, Sandbox as SandboxBase } from "@cloudflare/sandbox";
import * as Sentry from "@sentry/cloudflare";
import { DEFAULT_MAX_MAJOR, DEFAULT_MIN_MAJOR, mintSessionId, pickLatestNextVersion } from "@handsontable/demo-runtime";
import { injectMonitor } from "./monitor-inject.js";
import type { Env } from "./env.js";
import { FRAMEWORK_DEV, BUILD_CONFIG } from "./frameworks.generated.js";
import { dependencyMetadataFingerprint } from "./dependency-metadata.js";
import { authenticate, authenticateService, sameOwner } from "./auth.js";
import { MAX_TITLE, isValidationError, validateDescription, validateTitle } from "./demo-info.js";
import { isMcpValidationError, validateMcpFiles } from "./mcp-create.js";
import { demoListQuery, parseDemoScope } from "./demos-list.js";
import { errorPageResponse, wantsHtmlError } from "./error-page.js";
import { classifyPreviewBootFailure, isPortNotListening } from "./preview-boot.js";
import { ImportError, MAX_PAYLOAD_CHARS, importFromUrl, validatePayloadFiles } from "./import-url.js";
import { createDemo, getDemo, getDemoSource, invalidateDemo, serveDemoAsset, shortId, updateDemo, type DemoRow } from "./share.js";
import {
  budgetPausedMessage,
  countEgress,
  flushTraffic,
  getBudgetState,
  hasSessionMeter,
  invalidateBudgetState,
  meterSession,
  noteTraffic,
  publicBudget,
  recordLlmUsage,
  sessionDenial,
  startSessionMeter,
} from "./budget.js";
import { checkCostAlerts, gcRevokedArtifacts, reconcileBilling } from "./reconcile.js";
import { flushUsage, noteView, recordUsageEvent } from "./usage.js";
import { flushAnalytics, normalisePage, notePageView, pruneAnalytics } from "./analytics.js";
import { adminUsage } from "./admin.js";
import {
  ChatUnavailableError,
  checkChatRateLimit,
  requestAnswer,
  searchDocPages,
  validateChatRequest,
} from "./chat.js";
import { loadSettings, resetSettings, saveSettings, validateSettings } from "./settings.js";
import { checkAvatarSize, normalizeProfileInput, sniffImage, MAX_AVATAR_BYTES } from "./profile.js";
import { putAvatar, readProfile, removeAvatar, saveProfile, serveAvatar } from "./profile-store.js";
import { requestTheme, validateStylePrompt } from "./theme-ai.js";

// proxyToSandbox() hard-requires a single DO namespace literally named `Sandbox`,
// so live-preview sessions all use ONE class backed by one generic image that
// resolves each demo's deps at session start (per-framework images can't be
// previewed by the SDK). The builder (no preview) keeps its own class.
// Idle window before a live-preview container scales to zero. While a demo tab
// is open the client keepalive (60s pings) + HMR WebSocket keep resetting this
// timer, so the dev server stays warm during active use and only sleeps (stops
// billing) once the user is truly gone. Closing the tab tears the session down
// immediately (ContainerRuntime's pagehide dispose), so this window only covers
// hidden tabs and crashed clients — with max_instances at 5, a long window lets
// abandoned sessions exhaust the pool. Disk is ephemeral, so a slept container
// cold-boots on return — the point is to avoid that mid-session, not to make
// wake cheap.
/** The one production host. Doubles as the "am I deployed?" signal below. */
const PRODUCTION_HOST = "demos.handsontable.com";

/**
 * Sentry init options, shared by the fetch handler and both Durable Objects so
 * every event carries the same release and environment. Errors only — no
 * tracing, no profiling. See docs/run-and-deploy.md.
 *
 * Reporting is enabled only on the deployed Worker. `PREVIEW_HOST` is the
 * discriminator: it is `demos.handsontable.com` in the committed
 * `wrangler.jsonc` vars and is overridden to `localhost:8787` by
 * `workers/api/.dev.vars` for local runs — the same prod-vs-local switch the
 * Tier-2 preview URLs already depend on. Without the gate, `wrangler dev` would
 * file local experiments as `api-production` issues. The browser SDK gates on
 * `window.location.hostname` for the same reason.
 *
 * The DSN var is deliberately NOT named `SENTRY_DSN`: the SDK's own
 * `getFinalOptions` falls back to `env.SENTRY_DSN` whenever the options object
 * omits a dsn, which would initialise the client straight from env and silently
 * defeat the gate. Under a different key that fallback finds nothing, so the only
 * path a DSN can take is the explicit line below. For the same reason the gate is
 * expressed as `dsn: undefined` (an inert client that never sends) rather than by
 * returning `undefined` — the SDK reads that as an empty options object and then
 * env-falls-back anyway.
 *
 * `CF_VERSION_METADATA` is optional-chained: local `wrangler dev` supplies a
 * throwaway id, and a missing release must never throw at init.
 */
const sentryOptions = (env: Env): Sentry.CloudflareOptions => ({
  dsn: env.PREVIEW_HOST === PRODUCTION_HOST ? env.ERROR_REPORTING_DSN : undefined,
  environment: "api-production",
  release: env.CF_VERSION_METADATA?.id,
  tracesSampleRate: 0,
});

/**
 * The literal value of the SDK's `PREVIEW_PROXY_HEADER`, pinned.
 *
 * `proxyToSandbox()` strips the four `x-sandbox-preview-*` names off the
 * incoming request and sets this one to "1" before calling `sandbox.fetch()`,
 * so it is the reliable "this DO fetch is preview traffic" signal. The constant
 * is `@internal` in the SDK and not exported, hence the copy. If the SDK renames
 * it, the check below stops matching and we degrade to today's behaviour — a 500
 * — which is the right direction for a guess to fail in.
 */
const PREVIEW_PROXY_HEADER = "x-sandbox-preview-proxy";

/** Marks our own boot-failure page so the proxy seam leaves it alone. */
const PREVIEW_BOOTING_HEADER = "x-demo-preview-booting";

class SandboxBaseWithSleep extends SandboxBase {
  sleepAfter = "5m";

  /**
   * When the container this DO fronts last started, or when it first refused a
   * preview request. In-memory on purpose: it is a per-boot clock, and a DO
   * isolate recreated without `onStart()` having run falls back to the
   * first-refusal stamp, which biases toward under-reporting. That is the
   * correct direction here — over-reporting is the bug being fixed.
   */
  private bootStartedAt: number | null = null;
  /** One Sentry event per overrunning boot, not one per HMR retry. */
  private bootFailureReported = false;

  /**
   * Fires on every container start, which is exactly the clock DEV-2537 needs:
   * a refusal is only ever reachable inside the generation that exposed the port
   * (see `preview-boot.ts` — a restart makes every preview URL a 410 instead),
   * so "since this container started" is the right thing to measure. Stamped
   * before `super.onStart()` because the SDK's own start work is part of the
   * boot a visitor is waiting on.
   */
  override async onStart(): Promise<void> {
    this.bootStartedAt = Date.now();
    this.bootFailureReported = false;
    await super.onStart();
  }

  /**
   * Turn "the container is up but nothing is listening on the dev-server port"
   * into an honest 503 instead of a thrown exception (DEV-2537).
   *
   * This has to live inside the Durable Object, not at the Worker's proxy seam:
   * `proxyToSandbox()` already catches and synthesises `500 Proxy routing error`,
   * so the Worker never sees the throw — and the Sentry event does not come from
   * `withSentry` on the fetch handler either. It comes from
   * `instrumentDurableObjectWithSentry`, which binds and wraps `obj.fetch` after
   * construction. Because it binds the *instance* method, this override is what
   * gets wrapped, so our catch runs first and Sentry never sees a throw. An event
   * captured here still ships: the wrapper's isolation scope holds the client for
   * the whole call and flushes it via `waitUntil` on the normal return path.
   */
  override async fetch(request: Request): Promise<Response> {
    let response: Response;
    try {
      response = await super.fetch(request);
    } catch (err) {
      // Anything we did not diagnose keeps today's status and today's report.
      // The intercept keys on a workerd message string, so a wording change must
      // degrade to current behaviour, never to a swallowed error.
      if (!isPortNotListening(err) || request.headers.get(PREVIEW_PROXY_HEADER) !== "1") throw err;
      return this.previewBootFailureResponse(request, err);
    }
    // Cleared on any non-throwing return, so a dev server that dies mid-session
    // starts a fresh clock at its first refusal rather than being permanently
    // silenced by the successful boot that preceded it.
    this.bootStartedAt = null;
    this.bootFailureReported = false;
    return response;
  }

  private previewBootFailureResponse(request: Request, err: unknown): Response {
    if (this.bootStartedAt === null) this.bootStartedAt = Date.now();
    // `PREVIEW_PROXY_HEADERS` strips only the four `x-sandbox-preview-*` names,
    // so `Upgrade` and `Accept` are the client's own and are readable here.
    const descriptor = classifyPreviewBootFailure({
      elapsedMs: Date.now() - this.bootStartedAt,
      isUpgrade: request.headers.get("Upgrade")?.toLowerCase() === "websocket",
      wantsHtml: wantsHtmlError(new URL(request.url).pathname),
      acceptsHtml: (request.headers.get("Accept") ?? "").toLowerCase().includes("text/html"),
    });

    if (descriptor.report && !this.bootFailureReported) {
      this.bootFailureReported = true;
      // Fingerprinted away from the raw error. Without this the surviving
      // events land in the same issue as the 500s this change removes, and the
      // one signal that tells "the fix worked" from "the report never fired" —
      // volume dropping to near zero rather than to exactly zero — is unreadable.
      Sentry.captureException(err, {
        fingerprint: ["preview-boot-window-exceeded"],
        tags: { preview_boot: "terminal" },
      });
    }

    const response =
      descriptor.shape === "html"
        ? errorPageResponse({
            status: 503,
            title: descriptor.title,
            body: descriptor.body,
            refreshSeconds: descriptor.refreshSeconds,
          })
        : new Response(descriptor.shape === "bare" ? null : `${descriptor.title}. ${descriptor.body}`, {
            status: 503,
            headers: descriptor.shape === "bare" ? {} : { "Content-Type": "text/plain; charset=utf-8" },
          });

    // 503 stays the status for both branches. It is what `Retry-After` is for,
    // and it is in the SDK's `RETRYABLE_WEBSOCKET_UPGRADE_STATUSES` — the SDK's
    // own 410 "stale preview" would drop out of that set and change how HMR
    // reconnects. `refreshSeconds` and the copy carry the distinction instead.
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Retry-After", String(descriptor.retryAfterSeconds));
    response.headers.set(PREVIEW_BOOTING_HEADER, "1");
    return response;
  }
}

/** The builder is destroyed in runBuild's `finally`, so this window only ever
 *  covers the case where that never runs (Worker evicted or killed mid-build).
 *  Long enough not to cut a slow install short, short enough that a stranded
 *  builder cannot squat a pool slot — or bill — for long. */
class BuilderSandboxWithSleep extends SandboxBase {
  sleepAfter = "10m";
}

// Both DO classes are Sentry-instrumented: Tier-2 session orchestration and the
// share-build snapshotter run inside them, so a failure there never passes
// through the fetch handler's own error path. The export name `Sandbox` is
// load-bearing — proxyToSandbox() resolves the live-preview namespace by that
// literal name — so the wrapper is assigned to it rather than aliased.
// The `as unknown as typeof X` casts mirror the proxyToSandbox() cast below:
// the Sandbox SDK's recursive RPC generic hits TS2589 (deep instantiation) when
// a wrapper re-infers it.
export const Sandbox = Sentry.instrumentDurableObjectWithSentry(
  sentryOptions,
  SandboxBaseWithSleep as unknown as new (state: DurableObjectState, env: Env) => never,
) as unknown as typeof SandboxBaseWithSleep;

export const BuilderSandbox = Sentry.instrumentDurableObjectWithSentry(
  sentryOptions,
  BuilderSandboxWithSleep as unknown as new (state: DurableObjectState, env: Env) => never,
) as unknown as typeof BuilderSandboxWithSleep;

const CONTAINER_ROOT = "/app";
const BOOT_LOG = "/tmp/boot.log";
/** Single-quote a trusted command fragment for embedding in `sh -lc`. */
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
class InvalidFilePathError extends Error {}

/**
 * Resolve a nonempty relative POSIX path under CONTAINER_ROOT.
 */
function resolveContainerPath(path: unknown): string {
  if (typeof path !== "string" || path.length === 0) throw new InvalidFilePathError("file path is required");
  const segments = path.split("/");
  if (
    path.startsWith("/")
    || path.includes("\\")
    || path.includes("\0")
    || segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." || segment === "node_modules")
  ) {
    throw new InvalidFilePathError(`invalid file path: ${path}`);
  }
  return `${CONTAINER_ROOT}/${segments.join("/")}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Validate the full file map before creating any directories or files. */
function validateFiles(files: unknown): Record<string, string> {
  if (!isPlainRecord(files)) throw new InvalidFilePathError("files must be a plain record");
  for (const [path, contents] of Object.entries(files)) {
    resolveContainerPath(path);
    if (typeof contents !== "string") throw new InvalidFilePathError(`contents must be a string: ${path}`);
  }
  return files as Record<string, string>;
}

function validateFileWrite(body: unknown): { path: string; contents: string } {
  if (!isPlainRecord(body)) throw new InvalidFilePathError("file write must be a plain record");
  const { path, contents } = body;
  const full = resolveContainerPath(path);
  if (typeof contents !== "string") throw new InvalidFilePathError("contents must be a string");
  return { path: full, contents };
}

// Minimal structural view of the Sandbox stub — avoids deep instantiation of the
// full RPC proxy type (TS2589) while typing exactly the methods we call.
type SandboxLike = {
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<unknown>;
  writeFile(path: string, contents: string): Promise<unknown>;
  deleteFile(path: string): Promise<unknown>;
  exec(cmd: string): Promise<{ success?: boolean; stdout?: string; stderr?: string }>;
  startProcess(cmd: string, opts?: { cwd?: string; env?: Record<string, string> }): Promise<unknown>;
  exposePort(port: number, opts?: { hostname?: string }): Promise<{ url?: string; exposedAt?: string }>;
  destroy(): Promise<unknown>;
};
// Cast the function itself so TS never instantiates its deep generic return.
const getSandboxShallow = getSandbox as unknown as (ns: unknown, id: string) => SandboxLike;
/** The single live-preview sandbox namespace (required by proxyToSandbox). */
const liveSbx = (env: Env, id: string): SandboxLike => getSandboxShallow(env.Sandbox, id);
/** True when DELETE /api/session/:id has tombstoned this session (see that
 *  handler). Every session-scoped handler must check this BEFORE any sandbox
 *  RPC: the SDK auto-boots a destroyed container on any call (containerFetch
 *  restarts it if it isn't running), so a straggler file write or status ping
 *  would resurrect an empty container under a dead id and squat a pool slot.
 *  A KV read failure counts as "no tombstone" — refusing healthy sessions on
 *  a KV hiccup is worse than falling back to the sleepAfter backstop. */
const isTombstoned = async (env: Env, sessionId: string): Promise<boolean> =>
  (await env.CACHE.get(`session-tombstone:${sessionId}`).catch(() => null)) !== null;

function cors(resp: Response): Response {
  const h = new Headers(resp.headers);
  h.set("Access-Control-Allow-Origin", "*");
  // PUT is here for `/api/profile` and `/api/admin/settings`. Prod and the vite
  // dev proxy are both same-origin, so its absence never surfaced — but a dev
  // pointing VITE_API_BASE straight at :8787 fails preflight without it.
  h.set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return new Response(resp.body, { status: resp.status, headers: h });
}

const json = (data: unknown, status = 200) =>
  cors(new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }));

const nowIso = () => new Date().toISOString();

/** Write out whatever the in-memory meters have accumulated (bytes, requests,
 *  share views). Batched deliberately: one D1 write per asset served would
 *  cost more than the asset does. */
/**
 * Fold a caller-supplied framework into a known label.
 *
 * Anything that reaches `usage_daily` as a dimension has to come from a fixed
 * set, or a public endpoint becomes a way to grow the table one invented label
 * at a time. The catalog keys plus the four documentation flavours cover every
 * real value; everything else is "other".
 */
const KNOWN_DOC_FLAVOURS = new Set(["javascript", "react", "angular", "vue"]);
const knownFramework = (value: unknown): string => {
  if (typeof value !== "string") return "other";
  if (Object.prototype.hasOwnProperty.call(BUILD_CONFIG, value)) return value;
  return KNOWN_DOC_FLAVOURS.has(value) ? value : "other";
};

/** How long an ad-hoc payload stays openable (DEV-2516). Long enough to survive
 *  a "let me finish this tomorrow", short enough that nothing here is a store:
 *  a payload the author wants to keep is one Save away from being a real demo. */
const PAYLOAD_TTL_SECONDS = 24 * 60 * 60;

const flushMeters = (env: Env): Promise<void> =>
  Promise.all([flushTraffic(env), flushUsage(env), flushAnalytics(env)]).then(() => undefined);

/**
 * Budget gate for the two paths that boot a container: starting a Tier-2 live
 * session, and running a share build. Returns a response to send back, or null
 * to proceed.
 *
 * Two deliberate escape hatches. `BUDGET_ENFORCE != "1"` logs what it *would*
 * have refused and lets the request through — that is the observation week.
 * And a ledger read that throws (D1 hiccup, migration not applied yet) also
 * lets the request through: a broken meter must degrade to "no ceiling", never
 * to "nothing works".
 *
 * `isAuthenticated` is a thunk, not a boolean, because resolving an identity
 * means a round trip to the login broker. Only the `anon_blocked` tier cares
 * who the caller is, so every other tier skips that latency entirely.
 */
async function budgetGate(
  env: Env,
  opts: { isAuthenticated: () => Promise<boolean>; what: string },
): Promise<Response | null> {
  let denial: ReturnType<typeof sessionDenial> = null;
  let tier = "ok";
  let pct = 0;
  let enforced = false;
  try {
    const state = await getBudgetState(env);
    tier = state.tier;
    pct = state.pct;
    enforced = state.enforced;
    denial = sessionDenial(state, state.tier === "anon_blocked" ? await opts.isAuthenticated() : false);
  } catch (err) {
    console.warn("[budget] state unavailable, allowing:", err instanceof Error ? err.message : String(err));
    return null;
  }
  if (!denial) return null;
  const detail = `${opts.what}: tier=${tier} pct=${pct.toFixed(3)}`;
  if (!enforced) {
    console.log(`[budget] would deny ${detail} (observe-only)`);
    return null;
  }
  console.log(`[budget] denied ${detail}`);
  return json(denial.body, denial.status);
}

/**
 * At the `closed` tier, tear down a live session on its next keepalive ping.
 * Returns the 410 to send back, or null when the session may keep running.
 *
 * Reuses the existing tombstone machinery, so the client's own 410 handling
 * (stop polling, stop pinging, show the message) already covers this case.
 */
async function sessionSubrouteGuard(env: Env, sessionId: string): Promise<Response | null> {
  let state;
  try {
    state = await getBudgetState(env);
  } catch {
    return null; // A ledger read that fails must not kill running sessions.
  }
  if (!state.enforced) return null;

  // Every `/api/session/:id/*` route reaches the sandbox, and every sandbox RPC
  // boots a container if one isn't running. Gating only `POST /api/session`
  // would leave the ceiling trivially bypassable: an unauthenticated caller
  // could write a file to an invented id and get a container out of it —
  // sidestepping both the sign-in requirement at `anon_blocked` and the freeze
  // at `new_blocked`.
  //
  // So from `anon_blocked` upward a subroute is allowed only for a session we
  // actually created (it has a meter). An unknown id *is* a session creation
  // in disguise, so it gets the same answer `POST /api/session` would give an
  // anonymous caller — 401 "sign in" at `anon_blocked`, 503 at `new_blocked`.
  if (state.tier === "anon_blocked" || state.tier === "new_blocked") {
    if (await hasSessionMeter(env, sessionId)) return null;
    const denial = sessionDenial(state, false);
    if (denial) {
      console.log(`[budget] refused subroute for unknown session ${sessionId}: tier=${state.tier}`);
      return json(denial.body, denial.status);
    }
    return null;
  }

  if (state.tier !== "closed") return null;

  await meterSession(env, sessionId, { final: true });
  try {
    await env.CACHE.put(`session-tombstone:${sessionId}`, "1", { expirationTtl: 600 });
  } catch { /* the destroy below is the primary action */ }
  try {
    await liveSbx(env, sessionId).destroy();
  } catch { /* best effort */ }
  console.log(`[budget] closed live session ${sessionId}: over the monthly ceiling`);
  return json({ error: "budget_exhausted", message: budgetPausedMessage, tier: "closed" }, 410);
}

const ROOT_HTML = `<!doctype html><meta charset="utf-8"><title>Handsontable Demos API</title>
<style>body{font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:12vh auto;padding:0 20px;color:#1f2933}
a{color:#1a8f5a}code{background:#f4f6f8;padding:1px 5px;border-radius:4px}h1{font-size:20px}</style>
<h1>Handsontable Demos — API &amp; orchestration</h1>
<p>This Worker serves shared demos and Tier-2 live sessions. It has no page at the root.</p>
<ul>
<li><code>GET /d/:id</code> — a shared demo (prebuilt, static)</li>
<li><code>GET /embed/:id</code> — docs-only embeddable demo</li>
<li><code>GET /api/health</code> — health check</li>
</ul>
<p>Create and share demos in the authoring app (internal, Handsontable login).</p>`;

/** Public demo JSON with a stale-while-revalidate cache header. */
function cacheableJson(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
    },
  });
}

/** Strip internal columns from a demo row before returning it publicly. */
function publicView(row: DemoRow) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    framework: row.framework,
    tier: row.tier,
    ht_version: row.ht_version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Write a validated FilesMap into CONTAINER_ROOT, creating directories. */
async function writeFiles(sandbox: SandboxLike, files: Record<string, string>) {
  const dirs = new Set<string>();
  const resolvedFiles = Object.entries(files).map(([path, contents]) => ({
    full: resolveContainerPath(path),
    contents,
  }));
  for (const { full } of resolvedFiles) {
    const dir = full.slice(0, full.lastIndexOf("/"));
    if (dir && dir !== CONTAINER_ROOT) dirs.add(dir);
  }
  for (const dir of dirs) {
    try {
      await sandbox.mkdir(dir, { recursive: true });
    } catch {
      /* dir may exist */
    }
  }
  for (const { full, contents } of resolvedFiles) {
    await sandbox.writeFile(full, contents);
  }
}

export default Sentry.withSentry(sentryOptions, {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Meter this request against the Workers-requests sku. Counting is batched
    // in isolate memory (see budget.ts), so this is free until a flush is due.
    if (noteTraffic(0, 1)) ctx.waitUntil(flushMeters(env));

    // 1) Preview-URL traffic (and its HMR WebSocket) is proxied to the container.
    // Cast to keep TS from instantiating the SDK's deep generic over Env (TS2589).
    const proxy = proxyToSandbox as unknown as (r: Request, e: Env) => Promise<Response | null>;
    const proxied = await proxy(request, env);
    // Preview responses are the one unbounded egress path we own — every asset
    // and dev-server payload of a live session leaves through here. Count the
    // bytes on the way out (WebSocket upgrades pass through unmeasured), after the
    // monitor rewrite so its bytes are metered too.
    // Our own boot-failure page (DEV-2537) is not a dev-server document and has
    // no demo to monitor — skip the reporter injection, but still meter the bytes.
    if (proxied) {
      const body = proxied.headers.has(PREVIEW_BOOTING_HEADER) ? proxied : await injectMonitor(proxied, env, PRODUCTION_HOST);
      return countEgress(body);
    }

    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean); // ["api","session",...]

    try {
      // POST /api/session  { framework, files, sessionId? } -> { sessionId, previewUrl }
      if (request.method === "POST" && parts[0] === "api" && parts[1] === "session" && parts.length === 2) {
        const body = await request.json() as {
          framework: string;
          files: unknown;
          sessionId?: string;
          htVersion?: string;
        };
        if (!isPlainRecord(body)) return json({ error: "request body must be a plain record" }, 400);
        const dev = FRAMEWORK_DEV[body.framework];
        const cfg = BUILD_CONFIG[body.framework];
        if (!dev || !cfg) return json({ error: `Tier-2 not wired for framework: ${body.framework}` }, 400);
        const files = validateFiles(body.files);

        // Cost ceiling, before anything that can boot a container (every
        // sandbox RPC does). `POST /api/session` is public; the identity check
        // is what the `anon_blocked` tier degrades to — at >=80% of budget a
        // live session costs you a Handsontable login.
        const denied = await budgetGate(env, {
          isAuthenticated: async () => (await authenticate(request, env)) !== null,
          what: `session ${body.framework}`,
        });
        if (denied) {
          await recordUsageEvent(env, "session_denied", body.framework);
          return denied;
        }

        const sessionId = body.sessionId?.trim() || mintSessionId(body.framework);
        const sandbox = liveSbx(env, sessionId);
        // Shared teardown for the create/delete race, used on BOTH create
        // exits (success and throw): a DELETE that landed before or during
        // this create means the container built here belongs to a client
        // that is already gone.
        const closedWhileCreating = async (): Promise<Response | null> => {
          if (!(await isTombstoned(env, sessionId))) return null;
          try { await sandbox.destroy(); } catch { /* best effort */ }
          return json({ error: "session was closed while it was being created" }, 410);
        };

        // A tab closed while this create is in flight can only send one
        // best-effort DELETE (pagehide keepalive) and then it's gone — if that
        // DELETE lands mid-create, or even BEFORE this handler runs (the tiny
        // keepalive DELETE can overtake the large POST body), the container
        // built here would be orphaned until sleepAfter. The DELETE handler
        // drops a tombstone; it is re-checked when the create finishes —
        // successfully OR by throwing, since a failed step may equally have
        // left a recreated container behind. The tombstone is deliberately
        // never cleared here: wiping it up front would blind those checks to
        // a DELETE that already arrived. This requires session ids to be
        // unique per create (they are: client and server both mint a fresh
        // UUID suffix) — recreating a deleted id within the tombstone TTL
        // would be torn down by the end-of-create check.
        try {
          // Billing starts at the first sandbox RPC, so the awake-window meter
          // starts here rather than after a successful boot — a create that
          // throws half-way still ran a container.
          await startSessionMeter(env, sessionId);
          await recordUsageEvent(env, "session_started", body.framework);
          await writeFiles(sandbox, files);
          // Boot asynchronously (returns immediately; UI polls /status for live
          // progress). Default boot seeds immutable baked dependencies, then runs
          // fast frozen pnpm reconciliation. Keep submitted starters frozen; only
          // custom package or lock metadata may update the lockfile.
          //
          // The fingerprint doubles as a content-addressed bucket selector
          // (DEV-2213): each baked (framework, bucket) context carries the hash
          // of its exact package.json+lock, so a session mounting a bucket's
          // pristine starter seeds that bucket's node_modules and stays frozen.
          const dependencyFingerprint = await dependencyMetadataFingerprint({
            packageJson: files["package.json"],
            pnpmLock: files["pnpm-lock.yaml"],
          });
          const bakedContext = dev.contexts.find(
            (c) => c.sourceDependencyFingerprint === dependencyFingerprint,
          );
          const bakedKey = bakedContext?.bakedKey ?? dev.defaultBakedKey;
          const metadataDiffersFromStarter = bakedContext === undefined;
          const installDependencies = files["pnpm-lock.yaml"] !== undefined
            ? [
                `if ! pnpm install --frozen-lockfile; then`,
                metadataDiffersFromStarter
                  ? `  echo '::frozen install failed for custom metadata; retrying non-frozen::'; pnpm install --no-frozen-lockfile`
                  : `  echo '::error::frozen install failed for generated starter metadata; refusing to modify its lockfile' >&2; exit 1`,
                `fi`,
              ]
            : metadataDiffersFromStarter
              ? [`echo '::no lockfile for custom metadata; installing non-frozen::'; pnpm install --no-frozen-lockfile`]
              : [`echo '::error::generated starter is missing its lockfile; refusing non-frozen install' >&2; exit 1`];
          const script = [
            `set -e`,
            `cd ${CONTAINER_ROOT}`,
            `echo '::seeding immutable baked dependencies::'`,
            `rm -rf ./node_modules`,
            `cp -al /baked/${bakedKey}/node_modules ./node_modules`,
            `echo '::reconciling dependencies with pnpm::'`,
            ...installDependencies,
            `echo '::starting dev server::'`,
            dev.cmd,
          ].join("\n");
          // Append the boot script's own exit code as a sentinel line so /status
          // can detect a failed install/boot (e.g. pnpm can't resolve the pinned
          // Handsontable version) instead of polling "not ready yet" forever.
          // Must be a subshell `( ... )`, not a brace group `{ ... }`: the script
          // sets `-e`, and a brace group shares the outer shell, so a failure
          // inside it kills the whole `sh -lc` process before the marker echo
          // ever runs. A subshell isolates that fatal exit so the parent always
          // reaches the marker append, whether the script failed or (for the
          // normal case) the dev server is still running in the foreground.
          await sandbox.startProcess(
            `sh -lc ${shq(`( ${script} ) > ${BOOT_LOG} 2>&1; echo "__RUNNER_EXIT__:$?" >> ${BOOT_LOG}`)}`,
          );

          // Preview URL host: the wildcard domain in production (PREVIEW_HOST), or
          // the request host in local dev (localhost:8787 -> *.localhost:8787).
          const previewHost = env.PREVIEW_HOST && env.PREVIEW_HOST.length ? env.PREVIEW_HOST : url.host;
          const exposed = await sandbox.exposePort(dev.port, { hostname: previewHost });
          const previewUrl = (exposed as { url?: string; exposedAt?: string }).url
            ?? (exposed as { exposedAt?: string }).exposedAt;

          // Create/delete race check: if the client's DELETE landed while this
          // create was still running — or arrived before it even started — its
          // destroy() hit nothing durable and the work since then booted a
          // container for a client that is already gone.
          // (KV reads are immediately consistent within a colo, and the DELETE
          // comes from the same client/colo as this POST; cross-colo lag is
          // covered by the sleepAfter backstop.)
          return (await closedWhileCreating()) ?? json({ sessionId, previewUrl, port: dev.port });
        } catch (err) {
          // A create step that throws may still have left a booted container
          // behind (every sandbox RPC auto-boots one), and if the client's
          // DELETE already landed there is no client left to clean it up —
          // run the same tombstone check before surfacing the error.
          const closed = await closedWhileCreating();
          if (closed) return closed;
          throw err;
        }
      }

      // Central resurrection gate for every /api/session/:id/* subroute: a
      // straggler request racing a tab-close DELETE (file write, status or
      // keepalive ping, file delete) must not touch the sandbox — any RPC
      // auto-boots the destroyed container. Create (length 2) and the session
      // DELETE itself (length 3) stay outside the gate. New subroutes are
      // covered by default instead of each hand-copying the check.
      if (parts[0] === "api" && parts[1] === "session" && parts.length >= 4) {
        const sessionId = parts[2]!;
        if (await isTombstoned(env, sessionId)) {
          // A file delete against a torn-down session is a satisfied no-op;
          // everything else reports the session gone.
          if (request.method === "DELETE" && parts[3] === "file") {
            return cors(new Response(null, { status: 204 }));
          }
          return json({ error: "session closed" }, 410);
        }
        // The cost ceiling belongs here too, for the same reason the tombstone
        // check does: every subroute below reaches the sandbox, and every
        // sandbox RPC boots a container.
        const overBudget = await sessionSubrouteGuard(env, sessionId);
        if (overBudget) return overBudget;
      }

      // POST /api/session/:id/file  { path, contents } -> 204   (streams an edit; HMR picks it up)
      if (request.method === "POST" && parts[0] === "api" && parts[1] === "session" && parts[3] === "file") {
        const sessionId = parts[2]!;
        const body = validateFileWrite(await request.json());
        const sandbox = liveSbx(env, sessionId);
        const full = body.path;
        const dir = full.slice(0, full.lastIndexOf("/"));
        if (dir && dir !== CONTAINER_ROOT) {
          try { await sandbox.mkdir(dir, { recursive: true }); } catch { /* exists */ }
        }
        await sandbox.writeFile(full, body.contents);
        return cors(new Response(null, { status: 204 }));
      }

      // DELETE /api/session/:id/file?path= -> remove a file (file-tree delete/rename)
      if (request.method === "DELETE" && parts[0] === "api" && parts[1] === "session" && parts[3] === "file") {
        const sandbox = liveSbx(env, parts[2]!);
        const p = url.searchParams.get("path") ?? "";
        const full = resolveContainerPath(p);
        try { await sandbox.deleteFile(full); } catch { /* best effort */ }
        return cors(new Response(null, { status: 204 }));
      }

      // GET /api/session/:id/status?port=NNNN -> { ready, log } (boot progress)
      if (request.method === "GET" && parts[0] === "api" && parts[1] === "session" && parts[3] === "status") {
        const sessionId = parts[2]!;
        // This route doubles as the client keepalive (a ping every 60s while
        // the tab is visible), which makes it the meter's tick. The budget
        // guard that tears sessions down at `closed` already ran above, for
        // this and every other subroute.
        ctx.waitUntil(meterSession(env, sessionId));

        const sandbox = liveSbx(env, sessionId);
        const port = Number(url.searchParams.get("port")) || 0;
        let ready = false;
        if (port) {
          const probe = `node -e "require('net').connect(${port},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"`;
          try { ready = (await sandbox.exec(probe)).success === true; } catch { ready = false; }
        }
        let log = "";
        try {
          const r = await sandbox.exec(`sh -lc "tail -c 2500 ${BOOT_LOG} 2>/dev/null || true"`);
          log = r.stdout ?? "";
        } catch { /* no log yet */ }
        // The boot script appends "__RUNNER_EXIT__:<code>" once it exits; a
        // nonzero code means install/boot failed and it'll never become ready.
        const exitMatch = /__RUNNER_EXIT__:(\d+)\s*$/.exec(log);
        const failed = exitMatch !== null && exitMatch[1] !== "0";
        if (exitMatch) log = log.slice(0, exitMatch.index).trimEnd();
        return json({ ready, log, failed });
      }

      // DELETE /api/session/:id -> destroy container
      if (request.method === "DELETE" && parts[0] === "api" && parts[1] === "session" && parts.length === 3) {
        const sessionId = parts[2]!;
        // Tombstone BEFORE destroying: if a create for this id is still in
        // flight (tab closed mid-POST), destroy() alone hits a half-built
        // session and the create keeps going — the POST handler re-checks
        // this marker when it finishes and tears the orphan down. TTL keeps
        // stale markers from accumulating. Best-effort: a KV hiccup must not
        // block the primary destroy below (without the marker the mid-create
        // race falls back to the sleepAfter backstop).
        try {
          await env.CACHE.put(`session-tombstone:${sessionId}`, "1", { expirationTtl: 600 });
        } catch { /* tombstone is defense-in-depth only */ }
        // Close the awake window before the container goes away: this is the
        // one teardown path that knows the session is over for good.
        await meterSession(env, sessionId, { final: true });
        const sandbox = liveSbx(env, sessionId);
        await sandbox.destroy();
        return cors(new Response(null, { status: 204 }));
      }

      // ---- Sharing (D5) ----------------------------------------------------

      // POST /api/mcp/demos  (service auth) — headless create for the Handsontable
      // MCP (DEV-2501, ADR-0033). Same build path as the editor's Save; the only
      // differences are how the caller is authenticated and that an agent-supplied
      // file map has to be re-validated here (mcp-create.ts).
      if (request.method === "POST" && parts[0] === "api" && parts[1] === "mcp" && parts[2] === "demos" && parts.length === 3) {
        const id = await authenticateService(request, env);
        if (!id) return json({ error: "unauthorized" }, 401);
        const body = (await request.json()) as {
          framework?: string;
          files?: unknown;
          title?: string;
          description?: string;
          htVersion?: string;
        };
        const cfg = body.framework ? BUILD_CONFIG[body.framework] : undefined;
        if (!body.framework || !cfg) {
          return json({ error: `unknown framework: ${body.framework ?? "(missing)"}` }, 400);
        }
        const title = validateTitle(body.title);
        if (isValidationError(title)) return json(title, 400);
        // A demo created from a prompt is read by people who were not in that
        // conversation, so the description is required here even though the editor
        // treats it as optional.
        if (!body.description || !body.description.trim()) {
          return json({ error: "description is required for MCP-created demos" }, 400);
        }
        const description = validateDescription(body.description);
        if (isValidationError(description)) return json(description, 400);
        const files = validateMcpFiles(body.files);
        if (isMcpValidationError(files)) return json(files, 400);

        // A build is a container boot, so it answers to the same ceiling as any other.
        const buildDenied = await budgetGate(env, { isAuthenticated: async () => true, what: `mcp build ${body.framework}` });
        if (buildDenied) return buildDenied;
        await recordUsageEvent(env, "build", body.framework);

        const created = await createDemo(env, {
          entry: { framework: body.framework, ...cfg },
          files,
          htVersion: body.htVersion ?? "latest",
          title,
          description: description ?? null,
          createdBy: id.email,
          forkedFrom: `mcp:${body.framework}`,
          now: nowIso(),
        });
        await recordUsageEvent(env, "share_created", body.framework);
        return json(
          {
            id: created.id,
            url: `/d/${created.id}`,
            embedUrl: `/embed/${created.id}`,
            editUrl: `/edit/${created.id}`,
            shareUrl: `/share/${created.id}`,
            createdBy: id.email,
          },
          201,
        );
      }

      // POST /api/demos  (auth) — fork -> build -> R2 -> short id -> /d/:id
      if (request.method === "POST" && parts[0] === "api" && parts[1] === "demos" && parts.length === 2) {
        const id = await authenticate(request, env);
        if (!id) return json({ error: "unauthorized" }, 401);
        const body = (await request.json()) as {
          framework: string;
          files: Record<string, string>;
          title?: string;
          description?: string;
          htVersion?: string;
          forkedFrom?: string;
        };
        const cfg = BUILD_CONFIG[body.framework];
        if (!cfg) return json({ error: `unknown framework: ${body.framework}` }, 400);
        const title = validateTitle(body.title);
        if (isValidationError(title)) return json(title, 400);
        // Markdown, kept verbatim (DEV-2507) — only the length is our business.
        const description = validateDescription(body.description);
        if (isValidationError(description)) return json(description, 400);
        if (!body.files || !body.files["/package.json"]) return json({ error: "files must include /package.json" }, 400);

        // A build is a container boot too, so it answers to the same ceiling.
        // The caller is authenticated by definition here, so only the
        // new_blocked/closed tiers can refuse it.
        const buildDenied = await budgetGate(env, { isAuthenticated: async () => true, what: `build ${body.framework}` });
        if (buildDenied) return buildDenied;
        await recordUsageEvent(env, "build", body.framework);

        const created = await createDemo(env, {
          entry: { framework: body.framework, ...cfg },
          files: body.files,
          htVersion: body.htVersion ?? "latest",
          title,
          description: description ?? null,
          createdBy: id.email,
          forkedFrom: body.forkedFrom ?? `catalog:${body.framework}`,
          now: nowIso(),
        });
        await recordUsageEvent(env, "share_created", body.framework);
        return json({ id: created.id, url: `/d/${created.id}`, embedUrl: `/embed/${created.id}` }, 201);
      }

      // PATCH /api/mcp/demos/:id  (service auth, owner) — fix a demo in place from the
      // MCP (DEV-2501, ADR-0033). Mirrors the editor's Save: same updateDemo(), same
      // budget gate. The ownership check is the whole point — the shared service secret
      // says a trusted service is calling, it does not say whose demos it may rewrite.
      if (request.method === "PATCH" && parts[0] === "api" && parts[1] === "mcp" && parts[2] === "demos" && parts.length === 4) {
        const id = await authenticateService(request, env);
        if (!id) return json({ error: "unauthorized" }, 401);
        const demoId = parts[3]!;
        const row = await getDemo(env, demoId);
        if (!row) return json({ error: "not found" }, 404);
        // A revoked demo is gone as far as every reader is concerned; rebuilding one
        // would quietly resurrect a link someone deliberately killed.
        if (row.revoked) return json({ error: "gone" }, 410);
        if (!sameOwner(row.created_by, id.email)) {
          return json({ error: "forbidden", detail: "this demo belongs to someone else" }, 403);
        }
        // Containment, not authentication (security review of PR #177). `X-Demo-Author` is
        // asserted under the same shared secret that grants access to this route, so the
        // ownership check above catches a wrong id — it cannot withstand misuse of the secret
        // itself. Restricting the path to demos this service created means a leaked secret can
        // never rewrite work somebody built in the browser; the blast radius stays inside what
        // the MCP published in the first place.
        if (!row.forked_from?.startsWith("mcp:")) {
          return json(
            {
              error: "forbidden",
              detail:
                "this demo was not created through the MCP; edit it at /edit/<id> in the browser",
            },
            403,
          );
        }
        const patch = (await request.json()) as {
          title?: string;
          description?: string | null;
          files?: unknown;
          htVersion?: string;
        };
        const patchTitle = patch.title?.trim() ? validateTitle(patch.title) : undefined;
        if (isValidationError(patchTitle)) return json(patchTitle, 400);
        const patchDescription = validateDescription(patch.description);
        if (isValidationError(patchDescription)) return json(patchDescription, 400);

        if (patch.files !== undefined) {
          const files = validateMcpFiles(patch.files);
          if (isMcpValidationError(files)) return json(files, 400);
          const cfg = BUILD_CONFIG[row.framework];
          if (!cfg) return json({ error: `unknown framework: ${row.framework}` }, 400);
          const rebuildDenied = await budgetGate(env, { isAuthenticated: async () => true, what: `mcp rebuild ${row.framework}` });
          if (rebuildDenied) return rebuildDenied;
          await recordUsageEvent(env, "build", row.framework);
          await updateDemo(env, {
            id: demoId,
            entry: { framework: row.framework, ...cfg },
            files,
            htVersion: patch.htVersion ?? row.ht_version,
            // Absent means "leave the column alone" — never fall back to the row read
            // at the start of this handler, or a rename committed during the rebuild
            // would be reverted (the DEV-2495 lesson from the broker path above).
            ...(patchTitle ? { title: patchTitle } : {}),
            ...(patchDescription !== undefined ? { description: patchDescription } : {}),
            now: nowIso(),
          });
          return json({ ok: true, id: demoId, url: `/d/${demoId}`, editUrl: `/edit/${demoId}`, rebuilt: true });
        }

        if (patchTitle === undefined && patchDescription === undefined) {
          return json({ error: "nothing to update: pass files, title or description" }, 400);
        }
        await env.DB.prepare("UPDATE demos SET title=?, description=?, updated_at=? WHERE id=?")
          .bind(
            patchTitle ?? row.title,
            patchDescription !== undefined ? patchDescription : row.description,
            nowIso(),
            demoId,
          )
          .run();
        await invalidateDemo(env, demoId);
        return json({ ok: true, id: demoId, url: `/d/${demoId}`, editUrl: `/edit/${demoId}`, rebuilt: false });
      }

      // GET /api/demos  (auth) — the caller's demos, or `?scope=all` for the
      // team's (DEV-2506). Visibility only: editing still answers to
      // `created_by` in the PATCH/DELETE handlers below.
      if (request.method === "GET" && parts[0] === "api" && parts[1] === "demos" && parts.length === 2) {
        const id = await authenticate(request, env);
        if (!id) return json({ error: "unauthorized" }, 401);
        const scope = parseDemoScope(url.searchParams.get("scope"));
        const query = demoListQuery(scope, id.email);
        const rows = await env.DB.prepare(query.sql).bind(...query.binds).all();
        return json({ demos: rows.results, scope });
      }

      // GET /api/demos/:id/access  (auth) — may the caller edit this demo?
      //
      // Its own endpoint because `GET /api/demos/:id` is public *and* edge-cached
      // (`cacheableJson`): adding an auth-dependent field there would hand one
      // caller's answer to the next. One row, no cache, no body to speak of.
      if (request.method === "GET" && parts[0] === "api" && parts[1] === "demos" && parts[3] === "access" && parts.length === 4) {
        const id = await authenticate(request, env);
        if (!id) return json({ error: "unauthorized" }, 401);
        const row = await getDemo(env, parts[2]!);
        if (!row) return json({ error: "not found" }, 404);
        return json({ owned: sameOwner(row.created_by, id.email), revoked: !!row.revoked });
      }

      // GET /api/demos/:id/source  (public) — source snapshot for the read-only
      // share playground and for forking. A demo link is unlisted-but-public, so
      // its code is viewable by anyone with the link (revoked demos return 404).
      if (request.method === "GET" && parts[0] === "api" && parts[1] === "demos" && parts[3] === "source") {
        const src = await getDemoSource(env, parts[2]!);
        if (!src) return json({ error: "not found" }, 404);
        return json(src);
      }

      // GET /api/demos/:id  (public) — metadata; 410 if revoked
      if (request.method === "GET" && parts[0] === "api" && parts[1] === "demos" && parts.length === 3) {
        const row = await getDemo(env, parts[2]!);
        if (!row) return json({ error: "not found" }, 404);
        if (row.revoked) return json({ error: "revoked" }, 410);
        return cors(cacheableJson(publicView(row)));
      }

      // PATCH /api/demos/:id  (auth, owner) — update title/description/visibility
      if (request.method === "PATCH" && parts[0] === "api" && parts[1] === "demos" && parts.length === 3) {
        const id = await authenticate(request, env);
        if (!id) return json({ error: "unauthorized" }, 401);
        const demoId = parts[2]!;
        const row = await getDemo(env, demoId);
        if (!row) return json({ error: "not found" }, 404);
        if (!sameOwner(row.created_by, id.email)) return json({ error: "forbidden" }, 403);
        const patch = (await request.json()) as {
          title?: string; description?: string | null; visibility?: string;
          files?: Record<string, string>; htVersion?: string;
        };
        // Validated once for both branches below. `undefined` still means "leave
        // it alone" and `null` "clear it" — the distinction the description edit
        // depends on (DEV-2507).
        // A blank title is dropped, not refused: master's rebuild branch treats
        // "supplied but empty" as "leave the column alone" (DEV-2495), and a 400
        // here would break that without protecting anything — the length cap and
        // the type check still apply to a real one.
        const patchTitle = patch.title?.trim() ? validateTitle(patch.title) : undefined;
        if (isValidationError(patchTitle)) return json(patchTitle, 400);
        const patchDescription = validateDescription(patch.description);
        if (isValidationError(patchDescription)) return json(patchDescription, 400);
        // Code change -> rebuild the snapshot in place (edit-page Save).
        if (patch.files) {
          if (!patch.files["/package.json"]) return json({ error: "files must include /package.json" }, 400);
          const cfg = BUILD_CONFIG[row.framework];
          if (!cfg) return json({ error: `unknown framework: ${row.framework}` }, 400);
          // Same ceiling as a first build — a re-save boots a builder container.
          const rebuildDenied = await budgetGate(env, { isAuthenticated: async () => true, what: `rebuild ${row.framework}` });
          if (rebuildDenied) return rebuildDenied;
          await recordUsageEvent(env, "build", row.framework);
          await updateDemo(env, {
            id: demoId,
            entry: { framework: row.framework, ...cfg },
            files: patch.files,
            htVersion: patch.htVersion ?? row.ht_version,
            // Forwarded only when the request carried them, and `row` is never used
            // as the fallback: a rebuild takes long enough for the Edit info dialog
            // to commit a rename in the middle of one, and re-writing the row this
            // handler read at the start would revert it (DEV-2495). Absent means the
            // UPDATE leaves the column alone; `null` on description still clears it,
            // which is the distinction the `!== undefined` check exists for.
            //
            // The values are the validated ones (DEV-2507): length-capped, CRLF
            // normalized, and — for the description — markdown kept verbatim.
            ...(patchTitle ? { title: patchTitle } : {}),
            ...(patchDescription !== undefined ? { description: patchDescription } : {}),
            now: nowIso(),
          });
          return json({ ok: true });
        }
        // Metadata-only update (title / description / visibility).
        await env.DB.prepare("UPDATE demos SET title=?, description=?, visibility=?, updated_at=? WHERE id=?")
          .bind(
            patchTitle ?? row.title,
            // See the rebuild branch above: `undefined` leaves it, `null` clears it.
            patchDescription !== undefined ? patchDescription : row.description,
            patch.visibility ?? row.visibility,
            nowIso(),
            demoId,
          )
          .run();
        await invalidateDemo(env, demoId);
        return json({ ok: true });
      }

      // DELETE /api/demos/:id  (auth, owner) — revoke (410 thereafter)
      if (request.method === "DELETE" && parts[0] === "api" && parts[1] === "demos" && parts.length === 3) {
        const id = await authenticate(request, env);
        if (!id) return json({ error: "unauthorized" }, 401);
        const demoId = parts[2]!;
        const row = await getDemo(env, demoId);
        if (!row) return json({ error: "not found" }, 404);
        if (!sameOwner(row.created_by, id.email)) return json({ error: "forbidden" }, 403);
        await env.DB.prepare("UPDATE demos SET revoked=1, revoked_at=?, updated_at=? WHERE id=?")
          .bind(nowIso(), nowIso(), demoId).run();
        await invalidateDemo(env, demoId);
        return cors(new Response(null, { status: 204 }));
      }

      // GET /d/:id[/*]  and  /embed/:id[/*]  — public static viewer / docs embed
      if (request.method === "GET" && (parts[0] === "d" || parts[0] === "embed") && parts.length >= 2) {
        const embed = parts[0] === "embed";
        const demoId = parts[1]!;
        const sub = parts.slice(2).join("/");
        // Redirect /d/:id -> /d/:id/ so relative asset paths (./assets/...) resolve
        // under the demo prefix rather than the site root.
        if (sub === "" && !url.pathname.endsWith("/")) {
          return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 308);
        }
        const asset = await serveDemoAsset(env, demoId, sub, { embed });
        // Count the page load only, and only when it resolved to a real demo:
        // counting unresolved ids would let a crawler write arbitrary rows.
        //
        // Off the response path deliberately. This is the static degradation
        // path that has to stay cheap at every budget tier, and the visitor
        // hash costs a KV read plus a SHA-256 — none of which the reader
        // should wait for.
        if (sub === "" && asset.status === 200) {
          const countDue = noteView(embed ? "embed_view" : "share_view", demoId);
          ctx.waitUntil(
            notePageView(env, request, { page: normalisePage(url.pathname), demoId })
              .then((analyticsDue) => (countDue || analyticsDue ? flushMeters(env) : undefined)),
          );
        }
        return asset;
      }

      // GET /api/versions/exists?v=<version> (public) — does npm have this exact
      // version published? Used to detect an unresolvable deep-linked/pinned
      // next-dist-tag build (e.g. a local docs build's own commit stamp that was
      // never published) so the runner can fall back to the current next build
      // instead of failing the container's pnpm install.
      if (request.method === "GET" && parts[0] === "api" && parts[1] === "versions" && parts[2] === "exists") {
        const v = url.searchParams.get("v")?.trim() ?? "";
        if (!v) return json({ error: "v is required" }, 400);
        const cacheKey = `version-exists:${v}`;
        const cached = await env.CACHE.get(cacheKey, "json");
        if (cached) return cors(cacheableJson(cached));
        try {
          const r = await fetch(`https://registry.npmjs.org/handsontable/${encodeURIComponent(v)}`);
          const payload = { exists: r.status === 200 };
          // A miss might just be "not published yet" for a version some other
          // request is about to publish; cache negatives briefly, positives longer.
          await env.CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: payload.exists ? 3600 : 300 });
          return cors(cacheableJson(payload));
        } catch (e) {
          // The registry being unreachable silently re-pins docs examples onto a
          // version that may not exist — actionable, so report it.
          Sentry.captureException(e, { tags: { upstream: "npm-registry", probe: "version-exists" } });
          return json({ error: e instanceof Error ? e.message : String(e) }, 502);
        }
      }

      // POST /api/import  (auth) — pull a workspace out of a JSFiddle or
      // StackBlitz URL (DEV-2504). Auth'd because it makes the Worker fetch a
      // user-supplied URL; `resolveSource` is the host gate.
      if (request.method === "POST" && parts[0] === "api" && parts[1] === "import" && parts.length === 2) {
        const id = await authenticate(request, env);
        if (!id) return json({ error: "unauthorized" }, 401);
        const body = (await request.json().catch(() => ({}))) as { url?: string };
        if (!body.url?.trim()) return json({ error: "url is required" }, 400);
        try {
          const imported = await importFromUrl(body.url, {
            knownFrameworks: new Set(Object.keys(BUILD_CONFIG)),
          });
          await recordUsageEvent(env, "import", imported.provider);
          return json(imported);
        } catch (error) {
          // An ImportError is the user's problem to fix (wrong host, private
          // project) or a provider format change; either way its message is
          // written to be shown. Anything else is ours, and gets reported.
          if (error instanceof ImportError) return json({ error: error.message }, error.status);
          Sentry.captureException(error, { tags: { upstream: "import-url" } });
          return json({ error: "import failed" }, 500);
        }
      }

      // POST /api/payload (public, rate-limited) — hand the runner an ad-hoc
      // example that is in no catalog: the Theme Builder's generated project
      // (DEV-2516). Returns an id the playground boots from as `?payload=<id>`.
      //
      // Public on purpose, unlike /api/import above. That route is authenticated
      // because it makes the Worker fetch a user-supplied URL; this one fetches
      // nothing, and Theme Builder users are anonymous — an authenticate() line
      // here would 401 every real caller. The gate is the rate limit plus the
      // ceilings in validatePayloadFiles.
      if (request.method === "POST" && parts[0] === "api" && parts[1] === "payload" && parts.length === 2) {
        // Cheap refusal first, so an oversized body is never buffered. JSON
        // escaping inflates the payload, so this ceiling is deliberately looser
        // than MAX_PAYLOAD_CHARS — the real check is on the parsed files, since
        // the header can be absent or a lie.
        const declared = Number(request.headers.get("Content-Length"));
        if (Number.isFinite(declared) && declared > MAX_PAYLOAD_CHARS * 4) {
          return json({ error: `That project is larger than ${MAX_PAYLOAD_CHARS / 1024} KB.` }, 413);
        }

        const ip = request.headers.get("cf-connecting-ip") ?? "";
        const limit = await checkChatRateLimit(env, ip, "payload");
        if (!limit.ok) {
          return cors(new Response(
            JSON.stringify({ error: "rate_limited", message: "Too many demos at once — give it a minute." }),
            { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(limit.retryAfter) } },
          ));
        }

        // A body of literal `null` parses fine, so the catch never fires and the
        // reads below have to tolerate it — otherwise probing this public route
        // with `null` is a TypeError, which the handler downstream would report
        // to Sentry as our own 500 instead of answering 400.
        const body = (await request.json().catch(() => null)) as {
          files?: unknown;
          title?: unknown;
          framework?: unknown;
        } | null;
        try {
          const { files, framework } = validatePayloadFiles(body?.files, {
            knownFrameworks: new Set(Object.keys(BUILD_CONFIG)),
            framework: typeof body?.framework === "string" ? body.framework : undefined,
          });
          // The title is cosmetic here — a demo is not being saved — so it is
          // clamped rather than validated: a long one must not 400 a project
          // that is otherwise fine.
          const title = (typeof body?.title === "string" ? body.title.trim() : "").slice(0, MAX_TITLE)
            || "Untitled example";

          const id = shortId();
          await env.CACHE.put(
            `payload:${id}`,
            JSON.stringify({ files, framework, title }),
            { expirationTtl: PAYLOAD_TTL_SECONDS },
          );
          ctx.waitUntil(recordUsageEvent(env, "payload", framework));
          return json({ id, framework, title }, 201);
        } catch (error) {
          // Every refusal in validatePayloadFiles is written to be shown; only a
          // KV failure gets here as something else, and that one is ours.
          if (error instanceof ImportError) return json({ error: error.message }, error.status);
          Sentry.captureException(error, { tags: { route: "payload" } });
          return json({ error: "could not store that project" }, 500);
        }
      }

      // GET /api/payload/:id (public) — what the playground boots from.
      //
      // 404, never 410, on a miss: KV cannot tell an expired key from one that
      // never existed (`get` returns null either way), and distinguishing them
      // would mean a D1 row or a tombstone for a record that is deliberately
      // throwaway. Every 410 elsewhere in this Worker is a stored flag.
      if (request.method === "GET" && parts[0] === "api" && parts[1] === "payload" && parts.length === 3) {
        // Shape-check before the lookup: a KV key is capped at 512 bytes, so an
        // overlong segment makes `get` throw, and a malformed request would then
        // be reported to Sentry as our 500. Ids are what `shortId` mints.
        const payloadId = parts[2]!;
        if (!/^[a-z0-9]{1,32}$/i.test(payloadId)) return json({ error: "not found" }, 404);
        const record = await env.CACHE.get(`payload:${payloadId}`, "json");
        if (!record) return json({ error: "not found" }, 404);
        // Immutable under an unguessable id, so the edge may hold it.
        return cors(cacheableJson(record));
      }

      // GET /api/versions (public) — real published Handsontable versions.
      if (request.method === "GET" && parts[0] === "api" && parts[1] === "versions" && parts.length === 2) {
        const cached = await env.CACHE.get("versions", "json");
        if (cached) return cors(cacheableJson(cached));
        try {
          const r = await fetch("https://registry.npmjs.org/handsontable");
          const j = (await r.json()) as {
            "dist-tags"?: Record<string, string>;
            versions?: Record<string, unknown>;
            time?: Record<string, string>;
          };
          const latest = j["dist-tags"]?.latest ?? null;
          // Newest -next build by publish date — the `next` dist-tag went
          // stale (2026-02-19) while nightlies kept publishing, and serving
          // it here re-pinned docs examples onto a five-month-old core. The
          // tag is only a fallback for a registry document without `time`.
          const next = pickLatestNextVersion(j.time) ?? j["dist-tags"]?.next ?? null;
          const cmp = (a: string, b: string) => {
            const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
            for (let i = 0; i < 3; i++) { const d = (pb[i] ?? 0) - (pa[i] ?? 0); if (d) return d; }
            return 0;
          };
          const versions = Object.keys(j.versions ?? {})
            .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
            .filter((v) => { const m = Number(v.split(".")[0]); return m >= DEFAULT_MIN_MAJOR && m <= DEFAULT_MAX_MAJOR; })
            .sort(cmp)
            .slice(0, 15);
          const payload = { latest, next, versions };
          await env.CACHE.put("versions", JSON.stringify(payload), { expirationTtl: 3600 });
          return cors(cacheableJson(payload));
        } catch (e) {
          // Version picker falls back to a stale list when this fails.
          Sentry.captureException(e, { tags: { upstream: "npm-registry", probe: "versions" } });
          return json({ error: e instanceof Error ? e.message : String(e) }, 502);
        }
      }

      // POST /api/chat (public, rate-limited) — "talk with this example".
      // The browser sends the question, the example's files, and the doc
      // chunks it retrieved from the docs-assistant; this Worker adds Algolia
      // page hits and asks the model, holding the LiteLLM key server-side.
      // See src/chat.ts for why retrieval is split that way.
      if (request.method === "POST" && parts[0] === "api" && parts[1] === "chat" && parts.length === 2) {
        const ip = request.headers.get("cf-connecting-ip") ?? "";
        const limit = await checkChatRateLimit(env, ip);
        if (!limit.ok) {
          ctx.waitUntil(recordUsageEvent(env, "chat_denied", "rate_limit"));
          return cors(new Response(
            JSON.stringify({ error: "rate_limited", message: "Too many questions — give it a minute." }),
            { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(limit.retryAfter) } },
          ));
        }

        // Answers cost money, so they answer to the same ceiling as containers:
        // sign-in required at `anon_blocked`, nothing new at `new_blocked`.
        const chatDenied = await budgetGate(env, {
          isAuthenticated: async () => (await authenticate(request, env)) !== null,
          what: "chat",
        });
        if (chatDenied) {
          ctx.waitUntil(recordUsageEvent(env, "chat_denied", "budget"));
          return chatDenied;
        }

        const parsed = validateChatRequest(await request.json().catch(() => null));
        if (!parsed.ok) return json({ error: "invalid_request", message: parsed.error }, 400);

        const question = [...parsed.value.messages].reverse().find((m) => m.role === "user")?.content ?? "";
        const pages = await searchDocPages(env, question, parsed.value.framework);
        try {
          const answer = await requestAnswer(env, parsed.value, pages);
          ctx.waitUntil(Promise.all([
            recordLlmUsage(env, answer.usd),
            recordUsageEvent(env, "chat_message", knownFramework(parsed.value.framework)),
            answer.edits.length
              ? recordUsageEvent(env, "chat_edit", knownFramework(parsed.value.framework))
              : Promise.resolve(),
          ]).then(() => undefined));
          return json({
            message: answer.message,
            edits: answer.edits,
            references: answer.references,
            pages,
          });
        } catch (err) {
          if (err instanceof ChatUnavailableError) {
            ctx.waitUntil(recordUsageEvent(env, "chat_error", knownFramework(parsed.value.framework)));
            // Configuration and upstream faults are already logged in chat.ts;
            // the caller gets a sentence, not a stack trace.
            return json({ error: "chat_unavailable", message: err.message }, 503);
          }
          throw err;
        }
      }

      // POST /api/theme  { prompt, current } -> a theme (public, rate-limited)
      // "Describe a style" in the theme panel. Same guards as /api/chat — it
      // is the same gateway and the same money — but its own tool and its own
      // whitelist, so a styling request can never return file edits.
      if (request.method === "POST" && parts[0] === "api" && parts[1] === "theme" && parts.length === 2) {
        const limit = await checkChatRateLimit(env, request.headers.get("cf-connecting-ip") ?? "");
        if (!limit.ok) {
          ctx.waitUntil(recordUsageEvent(env, "chat_denied", "rate_limit"));
          return cors(new Response(
            JSON.stringify({ error: "rate_limited", message: "Too many requests — give it a minute." }),
            { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(limit.retryAfter) } },
          ));
        }
        const themeDenied = await budgetGate(env, {
          isAuthenticated: async () => (await authenticate(request, env)) !== null,
          what: "theme",
        });
        if (themeDenied) {
          ctx.waitUntil(recordUsageEvent(env, "chat_denied", "budget"));
          return themeDenied;
        }

        const body = await request.json().catch(() => null) as { prompt?: unknown; current?: unknown } | null;
        const parsed = validateStylePrompt(body);
        if (!parsed.ok) return json({ error: "invalid_request", message: parsed.error }, 400);

        try {
          const { suggestion, usd } = await requestTheme(env, parsed.prompt, body?.current ?? {});
          ctx.waitUntil(Promise.all([
            recordLlmUsage(env, usd),
            recordUsageEvent(env, "theme_prompt", ""),
          ]).then(() => undefined));
          return json(suggestion);
        } catch (err) {
          if (err instanceof ChatUnavailableError) {
            ctx.waitUntil(recordUsageEvent(env, "chat_error", "theme"));
            return json({ error: "chat_unavailable", message: err.message }, 503);
          }
          throw err;
        }
      }

      // POST /api/chat/event  { event, framework } -> 204 (public)
      // Whether a proposed edit was actually applied is only knowable in the
      // browser, and it is the number that says whether the assistant is
      // useful rather than merely used. Aggregated like every other counter —
      // no per-request rows, nothing identifying.
      if (request.method === "POST" && parts[0] === "api" && parts[1] === "chat" && parts[2] === "event") {
        const body = await request.json().catch(() => null) as { event?: unknown; framework?: unknown } | null;
        const event = body?.event;
        if (event !== "edit_applied" && event !== "edit_undone") {
          return json({ error: "unknown event" }, 400);
        }
        // Its own bucket, deliberately: sharing the chat counters would make
        // Apply/Undo spend the user's question quota, and would let anyone
        // exhaust an IP's paid budget through this free route.
        const eventLimit = await checkChatRateLimit(env, request.headers.get("cf-connecting-ip") ?? "", "event");
        if (!eventLimit.ok) return cors(new Response(null, { status: 429 }));
        ctx.waitUntil(recordUsageEvent(
          env,
          event === "edit_applied" ? "chat_edit_applied" : "chat_edit_undone",
          knownFramework(body?.framework),
        ));
        return cors(new Response(null, { status: 204 }));
      }

      // POST /api/beacon  { path } -> 204 (public, no body echoed)
      // The authoring app is a separate Worker serving static assets, so its
      // page views never reach this Worker on their own. One beacon per view
      // closes that gap. Nothing identifying is accepted from the client: the
      // path is normalised to a fixed label set here, and everything else
      // (country, device, referrer, the anonymous visitor hash) is derived
      // from the request itself. See analytics.ts for the privacy rules.
      if (request.method === "POST" && parts[0] === "api" && parts[1] === "beacon" && parts.length === 2) {
        const body = await request.json().catch(() => null) as { path?: unknown } | null;
        const path = typeof body?.path === "string" ? body.path : "/";
        ctx.waitUntil(
          notePageView(env, request, { page: normalisePage(path) })
            .then((due) => (due ? flushMeters(env) : undefined)),
        );
        return cors(new Response(null, { status: 204 }));
      }

      // ---- profile (DEV-2166) ------------------------------------------------
      //
      // The caller's own row and nothing else: none of these routes takes an
      // email, so there is no "other user's profile" for them to reach. The one
      // public route serves an image by opaque key.

      // GET /api/profile (auth) — the caller's profile, or the derived defaults
      // if they have never saved one.
      if (request.method === "GET" && parts[0] === "api" && parts[1] === "profile" && parts.length === 2) {
        const identity = await authenticate(request, env);
        if (!identity) return json({ error: "unauthorized" }, 401);
        return json(await readProfile(env, identity));
      }

      // PUT /api/profile (auth) — name + description. The avatar is not touched
      // here; it has its own endpoints and its own immediate save.
      if (request.method === "PUT" && parts[0] === "api" && parts[1] === "profile" && parts.length === 2) {
        const identity = await authenticate(request, env);
        if (!identity) return json({ error: "unauthorized" }, 401);
        const parsed = normalizeProfileInput(await request.json().catch(() => null));
        if (!parsed.ok) return json({ error: parsed.error }, 400);
        return json(await saveProfile(env, identity, parsed.value, nowIso()));
      }

      // POST /api/profile/avatar (auth) — raw image body.
      if (request.method === "POST" && parts[0] === "api" && parts[1] === "profile"
        && parts[2] === "avatar" && parts.length === 3) {
        const identity = await authenticate(request, env);
        if (!identity) return json({ error: "unauthorized" }, 401);

        // Cheap refusal first, so a multi-megabyte body is never buffered. The
        // header is advisory — absent, or a lie — hence the real check below.
        const declared = Number(request.headers.get("Content-Length"));
        if (Number.isFinite(declared) && declared > MAX_AVATAR_BYTES) {
          return json({ error: `image is larger than ${Math.floor(MAX_AVATAR_BYTES / 1024)} KB` }, 413);
        }

        const bytes = await request.arrayBuffer();
        const size = checkAvatarSize(bytes.byteLength);
        if (!size.ok) return json({ error: size.error }, size.error === "empty upload" ? 400 : 413);

        // Magic bytes, not the request's Content-Type: whatever this returns is
        // what we store and later echo back to a browser.
        const contentType = sniffImage(new Uint8Array(bytes.slice(0, 16)));
        if (!contentType) return json({ error: "avatar must be a PNG, JPEG or WebP image" }, 415);

        return json(await putAvatar(env, identity, bytes, contentType, nowIso()));
      }

      // DELETE /api/profile/avatar (auth) — back to the monogram.
      if (request.method === "DELETE" && parts[0] === "api" && parts[1] === "profile"
        && parts[2] === "avatar" && parts.length === 3) {
        const identity = await authenticate(request, env);
        if (!identity) return json({ error: "unauthorized" }, 401);
        return json(await removeAvatar(env, identity, nowIso()));
      }

      // GET /api/profile/avatar/:key (public) — the image itself. Public because
      // it is an <img src> on pages that carry no token; safe because the key is
      // an opaque uuid, so the URL space cannot be walked back to an email.
      if (request.method === "GET" && parts[0] === "api" && parts[1] === "profile"
        && parts[2] === "avatar" && parts.length === 4) {
        return cors(await serveAvatar(env, parts[3]!));
      }

      // GET /api/budget (public) — the degradation tier the client should
      // reflect. Dollar figures only for a signed-in Handsontable identity;
      // anonymous callers get the tier and the user-facing notice, which is
      // all the UI needs to explain why live editing is restricted.
      if (request.method === "GET" && parts[0] === "api" && parts[1] === "budget" && parts.length === 2) {
        const identity = await authenticate(request, env);
        try {
          const state = await getBudgetState(env);
          return json(publicBudget(state, { detailed: identity !== null }));
        } catch {
          // Never let a ledger read failure show the UI a scary banner.
          return json({ tier: "ok", pct: 0, enforced: false, notice: null });
        }
      }

      // GET /api/admin/settings (auth) — the effective guardrail settings,
      // and whether they come from the panel or from wrangler.jsonc.
      if (request.method === "GET" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "settings") {
        const identity = await authenticate(request, env);
        if (!identity) return json({ error: "unauthorized" }, 401);
        return json(await loadSettings(env));
      }

      // PUT /api/admin/settings (auth) — change the ceiling, the tiers, the
      // alert thresholds or the enforcement switch, without a deploy.
      // DELETE reverts to the wrangler.jsonc defaults.
      if ((request.method === "PUT" || request.method === "DELETE")
        && parts[0] === "api" && parts[1] === "admin" && parts[2] === "settings") {
        const identity = await authenticate(request, env);
        if (!identity) return json({ error: "unauthorized" }, 401);

        if (request.method === "DELETE") {
          const defaults = await resetSettings(env);
          await invalidateBudgetState(env);
          console.log(`[budget] settings reset to defaults by ${identity.email}`);
          return json(defaults);
        }

        const parsed = validateSettings(await request.json().catch(() => null));
        if (!parsed.ok) return json({ error: parsed.error }, 400);
        const saved = await saveSettings(env, parsed.value, identity.email);
        // The cached state embeds the old thresholds; drop it so the new ones
        // take effect on the very next request rather than in five minutes.
        await invalidateBudgetState(env);
        console.log(
          `[budget] settings updated by ${identity.email}: limit=$${saved.limitUsd} `
          + `warn=$${saved.warnUsd} signin=$${saved.anonBlockUsd} nonew=$${saved.newBlockUsd} `
          + `closed=$${saved.closedUsd} enforce=${saved.enforce}`,
        );
        return json(saved);
      }

      // GET /api/admin/usage?days=30 (auth) — internal cost + usage dashboard.
      if (request.method === "GET" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "usage") {
        const identity = await authenticate(request, env);
        if (!identity) return json({ error: "unauthorized" }, 401);
        const requested = Number(url.searchParams.get("days"));
        const days = Math.min(90, Math.max(1, Number.isFinite(requested) ? requested : 30));
        // Flush the in-memory counters first so the panel is not systematically
        // missing the current batch of views.
        await flushMeters(env);
        return json(await adminUsage(env, days));
      }

      if (parts[0] === "api" && parts[1] === "health") return json({ ok: true });

      // Friendly root (this is the API/orchestration worker, not a site).
      if (parts.length === 0) {
        return new Response(ROOT_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      // Unmatched. `/api/*` is machine traffic and keeps its JSON body; anything
      // else reached this worker from a browser address bar, so it gets the page
      // (T9 / DEV-2163 — same 404, branded body).
      if (parts[0] === "api") return json({ error: "not found" }, 404);
      return cors(
        errorPageResponse({
          status: 404,
          title: "Page not found",
          body: "There's nothing at this address.",
          homeUrl: "/",
        }),
      );
    } catch (err) {
      // Client input validation (a 400) is not a fault — never reported.
      if (err instanceof InvalidFilePathError) return json({ error: err.message }, 400);
      // This catch turns every unexpected throw into a 500 body, so withSentry()
      // never sees it. Report here or the error is invisible.
      Sentry.captureException(err);
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  },

  /**
   * Nightly (04:17 UTC, see `triggers.crons`): replace yesterday's estimated
   * ledger rows with Cloudflare's own figures, flush anything the in-memory
   * meters were still holding, and — when explicitly enabled — purge the R2
   * artifacts of long-revoked demos.
   */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        await flushMeters(env);
        await reconcileBilling(env);
        // Alerts run after reconciliation so they fire on the best numbers
        // available, not on last night's estimate.
        await checkCostAlerts(env);
        await gcRevokedArtifacts(env);
        await pruneAnalytics(env, Number(env.ANALYTICS_RETENTION_DAYS ?? 180));
      })(),
    );
  },
});

