// Error reporting for the authoring app. Errors only — no tracing, no session
// replay, no profiling. Imported for its side effect (init) as the very first
// import in main.tsx, so a crash while the module graph is still evaluating is
// still recorded.
//
// Every callsite reports through `reportError` below rather than importing the
// SDK directly, which keeps the production gate authoritative in one place.
import * as Sentry from "@sentry/react";
import {
  MONITOR_BREADCRUMB_CEILING,
  MONITOR_EVENT_CEILING,
  createMonitorBudget,
  sanitizeMonitorPayload,
  type MonitorPayload,
} from "@handsontable/demo-runtime/monitor";
import { fingerprint as contractFingerprint } from "@handsontable/demo-runtime/telemetry";
import { ApiError } from "./apiError.js";
import { resolveReporting } from "./reportingGate.js";
import { isEdgelessForeignSessionStart, isOfficeScannerRejection } from "./eventGate.js";
import { resolveSentryScope, reportsDiagnosticToSentry } from "./sentryScope.js";
import { demoEventReport, type DemoMonitorKind } from "./demoEventReport.js";
import { telemetry } from "./telemetry/index.js";

const DSN = import.meta.env.VITE_SENTRY_DSN as string | undefined;

/**
 * Who may report, and under what `environment`. Both come from `reportingGate.ts`,
 * which holds the production-host literal and is import-free so the decision can be
 * unit-tested (`pipeline/sentry-gating.test.mjs`) — this module cannot be, it reads
 * `import.meta.env` and pulls in the SDK.
 *
 * Two DEV-2540 facts worth carrying at the callsite:
 *
 * 1. `navigator.webdriver === true` under any automation harness, and that closes
 *    the gate. A Playwright suite pointed at the production host used to file real
 *    issues (DEMOS-P, 3 events, release `ddf044c0`, Chrome 149 on Windows,
 *    `context: tier2-session-start`). This covers every prod-targeted harness at
 *    once — `e2e-starter-matrix.yml`, `e2e-live.yml`, and the ad-hoc local
 *    `E2E_BASE_URL=https://demos.handsontable.com` run that actually produced those
 *    events. Nothing is lost: `e2e/starter-matrix.spec.ts` collects failures itself
 *    through `page.on("console")` / `page.on("pageerror")` and never reads Sentry.
 * 2. `environment` is hostname-derived, so a build served anywhere else labels
 *    itself `authoring-local` even when the enable gate has been patched open
 *    locally — which is what produced 15 mislabelled `authoring-production` events
 *    on 2026-07-27/28. Mode-derived would not have helped: one of those was a
 *    production-MODE build served at localhost:4173.
 */
const reporting = resolveReporting({
  dsn: DSN,
  hostname: typeof window !== "undefined" ? window.location.hostname : undefined,
  webdriver: typeof navigator !== "undefined" ? navigator.webdriver : undefined,
});

export const reportingEnabled = reporting.enabled;

/** Contract §11 / ADR §E.3. `sentryScope.ts` resolves the raw env string and
 *  decides whether an explicit diagnostic report (as opposed to an uncaught
 *  one, which always stays in Sentry — ADR §E.1) also reaches Sentry, beside
 *  the facade, which receives it either way. */
const SENTRY_SCOPE = resolveSentryScope(import.meta.env.VITE_SENTRY_SCOPE as string | undefined);
export const diagnosticsGoToSentry = reportsDiagnosticToSentry(reportingEnabled, SENTRY_SCOPE);

/**
 * Demo-runtime monitoring (DEV-2527). Temporary and deliberately build-time: off is
 * a one-line commit plus a deploy, which is why the in-page caps in
 * `packages/runtime/src/monitor.ts` are the brake that acts immediately. Removal
 * path in docs/run-and-deploy.md.
 *
 * No second host gate: `reportingEnabled` already pins reporting to production, so
 * local runs and PR CI stay silent whatever this is set to. It inherits the
 * automation gate through the same flag, also deliberately (DEV-2540) — an
 * e2e-driven page load is not real demo usage, so the ~36-minute `e2e:matrix` run
 * against production no longer relays preview events either.
 */
export const monitorDemos =
  reportingEnabled && (import.meta.env.VITE_MONITOR_DEMOS as string | undefined) === "1";

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
 *
 * The two other NOT-OURS populations this project has classified — the Office
 * scanner rejection (DEMOS-5F) and the edgeless-foreign session-start facet
 * (DEMOS-9) — are NOT regexes here. They live in `eventGate.ts`, gated in
 * `beforeSend` below, and are pinned by `pipeline/sentry-gating.test.mjs`. Adding
 * another regex to this array for either would lose that test coverage.
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
    environment: reporting.environment,
    // `|| undefined` matters: the define below substitutes "" when GITHUB_SHA is
    // absent, and a release of "" would not match the SHA-named artifact bundle
    // the plugin uploads — source maps would silently stop resolving.
    release: (import.meta.env.VITE_SENTRY_RELEASE as string | undefined) || undefined,
    // Errors only. Spans would triple the event volume for signal we don't act on.
    tracesSampleRate: 0,
    // Stated rather than inherited, because `reportDemoEvent` now writes into this
    // buffer (DEV-2539). The SDK default is 100 and it keeps the *most recent* N, so
    // with the default a demo spending its whole `MONITOR_BREADCRUMB_CEILING` (50)
    // would evict half the authoring app's own trail — a save failure would file an
    // issue whose breadcrumbs are demo warnings instead of the user's clicks and
    // fetches. At 200 the demo's ceiling can never take more than a quarter. Raise
    // this alongside that ceiling, never one without the other.
    maxBreadcrumbs: 200,
    // Contract §11 / ADR §E.3. `"uncaught"` narrows Sentry to exactly the global
    // handlers plus dedupe — `Sentry.ErrorBoundary`'s own `componentDidCatch` call
    // is unaffected by this list either way, it never goes through an
    // integration. `"full"` (default) keeps every integration the SDK ships with
    // today (browser tracing off already, via `tracesSampleRate: 0`).
    ...(SENTRY_SCOPE === "uncaught"
      ? {
          defaultIntegrations: false,
          integrations: [Sentry.globalHandlersIntegration(), Sentry.dedupeIntegration()],
        }
      : {}),
    beforeSend(event) {
      if (isUnhandledNoise(event)) return null;
      // DEMOS-5F, Office/Outlook safelink scanner (DEV-2858). Sits ahead of the
      // foreign-frame check below, same reasoning as always: it requires
      // `mechanism.handled === false`, and every relay arrives via
      // `captureException`, which sets `handled: true`.
      if (isOfficeScannerRejection(event)) return null;
      // DEMOS-9, edgeless-foreign session-start facet (DEV-2858).
      if (isEdgelessForeignSessionStart(event)) return null;
      if (isForeignUnhandled(event)) return null;
      // ADR §E.2 tee: the Faro page-load id becomes a Sentry tag, and the
      // Sentry event id is pushed as a Faro event — both directions of the
      // cross-reference, on every event that actually ships. No-ops safely
      // when telemetry never initialised (`noopTelemetry.pageLoadId()` still
      // mints and returns a real, stable id; `.event()` is a no-op).
      event.tags = { ...event.tags, page_load_id: telemetry.pageLoadId() };
      telemetry.event("sentry.event", { sentry_event_id: event.event_id ?? "" });
      return event;
    },
  });
}

/**
 * Report a caught error that would otherwise be swallowed.
 *
 * Always reaches the facade (a no-op when telemetry is off); reaches Sentry
 * only when `diagnosticsGoToSentry` (contract §11 / ADR §E.3) — so a local run
 * with `VITE_TELEMETRY_LOCAL=1` still exercises the facade even off-host,
 * where Sentry itself never initialises (`reportingGate.ts`'s production-only
 * gate, unchanged).
 */
export function reportError(error: unknown, context: string): void {
  // A described failure the user is already being told about, and that says
  // nothing about this app's health, stops here (DEV-2534). One gate, rather
  // than an `if` at each of the callsites, is what retires the expired-session
  // half of DEMOS-3/-6/-7/-B/-W without touching a single `catch`. Note this is
  // deliberately narrow: an ownership 403 is still `reportable`, because the UI
  // only offers Save and Delete on a demo it believes is the user's. Applies to
  // both destinations equally — a described failure says nothing about health
  // for the facade either.
  if (error instanceof ApiError && !error.reportable) return;
  telemetry.error(error, context);
  if (diagnosticsGoToSentry) {
    Sentry.captureException(error, { tags: { context } });
  }
}

/**
 * The relay's budget, module-scoped so it lasts the page load rather than the mount —
 * switching examples must not hand out a fresh allowance. The reporter's in-page copy
 * of this cap is advisory: the demo it lives beside can bypass it by posting straight
 * at this window (see `createMonitorBudget`). This is the enforceable one.
 */
const demoRelayBudget = createMonitorBudget(MONITOR_EVENT_CEILING);

/**
 * A second, separate budget for the warnings that become breadcrumbs (DEV-2539).
 *
 * Separate in both directions. A breadcrumb files no issue, so it can be looser than
 * the relay ceiling; and a demo that warns on every render must not be able to spend
 * the relay budget before the `console.error` explaining the breakage arrives. Its
 * `admit` also dedupes, so the repeated "Theme is already registered" notice occupies
 * one breadcrumb rather than the whole buffer.
 */
const demoBreadcrumbBudget = createMonitorBudget(MONITOR_BREADCRUMB_CEILING);

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
 * ADR §E.1 "Moves to the new stack only": demo-runtime preview events leave Sentry
 * entirely now — no `captureException`/`captureMessage`/`addBreadcrumb`, whatever
 * `SENTRY_SCOPE` is. Every kind becomes one `preview.runtime_error` count through
 * the facade (§5), fingerprinted with the contract's `fingerprint()` — a
 * keystroke-ladder shape collapses to one fingerprint per shape (§7), which is
 * what makes this "one deduplicated count" rather than one relay per keystroke.
 * The kind→budget split (`demoEventReport.ts`) is unchanged from the pre-T06
 * Sentry version: `console-warn` still spends the looser
 * `MONITOR_BREADCRUMB_CEILING`, everything else the tighter
 * `MONITOR_EVENT_CEILING` — same two caps, new destination.
 */
export function reportDemoEvent(payload: MonitorPayload, context: DemoEventContext): void {
  if (!monitorDemos) return;
  // Bound and redacted before anything else touches it — including the dedupe key
  // below, which hashes the stack. An unbounded `stack` from a crafted postMessage is
  // free client-side resource pressure, and a Tier-2 preview host inside it is a live
  // session token.
  const clean = sanitizeMonitorPayload(payload);
  const report = demoEventReport({
    kind: clean.kind as DemoMonitorKind,
    message: clean.message,
    tier: context.tier,
    framework: context.framework,
    demoId: context.demoId,
  });
  const budget = report.budget === "breadcrumb" ? demoBreadcrumbBudget : demoRelayBudget;
  if (!budget.admit(clean.kind, clean.message, clean.stack)) return;
  telemetry.metric(
    "preview.runtime_error",
    { count: 1 },
    {
      ...report.attrs,
      reason: report.reason,
      fingerprint: contractFingerprint(report.fingerprintContext, report.fingerprintMessage),
    },
  );
}

export { Sentry };
