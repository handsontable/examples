// What a relayed demo-runtime event becomes now that it leaves Sentry entirely
// (ADR §E.1, "Moves to the new stack only": "...and demo-runtime preview
// events"): a `preview.runtime_error` count through the facade. The Sentry
// side is budgeted by the SAME two `monitor.ts` caps the pre-T06 Sentry
// version used (DEV-2539) — a loud kind still spends the tight relay budget,
// `console-warn` still spends the looser one. The facade side is bounded by
// the F26 edit-burst collapse instead (`demoEventCollapse.ts`).
//
// Split out of `sentry.ts` for the same reason as `tier1Report.ts` /
// `tier2Report.ts` (see their headers): that module imports `@sentry/react`,
// so `node --test` cannot import it and none of this logic could otherwise be
// pinned. Kept import-free like they are — deliberately NOT importing
// `@handsontable/demo-runtime/{monitor,telemetry}` either, for a second reason
// specific to this file: from `pipeline/`, those resolve only via each
// telemetry test's own relative `dist/` path (`runner/node_modules` has no
// `@handsontable` entry at all — only each workspace package's own
// `node_modules` does, via pnpm's strict layout), and a sibling apps/authoring
// module reached through the bare specifier is not `node --test`-importable
// either way. The caller (`sentry.ts`, which already imports the telemetry
// contract module for the facade itself) turns the returned
// `{ fingerprintContext, fingerprintMessage }` into a real fingerprint with
// `fingerprint(context, message)`.
//
// The one exception is `HtMajor`, below: a `type`-only import, which
// `node --experimental-strip-types` (this file's `pipeline/` test runner)
// erases as syntax before any module resolution runs, so it hits neither of
// the two problems above — no `@sentry/react` transitively, no
// `runner/node_modules` bare-specifier resolution at all.
import type { HtMajor } from "@handsontable/demo-runtime/telemetry";

/** Mirrors `MonitorKind` (`packages/runtime/src/monitor.ts`) structurally,
 *  same arrangement as `eventGate.ts`'s local `ExceptionShape`. */
export type DemoMonitorKind = "error" | "rejection" | "console-error" | "console-warn" | "network" | "stderr";

/** `preview.runtime_error`'s `reason` values (contract §5). */
export type PreviewRuntimeErrorReason = "uncaught" | "console" | "network" | "stderr";

/** F10 Loki: the `name` of the Faro exception record a collapsed report
 *  becomes (its Loki line is `<name>: <shape>`). The first two match the
 *  names `sentry.ts` gives the Sentry capture of the same kinds, so the two
 *  sides read alike.
 *
 *  `console-warn` gets none: a warning is context, not a fault (DEV-2539 —
 *  Sentry files it as a breadcrumb, never an issue), so it keeps its
 *  `preview.runtime_error reason=console` count but opens no Loki "error"
 *  line and no `error.handled` point. Handsontable's own "Theme … is already
 *  registered" notice, emitted by normal re-renders, is the everyday case. */
const RECORD_NAME_BY_KIND: Record<DemoMonitorKind, string | null> = {
  error: "DemoError",
  rejection: "DemoUnhandledRejection",
  "console-error": "DemoConsoleError",
  "console-warn": null,
  network: "DemoNetworkError",
  stderr: "DemoStderr",
};

const REASON_BY_KIND: Record<DemoMonitorKind, PreviewRuntimeErrorReason> = {
  error: "uncaught",
  rejection: "uncaught",
  "console-error": "console",
  "console-warn": "console",
  network: "network",
  stderr: "stderr",
};

/** Everything the decision needs, extracted at the callsite — same shape as
 *  `Tier1ErrorFacts`. `message` is assumed already bounded and host-redacted
 *  (`sanitizeMonitorPayload`, unchanged, runs upstream in `sentry.ts`). */
export interface DemoEventFacts {
  kind: DemoMonitorKind;
  message: string;
  tier: 1 | 2;
  framework: string;
  htMajor: HtMajor;
  demoId?: string | null;
}

export interface DemoEventReport {
  /** Which budget governs this event: `"relay"` (the tight
   *  `MONITOR_EVENT_CEILING`) for everything but a console warning,
   *  `"breadcrumb"` (the looser `MONITOR_BREADCRUMB_CEILING`) for
   *  `console-warn` — the same split the pre-T06 Sentry breadcrumb path used,
   *  so a chatty demo still cannot spend the tight budget on warnings alone. */
  budget: "relay" | "breadcrumb";
  /** `fingerprint()`'s `context` argument. Always `"demo-runtime"` — kept as an
   *  explicit field, not a literal at the callsite, so a test can assert the
   *  caller passes the *surface*, not the *kind*, as fingerprint context (the
   *  kind already lives in `reason`, and folding it into context too would
   *  fragment one shape's fingerprint by kind for no reason). */
  fingerprintContext: string;
  /** `fingerprint()`'s `message` argument — the raw relayed message,
   *  unnormalised; the caller runs it through `fingerprint()`, not this
   *  function (T00 owns that normalisation, not this decision). */
  fingerprintMessage: string;
  reason: PreviewRuntimeErrorReason;
  /** F10 Loki: the Faro exception record's `name` (see `RECORD_NAME_BY_KIND`),
   *  or `null` for no record at all (`console-warn`). Its message is the §7
   *  fingerprint shape of the relayed message, never the raw message —
   *  computed by the caller (`fingerprintShape`), for the import-free reason
   *  in this file's header. */
  recordName: string | null;
  attrs: {
    surface: "demo-runtime";
    tier: "1" | "2";
    framework: string;
    ht_major: HtMajor;
    demo_id?: string;
  };
}

/**
 * Always returns a report — the stateful budget check
 * (`demoRelayBudget`/`demoBreadcrumbBudget.admit(...)`) stays the caller's
 * job, since this function is pure and cannot consult a stateful budget,
 * exactly as `tier1Report`'s callers apply `monitorDemos` before this ever
 * runs.
 */
export function demoEventReport(facts: DemoEventFacts): DemoEventReport {
  return {
    budget: facts.kind === "console-warn" ? "breadcrumb" : "relay",
    fingerprintContext: "demo-runtime",
    fingerprintMessage: facts.message,
    reason: REASON_BY_KIND[facts.kind],
    recordName: RECORD_NAME_BY_KIND[facts.kind],
    attrs: {
      surface: "demo-runtime",
      tier: facts.tier === 2 ? "2" : "1",
      framework: facts.framework,
      ht_major: facts.htMajor,
      ...(facts.demoId ? { demo_id: facts.demoId } : {}),
    },
  };
}
