// Contract §11 / ADR §E.3 — the `VITE_SENTRY_SCOPE` switch. Import-free
// like `reportingGate.ts` so `node --test` can import it.

export type SentryScope = "full" | "uncaught";

/** `import.meta.env.VITE_SENTRY_SCOPE`, resolved to the closed set.
 *  Anything other than `"uncaught"` stays `"full"`, the safer default. */
export function resolveSentryScope(raw: string | undefined): SentryScope {
  return raw === "uncaught" ? "uncaught" : "full";
}

/** Whether an explicit diagnostic report (a HANDLED condition) also reaches
 *  Sentry, beside the facade. Only narrows `reportingEnabled`, never widens
 *  it. Uncaught errors bypass this — they stay in Sentry in both scopes
 *  (ADR §E.1), via Sentry's own global handlers / `componentDidCatch`. */
export function reportsDiagnosticToSentry(reportingEnabled: boolean, scope: SentryScope): boolean {
  return reportingEnabled && scope === "full";
}
