// Error reporting for the authoring app. Errors only — no tracing, no session
// replay, no profiling. Imported for its side effect (init) as the very first
// import in main.tsx, so a crash while the module graph is still evaluating is
// still recorded.
//
// Every callsite reports through `reportError` below rather than importing the
// SDK directly, which keeps the production gate authoritative in one place.
import * as Sentry from "@sentry/react";

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
 * Browser noise that is never actionable: a benign layout-loop warning browsers
 * surface as an error, and the two shapes an in-flight request takes when the
 * user navigates away mid-fetch.
 */
const IGNORED = [/^ResizeObserver loop/i, /^AbortError/i, /Failed to fetch/i, /Load failed/i];

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
    ignoreErrors: IGNORED,
    beforeSend(event) {
      // The preview iframe runs arbitrary authored and imported example code, so
      // a compile error or a typo there is product output, not an application
      // fault — see reportRuntimeError in App.tsx. Being cross-origin, the iframe
      // cannot reach this window's error handlers anyway; this is the backstop for
      // anything that arrives with frames pointing outside the app's own origin
      // (the Sandpack bundler, or a container preview host).
      const frames = event.exception?.values?.flatMap((v) => v.stacktrace?.frames ?? []) ?? [];
      const foreign = frames.some(
        (f) => f.filename?.startsWith("http") && !f.filename.startsWith(window.location.origin),
      );
      return foreign ? null : event;
    },
  });
}

/** Report a caught error that would otherwise be swallowed. No-op when gated off. */
export function reportError(error: unknown, context: string): void {
  if (!reportingEnabled) return;
  Sentry.captureException(error, { tags: { context } });
}

export { Sentry };
