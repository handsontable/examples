// The Sentry scope switch (ADR-0041 §E.1, §E.3; contract §11).
//
// Two shapes:
//
// - `reportDiagnostic` — a "handled condition" report: an upstream failure
//   reported with tags (npm registry, import URL, the LLM gateway), the
//   preview boot-window report, a handled refusal. Always gets a structured
//   error line AND an `error.handled` Analytics Engine point; only reaches
//   Sentry while `SENTRY_SCOPE` is `full` (the default).
// - `reportUncaught` — an error that escapes a handler (the fetch catch-all,
//   a DO alarm, the cron handler, a snapshot-job failure). Always gets a
//   structured error line; Sentry capture stays wherever it already was
//   (untouched by this switch — §E.1: "stays in Sentry ... in both scopes").
//
// `reportDiagnostic` never carries the *content* of what failed (a gateway
// response body, a user's question) — only short tags and the thrown error's
// own message, which every call site already writes to be safe to show or log
// (see `chat.ts`/`theme-ai.ts`, `import-url.ts`'s `ImportError`).

import * as Sentry from "@sentry/cloudflare";
import { fingerprint } from "@handsontable/demo-runtime/telemetry";
import type { Env } from "../env.js";
import { logErrorLine } from "./lines.js";
import { emitPoint } from "./points.js";
import { sentryScopeIsFull } from "./scope.js";

export interface DiagnosticOptions {
  /** Short, fixed label — the structured line's `context` and the
   *  `error.handled` fingerprint's namespace. Never free text. */
  context: string;
  /** `blob10 route_class` for the `error.handled` point. */
  routeClass: string;
  /** Sentry tags — no request/response content, same rule as everywhere else
   *  in this file. */
  tags?: Record<string, string>;
  sentryFingerprint?: string[];
  level?: "warning" | "error";
}

/** The shape `Sentry.captureException` is called with — factored out so a
 *  test can inject a recorder instead of the real SDK call (fix round: this
 *  gate had no direct test — see `pipeline/api-telemetry-diagnostic.test.mjs`). */
export type CaptureExceptionFn = (
  err: unknown,
  context: { level?: "warning" | "error"; tags?: Record<string, string>; fingerprint?: string[] },
) => void;

const defaultCapture: CaptureExceptionFn = (err, context) => Sentry.captureException(err, context);

export function reportDiagnostic(
  env: Env,
  err: unknown,
  opts: DiagnosticOptions,
  capture: CaptureExceptionFn = defaultCapture,
): void {
  const message = err instanceof Error ? err.message : String(err);
  logErrorLine(env, opts.context, err);
  void emitPoint(
    env,
    "error.handled",
    { count: 1 },
    { surface: "api", route_class: opts.routeClass, fingerprint: fingerprint(opts.context, message) },
  );
  if (sentryScopeIsFull(env)) {
    capture(err, {
      level: opts.level,
      ...(opts.tags ? { tags: opts.tags } : {}),
      ...(opts.sentryFingerprint ? { fingerprint: opts.sentryFingerprint } : {}),
    });
  }
}

/** Structured line only — Sentry capture for an uncaught-class error is left
 *  to the existing call site (or to `Sentry.withSentry`/
 *  `instrumentDurableObjectWithSentry`'s own auto-capture on rethrow), which
 *  must stay unconditional in both scopes (§E.1). */
export function reportUncaught(env: Env, err: unknown, context: string): void {
  logErrorLine(env, context, err);
}
