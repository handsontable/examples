// Structured JSON lines (ADR-0041 §D), replacing the old bracketed-prefix
// `console.log`/`console.warn` convention for the two shapes this worker owns:
// one request-summary line per non-proxy request, and one error line for
// anything our own code catches on behalf of a handler that would otherwise
// swallow it silently (the fetch catch-all, the snapshot-job alarm's report
// path, the `BuildJob` DO alarm, the cron handler).
//
// Every key is present on every line of its shape (contract §D: "one JSON
// line ... with every field") — optional data is `null`, never an absent key,
// so a Loki query never has to guard a missing field. Per §E.4's operational-
// log rule, only a page-load id, a demo id and a cf-ray may identify a
// request; nothing else request-shaped is added here.

import type { Env } from "../env.js";
import { serviceVersion } from "./resource.js";

export interface RequestLineFields {
  route_class: string;
  status: number;
  duration_ms: number;
  cf_ray: string;
  session_id: string;
  demo_id: string;
}

export function logRequestLine(env: Env, fields: RequestLineFields): void {
  console.log(
    JSON.stringify({
      "log.kind": "api.request",
      route_class: fields.route_class,
      status: fields.status,
      duration_ms: fields.duration_ms,
      "cf.ray": fields.cf_ray || null,
      "session.id": fields.session_id || null,
      "hot.demo_id": fields.demo_id || null,
      "service.version": serviceVersion(env),
    }),
  );
}

/**
 * "Our own error line" (ADR §D): one structured JSON line for an error our
 * code caught rather than letting it escape uninstrumented. `context` is a
 * short, fixed label (a fingerprint-friendly tag, not free text) — never the
 * raw request; see `chat.ts`/`theme-ai.ts` for why a gateway failure's body is
 * kept out of every log line, this one included.
 */
export function logErrorLine(env: Env, context: string, err: unknown, extra?: Record<string, string | number | null>): void {
  console.error(
    JSON.stringify({
      "log.kind": "error",
      context,
      name: err instanceof Error ? err.name : "Error",
      message: err instanceof Error ? err.message : String(err),
      "service.version": serviceVersion(env),
      ...extra,
    }),
  );
}
