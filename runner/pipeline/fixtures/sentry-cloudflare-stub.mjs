// Stands in for `@sentry/cloudflare` when the router runs under plain Node (see
// worker-hooks.mjs). The real client is inert in every other route spec
// already — `makeEnv()`'s `ERROR_REPORTING_DSN: ""` and the absence of
// `SENTRY_ENVIRONMENT` make `apiSentryDsn()` return `undefined`, so
// `sentryOptions()` never wires up a live DSN — but nothing has ever observed
// what index.ts PASSES to `Sentry.captureException`, because there was no
// stub to record it. This one does, additively: every symbol below is a
// passthrough or a no-op recorder, so a spec that asserts nothing about
// Sentry (mcp-routes, token-routes, demo-routes-version, snapshot-build) stays
// exactly as green as it was before this file existed.
//
// Confirmed against `grep -rn "Sentry\." workers/api/src` (DEV-2857 planning):
// the full symbol surface used across that tree is `withSentry`,
// `instrumentDurableObjectWithSentry`, `captureException`, and
// `captureMessage`. Nothing else is exported here on purpose — an unstubbed
// symbol should fail loudly (ReferenceError/TypeError on import) rather than
// silently resolve to `undefined`.

/** Every `captureException`/`captureMessage` call this process has recorded,
 *  in order. `node --test` runs each spec file in its own process, so this
 *  never crosses files — no reset hook needed between tests in the same file
 *  either, since each test constructs its own fake sandbox and asserts on the
 *  tail of this array or filters by a fingerprint/tag it just triggered. */
export const captures = [];

/** `withSentry(options, handlers) => handlers`. The real function wraps
 *  `fetch` to install request-scoped Sentry context; nothing under test reads
 *  that context, so the handlers object passes through unwrapped. */
export function withSentry(_options, handlers) {
  return handlers;
}

/** `instrumentDurableObjectWithSentry(options, cls) => cls`. Same reasoning:
 *  index.ts exports `Sandbox`/`BuilderSandbox`/`BuildJob` through this at
 *  module scope, but no route spec drives a Durable Object directly (the
 *  sandbox stub throws before one would be reached), so the class passes
 *  through unwrapped. */
export function instrumentDurableObjectWithSentry(_options, cls) {
  return cls;
}

export function captureException(error, context) {
  captures.push({ kind: "exception", error, context });
}

export function captureMessage(message, context) {
  captures.push({ kind: "message", message, context });
}
