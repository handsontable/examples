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
// The copy is deliberately neutral. The dominant cause is NOT a first boot:
// `packages/runtime/src/container.ts` only points the iframe at the preview URL
// after `/status` reports a real `net.connect` probe as ready, so a cold start
// mostly does not reach here. What does is wake-from-sleep, where (per the
// `sleepAfter` note in `index.ts`) the disk is ephemeral and the boot script is
// not re-run — the dev server is simply gone. "The demo is still starting"
// would be a guess dressed as a fact.

/**
 * How long a refusal is treated as a boot still in progress rather than a fault.
 *
 * Inferred from this repo's own e2e render budget — the container-preview specs
 * allow 90s for a demo to paint — NOT measured against production cold-boot
 * percentiles. It is one named constant precisely because it will want retuning
 * once DEMOS-K volume is observable: too low and ordinary cold starts still
 * file, too high and a permanently dead container is invisible for 90s.
 */
export const BOOT_WINDOW_MS = 90_000;

/** Bound on the `.cause` walk. A self-referencing cause is not hypothetical. */
const MAX_CAUSE_DEPTH = 5;

/**
 * Whether an error is workerd refusing to connect to the container's port.
 *
 * Narrow on purpose. The SDK's own `isPlatformTransientError` does not cover
 * this case (it matches superseded isolates, lost network, DO storage resets),
 * and the string is raised by workerd itself rather than by any package here,
 * so a message match is the only signal available. Everything that does not
 * match is rethrown by the caller and keeps today's status and today's report.
 */
export function isPortNotListening(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error) || seen.has(current)) return false;
    seen.add(current);
    if (/connecting to the port/i.test(current.message)) return true;
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
  };
}
