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
  normalizeMonitorMessage,
  sanitizeMonitorPayload,
  type MonitorPayload,
} from "@handsontable/demo-runtime/monitor";
import { fingerprint as contractFingerprint } from "@handsontable/demo-runtime/telemetry";
import { ApiError } from "./apiError.js";
import { resolveReporting } from "./reportingGate.js";
import {
  isEdgelessForeignSessionStart,
  isForeignUnhandled,
  isOfficeScannerRejection,
  isUnhandledNoise,
} from "./eventGate.js";
import { resolveSentryScope, reportsDiagnosticToSentry } from "./sentryScope.js";
import { demoEventReport, type DemoMonitorKind } from "./demoEventReport.js";
import { tier2StderrReport } from "./tier2Report.js";
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

/**
 * Fix round I3's e2e-only hook: the same two build-time+host conditions as
 * Faro's own local path (contract §10 / `telemetry/gate.ts`'s local leg),
 * inlined here rather than imported — same reasoning `main.tsx`'s
 * `CrashProbe` doc comment gives for its own inlining: this stays a pure
 * function of `import.meta.env.VITE_TELEMETRY_LOCAL` (a build-time constant
 * Vite replaces literally), so a plain production build folds the whole
 * caller branch to dead code — the `check:telemetry-leak` script
 * (`scripts/check-telemetry-leak.mjs`) greps for that flag's literal name and
 * for `CrashProbe`'s own strings as the durable proof, every build, that this
 * never survives one that lacks the flag. Declared before `diagnosticsGoToSentry`
 * (which calls it) even though it is a hoisted function declaration — kept in
 * reading order with the value that depends on it.
 */
function localTestSentryEnabled(): boolean {
  return (
    (import.meta.env.VITE_TELEMETRY_LOCAL as string | undefined) === "1" &&
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
  );
}

/** Whether SOME Sentry client is initialised at all — production
 *  (`reportingEnabled`) or the fix-round-I3 local test-capture path
 *  (`localTestSentryEnabled`). Distinct from `reportingEnabled` on purpose:
 *  `monitorDemos` below must stay production-only (it gates whether real
 *  preview-instrumentation JS is injected for actual visitors, DEV-2540 — a
 *  much bigger footprint than "does a captureException call go anywhere"),
 *  but a diagnostic report's Sentry-reaching decision only cares whether
 *  SOME client would receive it. */
const sentryActive = reportingEnabled || localTestSentryEnabled();

/** Contract §11 / ADR §E.3. `sentryScope.ts` resolves the raw env string and
 *  decides whether an explicit diagnostic report (as opposed to an uncaught
 *  one, which always stays in Sentry — ADR §E.1) also reaches Sentry, beside
 *  the facade, which receives it either way. Gated on `sentryActive`, not
 *  `reportingEnabled` directly — see its own doc comment. */
const SENTRY_SCOPE = resolveSentryScope(import.meta.env.VITE_SENTRY_SCOPE as string | undefined);
export const diagnosticsGoToSentry = reportsDiagnosticToSentry(sentryActive, SENTRY_SCOPE);

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

/** The `environment` (and tag) demo-side events are filed under, so a flood of them
 *  can be rate-limited or muted in the Sentry UI without touching the app — the only
 *  brake that works without a build. Fix round I1 (controller ruling, ADR §E.3 is
 *  binding over the task file's "leave Sentry" line): `reportDemoEvent` keeps
 *  today's Sentry behaviour, this re-homing included, under `full` scope — it is
 *  reachable again only because `reportDemoEvent` conditionally restores its
 *  pre-T06 `Sentry.captureException`/`captureMessage` calls under that scope (see
 *  `reportDemoEvent` below). Under `uncaught` scope nothing tagged `DEMO_SURFACE`
 *  ever reaches `beforeSend` in the first place, so the branch is simply never
 *  hit — the re-homing "disappears once the scope flips" (ADR Consequences)
 *  without needing its own scope check. */
const DEMO_SURFACE = "demo-runtime";

/**
 * Everything a `Sentry.init()` call needs beyond `dsn`/`transport` — shared by
 * the real production init and the fix-round-I3 local test-capture init below,
 * so the two paths cannot drift apart (the whole point of I3's e2e proof is
 * that it exercises the SAME scope/beforeSend logic production uses).
 */
function sharedSentryOptions(environment: string): Sentry.BrowserOptions {
  return {
    environment,
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
      // DEMO_SURFACE branch, unlike isForeignUnhandled below: it requires
      // `mechanism.handled === false`, and every relay arrives via
      // `captureException`, which sets `handled: true` — so it cannot fire on a
      // relayed event and needs no re-homing protection.
      if (isOfficeScannerRejection(event)) return null;
      // DEMOS-9, edgeless-foreign session-start facet (DEV-2858). Also sits ahead
      // of the DEMO_SURFACE branch: it requires the `tier2-session-start` /
      // `session_response_origin` tags that only `App.tsx`'s own
      // `Sentry.captureException` call sets — `reportDemoEvent` never sets them,
      // so this gate cannot fire on a relayed event either.
      if (isEdgelessForeignSessionStart(event)) return null;
      // A client carries one `environment` from init, so a relayed demo event is
      // re-homed per event here (fix round I1 restores this — see `DEMO_SURFACE`'s
      // own doc comment). ADR §E.2's tee below still applies to a re-homed event
      // too, so the ordering here (re-home, then return before the tee runs) would
      // skip the tee for demo-runtime events — restored to match the exact pre-T06
      // shape instead: re-home and return immediately, same as before this task.
      if (event.tags?.surface === DEMO_SURFACE) {
        event.environment = DEMO_SURFACE;
        return event;
      }
      if (isForeignUnhandled(event, window.location.origin)) return null;
      // ADR §E.2 tee: the Faro page-load id becomes a Sentry tag, and the
      // Sentry event id is pushed as a Faro event — both directions of the
      // cross-reference, on every event that actually ships. No-ops safely
      // when telemetry never initialised (`noopTelemetry.pageLoadId()` still
      // mints and returns a real, stable id; `.event()` is a no-op).
      event.tags = { ...event.tags, page_load_id: telemetry.pageLoadId() };
      telemetry.event("sentry.event", { sentry_event_id: event.event_id ?? "" });
      return event;
    },
  };
}

if (reportingEnabled) {
  Sentry.init({ dsn: DSN, ...sharedSentryOptions(reporting.environment) });
} else if (localTestSentryEnabled()) {
  // Fix round I3: acceptance says "an uncaught error reaches Sentry (transport
  // spy)" — untestable against the real production gate (`reportingEnabled`
  // requires the production host, which a local/e2e run can never be). This is
  // the e2e-only hook the finding explicitly offers as an alternative: a SECOND
  // `Sentry.init()`, gated on the exact same build-time+host conditions as
  // Faro's own local path (`localTestSentryEnabled`, own doc comment below) and
  // mutually exclusive with the real one (`reportingEnabled` is production-only,
  // so the two branches never both fire). Same `sharedSentryOptions` as
  // production — same scope/beforeSend behaviour under test — only `dsn` and
  // `transport` differ: a syntactically valid but non-routable DSN (Sentry
  // validates the DSN's *shape* at init even though `transport` below replaces
  // the real network call entirely) and a transport that appends every envelope
  // to `window.__t06SentryCapture` instead of sending it, so
  // `e2e/telemetry-faro.spec.ts` can read it back with `page.evaluate`.
  Sentry.init({
    dsn: "https://t06e2e@o0.ingest.sentry.io/0",
    ...sharedSentryOptions("local-test"),
    transport: () => ({
      send(envelope) {
        const w = window as unknown as { __t06SentryCapture?: unknown[] };
        (w.__t06SentryCapture ??= []).push(envelope);
        return Promise.resolve({});
      },
      flush: () => Promise.resolve(true),
    }),
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
 * Fix round I1 (controller ruling: ADR §E.3's scope switch is binding over the task
 * file's "leave Sentry" line for this function specifically):
 *
 * - **Always**, when the shared budget admits: one `preview.runtime_error` count
 *   through the facade (§5), fingerprinted with the contract's `fingerprint()` — a
 *   keystroke-ladder shape collapses to one fingerprint per shape (§7), which is
 *   what makes this "one deduplicated count" rather than one relay per keystroke.
 * - **`full` scope (default)**: ALSO today's pre-T06 Sentry behaviour, byte-for-byte
 *   — `captureException`/`captureMessage`/`addBreadcrumb`, the `tier2Report.ts`
 *   TS-diagnostic/build-envelope classification, the `DEMO_SURFACE` tags that the
 *   `beforeSend` re-homing above keys on.
 * - **`uncaught` scope**: facade only — no Sentry capture, so the re-homing branch
 *   above is simply never reached for these events (ADR Consequences: "the re-homing
 *   disappears once the scope flips").
 *
 * The kind→budget split (`demoEventReport.ts`) governs both destinations from one
 * admission check: `console-warn` still spends the looser `MONITOR_BREADCRUMB_CEILING`
 * (and, under `full`, becomes a breadcrumb rather than an issue — DEV-2539), everything
 * else the tighter `MONITOR_EVENT_CEILING`.
 */
export function reportDemoEvent(payload: MonitorPayload, context: DemoEventContext): void {
  if (!monitorDemos) return;
  reportDemoEventUnguarded(payload, context);
}

/**
 * The body of `reportDemoEvent`, without the `monitorDemos` gate — split out
 * so fix round I3's e2e-only test hook (below) can drive it directly. A real
 * preview mount (the only way `reportDemoEvent` is called for real) needs
 * `E2E_LIVE` and an external bundler, out of reach for this deterministic
 * spec; this hook exercises the exact same reporting logic (budget, facade,
 * Sentry gate — everything past this point) without needing one, and does NOT
 * touch `monitorDemos` itself, so `App.tsx`'s real preview instrumentation
 * gate is completely unaffected.
 */
function reportDemoEventUnguarded(payload: MonitorPayload, context: DemoEventContext): void {
  // Bound and redacted before anything else touches it — including the dedupe key
  // below, which hashes the stack. An unbounded `stack` from a crafted postMessage is
  // free client-side resource pressure, and a Tier-2 preview host inside it is a live
  // session token.
  const clean = sanitizeMonitorPayload(payload);
  const message = clean.message;
  const report = demoEventReport({
    kind: clean.kind as DemoMonitorKind,
    message,
    tier: context.tier,
    framework: context.framework,
    demoId: context.demoId,
  });

  function toFacade(): void {
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

  // A warning is context, not a fault (DEV-2539). Handsontable's own "Theme is already
  // registered" notice is emitted by normal re-renders, and every warning used to open
  // a Sentry issue — a message event at `warning` level is still an issue. Filed as a
  // breadcrumb instead, so it survives as the context attached to the next real error
  // from the preview without being one itself.
  //
  // Before `demoBreadcrumbBudget.admit`, so a warning never consumes a relay slot, and
  // after `sanitizeMonitorPayload`, so the breadcrumb is bounded and host-redacted like
  // everything else that crossed the origin boundary.
  if (clean.kind === "console-warn") {
    if (!demoBreadcrumbBudget.admit(clean.kind, message)) return;
    toFacade();
    if (diagnosticsGoToSentry) {
      // Breadcrumbs live on the Sentry scope, which outlives a preview: one recorded
      // while example A was mounted can still be attached to an error from example B.
      // `data` carries the tier, framework and demo id so a stale one is identifiable.
      Sentry.addBreadcrumb({
        category: `${DEMO_SURFACE}.console`,
        level: "warning",
        message,
        data: {
          tier: context.tier,
          framework: context.framework,
          ...(context.demoId ? { demo_id: context.demoId } : {}),
        },
      });
    }
    return;
  }
  if (!demoRelayBudget.admit(clean.kind, message, clean.stack)) return;
  toFacade();
  if (!diagnosticsGoToSentry) return;

  // DEV-2854 / DEV-2876: a recognised Tier-2 compiler diagnostic, or a recognised Tier-2
  // build-failure envelope, collapses into its own flat, constant-titled bucket instead of
  // the per-message fingerprint below. Never fed into `demoRelayBudget.admit` above — that
  // stays keyed on the raw message, so 20 distinct diagnostics in one bad editing session
  // still consume 20 of `MONITOR_EVENT_CEILING` rather than collapsing and losing their
  // `extra` after the first. See `tier2Report.ts` for why, and for why the two shapes get
  // two fingerprints rather than one.
  const tier2 = tier2StderrReport(clean.kind, message);
  const tags: Record<string, string> = {
    surface: DEMO_SURFACE,
    kind: clean.kind,
    tier: String(context.tier),
    framework: context.framework,
    ...(tier2 ? tier2.tags : {}),
  };
  if (context.demoId) tags.demo_id = context.demoId;
  const captureContext = {
    tags,
    fingerprint: tier2
      ? tier2.fingerprint
      : [DEMO_SURFACE, clean.kind, normalizeMonitorMessage(message)],
    level: (clean.kind === "error" || clean.kind === "rejection" ? "error" : "warning") as
      | "error"
      | "warning",
    ...(clean.url || tier2
      ? {
          extra: {
            ...(clean.url ? { url: clean.url } : {}),
            ...(tier2 ? tier2.extra : {}),
          },
        }
      : {}),
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
  // Display only, and only for network events (DEV-2539/DEMOS-12). "resource failed to
  // load" as an issue title says nothing; the URL is the whole diagnosis, and `extra`
  // is not visible from the issue list. Deliberately NOT used for
  // `demoRelayBudget.admit` or the fingerprint above, both of which stay on the bare
  // `message` — so a demo with a dozen broken assets still collapses into one issue and
  // still costs one relay slot, while the title becomes actionable.
  const display = tier2
    ? tier2.display
    : clean.kind === "network" && clean.url
      ? `${message}: ${clean.url}`
      : message;
  Sentry.captureMessage(display, captureContext);
}

// Fix round I3's e2e-only hook, second half: expose `reportDemoEventUnguarded`
// (defined above, so this can run after it) on `window` under the same local
// test gate as the Sentry local-test init — `e2e/telemetry-faro.spec.ts` calls
// it directly to prove "demo-runtime → Sentry only with full" without needing
// a real (E2E_LIVE-gated) preview mount. Never touches the exported
// `monitorDemos`, so `App.tsx`'s real preview-instrumentation gate is
// unaffected either way.
if (localTestSentryEnabled()) {
  (
    window as unknown as {
      __t06ReportDemoEvent?: (payload: MonitorPayload, context: DemoEventContext) => void;
    }
  ).__t06ReportDemoEvent = reportDemoEventUnguarded;
}

export { Sentry };
