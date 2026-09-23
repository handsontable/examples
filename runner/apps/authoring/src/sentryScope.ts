// Contract §11 / ADR §E.3 — the `VITE_SENTRY_SCOPE` switch. Split out of
// `sentry.ts` for the same import-free reason as `reportingGate.ts` (whose
// header explains the constraint in full): that module pulls in `@sentry/react`
// and reads `import.meta.env`, so `node --test` cannot import it and nothing in
// it can be unit-tested directly. `pipeline/sentry-gating.test.mjs` imports
// this file under `--experimental-strip-types`. Do not let it grow imports.

export type SentryScope = "full" | "uncaught";

/** `import.meta.env.VITE_SENTRY_SCOPE`, resolved to the closed set. Anything
 *  other than the literal string `"uncaught"` — absent, empty, a typo — stays
 *  `"full"`, the safer default (ADR §E.3: "both `full` by default... nothing
 *  that reaches Sentry today stops reaching it" until the launch plan flips
 *  it). */
export function resolveSentryScope(raw: string | undefined): SentryScope {
  return raw === "uncaught" ? "uncaught" : "full";
}

/**
 * Whether an explicit diagnostic report — a HANDLED condition: `reportError`,
 * the Tier-1/Tier-2 branches of `reportRuntimeError` — also reaches Sentry,
 * beside the facade (which always receives it while telemetry is enabled,
 * regardless of this scope — ADR §E.3: "moved reports go to both").
 *
 * Never widens `reportingEnabled`: the production/automation gate
 * (`reportingGate.ts`) is unconditional, and this scope switch can only ever
 * narrow it further (to `false` under `"uncaught"`), never open it when
 * `reportingEnabled` is already `false`.
 *
 * Uncaught errors (`window.onerror`/`unhandledrejection`/`Sentry.ErrorBoundary`)
 * are NOT gated by this function at all — they stay in Sentry in both scopes
 * (ADR §E.1), because Sentry's own global-handlers integration (or the
 * ErrorBoundary's `componentDidCatch`) captures them directly, never through
 * this decision.
 */
export function reportsDiagnosticToSentry(reportingEnabled: boolean, scope: SentryScope): boolean {
  return reportingEnabled && scope === "full";
}
