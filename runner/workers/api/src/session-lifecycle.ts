// The two decisions the Tier-2 session lifecycle makes about a container the
// platform will not give us (DEV-2556): what a *teardown* does when the pool
// refuses it, and what a visitor is told when a *create* is refused.
//
// Sentry DEMOS-1 caught the first half. Two `DELETE /api/session/:id` calls,
// 328 ms apart, threw "Maximum number of running container instances exceeded"
// out of `sandbox.destroy()`, through the outer catch in `index.ts`, into a 500
// and a Sentry event. The causal story is the inverse of what it looks like: an
// instance that cannot be allocated is not occupying one of the five slots, so a
// failed teardown is a *symptom* of a full pool and never a contributor to one.
// Nothing leaked. And nobody read the 500 either — `deleteSession()` in
// packages/runtime/src/container.ts is `void fetch(…, { keepalive: true })
// .catch(() => {})`, fired from `pagehide`. The release path was the only
// `destroy()` in `index.ts` that was not already best-effort; its two siblings
// (`closedWhileCreating`, the closed-tier teardown) both swallow.
//
// Deliberately free of Cloudflare imports and of runtime sibling imports, and
// written in erasable syntax only (no enum, no parameter properties), so
// `pipeline/` can import this `.ts` directly under `--experimental-strip-types`
// — the same constraint `preview-boot.ts` and `monitor-inject.ts` document.
// `index.ts` is a Worker entrypoint and cannot be imported that way at all,
// which is exactly why both decisions are lifted out of it: this module is the
// only seam either one can be tested through.

// ---- the tombstone state machine ------------------------------------------
//
// `session-tombstone:<id>` in KV is written before a teardown and read by the
// resurrection gate in `index.ts` (any RPC on a destroyed session auto-boots a
// fresh container under the dead id, so every session-scoped route checks it
// first). It now carries two states instead of one, which is what makes a
// duplicate DELETE free rather than a container boot in order to destroy one.

/** A teardown was started for this session. What the gate has always written,
 *  kept byte-identical so a rolling deploy and any legacy marker still in KV
 *  keep working — `isTombstoned` treats any non-null value as tombstoned. */
export const TOMBSTONE_ATTEMPTED = "1";

/** `destroy()` resolved. The ONLY value that lets a later DELETE answer from KV
 *  without touching the sandbox. */
export const TOMBSTONE_DESTROYED = "destroyed";

/** Ten minutes, comfortably past `sleepAfter = "5m"` in `index.ts`: a marker
 *  must outlive the container it guards, or a straggler request resurrects one
 *  under a dead id. Also the ceiling on how long a DELETE stays idempotent. */
export const TOMBSTONE_TTL_SECONDS = 600;

/**
 * Whether we have watched this session's container actually go away.
 *
 * True for exactly one literal. `null` (no marker), `"1"` (a teardown was
 * attempted, outcome unknown) and anything unrecognised all mean "still needs
 * the RPC" — the direction a mistake has to fail in. Answering `true` for an
 * attempt would turn a transient destroy failure into a guaranteed leak, since
 * the retry a failed teardown depends on is the *next* DELETE.
 *
 * True is a statement about a container *generation*, not about an id, so it
 * only licenses a skip where nothing can have booted a fresh container under
 * the same id since. That holds for a repeated `DELETE /api/session/:id` (the
 * resurrection gate refuses every other route on a tombstoned session). It does
 * NOT hold in `closedWhileCreating`, whose entire premise is that a create kept
 * running past the DELETE and built a second container — that path must always
 * destroy, and only writes the confirmation afterwards.
 */
export function destroyConfirmed(marker: string | null | undefined): boolean {
  return marker === TOMBSTONE_DESTROYED;
}

// ---- platform failure classification --------------------------------------

/** Bound on the `.cause` walk. A self-referencing cause is not hypothetical. */
const MAX_CAUSE_DEPTH = 5;

/** Test a message pattern against an error and its causes.
 *
 *  Non-`Error` throws answer false everywhere: these strings are raised by
 *  workerd and by the containers SDK, both of which throw real Errors, so a
 *  bare string carrying the same words is somebody else's — and unrecognised is
 *  the safe answer for every caller here. */
function messageMatches(err: unknown, pattern: RegExp): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error) || seen.has(current)) return false;
    seen.add(current);
    if (pattern.test(current.message)) return true;
    current = current.cause;
  }
  return false;
}

/** The pool is full. The DEMOS-1 message, and the only one of the three that
 *  supports telling a visitor "we are at capacity". */
const AT_CAPACITY_PATTERN = /maximum number of running container instances exceeded/i;

/** The other two ways the platform says "there is no container here to talk to
 *  right now" — both seen on this project, the first in the same Sentry group. */
const SERVICE_UNREACHABLE_PATTERN = /container service is unreachable/i;
const NOT_RUNNING_PATTERN = /container is not running/i;

/**
 * Whether a failed `destroy()` is the platform declining rather than a teardown
 * regression.
 *
 * All three messages mean the same thing for a release: there is nothing here
 * to destroy right now, and there is no slot being held by whatever we failed
 * to reach. The caller answers 204 and logs; anything that does NOT match is
 * rethrown and keeps today's status and today's Sentry event.
 *
 * DEGRADE DIRECTION, documented like `isPortNotListening`: these strings come
 * from the platform, not from any package in this repo, so a message match is
 * the only signal available. If Cloudflare rewords one, this predicate stops
 * matching and the case falls back to report-and-500 — noisy, never silent.
 */
export function isExpectedTeardownFailure(err: unknown): boolean {
  return (
    messageMatches(err, AT_CAPACITY_PATTERN) ||
    messageMatches(err, SERVICE_UNREACHABLE_PATTERN) ||
    messageMatches(err, NOT_RUNNING_PATTERN)
  );
}

/**
 * Whether a failed *create* means the instance pool is full.
 *
 * Narrower than the teardown predicate on purpose: only the capacity message
 * supports the sentence below. "The container is not running" and "the service
 * is unreachable" are different faults, and the client already has an honest
 * tier for an unavailable service (`sessionStartMessage`, DEV-2553).
 */
export function isAtCapacityFailure(err: unknown): boolean {
  return messageMatches(err, AT_CAPACITY_PATTERN);
}

/** Machine-readable reason on the 503 envelope. `sessionStartMessage` in
 *  packages/runtime/src/container.ts matches this exact code to pass the
 *  sentence below through to the user unwrapped. */
export const AT_CAPACITY_CODE = "at_capacity";

/**
 * What a visitor sees when every live-preview slot is taken.
 *
 * Today they get the platform's own words instead — "…try configuring a higher
 * value for max_instances", an instruction to us, wrapped in a 500. Two things
 * constrain this sentence:
 *  - It must contain none of /failed to fetch|networkerror|load failed|session
 *    start failed|fetch/i. `describeRuntimeError` in apps/authoring/src/App.tsx
 *    REPLACES any container message matching that alternation with "install
 *    Docker and run the local API worker", which is the wrong answer for a
 *    visitor on demos.handsontable.com (DEMOS-9, DEV-2538/DEV-2553).
 *  - It must not leak `max_instances` or any other knob only we can turn.
 * `pipeline/session-lifecycle.test.mjs` pins both.
 */
export const atCapacityMessage =
  "All live-preview sandboxes are busy right now. Nothing is wrong with the code — try again in a minute.";
