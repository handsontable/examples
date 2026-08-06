// Orchestration + sharing Worker for the Handsontable demo runner.
//
// Tier-2 live editing: per-session Cloudflare Sandbox container running the real
// framework dev server with HMR. proxyToSandbox() transparently proxies the
// preview URL (HTTP + WebSocket/HMR) back through this Worker.
//
// Sharing endpoints (POST/GET/PATCH/DELETE /api/demos) land in Deliverable 5.

import { getSandbox, proxyToSandbox, Sandbox as SandboxBase } from "@cloudflare/sandbox";
import * as Sentry from "@sentry/cloudflare";
import { mintSessionId, pickLatestNextVersion } from "@handsontable/demo-runtime";
import type { Env } from "./env.js";
import { FRAMEWORK_DEV, BUILD_CONFIG } from "./frameworks.generated.js";
import { dependencyMetadataFingerprint } from "./dependency-metadata.js";
import { authenticate } from "./auth.js";
import { createDemo, getDemo, getDemoSource, invalidateDemo, serveDemoAsset, updateDemo, type DemoRow } from "./share.js";
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
  sessionDenial,
  startSessionMeter,
} from "./budget.js";
import { checkCostAlerts, gcRevokedArtifacts, reconcileBilling } from "./reconcile.js";
import { flushUsage, noteView, recordUsageEvent } from "./usage.js";
import { flushAnalytics, normalisePage, notePageView, pruneAnalytics } from "./analytics.js";
import { adminUsage } from "./admin.js";
import { loadSettings, resetSettings, saveSettings, validateSettings } from "./settings.js";

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

class SandboxBaseWithSleep extends SandboxBase {
  sleepAfter = "5m";
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
  h.set("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return new Response(resp.body, { status: resp.status, headers: h });
}

const json = (data: unknown, status = 200) =>
  cors(new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }));

const nowIso = () => new Date().toISOString();

/** Write out whatever the in-memory meters have accumulated (bytes, requests,
 *  share views). Batched deliberately: one D1 write per asset served would
 *  cost more than the asset does. */
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
  // could write a file to any id and get a container out of it. So at
  // `new_blocked` a subroute is allowed only for a session we already created
  // (it has a meter); an unknown id is refused rather than booted.
  if (state.tier === "new_blocked") {
    if (await hasSessionMeter(env, sessionId)) return null;
    console.log(`[budget] refused subroute for unknown session ${sessionId}: tier=new_blocked`);
    return json(
      {
        error: "budget_exhausted",
        message: budgetPausedMessage,
        tier: state.tier,
      },
      503,
    );
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
    // bytes on the way out (WebSocket upgrades pass through unmeasured).
    if (proxied) return countEgress(proxied);

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
          const dependencyFingerprint = await dependencyMetadataFingerprint({
            packageJson: files["package.json"],
            pnpmLock: files["pnpm-lock.yaml"],
          });
          const metadataDiffersFromStarter = dependencyFingerprint !== dev.sourceDependencyFingerprint;
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
            `cp -al /baked/${dev.bakedKey}/node_modules ./node_modules`,
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
        if (!body.title?.trim()) return json({ error: "title is required" }, 400);
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
          title: body.title.trim(),
          description: body.description ?? null,
          createdBy: id.email,
          forkedFrom: body.forkedFrom ?? `catalog:${body.framework}`,
          now: nowIso(),
        });
        await recordUsageEvent(env, "share_created", body.framework);
        return json({ id: created.id, url: `/d/${created.id}`, embedUrl: `/embed/${created.id}` }, 201);
      }

      // GET /api/demos  (auth, ?mine=1) — list the caller's demos
      if (request.method === "GET" && parts[0] === "api" && parts[1] === "demos" && parts.length === 2) {
        const id = await authenticate(request, env);
        if (!id) return json({ error: "unauthorized" }, 401);
        const rows = await env.DB.prepare(
          "SELECT id,title,description,framework,tier,ht_version,forked_from,visibility,revoked,created_at,updated_at FROM demos WHERE created_by = ? ORDER BY updated_at DESC",
        ).bind(id.email).all();
        return json({ demos: rows.results });
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
        if (row.created_by !== id.email) return json({ error: "forbidden" }, 403);
        const patch = (await request.json()) as {
          title?: string; description?: string; visibility?: string;
          files?: Record<string, string>; htVersion?: string;
        };
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
            title: patch.title?.trim() || row.title,
            description: patch.description ?? row.description,
            now: nowIso(),
          });
          return json({ ok: true });
        }
        // Metadata-only update (title / description / visibility).
        await env.DB.prepare("UPDATE demos SET title=?, description=?, visibility=?, updated_at=? WHERE id=?")
          .bind(patch.title ?? row.title, patch.description ?? row.description, patch.visibility ?? row.visibility, nowIso(), demoId)
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
        if (row.created_by !== id.email) return json({ error: "forbidden" }, 403);
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
            .filter((v) => { const m = Number(v.split(".")[0]); return m >= 15 && m <= 19; })
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

      return cors(new Response("Not found", { status: 404 }));
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

