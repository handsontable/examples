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
import {
  fingerprint as contractFingerprint,
  fingerprintShape,
  type HotAttrs,
  type HtMajor,
} from "@handsontable/demo-runtime/telemetry";
import { ApiError } from "./apiError.js";
import { resolveReporting } from "./reportingGate.js";
import {
  applyFaroTee,
  isEdgelessForeignSessionStart,
  isForeignUnhandled,
  isOfficeScannerRejection,
  isUnhandledNoise,
} from "./eventGate.js";
import { resolveSentryScope, reportsDiagnosticToSentry } from "./sentryScope.js";
import { demoEventReport, type DemoMonitorKind } from "./demoEventReport.js";
import { createDemoEventCollapse, type PushOutcome } from "./demoEventCollapse.js";
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

/** The same two build-time+host conditions as Faro's local path (contract
 *  §10) — a pure function of `VITE_TELEMETRY_LOCAL`, so a production build
 *  folds this branch to dead code (`check:telemetry-leak` greps for the
 *  flag's name as proof). Declared before `diagnosticsGoToSentry`, which
 *  calls it. */
function localTestSentryEnabled(): boolean {
  return (
    (import.meta.env.VITE_TELEMETRY_LOCAL as string | undefined) === "1" &&
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
  );
}

/** Whether SOME Sentry client is initialised — production or the local
 *  test-capture path. Distinct from `reportingEnabled`: `monitorDemos`
 *  gates real preview instrumentation and must stay production-only. */
const sentryActive = reportingEnabled || localTestSentryEnabled();

/** Contract §11 / ADR §E.3: whether an explicit diagnostic report also
 *  reaches Sentry, besides the facade (which always receives it). Gated
 *  on `sentryActive`, not `reportingEnabled` directly. */
const SENTRY_SCOPE = resolveSentryScope(import.meta.env.VITE_SENTRY_SCOPE as string | undefined);
export const diagnosticsGoToSentry = reportsDiagnosticToSentry(sentryActive, SENTRY_SCOPE);

/** Demo-runtime monitoring (DEV-2527), deliberately build-time: off is a
 *  one-line commit + deploy. Inherits the production/automation gate
 *  through `reportingEnabled`, so local runs and PR CI stay silent. */
export const monitorDemos =
  reportingEnabled && (import.meta.env.VITE_MONITOR_DEMOS as string | undefined) === "1";

/** Widens `monitorDemos`' "preview reporter injected" gate with the local
 *  leg, so Faro/facade reach the local stack under `dev:full`; Sentry
 *  calls stay gated on the real `monitorDemos` (see call sites below). */
export const previewMonitoring = monitorDemos || localTestSentryEnabled();

/** The `environment`/tag demo-side events are filed under, so they can be
 *  rate-limited in the Sentry UI without a build. Under `full` scope,
 *  `reportDemoEvent` re-homes into it (see `beforeSend` below). */
const DEMO_SURFACE = "demo-runtime";

/** Everything `Sentry.init()` needs beyond `dsn`/`transport` — shared by
 *  the production and local test-capture inits so they can't drift. */
function sharedSentryOptions(environment: string): Sentry.BrowserOptions {
  return {
    environment,
    // `|| undefined`: a "" release would not match the SHA-named source-map bundle.
    release: (import.meta.env.VITE_SENTRY_RELEASE as string | undefined) || undefined,
    tracesSampleRate: 0, // errors only — spans would triple volume for signal we don't act on
    // SDK default of 100 would evict half the app's own trail (`reportDemoEvent`
    // also writes here, DEV-2539) — raise alongside MONITOR_BREADCRUMB_CEILING.
    maxBreadcrumbs: 200,
    // Contract §11 / ADR §E.3: `"uncaught"` narrows to global handlers + dedupe only.
    ...(SENTRY_SCOPE === "uncaught"
      ? {
          defaultIntegrations: false,
          integrations: [Sentry.globalHandlersIntegration(), Sentry.dedupeIntegration()],
        }
      : {}),
    beforeSend(event) {
      if (isUnhandledNoise(event)) return null;
      // DEMOS-5F, Office/Outlook safelink scanner (DEV-2858): requires
      // `mechanism.handled === false`, which no relayed event carries.
      if (isOfficeScannerRejection(event)) return null;
      // DEMOS-9, edgeless-foreign session-start facet (DEV-2858): requires
      // tags only App.tsx's own capture call sets, never a relay.
      if (isEdgelessForeignSessionStart(event)) return null;
      // A client carries one `environment` from init, so a relayed demo
      // event is re-homed per event here; return before the tee below.
      if (event.tags?.surface === DEMO_SURFACE) {
        event.environment = DEMO_SURFACE;
        return event;
      }
      if (isForeignUnhandled(event, window.location.origin)) return null;
      // ADR §E.2 tee — best-effort, wrapped so its own failure never costs the event.
      return applyFaroTee(event, telemetry);
    },
  };
}

if (reportingEnabled) {
  Sentry.init({ dsn: DSN, ...sharedSentryOptions(reporting.environment) });
} else if (localTestSentryEnabled()) {
  // e2e-only: a second, mutually-exclusive `Sentry.init()` gated like Faro's
  // local path. Envelopes are captured to `window.__t06SentryCapture` instead
  // of sent, for `e2e/telemetry-faro.spec.ts` to read back.
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
 * Report a caught error that would otherwise be swallowed. Always reaches
 * the facade; reaches Sentry only when `diagnosticsGoToSentry` (contract
 * §11 / ADR §E.3).
 */
export function reportError(error: unknown, context: string): void {
  // A described failure the user is already told about says nothing about
  // app health (DEV-2534): skip it for both destinations. Narrow — an
  // ownership 403 is still `reportable` (Save/Delete only offered on own demos).
  if (error instanceof ApiError && !error.reportable) return;
  telemetry.error(error, context);
  if (diagnosticsGoToSentry) {
    Sentry.captureException(error, { tags: { context } });
  }
}

/** The relay's budget, module-scoped so it lasts the page load, not the
 *  mount. The in-page copy is advisory; this is the enforceable one. */
const demoRelayBudget = createMonitorBudget(MONITOR_EVENT_CEILING);

/** A second, looser budget for warnings-as-breadcrumbs (DEV-2539) — a
 *  chatty demo must not spend the relay budget on warnings alone. */
const demoBreadcrumbBudget = createMonitorBudget(MONITOR_BREADCRUMB_CEILING);

/** One collapsed demo-runtime report, ready for the facade. */
interface CollapsedDemoEvent {
  attrs: HotAttrs;
  reason: string;
  fingerprint: string;
  recordName: string | null;
  shape: string;
}

/**
 * What survives the edit-burst collapse becomes two facade calls: the
 * `preview.runtime_error` count (§5) and one handled Faro exception (the
 * Loki line), whose message is the §7 fingerprint shape, never the relayed
 * text. A console warning gets the count only.
 */
function emitCollapsedDemoEvent(event: CollapsedDemoEvent): void {
  telemetry.metric(
    "preview.runtime_error",
    { count: 1 },
    { ...event.attrs, reason: event.reason, fingerprint: event.fingerprint },
  );
  if (event.recordName === null) return; // a console warning: counted, not a Loki error line
  const record = new Error(event.shape);
  record.name = event.recordName;
  record.stack = "";
  telemetry.error(record, DEMO_SURFACE, event.attrs);
}

/** Facade demo-runtime reports go through the edit-burst collapse — one
 *  report per fingerprint per burst. Tier-1 compile errors share this
 *  instance since a non-compiling burst has no run of its own. */
const demoEventCollapse = createDemoEventCollapse<() => void>({
  emit: (emitItem) => emitItem(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

/** Collapse key for a compile error — by kind, not message; prefix
 *  `compile:` cannot collide with a §7 `context:hash` fingerprint. */
const COMPILE_ERROR_KEY = "compile:sandpack.compile_error";

/** Routes one Tier-1 compile error through the collapse with `replacesRun`,
 *  so a typed syntax error counts as one `sandpack.compile_error` and no
 *  `preview.runtime_error`. Not behind `previewMonitoring` — wired for every
 *  preview like `sandpack.compile_ms`. */
export function collapseCompileError(emit: () => void): void {
  demoEventCollapse.report(COMPILE_ERROR_KEY, emit, { replacesRun: true });
}

/** An edit that re-runs the preview — opens/extends the burst. Not behind
 *  `previewMonitoring`: with monitoring off nothing else enters the
 *  collapse, so this only arms a timer. */
export function noteDemoEdit(): void {
  demoEventCollapse.noteEdit();
}

/** The Tier-1 runtime's push outcome for the newest edit (`onPushOutcome`). */
export function noteDemoPushOutcome(outcome: PushOutcome): void {
  demoEventCollapse.pushOutcome(outcome);
}

/** A preview is being torn down (example/version switch, remount) —
 *  count its last run, then let the next preview's first load count afresh.
 *  Ungated for the same reason as `noteDemoEdit`. */
export function resetDemoEventCollapse(): void {
  demoEventCollapse.reset();
}

if (typeof window !== "undefined") {
  // A burst still open when the tab goes away: its last run is real.
  window.addEventListener("pagehide", () => demoEventCollapse.flush());
}

/** Where a relayed event came from. `tier` distinguishes the two engines; `demoId`
 *  is present only for a saved demo. */
export interface DemoEventContext {
  tier: 1 | 2;
  framework: string;
  htMajor: HtMajor;
  demoId?: string | null;
}

/**
 * Files an event the preview reported through the monitor bridge
 * (DEV-2527). Always enters the edit-burst collapse; under `full` scope
 * (default) ALSO reaches Sentry; under `uncaught` scope, facade only.
 */
export function reportDemoEvent(payload: MonitorPayload, context: DemoEventContext): void {
  if (!previewMonitoring) return;
  reportDemoEventUnguarded(payload, context, { sentry: monitorDemos });
}

/**
 * Body of `reportDemoEvent` without the `previewMonitoring` gate, split
 * out so the e2e-only hook below can drive it directly. `opts.sentry`
 * (default `true`) gates this relay's Sentry calls independently of
 * `diagnosticsGoToSentry`.
 */
function reportDemoEventUnguarded(
  payload: MonitorPayload,
  context: DemoEventContext,
  opts: { sentry: boolean } = { sentry: true },
): void {
  // Bound and redacted before anything touches it (including the dedupe
  // key below) — an unbounded stack could leak a live session token.
  const clean = sanitizeMonitorPayload(payload);
  const message = clean.message;
  const report = demoEventReport({
    kind: clean.kind as DemoMonitorKind,
    message,
    tier: context.tier,
    framework: context.framework,
    htMajor: context.htMajor,
    demoId: context.demoId,
  });

  // Into the edit-burst collapse, not straight to the facade, and before
  // either Sentry budget — a keystroke ladder must not drain the relay
  // budget before a later real error of the page load.
  const fp = contractFingerprint(report.fingerprintContext, report.fingerprintMessage);
  const collapsed: CollapsedDemoEvent = {
    attrs: report.attrs,
    reason: report.reason,
    fingerprint: fp,
    recordName: report.recordName,
    shape: fingerprintShape(report.fingerprintMessage),
  };
  demoEventCollapse.report(fp, () => emitCollapsedDemoEvent(collapsed));

  // A warning is context, not a fault (DEV-2539): filed as a breadcrumb,
  // not an issue, before the breadcrumb budget so it never spends a relay
  // slot.
  if (clean.kind === "console-warn") {
    if (!demoBreadcrumbBudget.admit(clean.kind, message)) return;
    if (opts.sentry && diagnosticsGoToSentry) {
      // Breadcrumbs live on the Sentry scope, which outlives a preview.
      // `data` carries the tier/framework/demo id so a stale one is identifiable.
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
  if (!(opts.sentry && diagnosticsGoToSentry)) return;

  // DEV-2854/DEV-2876: a recognised Tier-2 diagnostic/build-failure
  // envelope collapses into its own bucket instead of the per-message
  // fingerprint below; see `tier2Report.ts`.
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

  // An exception (with the preview's own stack) for a throw; a message for
  // the kinds that never had one — captureMessage would drop the stack.
  if (clean.kind === "error" || clean.kind === "rejection") {
    const error = new Error(message);
    error.name = clean.kind === "rejection" ? "DemoUnhandledRejection" : "DemoError";
    if (clean.stack) error.stack = `${error.name}: ${message}\n${clean.stack}`;
    Sentry.captureException(error, captureContext);
    return;
  }
  // Display only, for network events (DEV-2539/DEMOS-12): the URL is the
  // whole diagnosis. Kept off the fingerprint/budget key so a dozen broken
  // assets still collapse into one issue.
  const display = tier2
    ? tier2.display
    : clean.kind === "network" && clean.url
      ? `${message}: ${clean.url}`
      : message;
  Sentry.captureMessage(display, captureContext);
}

// e2e-only hooks under the `__t06ReportDemoEvent` prefix `check:telemetry-leak`
// covers: unguarded entry, guarded entry (proves the two-gate behaviour
// without a real preview mount), and the edit signal for a keystroke ladder.
if (localTestSentryEnabled()) {
  (
    window as unknown as {
      __t06ReportDemoEvent?: (payload: MonitorPayload, context: DemoEventContext) => void;
    }
  ).__t06ReportDemoEvent = reportDemoEventUnguarded;
  (
    window as unknown as {
      __t06ReportDemoEventGuarded?: (payload: MonitorPayload, context: DemoEventContext) => void;
    }
  ).__t06ReportDemoEventGuarded = reportDemoEvent;
  (
    window as unknown as { __t06ReportDemoEventNoteEdit?: () => void }
  ).__t06ReportDemoEventNoteEdit = noteDemoEdit;
}

export { Sentry };
