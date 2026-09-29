// The Sentry scope switch (ADR-0041 §E.1, §E.3; contract §11).
//
// `reportDiagnostic` — a "handled condition" report: an upstream failure
// reported with tags (npm registry, import URL, the LLM gateway), the
// preview boot-window report, a handled refusal. Always gets a structured
// error line AND an `error.handled` Analytics Engine point; only reaches
// Sentry while `SENTRY_SCOPE` is `full` (the default). Never carries the
// *content* of what failed (a gateway response body, a user's question) —
// only short tags and the thrown error's own message, which every call site
// already writes to be safe to show or log (see `chat.ts`/`theme-ai.ts`,
// `import-url.ts`'s `ImportError`).
//
// The structured error line also carries `hot.fingerprint` (contract §3
// AE-only key), which `workers/o11y/src/normalise/otlp.ts#apiFingerprintFeed`
// reads back out once this line reaches the o11y worker as a worker-tenant
// OTLP export, feeding the §F.3 new-fingerprint registry.

import * as Sentry from "@sentry/cloudflare";
import { ATTR_HOT_FINGERPRINT, fingerprint } from "@handsontable/demo-runtime/telemetry";
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
 *  test can inject a recorder instead of the real SDK call (see
 *  `pipeline/api-telemetry-diagnostic.test.mjs`). */
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
  const fp = fingerprint(opts.context, message);
  // A handled error's contract fingerprint (contract §7) is already computed
  // for the `error.handled` AE point below — also carry it on the structured
  // error line itself, under the AE-only `hot.fingerprint` key (contract §3's
  // `AE_ONLY_ATTRIBUTE_KEYS`, already an allowed key on every ingest path).
  // `workers/o11y/src/normalise/otlp.ts#apiFingerprintFeed` reads it back out
  // and feeds the §F.3 new-fingerprint registry with a real fingerprint.
  logErrorLine(env, opts.context, err, { [ATTR_HOT_FINGERPRINT]: fp });
  void emitPoint(
    env,
    "error.handled",
    { count: 1 },
    { surface: "api", route_class: opts.routeClass, fingerprint: fp },
  );
  if (sentryScopeIsFull(env)) {
    capture(err, {
      level: opts.level,
      ...(opts.tags ? { tags: opts.tags } : {}),
      ...(opts.sentryFingerprint ? { fingerprint: opts.sentryFingerprint } : {}),
    });
  }
}
