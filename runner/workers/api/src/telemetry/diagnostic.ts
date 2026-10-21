// Handled diagnostics (ADR-0041 §E.1; contract §11).
//
// `reportDiagnostic` — a "handled condition" report: an upstream failure
// (npm registry, import URL, the LLM gateway), the preview boot-window
// report, a handled refusal. Gets a structured error line AND an
// `error.handled` Analytics Engine point, and never reaches Sentry, which
// only receives errors that escape a handler. Never carries the *content*
// of what failed (a gateway response body, a user's question) — only the
// thrown error's own message, which every call site already writes to be
// safe to show or log (see `chat.ts`/`theme-ai.ts`, `import-url.ts`'s
// `ImportError`).
//
// The structured error line also carries `hot.fingerprint` (contract §3
// AE-only key), which `workers/o11y/src/normalise/otlp.ts#apiFingerprintFeed`
// reads back out once this line reaches the o11y worker as a worker-tenant
// OTLP export, feeding the §F.3 new-fingerprint registry.

import { ATTR_HOT_FINGERPRINT, fingerprint } from "@handsontable/demo-runtime/telemetry";
import type { Env } from "../env.js";
import { logErrorLine } from "./lines.js";
import { emitPoint } from "./points.js";

export interface DiagnosticOptions {
  /** Short, fixed label — the structured line's `context` and the
   *  `error.handled` fingerprint's namespace. Never free text. */
  context: string;
  /** `blob10 route_class` for the `error.handled` point. */
  routeClass: string;
}

export function reportDiagnostic(env: Env, err: unknown, opts: DiagnosticOptions): void {
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
}
