// What a visitor gets when the Tier-2 container is up but nothing is listening
// on the dev-server port (DEV-2537).
//
// Today that path throws out of the Durable Object's `fetch`, so the SDK's own
// `proxyToSandbox` catch synthesises `500 Proxy routing error` AND
// `instrumentDurableObjectWithSentry` files an unhandled exception. The visitor
// gets a blank frame and we get an issue per HMR retry. This module is the
// decision half of the fix; `index.ts` owns the seam that calls it.
//
// Deliberately free of Cloudflare imports and of runtime sibling imports so
// `pipeline/` can import this `.ts` directly under `--experimental-strip-types`
// — the same constraint `monitor-inject.ts` documents for its own gate. That is
// why `wantsHtml` / `acceptsHtml` arrive as booleans instead of this module
// reading a Request: importing `wantsHtmlError` from `./error-page.js` would
// make the specifier unresolvable to strip-types.
//
// WHAT CAN ACTUALLY REACH HERE, read out of the SDK rather than assumed — it is
// narrower than it looks, and the copy below depends on it.
//
// `Sandbox.fetchPreviewIfRunning` (`@cloudflare/sandbox@0.12.3/dist/sandbox-DI6suZAc.js:8191-8197`)
// pre-checks `container.running`, `state.status === "healthy"` and
// `currentRuntime.isActive(runtime)` before it ever calls the throwing
// `forwardPreviewRequest`, and 410s `STALE_PREVIEW_URL` if any of those fail. So
// what reaches the throw below is one of two things: (i) a dead port inside a
// live generation — the dev server process crashed, was killed, or is
// restarting itself (a Vite config change), or the `/status` probe won the race
// against the server actually serving; or (ii) the container being stopped
// *between* that pre-check and the `fetch` — a race against the `sleepAfter`
// activity alarm, an eviction, or a crash, which resolves into the SDK's own
// 410 on the very next request. DEMOS-K is production evidence for (ii): 14 of
// 20 events (5 of 5 post-deploy) carry workerd's "The container is not running,
// consider calling start()", which only happens when `container.running` was
// true at the check and false at the fetch. Both cases are transient by
// construction, so both get the same retry-then-terminal treatment below — a
// container-stopped race is not a reason to skip the retry page, because the
// very next request already falls through to the SDK's 410 on its own.
//
// Note the `/status` probe makes a cold start an unlikely visitor-facing cause
// of (i) on its own — `packages/runtime/src/container.ts` only points the
// iframe at the preview URL after `/status` reports a real `net.connect`
// success.
//
// Hence the neutral copy. "The demo is still starting" would be a guess dressed as
// a fact for a container that has been serving happily for ten minutes.

/**
 * How long a refused port is treated as a server on its way up rather than a
 * fault. The clock is per container generation: `onStart()` stamps it, and the
 * first refusal after a successful request restamps it, so it measures "how long
 * has this port been refusing", not "how old is the session".
 *
 * Inferred from this repo's own e2e render budget — the container-preview specs
 * allow 90s for a demo to paint — NOT measured against production percentiles.
 * It is one named constant precisely because it will want retuning once the
 * volume is observable: too low and a dev server restarting itself files an
 * issue, too high and a crashed one is invisible for 90s while the retry page
 * keeps the container warm.
 */
export const BOOT_WINDOW_MS = 90_000;

/** Bound on the `.cause` walk. A self-referencing cause is not hypothetical. */
const MAX_CAUSE_DEPTH = 5;

/**
 * The three messages workerd raises out of `container.getTcpPort(port).fetch()`, verbatim
 * from DEMOS-K. None of them exists in any package here — they come from the runtime — so a
 * message match is the only signal available, and each is listed rather than generalised so a
 * fourth shape shows up as a new Sentry event instead of being silently swallowed.
 */
const PORT_UNREACHABLE = [
  /connecting to the port/i, // "There has been an internal error connecting to the port"
  /container is not listening/i, // "The container is not listening in the TCP address 10.0.0.1:4321"
  /container is not running/i, // "The container is not running, consider calling start()"
];

/**
 * Whether an error is workerd failing to deliver a request to the container's port.
 *
 * Narrow on purpose. The SDK's own `isPlatformTransientError` does not cover
 * this case (it matches superseded isolates, lost network, DO storage resets),
 * and the strings are raised by workerd itself rather than by any package here,
 * so a message match is the only signal available. Everything that does not
 * match is rethrown by the caller and keeps today's status and today's report.
 */
export function isPreviewPortUnreachable(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error) || seen.has(current)) return false;
    seen.add(current);
    // Hoisted, not read inside the callback: `current` is a mutable `unknown`, and TS
    // discards the `instanceof Error` narrowing inside a closure body, so
    // `re.test(current.message)` would fail `pnpm typecheck`. Today's single inline
    // `.test` call compiles only because it is not in a callback.
    const message = current.message;
    if (PORT_UNREACHABLE.some((re) => re.test(message))) return true;
    current = current.cause;
  }
  return false;
}

export interface PreviewBootFailure {
  /**
   * `bare` — a bodyless response. The only correct answer to a failed WebSocket
   * upgrade; an HTML document there is garbage to the client.
   * `text` — a sub-resource. A styled document in place of a JS module is noise
   * in the network panel and garbage to whatever tried to parse it.
   * `html` — the branded page, for a real navigation.
   */
  shape: "bare" | "text" | "html";
  /** `Retry-After`, in seconds. Correct HTTP; browsers ignore it for navigations. */
  retryAfterSeconds: number;
  /**
   * When set, the page reloads itself after this many seconds. This is the half
   * that actually recovers a visitor. Only ever set inside the boot window and
   * only on the `html` shape — past the window the dev server is not coming
   * back on its own and a refresh loop would lie forever.
   */
  refreshSeconds?: number;
  title: string;
  body: string;
  /** Whether this refusal is worth a Sentry event. */
  report: boolean;
  /**
   * What the frame is holding, for the parent shell (DEV-2547).
   *
   * `data-preview-status` used to reach "ready" over one of these pages: the
   * container's readiness is a port probe, and the shell then emits ready a
   * fixed grace after the frame's `load` — which this document fires as happily
   * as a real demo does. The `html` shape carries the state to the parent over
   * `postMessage`, so "ready" can mean the demo, not our own apology for it.
   *
   * `booting` pairs with `refreshSeconds`: the page is coming back on its own,
   * so the shell keeps the boot overlay and waits for the next navigation.
   * `dead` is terminal and is the shell's cue to show the error card.
   */
  previewState: "booting" | "dead";
}

export interface PreviewBootInput {
  /** Since the container last started, or since the first refusal if unknown. */
  elapsedMs: number;
  /** The request carries `Upgrade: websocket` (HMR). */
  isUpgrade: boolean;
  /** The path looks like a document — see `wantsHtmlError` in `error-page.ts`. */
  wantsHtml: boolean;
  /**
   * The request's `Accept` names `text/html`.
   *
   * Required on top of `wantsHtml` because the path heuristic calls anything
   * extensionless a document, and Vite serves `/@vite/client` and
   * `/@react-refresh` — extensionless module requests whose `Accept` is a bare
   * wildcard. Without this they get a styled page where a module was expected,
   * the same class of mistake as answering an upgrade with HTML.
   */
  acceptsHtml: boolean;
}

/**
 * Decide the shape, the copy and the reportability of one refused preview
 * request. Pure: no I/O, no Response, so every branch is unit-testable.
 */
export function classifyPreviewBootFailure({
  elapsedMs,
  isUpgrade,
  wantsHtml,
  acceptsHtml,
}: PreviewBootInput): PreviewBootFailure {
  const booting = elapsedMs < BOOT_WINDOW_MS;
  const shape = isUpgrade ? "bare" : wantsHtml && acceptsHtml ? "html" : "text";

  if (booting) {
    return {
      shape,
      retryAfterSeconds: 2,
      refreshSeconds: shape === "html" ? 2 : undefined,
      title: "Reconnecting to the demo",
      body: "The live preview lost its connection to the demo server. Retrying…",
      report: false,
      previewState: "booting",
    };
  }

  // No "reload" here. This document renders inside the demo's own iframe, and
  // reloading the frame re-requests the same dead preview URL and lands right
  // back on this page. Only reopening the enclosing demo page mints a new
  // session — and recovering the frame in place (a tombstone plus a "Restart
  // preview" affordance) is deliberately not part of this change.
  return {
    shape,
    retryAfterSeconds: 30,
    title: "The demo stopped responding",
    body: "The server behind this live preview is no longer running. Open the demo again to start a new session.",
    report: true,
    previewState: "dead",
  };
}
