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
 * Minor triage item 2 (C-M2): one structured JSON line per API-worker
 * five-minute cron tick, through the same OTLP-exported `console.log` path every other
 * `lines.ts` line uses. Before this, a quiet period with NO real user
 * traffic (no `session.start`, no `api.request`) looked identical, from the
 * o11y worker's `heartbeat.lastIngest` side, to the ingest pipeline itself
 * being broken — the watchdog (`o11y-watchdog.ts`) could page on nothing
 * more than an empty five minutes. This line makes `lastIngest` a true
 * end-to-end check: it only advances when a record actually made it through
 * export → `/telemetry/v1/logs` → `InboxWriter`.
 *
 * `"cron.tick"` is deliberately NOT added to `normalise/otlp.ts`'s
 * `TRUSTED_BODY_JSON_LOG_KINDS` allowlist (that file is owned by a different
 * task) — confirmed unnecessary: `toIngestItem` only skips a record for
 * being oversize; an untrusted `log.kind` just means the body-JSON fields
 * are not hoisted into structured attributes, not that the record itself is
 * dropped, so this line still bumps `lastIngest` unmodified.
 */
export function logCronTickLine(env: Env): void {
  console.log(
    JSON.stringify({
      "log.kind": "cron.tick",
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
