// What a relayed demo-runtime event becomes now that it leaves Sentry entirely
// (ADR §E.1, "Moves to the new stack only": "...and demo-runtime preview
// events"): a `preview.runtime_error` count through the facade, budgeted by
// the SAME two `monitor.ts` caps the pre-T06 Sentry version used (DEV-2539) —
// a loud kind still spends the tight relay budget, `console-warn` still spends
// the looser one, so a demo re-rendering every keystroke cannot flood either.
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
    attrs: {
      surface: "demo-runtime",
      tier: facts.tier === 2 ? "2" : "1",
      framework: facts.framework,
      ht_major: facts.htMajor,
      ...(facts.demoId ? { demo_id: facts.demoId } : {}),
    },
  };
}
