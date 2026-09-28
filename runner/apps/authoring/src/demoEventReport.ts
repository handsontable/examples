// What a relayed demo-runtime event becomes (ADR §E.1): a
// `preview.runtime_error` count through the facade, budgeted by the SAME
// two `monitor.ts` caps Sentry used. Import-free so `node --test` can pin
// this logic; `HtMajor` is a type-only import, erased before resolution.
import type { HtMajor } from "@handsontable/demo-runtime/telemetry";

/** Mirrors `MonitorKind` (`packages/runtime/src/monitor.ts`) structurally,
 *  same arrangement as `eventGate.ts`'s local `ExceptionShape`. */
export type DemoMonitorKind = "error" | "rejection" | "console-error" | "console-warn" | "network" | "stderr";

/** `preview.runtime_error`'s `reason` values (contract §5). */
export type PreviewRuntimeErrorReason = "uncaught" | "console" | "network" | "stderr";

/** The Faro exception record `name` a collapsed report becomes (Loki line
 *  `<name>: <shape>`). `console-warn` gets none — a warning is context,
 *  not a fault (DEV-2539), so it counts but opens no Loki "error" line. */
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
  /** Which budget governs this event: `"relay"` (tight) for everything but
   *  a console warning, `"breadcrumb"` (looser) for `console-warn`. */
  budget: "relay" | "breadcrumb";
  /** `fingerprint()`'s `context` argument, always `"demo-runtime"` — an
   *  explicit field so a test can assert the caller passes surface, not kind. */
  fingerprintContext: string;
  /** `fingerprint()`'s `message` argument — the raw relayed message,
   *  unnormalised; the caller runs it through `fingerprint()`, not this
   *  function (a separate concern from this decision). */
  fingerprintMessage: string;
  reason: PreviewRuntimeErrorReason;
  /** The Faro exception record's `name` (see `RECORD_NAME_BY_KIND`), or
   *  `null` for no record. Message is the §7 fingerprint shape, not raw. */
  recordName: string | null;
  attrs: {
    surface: "demo-runtime";
    tier: "1" | "2";
    framework: string;
    ht_major: HtMajor;
    demo_id?: string;
  };
}

/** Always returns a report — the stateful budget check stays the caller's
 *  job, since this function is pure. */
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
