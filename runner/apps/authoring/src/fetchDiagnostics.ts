// Measurement + retry policy for `fetchVersions` / `fetchDocsJson` (DEV-2859,
// Sentry DEMOS-2X / DEMOS-7D).
//
// `fetchFailure.ts` (DEV-2858 / the sibling fix in
// fix/DEV-2859-opaque-fetch-host-suffix) only classifies a failure shape after
// the fact — it has no measurement and no remedy. This module adds both: a
// bounded retry so a transient blip doesn't become an issue, and a diagnostics
// bundle (attempts, outcome, elapsed, online) so a real dip is distinguishable
// from one visitor's dropped tab without either population being silenced.
//
// Import-free by construction, same reason and same constraint as
// `reportingGate.ts` / `fetchFailure.ts` / `sessionDiagnostics.ts` /
// `identity.ts`: `pipeline/fetch-diagnostics.test.mjs` imports this directly
// under `--experimental-strip-types`, which cannot resolve a sibling `./x.js`
// specifier (verified empirically). Every ambient dependency (fetch, the
// clock, `navigator.onLine`, the retry delay) is an injected parameter with a
// browser-real default, so node can drive every branch without a DOM.
//
// RETRY IS THE DISCRIMINATOR, not the classifier. A visitor's own network
// dropping mid-request (DEMOS-2X) and our host having a real dip both start
// the same way — a fetch that never completes — but only the first one
// recovers 300ms later. `versions_fetch_attempts` (attached to the thrown
// error, read at the callsite) is the tag that tells them apart: a dip fails
// twice, a blip does not.
//
// `!res.ok` (our host answering, e.g. a 503) is deliberately NOT retried here
// at all — retrying a real outage amplifies it, and the caller already reports
// that population as it always has (`catalog.ts`'s
// `if (!res.ok) throw new Error(...)` stays byte-identical). This module's
// retry only ever fires on a *thrown* fetch failure — a request that never
// produced a response.
//
// A timeout (the per-attempt AbortController, 5s, copied from
// `checkVersionExists` in catalog.ts) does NOT retry either: retrying a stall
// would either double a 5s wait into a 10s one on the version picker, or turn
// one outage into a retry storm across every open tab. It is its own outcome
// value (`"timeout"`) rather than being folded into `"transport"`.

export interface FetchDiagnosticsDeps {
  fetchFn?: typeof fetch;
  /** A monotonic clock. `performance.now` in the browser; injectable so a test
   *  can control elapsed time without real timers. */
  now?: () => number;
  isOnline?: () => boolean | undefined;
  sleep?: (ms: number) => Promise<void>;
  /** Per-attempt abort budget. Defaults to 5000ms — the same figure
   *  `checkVersionExists` uses, for the same reason (see its own comment). */
  timeoutMs?: number;
  /** Delay before the single retry. Defaults to 300ms. */
  retryDelayMs?: number;
}

export type FetchOutcome = "ok" | "transport" | "timeout";

export interface FetchDiagnostics {
  /** 1 (no retry attempted, or a timeout — which never retries) or 2 (a
   *  transport failure was retried once). The decisive tag: a dip fails at
   *  both attempts, a blip only fails the first. Always populated by
   *  `fetchWithDiagnostics`; optional only because `docs-catalog.ts`'s
   *  `fetchDocsJson` has no retry of its own to report (it cannot import this
   *  module and stay node-importable — see this file's header) and still
   *  reuses `diagnosticTags`/`diagnosticExtras` with a thinner bundle
   *  (DEV-2859's DEMOS-7D ruling). */
  attempts?: number;
  outcome?: FetchOutcome;
  /** `navigator.onLine` at the start of the call. `undefined` outside a
   *  browser. `true` proves nothing (an extension or captive portal still
   *  refuses the request); only an explicit `false` is evidence either way —
   *  same caution `tier1Report.ts` documents for the same signal. */
  onlineAtStart: boolean | undefined;
  elapsedMs?: number;
  /** Set by the caller (`context: "versions-fetch"` or `"docs-fetch"`) before
   *  tagging — this module has no opinion on which population it is instrumenting. */
  context?: string;
  apiBaseOrigin?: "same" | "cross" | "localhost";
  /** Chromium-only (`navigator.connection.effectiveType`); omitted elsewhere. */
  netEffectiveType?: string;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RETRY_DELAY_MS = 300;

function defaultIsOnline(): boolean | undefined {
  return typeof navigator !== "undefined" ? navigator.onLine : undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Attach diagnostics to a thrown error as a non-enumerable property, leaving
 *  `name`/`message` untouched — `isOpaqueNetworkFailure` (fetchFailure.ts)
 *  must still classify the underlying error by its own wording, and a
 *  non-enumerable property does not show up in `JSON.stringify`, a `for...in`,
 *  or Sentry's own error serialisation, so no grouping shifts. */
function attachDiagnostics(error: unknown, diagnostics: FetchDiagnostics): unknown {
  if (typeof error === "object" && error !== null) {
    Object.defineProperty(error, "fetchDiagnostics", {
      value: diagnostics,
      enumerable: false,
      configurable: true,
    });
  }
  return error;
}

export function readFetchDiagnostics(error: unknown): FetchDiagnostics | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  return (error as { fetchDiagnostics?: FetchDiagnostics }).fetchDiagnostics;
}

interface AttemptResult {
  res?: Response;
  error?: unknown;
  timedOut: boolean;
}

async function attemptOnce(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<AttemptResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { ...init, signal: controller.signal });
    return { res, timedOut: false };
  } catch (error) {
    return { error, timedOut: controller.signal.aborted };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch with the DEV-2859 retry policy. Resolves with `{ res, diagnostics }`
 * whenever a response was produced (`res.ok` may still be false — this
 * function has no opinion on HTTP status, only on whether the request
 * completed at all). Throws the terminal error, decorated with diagnostics,
 * when it never does.
 */
export async function fetchWithDiagnostics(
  url: string,
  init?: RequestInit,
  deps: FetchDiagnosticsDeps = {},
): Promise<{ res: Response; diagnostics: FetchDiagnostics }> {
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? (() => performance.now());
  const isOnline = deps.isOnline ?? defaultIsOnline;
  const sleep = deps.sleep ?? defaultSleep;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryDelayMs = deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  const onlineAtStart = isOnline();
  const start = now();

  const first = await attemptOnce(fetchFn, url, init, timeoutMs);
  if (first.res) {
    return {
      res: first.res,
      diagnostics: { attempts: 1, outcome: "ok", onlineAtStart, elapsedMs: now() - start },
    };
  }
  if (first.timedOut) {
    // A timeout never retries — see this file's header.
    throw attachDiagnostics(first.error, {
      attempts: 1,
      outcome: "timeout",
      onlineAtStart,
      elapsedMs: now() - start,
    });
  }

  // A transport failure (the request never completed, and it wasn't our own
  // abort) gets exactly one retry.
  await sleep(retryDelayMs);
  const second = await attemptOnce(fetchFn, url, init, timeoutMs);
  if (second.res) {
    return {
      res: second.res,
      diagnostics: { attempts: 2, outcome: "ok", onlineAtStart, elapsedMs: now() - start },
    };
  }
  throw attachDiagnostics(second.error, {
    attempts: 2,
    outcome: second.timedOut ? "timeout" : "transport",
    onlineAtStart,
    elapsedMs: now() - start,
  });
}

// --- Buckets, origin classification, tags/extras ---------------------------

/** Fetch-scale elapsed buckets — distinct boundaries from
 *  `sessionDiagnostics.ts`'s `elapsedBucket`, which is scaled for a Tier-2
 *  container boot (seconds to ~120s), not a single HTTP round trip. */
const FETCH_BOUNDARIES_MS = [100, 500, 1000, 3000, 5000];

export function elapsedBucket(ms: number): string {
  for (const boundary of FETCH_BOUNDARIES_MS) {
    if (ms < boundary) {
      return boundary >= 1000 ? `<${boundary / 1000}s` : `<${boundary}ms`;
    }
  }
  return ">=5s";
}

/** Is the API base same-origin, cross-origin, or the committed localhost
 *  fallback (`catalog.ts` / `auth.ts`'s `API_BASE`)? A `localhost` result in
 *  production means `VITE_API_BASE` never made it into the build — a single
 *  candidate cause that would fail the request for every visitor of that
 *  deploy, and would settle DEMOS-2X outright. */
export function apiBaseOrigin(apiBase: string, pageOrigin: string): "same" | "cross" | "localhost" {
  let apiHost: string;
  try {
    apiHost = new URL(apiBase, pageOrigin).host;
  } catch {
    return "cross";
  }
  if (/^localhost(:\d+)?$/.test(apiHost) || /^127\.0\.0\.1(:\d+)?$/.test(apiHost)) return "localhost";
  let pageHost: string;
  try {
    pageHost = new URL(pageOrigin).host;
  } catch {
    return "cross";
  }
  return apiHost === pageHost ? "same" : "cross";
}

/** `context` is required and drives the tag-name prefix, so the same
 *  diagnostics shape can tag both the `versions-fetch` (DEMOS-2X) and
 *  `docs-fetch` (DEMOS-7D) populations without one borrowing the other's tag
 *  names in the Sentry UI. */
function prefixFor(diag: FetchDiagnostics): string {
  return (diag.context ?? "fetch").replace(/-/g, "_");
}

export function diagnosticTags(diag: FetchDiagnostics): Record<string, string> {
  const prefix = prefixFor(diag);
  const tags: Record<string, string> = {
    context: diag.context ?? "fetch",
  };
  if (diag.attempts !== undefined) tags[`${prefix}_attempts`] = String(diag.attempts);
  if (diag.outcome !== undefined) tags[`${prefix}_outcome`] = diag.outcome;
  if (diag.elapsedMs !== undefined) tags[`${prefix}_elapsed_bucket`] = elapsedBucket(diag.elapsedMs);
  if (diag.onlineAtStart !== undefined) tags[`${prefix}_online`] = String(diag.onlineAtStart);
  if (diag.apiBaseOrigin) tags.api_base_origin = diag.apiBaseOrigin;
  if (diag.netEffectiveType) tags.net_effective_type = diag.netEffectiveType;
  return tags;
}

export function diagnosticExtras(diag: FetchDiagnostics): Record<string, string> {
  const extras: Record<string, string> = {};
  if (diag.elapsedMs !== undefined) extras.elapsedMs = String(Math.round(diag.elapsedMs));
  if (diag.attempts !== undefined && diag.outcome !== undefined) {
    extras.attemptSummary = `${diag.attempts} attempt${diag.attempts === 1 ? "" : "s"}, ${diag.outcome}`;
  }
  if (diag.apiBaseOrigin) {
    // Host only — never a full URL, never a query string. `apiBaseOrigin`'s
    // caller passes the classification, not the raw base, so there is nothing
    // more specific to redact here; this extra exists so the classification
    // shows up in the event body, not just as a filterable tag.
    extras.apiBaseClass = diag.apiBaseOrigin;
  }
  return extras;
}

/** Chromium-only `navigator.connection.effectiveType` (e.g. "4g", "3g").
 *  `undefined` on every other engine, and the caller omits the tag entirely
 *  rather than sending `"undefined"`. */
export function netEffectiveType(): string | undefined {
  const nav = typeof navigator !== "undefined" ? (navigator as Navigator & {
    connection?: { effectiveType?: string };
  }) : undefined;
  return nav?.connection?.effectiveType;
}
