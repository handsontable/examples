// Contract §11 / ADR §E.3 — the `VITE_SENTRY_SCOPE` switch. Import-free
// like `reportingGate.ts`: that module pulls in `@sentry/react` and reads
// `import.meta.env`, so `node --test` cannot import it. Do not let this
// file grow imports.

export type SentryScope = "full" | "uncaught";

/** `import.meta.env.VITE_SENTRY_SCOPE`, resolved to the closed set.
 *  Anything other than `"uncaught"` stays `"full"`, the safer default. */
export function resolveSentryScope(raw: string | undefined): SentryScope {
  return raw === "uncaught" ? "uncaught" : "full";
}

/**
 * Whether an explicit diagnostic report (a HANDLED condition: `reportError`,
 * `reportRuntimeError`) also reaches Sentry, beside the facade (which
 * always receives it). Never widens `reportingEnabled` — this scope switch
 * can only narrow it further, never open it when already `false`.
 *
 * Uncaught errors are NOT gated by this function — they stay in Sentry in
 * both scopes (ADR §E.1), captured directly by Sentry's own global-handlers
 * integration or `componentDidCatch`, never through this decision.
 */
export function reportsDiagnosticToSentry(reportingEnabled: boolean, scope: SentryScope): boolean {
  return reportingEnabled && scope === "full";
}
