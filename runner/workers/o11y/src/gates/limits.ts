// Size caps (ADR §B.5 "size caps"). Spike (b)'s sandbox probe was meant to
// measure real body sizes under load (task file, "Sandbox probe" section:
// "body sizes, batches per minute"); the probe section of this task's Outcome
// records what was actually captured. Until real traffic is measured, these
// are conservative, documented defaults (T02-D), not derived numbers:
//
// - `COLLECT_MAX_BYTES`: a Faro `transportBody` batch. 1 MB matches the
//   contract's own `LOKI_REQUEST_MAX_BYTES` (inbox.ts) — a batch bigger than
//   what one drain push can carry decompressed is already unreasonable.
// - `OTLP_MAX_BYTES`: a Cloudflare log-export batch. 4 MB matches
//   `PACK_AT_BYTES` (inbox.ts) for the same reason, generous because export
//   batches are Cloudflare's own aggregation, not ours to shrink.
// - `SMALL_JSON_MAX_BYTES`: `deploy` and `hooks/sentry` payloads are small,
//   hand-shaped JSON objects — 64 KB is already generous.
export const COLLECT_MAX_BYTES = 1_000_000;
export const OTLP_MAX_BYTES = 4_000_000;
export const SMALL_JSON_MAX_BYTES = 64_000;

/** Cheap pre-check against the `Content-Length` header, when the client sent
 *  one — not the enforcement itself (a chunked/absent `Content-Length` must
 *  not bypass the cap), just an early exit so an obviously oversized request
 *  never gets its body read at all. The real cap is enforced while reading
 *  the body (`normalise/read-body.ts`'s `readCappedText`). */
export function contentLengthExceeds(req: Request, maxBytes: number): boolean {
  const len = req.headers.get("content-length");
  if (!len) return false;
  const n = Number(len);
  return Number.isFinite(n) && n > maxBytes;
}
