// Import-free on purpose (like `route-class.ts`) so `pipeline/` can import it
// under `--experimental-strip-types`.

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const ZERO_TRACE_ID = "0".repeat(32);

/**
 * The trace id of a `Span.spanContext()` result, or `""` when there is no real
 * one. workerd returns an all-zero context for a span that is not traced
 * (most requests at the 1% head sampling rate), and that must never be logged
 * or propagated.
 */
export function traceIdOf(ctx: unknown): string {
  const id = (ctx as { traceId?: unknown } | null | undefined)?.traceId;
  return typeof id === "string" && TRACE_ID_RE.test(id) && id !== ZERO_TRACE_ID ? id : "";
}
