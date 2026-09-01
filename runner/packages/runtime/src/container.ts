// ContainerRuntime — Tier-2 engine. Implements the same DemoRuntime interface as
// SandpackRuntime, so the editor shell drives a Remix/Next/Astro/Nuxt/Angular
// demo exactly like a React one. Behind the interface it talks to the
// orchestration Worker: POST a session (files -> real dev server in a Cloudflare
// Sandbox container) and point the preview iframe at the container preview URL;
// stream edits as file writes that the dev server HMRs.
//
// DOM-only: imported via the "@handsontable/demo-runtime/container" subpath so it
// is never bundled into the (non-DOM) Worker itself.

import type {
  CatalogEntry,
  DemoRuntime,
  FilesMap,
  HandsontableVersionRef,
  WriteFileOptions,
} from "./types.js";
import { mintSessionId } from "./session.js";
import { applyHandsontableCss, applyHandsontableVersion } from "./version.js";
import { MONITOR_EVENT_CEILING, normalizeMonitorMessage, truncateMessage } from "./monitor.js";
import { failureDetail, RUNNER_PROGRESS_MARKER, STDERR_MARKERS } from "./failure-log.js";

/**
 * Split a failed boot log into the one line worth titling an issue with (`cause`) and
 * the recent context worth keeping beside it (`tail`).
 *
 * The rule set moved to `failure-log.ts` in DEV-2570, when the snapshot builder turned
 * out to have the same defect this function was written for (DEV-2533) and reproduced
 * it with a second copy of these regexes. This wrapper keeps the boot-log defaults —
 * the log arrives pre-bounded by the status route's `tail -c 2500`, so 40 lines is the
 * readability window and the byte cap never bites — and keeps the name and the export
 * `pipeline/container-boot-failure.test.mjs` imports.
 *
 * `code` is dropped: it exists for the Worker's Sentry fingerprint, and the boot path
 * fingerprints on `["tier2-container-boot"]` instead (App.tsx).
 */
export function bootFailureDetail(log: string): { cause: string; tail: string } {
  const { cause, tail } = failureDetail(log, {
    fallback: "Container failed to install dependencies or start.",
  });
  return { cause, tail };
}

/** The container reached the server and booted, but the boot script itself
 * exited nonzero (e.g. pnpm couldn't resolve the pinned Handsontable
 * version) — as opposed to the session request never reaching the server at
 * all.
 *
 * `message` is a single line: the cause, as picked by `bootFailureDetail`. `log` is
 * the recent boot output it was picked out of — context for whoever reads the report,
 * and never part of the message (see `bootFailureDetail` for why that distinction
 * matters). Callers should still show the message as-is rather than running it through
 * a connectivity heuristic: it can incidentally contain words like "fetching" that
 * pnpm's own error output happens to use. */
export class ContainerBootFailure extends Error {
  constructor(message: string, readonly log = "") {
    super(message);
  }
}

/** What only `mount()` can know about a failed create (DEV-2559).
 *
 * Both fields exist to tell two very different causes of Sentry DEMOS-9 apart —
 * a fixed ceiling somewhere above our Worker, versus container starts that are
 * genuinely slow — and neither is observable at the report site in App.tsx: only
 * this method holds the clock and the `Response`. They ride on the error because
 * that is the one thing that already crosses the package boundary; widening
 * `onError` or bolting a diagnostics callback onto `ContainerRuntime` would be a
 * far larger API change than one optional property.
 *
 * `ray` is the failing response's `cf-ray`, the id Cloudflare stamps on every
 * edge response — the join key from one Sentry event back to that invocation in
 * Workers Logs. It is `<hex>-<COLO>`, where the colo is a datacenter code:
 * strictly coarser than the `user.geo` Sentry already stores, and not a preview
 * hostname, so nothing here is a session credential. It is null whenever the
 * header is unreadable — a cross-origin dev setup pointed straight at :8787,
 * since `cors()` in workers/api sets no Access-Control-Expose-Headers. In
 * production the page and the API share an origin, so the response is `basic`
 * and every header is readable. */
export interface SessionStartDiagnostics {
  readonly elapsedMs: number;
  readonly ray: string | null;
  /** `res.type` verbatim — `"basic"` same-origin, `"cors"` cross-origin. What tells
   *  "no header" apart from "no visible header" below. */
  readonly responseType: string;
  /** True when `responseType` is `"basic"` or `"default"`: every header on the
   *  response is readable, so a header's ABSENCE is a fact about the response
   *  rather than an artefact of the CORS filter hiding it from us. Stored here
   *  rather than re-derived at each call site so the copy tier below and the
   *  Sentry tag in sessionDiagnostics.ts share one `basic | default` rule instead
   *  of drifting apart. */
  readonly headersReadable: boolean;
  /** Readable header names, lowercased, sorted, capped at HEADER_NAMES_MAX. */
  readonly headerNames: readonly string[];
  /** The `Server` header's VALUE, truncated. Unbounded, so extra-only, never a
   *  tag — see `sessionResponseServer` in App.tsx. */
  readonly server: string | null;
  /** How many header names there were before the cap, so a truncated list reads
   *  as truncated rather than as a response with exactly HEADER_NAMES_MAX headers. */
  readonly headerCount: number;
}

/** POST /api/session failed. `status` distinguishes the server's 410
 * "closed while being created" (session already destroyed server-side; a
 * follow-up DELETE would only re-extend its tombstone) from other failures.
 * `code` carries the server's machine-readable reason when it sent one —
 * `budget_exhausted` / `budget_login_required` are cost-guardrail refusals
 * (DEV-2030): a deliberate product state with a message written for users, not
 * a fault to retry or report. `diagnostics` is the timing/edge-id pair above;
 * optional so that the three arguments the message contract depends on stay
 * exactly where they were. */
export class SessionStartError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    public readonly diagnostics?: SessionStartDiagnostics,
  ) {
    super(message);
  }
}

/** True for the guardrail refusals above — "the system said no on purpose". */
export const isBudgetRefusal = (e: unknown): e is SessionStartError =>
  e instanceof SessionStartError && typeof e.code === "string" && e.code.startsWith("budget_");

/** Cap for a non-envelope failure body. Shorter than the monitor's own message bound:
 *  this text is prose for a user, not a log excerpt. */
const FAILURE_TEXT_MAX = 200;

/** Cap for the number of header NAMES carried in diagnostics. `extra` is not free —
 *  a response can carry arbitrarily many headers, the same bounding discipline
 *  `FAILURE_TEXT_MAX` applies to the body. */
const HEADER_NAMES_MAX = 20;

/** Cap for the `Server` header's VALUE. Unbounded input, bounded output — the same
 *  reasoning as `FAILURE_TEXT_MAX`. */
const SERVER_HEADER_MAX = 64;

/** Response types on which every header is readable, so a missing header is a fact
 *  about the response rather than about the CORS filter (DEMOS-9). */
const READABLE_TYPES = new Set(["basic", "default"]);

/** Read a `{ error, message }` body if the server sent one, else the raw text.
 *
 * `envelope` says which of the two happened, and that distinction is load-bearing:
 * every deliberate failure from our own Worker is a JSON `{ error }` — its handler
 * and its catch-all both are — so a response WITHOUT one did not come from our code
 * at all. It came from the platform above it (or from whatever proxy is standing in
 * for the API in local dev), and there is nothing in it worth showing a user.
 *
 * The raw-text branch is capped because it is unbounded: a gateway can answer with a
 * whole HTML error page, and that page would otherwise be interpolated verbatim into
 * both the message the user reads and the Sentry issue title. */
async function readFailure(
  res: Response,
): Promise<{ code?: string; message: string; envelope: boolean }> {
  // Not `res.statusText` on failure: Cloudflare serves HTTP/2, where browsers expose
  // statusText as "", so that fallback never bought anything and must not become a
  // message tier of its own.
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { error?: string; message?: string };
    if (body?.error) {
      return { code: body.error, message: body.message ?? body.error, envelope: true };
    }
  } catch { /* not JSON — fall through to the raw text */ }
  return { message: truncateMessage(text.trim(), FAILURE_TEXT_MAX), envelope: false };
}

/** Statuses that mean "nothing answered in time", emitted by the platform rather than
 *  by us (DEV-2538). Deliberately excludes 502 and 503. 503 has its own tier below
 *  (DEV-2553) because "the service did not take the request" is all an envelope-less
 *  503 supports — "took too long" would be a stronger claim than the evidence. 502
 *  stays in the connectivity tier: nothing has been observed emitting one, so there is
 *  no case to write a sentence for.
 *
 *  Only meaningful together with `envelope: false` — a 504 carrying a real `{ error }`
 *  body would be our Worker speaking, and its own words win. */
const TIMEOUT_STATUSES = new Set([504, 522, 524]);

/**
 * A 403 our Worker did not send is the edge refusing the request before it ever
 * arrived (DEV-2631, ADR-0038). The session handler answers 400, 410, and the
 * guardrail's 401/503 — never 403 — so on this route the status is diagnostic on
 * its own, and `envelope: false` confirms nobody downstream of the edge spoke.
 *
 * What earns this its own tier is not the wording but where the request dies. The
 * Worker never runs, so there is no Sentry event, no usage row and nothing in
 * `wrangler tail`: the only trace is the message below. It fires today because the
 * Cloudflare Managed Ruleset blocks any body containing `<script`, and 16 of the 19
 * frameworks ship an HTML entry that has one — so this is not a hypothetical tier,
 * it is the shape of a live incident.
 */
const EDGE_BLOCK_STATUS = 403;

/**
 * 504 whose response we could not attribute to our own edge (Sentry DEMOS-9, the
 * facet analysis that followed DEV-2559). 371 post-instrumentation events, ALL
 * measured 35-82ms — two orders of magnitude under Cloudflare's own ~100s ceiling —
 * and ALL missing `cf-ray`, against 11/11 rays on every other status (403/500) from
 * the identical code path in the identical environment. "Took too long" is false
 * against that timing; this tier replaces it with what the evidence actually
 * supports: the response carries no sign of having come from our servers.
 *
 * Gated on `edge.headersReadable` as well as `!edge.ray`, and that conjunct is not
 * decorative: local dev falls back to a CROSS-ORIGIN API (`App.tsx`'s
 * `API_BASE` defaults to `:8787`), where `cors()` in workers/api exposes no
 * headers, so a null ray there proves nothing about who answered — it is an
 * artefact of the CORS filter, not evidence. Without `headersReadable` this tier
 * would fire on every developer's machine. Production is same-origin
 * (`.env.production` pins `VITE_API_BASE` to the app's own host), so `res.type` is
 * `"basic"` and every header is readable there.
 *
 * 522 and 524 stay on the old timeout tier: they have zero events in 90 days on
 * this route (`context:tier2-session-start` returns only 403/500/503/504), so
 * there is no case behind widening this beyond 504 — the same doctrine
 * `sessionStartMessage`'s 502/503 comments already apply.
 */
const UNREACHED_STATUS = 504;

/**
 * What to tell the user when POST /api/session comes back not-ok, in seven tiers.
 *
 * ⚠ The wording of the platform tiers — interception, gateway-timeout,
 * service-unavailable and edge-block — is a contract with `describeRuntimeError` in
 * apps/authoring/src/App.tsx, whose container-engine heuristic matches
 * /failed to fetch|networkerror|load failed|session start failed|fetch/i and REPLACES
 * the message with the local-dev "run the API worker, it needs Docker" text. That is
 * right for a developer whose worker is down and wrong for a visitor on
 * demos.handsontable.com whose sandbox timed out — which is exactly what production
 * users got for the 82 events of Sentry DEMOS-9 (DEV-2538). So none of those four
 * sentences may contain any of those words, "fetch" above all. The stake is highest on
 * the edge-block one (DEV-2631): a blocked rule hits every visitor of an affected
 * framework at once, and "install Docker" is the one answer that guarantees none of
 * them reports the real cause. The connectivity tiers below them keep saying "session
 * start failed" on purpose, so they keep tripping the heuristic.
 * `pipeline/session-start-failure.test.mjs` is what holds both halves in place.
 *
 * `edge` defaults to `{ ray: null, headersReadable: false }` — "we could not
 * observe" — rather than being required, so a future caller with no `Response` in
 * hand (the 410 poll/write sites at the bottom of this file, which build their
 * message from `failure.message` directly and never route through here today)
 * falls through to the existing timeout tier instead of rendering the
 * interception copy for what might be an ordinary status-poll failure. Unlike the
 * `?.` on the `cf-ray` read that the comment in `mount()` forbids, this default
 * cannot hollow out the tier in practice: both Tier-1 and Tier-2 drive the create
 * path below, which always passes `edge` explicitly.
 */
function sessionStartMessage(
  status: number,
  failure: { code?: string; message: string; envelope: boolean },
  edge: { ray: string | null; headersReadable: boolean } = { ray: null, headersReadable: false },
): string {
  // A guardrail refusal already reads as a sentence aimed at the user; wrapping it in
  // "session start failed (503): …" would bury it (and trip the heuristic above).
  if (failure.code?.startsWith("budget_")) return failure.message;
  // Same reasoning, different refusal: `at_capacity` (DEV-2556) is the Worker
  // saying every container slot is taken, in a sentence written for the person
  // reading it. Wrapping it in "session start failed (503): …" would both bury
  // it and hand it to the App.tsx heuristic. Before the envelope-less 503 tier
  // below on purpose — this one HAS an envelope, so it would otherwise fall
  // through to the generic wrapper at the bottom.
  if (failure.code === "at_capacity") return failure.message;
  // The interception tier (Sentry DEMOS-9, UNREACHED_STATUS above). Placed before
  // TIMEOUT_STATUSES because 504 is a member of that set and this more specific gate
  // must win. `edge.headersReadable` is required, not just `!edge.ray`: without it a
  // cross-origin dev setup (App.tsx's `:8787` fallback) would read a CORS-hidden ray
  // as evidence of interception, on no evidence at all. Nothing here claims WHAT
  // answered — only that this response carries no sign of having come from our
  // servers, which is what the 371-of-371 ray-less measurement actually supports.
  if (!failure.envelope && status === UNREACHED_STATUS && edge.headersReadable && !edge.ray) {
    return `The sandbox service could not be reached (${status}). Nothing is wrong with the code — this response carries no sign of having come from our servers, so something between this browser and our service may have answered instead. Trying a different network or device is the quickest way to tell.`;
  }
  // Nothing answered in time, and no envelope means the silence came from above our
  // Worker. Nothing is wrong with the demo or with the visitor's connection, so say so
  // — "Restart preview" is the error card's own button (packages/editor-shell/src/
  // PreviewPane.tsx). The status stays in the sentence so Sentry keeps one issue per
  // status rather than merging every gateway failure into one.
  if (!failure.envelope && TIMEOUT_STATUSES.has(status)) {
    return `The sandbox took too long to start (${status}). Nothing is wrong with the code — try "Restart preview".`;
  }
  // A 503 with no envelope did not come from our Worker either: every refusal it makes
  // on this route is a `json({ error }, status)` — the budget guardrail above included,
  // and its catch-all answers `json({ error }, 500)` — so this one was emitted above
  // us. Not folded into TIMEOUT_STATUSES: only "the service did not take the request"
  // is supportable, never "it took too long" (DEV-2553). Gated on the envelope rather
  // than on an empty message on purpose: a platform 503 that DOES carry text — a
  // gateway's own HTML page — is just as much not-ours, and letting that case fall
  // through would keep the App.tsx misattribution alive for exactly it.
  if (!failure.envelope && status === 503) {
    return `The sandbox service is unavailable right now (503). Nothing is wrong with the code — try "Restart preview" in a moment.`;
  }
  // Refused above our Worker (see EDGE_BLOCK_STATUS). The body here is whatever error
  // page the edge served, which is worth nothing to a reader and would put a slab of
  // Cloudflare markup in the Sentry title, so it is dropped rather than appended. No
  // "Restart preview" hint either: a rule that refused this request will refuse the
  // retry, and inviting one buries the cause under a loop the visitor blames on us.
  if (!failure.envelope && status === EDGE_BLOCK_STATUS) {
    return `The preview was blocked before it reached the demo server (${status}). Nothing is wrong with the code — a security rule at the edge refused the request.`;
  }
  // No body at all on some other status: the API is not answering usefully, which in
  // practice is a local worker that isn't running. No trailing colon introducing a
  // message that does not exist — that empty tail is what titled DEMOS-9.
  if (!failure.message) return `session start failed (${status})`;
  return `session start failed (${status}): ${failure.message}`;
}

/** How long `reload()` waits for the reloaded page's `load` before settling anyway.
 *  Generous: a container that is merely slow should still resolve on the real event. */
const RELOAD_TIMEOUT_MS = 10_000;

/** Polling cadence and budget *after* the boot script has reported a nonzero exit.
 *  Slower than the boot cadence (2.5s) and bounded: the point is to notice a dev
 *  server that comes up in spite of the exit marker, not to keep probing a container
 *  that is never going to answer. 10s × 12 ≈ two minutes. */
const FAILED_POLL_INTERVAL_MS = 10_000;
const FAILED_POLLS_MAX = 12;

/** The live-session API accepts only relative POSIX paths. */
function relativeFiles(files: FilesMap): FilesMap {
  return Object.fromEntries(
    Object.entries(files).map(([path, contents]) => [relativePath(path), contents]),
  );
}

function relativePath(path: string): string {
  return path.startsWith("/") ? path.slice(1) : path;
}

export interface ContainerRuntimeOptions {
  /** The shell's preview-iframe slot; its src is set to the container preview URL. */
  iframe: HTMLIFrameElement;
  /** Origin of the orchestration Worker (e.g. http://localhost:8787). */
  apiBase: string;
  /** Pin Handsontable to this version before starting the session. */
  version?: HandsontableVersionRef;
  /** Optional session id (else a fresh one is minted per mount). MUST be
   *  unique per create: the server tombstones a deleted id for 10 minutes and
   *  tears down any session recreated under it in that window. */
  sessionId?: string;
  /** Debounce for streamed edits (ms). */
  writeDebounceMs?: number;
  /** Grace after the preview iframe loads, for the SPA to render (ms). */
  renderGraceMs?: number;
  /** Keepalive ping interval to keep the container warm while open (ms). */
  keepaliveMs?: number;
  /** Broker token of the signed-in user, when there is one. Sent with the
   *  session request so the cost guardrail's `anon_blocked` tier (live editing
   *  restricted to signed-in users at >=80% of budget) can recognise them. */
  authToken?: string | null;
  /** Relay post-boot dev-server stderr through `onStderr` (DEV-2527). Off unless
   *  the app's build has monitoring on. */
  monitor?: boolean;
}

export class ContainerRuntime implements DemoRuntime {
  private readonly entry: CatalogEntry;
  private readonly opts: ContainerRuntimeOptions;
  private sessionId: string | null = null;
  // sessionId exists from the moment mount() starts (so a tab close can always
  // DELETE), but the session accepts writes only once the create POST has
  // succeeded — streaming an edit mid-create would race the create handler's
  // own writeFiles and could overwrite the newer edit with the boot snapshot.
  private mounted = false;
  private files: FilesMap = {};
  private readonly readyCbs = new Set<() => void>();
  private readonly errorCbs = new Set<(e: Error) => void>();
  private didReady = false;
  private disposed = false;
  private pending = new Map<string, string>();
  /** Writes deliberately kept out of the dev server for now — see `writeFile`'s
   *  `quiet` option. Drained by `flush()` together with `pending`, so they are never
   *  lost: only delayed until something is going over the wire anyway. */
  private quietPending = new Map<string, string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly progressCbs = new Set<(log: string) => void>();
  private readonly stderrCbs = new Set<(line: string) => void>();
  /** Dev-server stderr lines already relayed, keyed on `normalizeMonitorMessage` —
   *  the same fingerprint `sentry.ts` groups the Sentry issue by — so a message the
   *  server repeats every keystroke, or with only its clock changed (a build
   *  envelope's timestamp), is filed once. A coarser key than the raw line, on
   *  purpose: the parent already fingerprints on the normalized message, so two raw
   *  lines that normalize identically were always going to land in one Sentry
   *  issue — relaying both just spent a `MONITOR_EVENT_CEILING` slot on a second
   *  sample of a fault already reported. The honest trade: only the first variant
   *  of a class now ever leaves the page, so no issue is lost, but sample diversity
   *  *within* an issue narrows — `Cannot find module 'foo'` and `'bar'` used to
   *  both reach Sentry as two events under one fingerprint; now only the first
   *  does. Capped by `MONITOR_EVENT_CEILING` below; the set only ever holds what
   *  fit under it. */
  private readonly stderrSeen = new Set<string>();
  private stderrRelayed = 0;
  private previewUrl = "";
  private port = 0;
  private pointed = false;
  /**
   * Whether the iframe has ever been pointed at the preview URL.
   *
   * Distinct from `pointed`, which is `poll()`'s own gate and goes false again
   * when a confirmation fails (see `confirmAndEmitReady`). `dispose()` needs the
   * sticky answer: a frame left on the preview URL keeps its HMR reconnect loop
   * running, and that loop resurrects the container this dispose just destroyed.
   */
  private frameEverPointed = false;
  /** Settle callbacks for in-flight `reload()` promises, so `dispose()` can close them
   *  out rather than leaving the shell's refresh spinner up on a torn-down preview. */
  private readonly reloadSettlers = new Set<() => void>();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  /** How many failed-state polls have gone out since the boot script reported a nonzero
   *  exit. Kept because polling continues past that report (see `poll()`) and has to
   *  stop eventually — a dead dev server never comes back on its own, and each poll
   *  costs two `exec`s in the container. */
  private failedPolls = 0;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * What the preview frame said about the document it is loading, consumed by the
   * next `load` event (DEV-2547).
   *
   * The Worker serves its own branded page when the dev-server port refuses
   * (`workers/api/src/preview-boot.ts`), and that page fires `load` exactly like a
   * real demo — which is how `data-preview-status` used to reach "ready" over a
   * "Reconnecting to the demo" card with no grid behind it. The page now posts its
   * state to us; an inline script runs at parse time, so the message is queued
   * before that document's `load`.
   */
  private pendingFrameState: "unknown" | "booting" | "dead" = "unknown";
  /** Frame navigations seen since the iframe was pointed. Gates the hard readiness
   *  fallback, whose only job is "the `load` event never fired at all". */
  private frameLoads = 0;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private readyFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  /** One error per session for a preview that died — the terminal page is served
   *  per request, and `onError` is wired to Sentry. */
  private previewDeadReported = false;
  /**
   * Decide readiness per frame navigation rather than once.
   *
   * The listener is deliberately NOT `{ once: true }`: the boot page refreshes
   * itself every two seconds, so a container that does come up is a later `load`
   * on the same iframe. Suppressing ready without listening again would leave the
   * boot overlay covering a working grid — status polling has already stopped by
   * the time we point the iframe.
   */
  private readonly onFrameLoad = () => {
    if (this.disposed) return;
    this.frameLoads += 1;
    const state = this.pendingFrameState;
    this.pendingFrameState = "unknown";
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    if (state === "dead") {
      this.reportPreviewDead();
      return;
    }
    if (state === "booting") {
      // Honest and recoverable: the pane keeps the boot overlay, and the page's own
      // meta-refresh gives us another `load` to judge.
      this.emitProgress("Dev server not answering yet — retrying…");
      return;
    }
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      void this.confirmAndEmitReady();
    }, this.opts.renderGraceMs ?? 3500);
  };
  /**
   * `postMessage` from the Worker's own preview page. Origin-checked against the
   * session's preview URL: any frame or opener can post to us, and this message
   * decides whether the shell claims the demo is up.
   */
  private readonly onPreviewMessage = (event: MessageEvent) => {
    if (this.disposed || !this.previewUrl) return;
    let previewOrigin: string;
    try {
      previewOrigin = new URL(this.previewUrl).origin;
    } catch {
      return;
    }
    if (event.origin !== previewOrigin) return;
    const data = event.data as { source?: unknown; state?: unknown } | null;
    if (!data || typeof data !== "object" || data.source !== "demo-preview") return;
    if (data.state !== "booting" && data.state !== "dead") return;
    // Which navigation does this message describe? A grace timer is running only
    // between a `load` and the readiness decision for that same document, so:
    //
    // - grace running -> it describes what is in the frame NOW (either a message
    //   delivered after its own `load`, or the next boot-page refresh arriving
    //   inside the previous document's 3.5s grace — the refresh interval is 2s).
    //   Cancel the decision and keep nothing: leaving it pending would let the
    //   next `load` — often the recovered demo — consume a stale `booting` and
    //   never emit ready, which is the boot overlay covering a working grid.
    // - no grace running -> the page is being parsed and its `load` has not
    //   fired yet (the ordinary case, since the script runs at parse time).
    //   Hold it for that `load` to consume.
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
      this.pendingFrameState = "unknown";
    } else {
      this.pendingFrameState = data.state;
    }
    if (data.state === "dead") this.reportPreviewDead();
  };
  // Tear the session down when the page goes away (tab close, navigation) —
  // otherwise the container squats one of the few live-preview instance slots
  // until sleepAfter expires. pagehide is the reliable end-of-page signal
  // (fires on tab close and navigation; unload/beforeunload are skipped by
  // bfcache-eligible navigations and headless closes). A bfcache freeze
  // (persisted=true) is NOT the end of the page — the browser may restore it
  // via back/forward, and a disposed runtime would leave that restored page
  // with a dead preview. Keep the session; if the page never comes back, the
  // container's sleepAfter idle window reclaims the slot (keepalive pings are
  // frozen along with the page).
  private readonly onPagehide = (event: PageTransitionEvent) => {
    if (!event.persisted) this.dispose();
  };

  constructor(entry: CatalogEntry, opts: ContainerRuntimeOptions) {
    if (entry.engine !== "container") {
      throw new Error(`ContainerRuntime requires engine 'container'; ${entry.framework} is '${entry.engine}'`);
    }
    this.entry = entry;
    this.opts = opts;
  }

  onReady(cb: () => void): void {
    this.readyCbs.add(cb);
    if (this.didReady) cb();
  }
  onError(cb: (e: Error) => void): void {
    this.errorCbs.add(cb);
  }
  /** Boot-progress log lines while the container installs deps + starts the dev server. */
  onProgress(cb: (log: string) => void): void {
    this.progressCbs.add(cb);
  }
  /**
   * Dev-server stderr raised *after* the preview came up (DEV-2527).
   *
   * Distinct from `onProgress` (which is boot narration for the loading card) and
   * from `ContainerBootFailure` on `onError` (which is the boot script exiting
   * nonzero). This is the third case: a dev server that started fine and then logged
   * a compile or runtime fault — invisible until now, because the shell stops
   * listening to the log the moment it points the iframe.
   */
  onStderr(cb: (line: string) => void): void {
    this.stderrCbs.add(cb);
  }
  private emitReady() {
    if (this.didReady) return;
    this.didReady = true;
    for (const cb of this.readyCbs) cb();
  }
  private emitError(e: Error) {
    for (const cb of this.errorCbs) cb(e);
  }
  /**
   * Ask the container once more before claiming the demo is up (DEV-2547).
   *
   * The frame's document is only self-describing when we wrote it: a dev server
   * that died between the readiness probe and the frame's first request can also
   * hand the frame the SDK's own `500 Proxy routing error`, or a truncated
   * document, and neither of those says so. One re-probe at the end of the render
   * grace turns "the port answered once" into "the port still answers", which is
   * the weakest claim that makes `ready` honest for shapes we do not author.
   *
   * On a failed confirmation this drops back into the boot loop rather than
   * failing: `pointed` goes false, so `poll()` re-points the iframe when the dev
   * server answers again — the frame gets a fresh navigation, and a document that
   * never refreshes itself is no longer a dead end.
   */
  private async confirmAndEmitReady(): Promise<void> {
    if (this.disposed || this.didReady) return;
    if (await this.probeStatusReady()) {
      if (!this.disposed) this.emitReady();
      return;
    }
    if (this.disposed || this.didReady) return;
    this.emitProgress("Dev server stopped answering — waiting for it to come back…");
    this.pointed = false;
    this.poll();
  }

  /** `ready` off the status route, with every failure reading as "not ready" — the
   *  same shape `poll()` uses, minus the log and the failure branches it owns. */
  private async probeStatusReady(): Promise<boolean> {
    if (!this.sessionId) return false;
    try {
      const r = await fetch(`${this.opts.apiBase}/api/session/${this.sessionId}/status?port=${this.port}`);
      if (!r.ok) return false;
      const { ready } = (await r.json()) as { ready?: boolean };
      return ready === true;
    } catch {
      return false;
    }
  }

  /** The preview's server is gone and is not coming back on its own — the shell's
   *  error card, with its "Restart preview" action, is the only way out. */
  private reportPreviewDead(): void {
    if (this.previewDeadReported || this.disposed) return;
    this.previewDeadReported = true;
    this.emitError(new Error("The demo stopped responding. Restart the preview to start a new session."));
  }
  private emitProgress(log: string) {
    for (const cb of this.progressCbs) cb(log);
  }

  async mount(files: FilesMap): Promise<{ previewUrl: string }> {
    this.files = this.opts.version
      ? applyHandsontableCss(applyHandsontableVersion(files, this.opts.version), this.opts.version)
      : files;

    // Mint the session id client-side (mintSessionId is shared with the
    // Worker so both sides always produce the same shape) and register the
    // pagehide teardown BEFORE the session request: the server starts creating
    // the container while the POST is in flight (file writes alone boot it),
    // and a tab close during that window — at its widest when the instance
    // pool is full and the request is stuck waiting for a slot — must already
    // know an id to DELETE. With a server-minted id there is nothing to
    // delete yet.
    const sessionId = this.opts.sessionId?.trim() || mintSessionId(this.entry.framework);
    this.sessionId = sessionId;
    window.addEventListener("pagehide", this.onPagehide);

    let previewUrl: string;
    let port: number;
    try {
      // Serialised BEFORE the clock starts, not inline in the fetch call below.
      // Argument expressions are evaluated after `startedAt` would have been
      // assigned, so leaving this where it reads most naturally would put
      // `relativeFiles` plus a `JSON.stringify` of the entire file map inside the
      // measured window — the one thing the measurement is defined to exclude.
      const body = JSON.stringify({
        framework: this.entry.framework,
        files: relativeFiles(this.files),
        sessionId,
        htVersion: this.opts.version?.ref,
      });
      // The create clock (DEV-2559), started here rather than at the top of mount()
      // on purpose: this is as close as the client can get to the interval the
      // gateway itself is timing. Not the same interval — connection setup and the
      // upload of `body` fall inside this window and outside the gateway's, which
      // starts on receipt — but that difference is milliseconds against a ceiling
      // near 100s, so it cannot move a bucket. Everything ABOVE this line is the
      // part that would: `applyHandsontableVersion` and the serialisation just
      // above vary by framework and file count, and folding them in would smear a
      // fixed ceiling into an apparent spread, destroying the one distinction the
      // number exists to make. `performance.now()` for monotonicity: a clock step
      // must not read as a slow container.
      const startedAt = performance.now();
      const res = await fetch(`${this.opts.apiBase}/api/session`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.opts.authToken ? { Authorization: `Bearer ${this.opts.authToken}` } : {}),
        },
        body,
      });
      // Stopped the instant the response headers land, before `readFailure` touches
      // the body: a gateway can answer with a whole HTML page, and how long we spend
      // reading it is our latency, not the sandbox's.
      const elapsedMs = Math.round(performance.now() - startedAt);
      if (!res.ok) {
        // Inside the failure branch only — several pipeline tests stub a successful
        // create as a bare `{ ok: true, status: 200, json }` with no `headers`, and
        // an unconditional read would break them. Not guarded with `?.` either: an
        // optional chain here would make the ray assertion in
        // pipeline/session-start-failure.test.mjs pass whether or not the header is
        // ever read. Same discipline extends to `res.type` and `[...res.headers.keys()]`
        // below (DEMOS-9) — the stubs get fixed to carry a real shape instead
        // (pipeline/session-start-failure.test.mjs's `sessionStartError` helper).
        const ray = res.headers.get("cf-ray");
        const responseType = res.type;
        const headersReadable = READABLE_TYPES.has(responseType);
        const names = [...res.headers.keys()].map((n) => n.toLowerCase()).sort();
        const server = truncateMessage(res.headers.get("server") ?? "", SERVER_HEADER_MAX) || null;
        const failure = await readFailure(res);
        throw new SessionStartError(
          res.status,
          sessionStartMessage(res.status, failure, { ray, headersReadable }),
          failure.code,
          {
            elapsedMs,
            ray,
            responseType,
            headersReadable,
            headerNames: names.slice(0, HEADER_NAMES_MAX),
            headerCount: names.length,
            server,
          },
        );
      }
      ({ previewUrl, port } = (await res.json()) as { previewUrl: string; port: number });
    } catch (err) {
      // A failed create can still leave a half-created session server-side
      // (the POST handler's file writes boot the container before the step
      // that failed). Tear the runtime down and DELETE by the local id —
      // dispose() alone can't be trusted with it: a mid-flight dispose() may
      // already have nulled this.sessionId. Exception: on the server's 410
      // ("closed while being created") the session is already destroyed, and
      // another DELETE would only re-extend its tombstone TTL.
      this.sessionId = null;
      this.dispose();
      if (!(err instanceof SessionStartError && err.status === 410)) this.deleteSession(sessionId);
      throw err instanceof Error ? err : new Error(String(err));
    }
    this.previewUrl = previewUrl;
    this.port = port;

    if (this.disposed) {
      // dispose() ran while the session request was in flight. Its DELETE
      // raced the server's container creation, so now that creation has
      // definitely finished, send another to tear down whatever won the race.
      this.deleteSession(sessionId);
      return { previewUrl };
    }

    // The session now accepts writes; stream any edits buffered while the
    // create was in flight (the create wrote the mount-time snapshot, so a
    // buffered edit is strictly newer — and flushing only from here on can
    // no longer race the create handler's writeFiles).
    //
    // Quiet writes count here too. They are held back from the *dev server*, not from
    // the session: a theme applied while the container was still booting has no bridge
    // to reach either (the demo has not run yet), so if this did not drain them they
    // would sit unsent until the user happened to make an ordinary edit.
    this.mounted = true;
    if (this.pending.size > 0 || this.quietPending.size > 0) void this.flush();

    // The container boots asynchronously (install + dev server). Poll status for
    // progress; only point the iframe at the preview once the dev server is up.
    this.emitProgress("Starting container…");
    this.poll();
    return { previewUrl };
  }

  private poll(): void {
    if (this.disposed || !this.sessionId) return;
    void (async () => {
      try {
        const r = await fetch(
          `${this.opts.apiBase}/api/session/${this.sessionId}/status?port=${this.port}`,
        );
        // 410 = the session was tombstoned (closed elsewhere); it can never
        // become ready, so stop polling instead of rescheduling forever.
        if (r.status === 410) {
          const failure = await readFailure(r);
          if (this.disposed || this.pointed) return;
          // The cost guardrail closing sessions at 100% of budget arrives here
          // too, and it has a real explanation to show instead of the generic
          // "closed" (which the app deliberately swallows as normal teardown).
          this.emitError(
            failure.code?.startsWith("budget_")
              ? new SessionStartError(410, failure.message, failure.code)
              : new Error("The session was closed."),
          );
          return;
        }
        if (r.ok) {
          const { ready, log, failed } = (await r.json()) as { ready: boolean; log: string; failed?: boolean };
          if (log && !this.pointed) this.emitProgress(log);
          if (failed && !this.disposed && !this.pointed) {
            // Report once, then keep polling rather than returning. Returning made the
            // failure a one-way door: the shell stopped asking the container anything,
            // so a dev server that did come up afterwards could never be picked up, and
            // the error card outlived its cause with no way back but a remount. Reporting
            // once matters as much as continuing — `onError` is wired to Sentry, and
            // re-emitting on every poll would file the same boot failure every few
            // seconds for as long as the tab stayed open.
            if (this.failedPolls === 0) {
              const { cause, tail } = bootFailureDetail(log);
              this.emitError(new ContainerBootFailure(cause, tail));
            }
            this.failedPolls += 1;
            // The boot script has exited, so this is a long shot, not the recovery path —
            // "Restart preview" in the error card is. Poll on slowly for a short window in
            // case the port opens anyway, then stop instead of probing a dead container
            // for the life of the tab.
            if (this.failedPolls > FAILED_POLLS_MAX) return;
            this.pollTimer = setTimeout(() => this.poll(), FAILED_POLL_INTERVAL_MS);
            return;
          }
          if (ready && !this.disposed && !this.pointed) {
            // Dev server is up. Point the iframe at it, but keep the loading
            // indicator through the client-render phase (the SPA still has to
            // boot + render the grid after the HTML loads). We can't inspect the
            // cross-origin iframe, so: on load, wait a short grace, then ready.
            this.pointed = true;
            this.frameEverPointed = true;
            this.emitProgress("Dev server ready — rendering the demo…");
            // The port answered, but a port is not a page: the request the frame is
            // about to make can still land on the Worker's boot page. `onFrameLoad`
            // and `onPreviewMessage` are what tell those two apart (DEV-2547).
            window.addEventListener("message", this.onPreviewMessage);
            this.opts.iframe.addEventListener("load", this.onFrameLoad);
            this.opts.iframe.src = this.previewUrl;
            // Hard fallback for "the load event never fired at all". Gated on that,
            // rather than firing unconditionally: a frame that did load and told us it
            // is holding the boot page must not be called ready twenty seconds later.
            // Cleared first: the confirmation path re-enters `poll()` with `pointed`
            // false, and overwriting a pending handle would leave one `dispose()` can
            // no longer reach.
            if (this.readyFallbackTimer) clearTimeout(this.readyFallbackTimer);
            this.readyFallbackTimer = setTimeout(() => {
              this.readyFallbackTimer = null;
              if (this.frameLoads === 0) void this.confirmAndEmitReady();
            }, 20000);
            // Keep the container awake while the demo is open so it never has to
            // cold-boot again mid-session. Any request resets sleepAfter; we ping
            // only while the tab is visible so a backgrounded/closed tab lets it
            // scale to zero (stop billing) after the idle window.
            this.startKeepalive();
            return;
          }
        }
      } catch {
        /* transient; keep polling */
      }
      if (!this.disposed) this.pollTimer = setTimeout(() => this.poll(), 2500);
    })();
  }

  /** Stream an edit; the container dev server HMRs it. Debounced per burst.
   *  An edit made while the create POST is still in flight is buffered
   *  (flush() is gated on `mounted`) and streamed as soon as it succeeds.
   *
   *  `quiet` holds the write back from the dev server (DEV-2496): the Style panel has
   *  already patched the running theme over the bridge, and streaming the file would
   *  buy nothing but a page reload — the worst version of this bug, since a reload
   *  loses the grid's scroll and selection. The file is stored the same way, and
   *  `quietPending` is drained by the next `flush()` (any edit, `reload()` or
   *  `flushQuiet()`), so the container never serves a theme older than the panel's. */
  writeFile(path: string, contents: string, opts: WriteFileOptions = {}): void {
    if (!this.sessionId) throw new Error("ContainerRuntime.writeFile called before mount()");
    this.files = { ...this.files, [path]: contents };
    // A path lives in exactly one of the two maps: whichever kind of write came last
    // holds the newest contents, and letting both keep an entry would make the answer
    // depend on the order `flush()` happens to drain them in. Hand-edit the theme module
    // and touch the panel inside the debounce window and that is a real disagreement —
    // the container ends up serving the older of the two.
    this.pending.delete(path);
    this.quietPending.delete(path);
    if (opts.quiet) {
      this.quietPending.set(path, contents);
      return;
    }
    this.pending.set(path, contents);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => void this.flush(), this.opts.writeDebounceMs ?? 250);
  }

  /** Stream whatever the quiet writes have been holding, now. */
  flushQuiet(): void {
    if (this.quietPending.size === 0) return;
    void this.flush();
  }

  /** Re-navigate the iframe to the same preview URL. The session, the container
   *  and the dev server are all left alone — only the page reloads. Before the
   *  iframe has been pointed at the preview (still booting) there is nothing to
   *  reload.
   *
   *  Resolves on the reloaded page's `load`, which is the honest completion signal
   *  here: `src` navigation is exactly what a refresh does. Cross-origin is no
   *  obstacle — `load` fires on the frame element regardless of what it loaded. */
  async reload(): Promise<void> {
    if (this.disposed || !this.pointed || !this.previewUrl) return;
    // Held-back writes have to reach the dev server *before* the navigation, or the
    // reloaded page serves a theme older than the one the panel is showing. Guarded
    // because this method must not reject: the shell's refresh spinner is cleared by
    // this promise settling, and `flush()` throwing would leave it up for good.
    if (this.quietPending.size > 0) {
      try {
        await this.flush();
      } catch { /* a write that failed reports through onError, not through refresh */ }
    }
    if (this.disposed || !this.pointed || !this.previewUrl) return;
    return new Promise<void>((resolve) => {
      const iframe = this.opts.iframe;
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        iframe.removeEventListener("load", settle);
        this.reloadSettlers.delete(settle);
        resolve();
      };
      // A container whose dev server died never navigates, and an unresolved promise
      // would leave the shell's spinner up forever. The promise reports "no longer in
      // flight", not success, so resolving on timeout is the correct outcome.
      const timer = setTimeout(settle, RELOAD_TIMEOUT_MS);
      this.reloadSettlers.add(settle);
      iframe.addEventListener("load", settle, { once: true });
      iframe.src = this.previewUrl;
    });
  }

  /** Remove a file from the running container (file-tree delete/rename). */
  deleteFile(path: string): void {
    if (!this.sessionId) return;
    this.pending.delete(path);
    this.quietPending.delete(path);
    const next = { ...this.files };
    delete next[path];
    this.files = next;
    // Mid-create there is nothing to delete server-side yet, and the RPC
    // would race the create's own writeFiles. Local removal is enough: the
    // pre-existing limitation that a mid-boot delete does not propagate to
    // the already-snapshotted container is unchanged.
    if (!this.mounted) return;
    void fetch(
      `${this.opts.apiBase}/api/session/${this.sessionId}/file?path=${encodeURIComponent(relativePath(path))}`,
      { method: "DELETE" },
    ).catch(() => {});
  }

  /** Ping the session periodically (while the tab is visible) to reset the
   *  container's sleepAfter timer, keeping the dev server warm during use. */
  /**
   * Pick the error-ish lines out of a dev-server log tail and relay each once.
   *
   * The status route returns the last 2500 bytes of the log on every ping, so the
   * same lines arrive over and over; `stderrSeen` is what makes this a report per
   * fault rather than one per minute. The ceiling is the same one the in-page
   * reporter uses, for the same reason — the kill switch is a deploy away.
   *
   * `stderrSeen` is keyed on `normalizeMonitorMessage(message)`, not the raw line
   * — see the field comment. The relayed payload stays the raw, truncated line: the
   * diagnostic reaching Sentry is still the verbatim compiler output, only the
   * dedupe key is coarsened to match what `sentry.ts:263` fingerprints on.
   */
  private relayStderr(log: string): void {
    if (this.disposed || this.stderrCbs.size === 0) return;
    for (const raw of log.replace(/\x1b\[[0-9;]*m/g, "").split("\n")) {
      if (this.stderrRelayed >= MONITOR_EVENT_CEILING) return;
      const line = raw.trim();
      if (!line) continue;
      // Our own boot-script narration (`index.ts` writes `::seeding …::`,
      // `::frozen install failed for custom metadata; retrying non-frozen::`,
      // …) is progress, not a fault — the "retrying non-frozen" line is the
      // DESIGNED path for an edited package.json, and it matches
      // STDERR_MARKERS only because it contains the word "failed". Relaying
      // it reported a recovered fallback as a defect and spent one of
      // MONITOR_EVENT_CEILING's slots doing it (Sentry DEMOS-5C). `::error::`
      // is exempt: the script emits it deliberately, before `exit 1`.
      if (RUNNER_PROGRESS_MARKER.test(line)) continue;
      if (!STDERR_MARKERS.test(line)) continue;
      const message = truncateMessage(line);
      const key = normalizeMonitorMessage(message);
      if (this.stderrSeen.has(key)) continue;
      this.stderrSeen.add(key);
      this.stderrRelayed += 1;
      for (const cb of this.stderrCbs) cb(message);
    }
  }

  private startKeepalive(): void {
    if (this.keepaliveTimer || this.disposed) return;
    const intervalMs = this.opts.keepaliveMs ?? 60000;
    this.keepaliveTimer = setInterval(() => {
      if (this.disposed || !this.sessionId) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void fetch(`${this.opts.apiBase}/api/session/${this.sessionId}/status?port=${this.port}`)
        .then(async (r) => {
          // The keepalive is also the only post-boot read of the dev-server log:
          // `poll()` stops the moment it points the iframe, so from here on this
          // request is where a fault the running dev server logged shows up. The
          // granularity is the keepalive interval (60s by default), which is a
          // diagnostic, not a live feed.
          if (r.ok && this.opts.monitor) {
            const body = await r.clone().json().catch(() => null) as { log?: unknown } | null;
            if (typeof body?.log === "string") this.relayStderr(body.log);
          }
          // Session tombstoned elsewhere — pinging it forever is pointless.
          if (r.status !== 410) return;
          if (this.keepaliveTimer) {
            clearInterval(this.keepaliveTimer);
            this.keepaliveTimer = null;
          }
          // The keepalive is also how a *running* session learns the cost
          // ceiling closed it (the server destroys the container on this
          // request). Without this the preview would just quietly go stale.
          const failure = await readFailure(r);
          if (this.disposed || !failure.code?.startsWith("budget_")) return;
          if (this.frameEverPointed) this.opts.iframe.src = "about:blank";
          this.emitError(new SessionStartError(410, failure.message, failure.code));
        })
        .catch(() => {});
    }, intervalMs);
  }

  private async flush() {
    // Gated on `mounted`: a flush before the create POST succeeds would race
    // the create handler's writeFiles. Buffered edits are flushed by mount().
    if (!this.mounted || !this.sessionId || this.disposed) return;
    // Quiet writes go out with whatever prompted this flush. Order does not decide
    // anything — `writeFile` keeps a path in one map only — so this is just "everything
    // that is waiting".
    const batch = [...this.quietPending.entries(), ...this.pending.entries()];
    this.quietPending.clear();
    this.pending.clear();
    for (const [path, contents] of batch) {
      // Re-check per iteration: a dispose() during an earlier await must stop
      // the rest of the batch — writes to a torn-down session are pointless
      // (and, unguarded server-side, would resurrect its container).
      if (!this.sessionId || this.disposed) return;
      try {
        await fetch(`${this.opts.apiBase}/api/session/${this.sessionId}/file`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: relativePath(path), contents }),
        });
      } catch (e) {
        this.emitError(e instanceof Error ? e : new Error(String(e)));
      }
    }
  }

  /** Best-effort server-side session destroy; the container also auto-sleeps.
   *  keepalive lets the request outlive the page when this runs from pagehide
   *  (tab close). Takes the id explicitly so callers can tear down a session
   *  whose id dispose() has already nulled (mid-flight mount races). */
  private deleteSession(id: string): void {
    void fetch(`${this.opts.apiBase}/api/session/${id}`, { method: "DELETE", keepalive: true }).catch(() => {});
  }

  dispose(): void {
    this.disposed = true;
    window.removeEventListener("pagehide", this.onPagehide);
    window.removeEventListener("message", this.onPreviewMessage);
    // Guarded like the `src` reset below: the listener is attached when the iframe is
    // pointed, and a runtime disposed before that never touched the element.
    if (this.frameEverPointed) this.opts.iframe.removeEventListener("load", this.onFrameLoad);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.graceTimer) clearTimeout(this.graceTimer);
    if (this.readyFallbackTimer) clearTimeout(this.readyFallbackTimer);
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    // Point the preview away from the dead session. Preview traffic proxies
    // straight to the container BEFORE any tombstone check (proxyToSandbox is
    // the Worker's first routing step), so a still-mounted iframe — above all
    // its Vite HMR WebSocket reconnect loop — would resurrect the container
    // this dispose just destroyed.
    if (this.frameEverPointed) this.opts.iframe.src = "about:blank";
    // On the `pointed` path that `about:blank` fires its own `load` and would settle
    // these anyway; doing it here too costs a line and drops the ordering assumption.
    for (const settle of [...this.reloadSettlers]) settle();
    this.progressCbs.clear();
    const id = this.sessionId;
    this.sessionId = null;
    this.readyCbs.clear();
    this.errorCbs.clear();
    if (id) this.deleteSession(id);
  }
}
