// Error reporting for the authoring app. Errors only — no tracing, no session
// replay, no profiling. Imported for its side effect (init) as the very first
// import in main.tsx, so a crash while the module graph is still evaluating is
// still recorded.
//
// Every callsite reports through `reportError` below rather than importing the
// SDK directly, which keeps the production gate authoritative in one place.
import * as Sentry from "@sentry/react";
import {
  MONITOR_EVENT_CEILING,
  createMonitorBudget,
  normalizeMonitorMessage,
  sanitizeMonitorPayload,
  type MonitorPayload,
} from "@handsontable/demo-runtime/monitor";

/**
 * The deployed host. Reporting is enabled ONLY here.
 *
 * `.env.production` is committed and is therefore loaded by every production-mode
 * build, including `ci.yml`'s "Build authoring" step — whose output Playwright
 * then serves at http://localhost:4173. Without this gate every PR run, and every
 * local `vite preview`, would file events against the production project. Gating
 * on the runtime hostname (rather than on a second env var or a CI secret) makes
 * that structurally impossible.
 *
 * The API worker gates on `PREVIEW_HOST` for the same reason — see
 * workers/api/src/index.ts.
 */
const PRODUCTION_HOST = "demos.handsontable.com";

const DSN = import.meta.env.VITE_SENTRY_DSN as string | undefined;

export const reportingEnabled =
  Boolean(DSN) && typeof window !== "undefined" && window.location.hostname === PRODUCTION_HOST;

/**
 * Demo-runtime monitoring (DEV-2527). Temporary and deliberately build-time: off is
 * a one-line commit plus a deploy, which is why the in-page caps in
 * `packages/runtime/src/monitor.ts` are the brake that acts immediately. Removal
 * path in docs/run-and-deploy.md.
 *
 * No second host gate: `reportingEnabled` already pins reporting to production, so
 * local runs and PR CI stay silent whatever this is set to.
 */
export const monitorDemos =
  reportingEnabled && (import.meta.env.VITE_MONITOR_DEMOS as string | undefined) === "1";

/** The `environment` (and tag) demo-side events are filed under, so a flood of them
 *  can be rate-limited or muted in the Sentry UI without touching the app — the only
 *  brake that works without a build. */
const DEMO_SURFACE = "demo-runtime";

/**
 * Browser noise that is never actionable: a benign layout-loop warning browsers
 * surface as an error, plus the shapes an in-flight request takes when the user
 * navigates away mid-fetch (`Failed to fetch` in Chrome, `Load failed` in Safari).
 *
 * These are matched ONLY against unhandled errors — see `isUnhandledNoise`. They
 * must not go in `ignoreErrors`: that runs in the event-filters integration, which
 * processes every event including explicit `captureException` calls, so
 * `/Failed to fetch/` there would silently discard the offline broker and
 * `/api/versions` failures that `reportError` exists to surface.
 */
const UNHANDLED_NOISE = [
  /^ResizeObserver loop/i,
  /^AbortError/i,
  /Failed to fetch/i,
  /Load failed/i,
];

/**
 * True for a global `onerror` / `onunhandledrejection` event whose message is
 * known noise. `mechanism.handled === false` is what distinguishes those from
 * anything we reported on purpose (`captureException` sets `handled: true`), and
 * it is populated before `beforeSend` runs.
 */
function isUnhandledNoise(event: Sentry.ErrorEvent): boolean {
  const values = event.exception?.values ?? [];
  return values.some(
    (v) =>
      v.mechanism?.handled === false &&
      UNHANDLED_NOISE.some((re) => re.test(v.value ?? "") || re.test(v.type ?? "")),
  );
}

/**
 * True for an *unhandled* event whose stack points outside this app's origin.
 *
 * The preview iframe runs arbitrary authored and imported example code, so a typo
 * there is product output, not an application fault — see `reportRuntimeError` in
 * App.tsx. Being cross-origin, the iframe cannot reach this window's error handlers
 * at all; this is the backstop for whatever does arrive that way (the Sandpack
 * bundler, a container preview host, an injected extension script).
 *
 * Scoped to `mechanism.handled === false` — the same discriminator
 * `isUnhandledNoise` uses, and for the same reason. Applied to every event, as it
 * was, it silently discarded explicit `reportError` and ErrorBoundary reports whose
 * stack merely *passed through* a foreign frame: precisely the failure the
 * `UNHANDLED_NOISE` note above avoids by keeping those regexes out of
 * `ignoreErrors`. `reportDemoEvent`'s relays are exempted at the callsite too —
 * they carry preview-origin frames by definition, so a future change to how they
 * are captured must not be able to re-break ingest through this path.
 */
function isForeignUnhandled(event: Sentry.ErrorEvent): boolean {
  const values = event.exception?.values ?? [];
  return values.some(
    (v) =>
      v.mechanism?.handled === false &&
      (v.stacktrace?.frames ?? []).some(
        (f) => f.filename?.startsWith("http") && !f.filename.startsWith(window.location.origin),
      ),
  );
}

if (reportingEnabled) {
  Sentry.init({
    dsn: DSN,
    environment: "authoring-production",
    // `|| undefined` matters: the define below substitutes "" when GITHUB_SHA is
    // absent, and a release of "" would not match the SHA-named artifact bundle
    // the plugin uploads — source maps would silently stop resolving.
    release: (import.meta.env.VITE_SENTRY_RELEASE as string | undefined) || undefined,
    // Errors only. Spans would triple the event volume for signal we don't act on.
    tracesSampleRate: 0,
    beforeSend(event) {
      if (isUnhandledNoise(event)) return null;
      // A client carries one `environment` from init, so a relayed demo event is
      // re-homed per event here. See `reportDemoEvent`.
      if (event.tags?.surface === DEMO_SURFACE) {
        event.environment = DEMO_SURFACE;
        return event;
      }
      return isForeignUnhandled(event) ? null : event;
    },
  });
}

/** Report a caught error that would otherwise be swallowed. No-op when gated off. */
export function reportError(error: unknown, context: string): void {
  if (!reportingEnabled) return;
  Sentry.captureException(error, { tags: { context } });
}

/**
 * The relay's budget, module-scoped so it lasts the page load rather than the mount —
 * switching examples must not hand out a fresh allowance. The reporter's in-page copy
 * of this cap is advisory: the demo it lives beside can bypass it by posting straight
 * at this window (see `createMonitorBudget`). This is the enforceable one.
 */
const demoRelayBudget = createMonitorBudget(MONITOR_EVENT_CEILING);

/** Where a relayed event came from. `tier` distinguishes the two engines; `demoId`
 *  is present only for a saved demo. */
export interface DemoEventContext {
  tier: 1 | 2;
  framework: string;
  demoId?: string | null;
}

/**
 * File an event the preview reported through the monitor bridge (DEV-2527).
 *
 * Everything here crossed an origin boundary, so nothing in the payload is trusted:
 * the message is re-truncated (the reporter's own cap could have been bypassed by
 * anything else on the page posting the same shape) and only the fields the payload
 * type declares are read.
 *
 * Fingerprinted by kind plus a normalised message. Without it one demo stuck in a
 * throwing render shards into an issue per distinct row index — the same reasoning
 * `ContainerBootFailure` already applies to boot logs in App.tsx.
 */
export function reportDemoEvent(payload: MonitorPayload, context: DemoEventContext): void {
  if (!monitorDemos) return;
  // Bound and redacted before anything else touches it — including the dedupe key
  // below, which hashes the stack. An unbounded `stack` from a crafted postMessage is
  // free client-side resource pressure, and a Tier-2 preview host inside it is a live
  // session token.
  const clean = sanitizeMonitorPayload(payload);
  const message = clean.message;
  if (!demoRelayBudget.admit(clean.kind, message, clean.stack)) return;
  const tags: Record<string, string> = {
    surface: DEMO_SURFACE,
    kind: clean.kind,
    tier: String(context.tier),
    framework: context.framework,
  };
  if (context.demoId) tags.demo_id = context.demoId;
  const captureContext = {
    tags,
    fingerprint: [DEMO_SURFACE, clean.kind, normalizeMonitorMessage(message)],
    level: (clean.kind === "error" || clean.kind === "rejection" ? "error" : "warning") as
      | "error"
      | "warning",
    ...(clean.url ? { extra: { url: clean.url } } : {}),
  };

  // An exception (with the preview's own stack) for a throw; a message for the
  // kinds that never had one. A synthesised Error is how the relayed stack reaches
  // Sentry's parser at all — captureMessage would drop it.
  if (clean.kind === "error" || clean.kind === "rejection") {
    const error = new Error(message);
    error.name = clean.kind === "rejection" ? "DemoUnhandledRejection" : "DemoError";
    if (clean.stack) error.stack = `${error.name}: ${message}\n${clean.stack}`;
    Sentry.captureException(error, captureContext);
    return;
  }
  Sentry.captureMessage(message, captureContext);
}

export { Sentry };
