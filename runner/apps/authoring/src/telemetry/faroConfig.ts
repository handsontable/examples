// Faro batching and delivery settings, sized against the ingest rate limit
// (`workers/o11y/wrangler.jsonc` `ratelimits`, runbook "Ingest rate limit").
// Import-free so `pipeline/faro-config.test.mjs` can pin them.

/** One POST per tab at most every 5 s (12/min). Faro also flushes the buffer
 *  on `visibilitychange` → hidden, and redelivers queued retries on `pagehide`. */
export const FARO_BATCHING = { enabled: true, sendTimeout: 5_000, itemLimit: 50 } as const;

/** Above the 429's `Retry-After: 60` plus Faro's 0–20 % jitter, so a 429'd batch
 *  waits out the limiter window instead of being dropped as "retry-after-too-long". */
export const FARO_RETRY = { maxAttempts: 3, initialBackoffMs: 1_000, maxBackoffMs: 75_000, backoffMultiplier: 2 } as const;

/** Batches admitted to the delivery queue, including those waiting to retry;
 *  Faro drops a new batch while all are taken. Bounds memory at 30 × `itemLimit`. */
export const FARO_BUFFER_SIZE = 30;
