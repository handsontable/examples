// What happens when the Tier-2 container pool has no slot left (DEV-2554).
//
// WHAT THIS STRING IS. `wrangler.jsonc` caps the pool at `max_instances: 5` for
// `Sandbox` and `3` for `BuilderSandbox`. That ceiling is ours and Cloudflare
// enforces it: past it, any RPC that would start a container rejects with
//
//   "Maximum number of running container instances exceeded. Try again later, or
//    try configuring a higher value for max_instances"
//
// raised by workerd itself, not by any package in this tree — there is no error
// code behind it, so a message match is the only signal available. Exactly the
// same exposure `preview-boot.ts` documents for `isPortNotListening`, and it is
// mitigated the same way: a match that stops firing degrades to TODAY'S behaviour
// (a 500 with the raw sentence, reported to Sentry), never to a swallowed error,
// and the verbatim string is pinned in `pipeline/pool-capacity.test.mjs` so a
// Cloudflare rewording fails a test loudly instead of quietly reverting the fix.
//
// WHY IT NEEDED HANDLING AT ALL. Untouched, that sentence falls through the
// catch-all at the bottom of `index.ts`'s `fetch`, which answers
// `500 {error: "<raw workerd sentence>"}` and calls `Sentry.captureException`. Two
// things go wrong. A capacity condition gets filed as our own unhandled fault; and
// on the create path the 500 reaches `describeRuntimeError` in
// apps/authoring/src/App.tsx, whose container-engine heuristic replaces the message
// with "run the local API worker (requires Docker)". A visitor on
// demos.handsontable.com who arrived while five other people were mid-demo would be
// told to install Docker — DEV-2538 / Sentry DEMOS-9 recurring on a status nobody
// had covered.
//
// NOT RAISING THE CAP. `docs/cost-guardrails.md` (ADR-0022) prices the saturated
// pool at ~$250-460/mo and says "Leave it at 5/3" verbatim. The observed rate does
// not argue with it: two genuine capacity events in 90 days, both on 2026-08-10.
// This module makes the refusal honest and recoverable; it does not buy more slots.
//
// Deliberately free of Cloudflare imports and of runtime sibling imports, the same
// constraint `preview-boot.ts` carries, so `pipeline/` can import this `.ts`
// directly under `--experimental-strip-types`.

/**
 * What we ask a refused client to wait before trying again.
 *
 * Short on purpose. A container that is finishing up frees its slot on a scale of
 * seconds, and the client budget is only three attempts — a long delay would spend
 * them all past the point where the visitor has given up and closed the tab. Sent
 * as `Retry-After` because it is correct HTTP; the client applies its own constant
 * rather than reading this back, so the two can be tuned independently.
 */
export const AT_CAPACITY_RETRY_AFTER_SECONDS = 5;

/** Bound on the `.cause` walk. A self-referencing cause is not hypothetical. */
const MAX_CAUSE_DEPTH = 5;

/**
 * Whether an error is Cloudflare refusing to start another container because the
 * configured `max_instances` ceiling is already met.
 *
 * Narrow on purpose, and narrow is the whole point: the neighbouring failures in
 * this project's own Sentry breakdown ("internal error connecting to the port",
 * "the container is not running", "sandbox.writeFile was interrupted") are either
 * somebody else's fix or undiagnosed, and both must keep today's status and today's
 * report. Widening this predicate would dress a real fault up as a soothing
 * "we're busy" that the visitor can do nothing about.
 */
export function isPoolExhausted(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error) || seen.has(current)) return false;
    seen.add(current);
    if (/maximum number of running container instances/i.test(current.message)) return true;
    current = current.cause;
  }
  return false;
}

export interface AtCapacityBody {
  /**
   * The machine-readable reason, and the entire signal the client keys on:
   * `SessionStartError.code === "at_capacity"` is what routes this past the
   * install-Docker heuristic in App.tsx and into the bounded retry. Renaming it
   * without renaming it there restores that misattribution silently.
   */
  error: "at_capacity";
  message: string;
  retryAfterSeconds: number;
}

/**
 * The refusal body for a create that found no free slot.
 *
 * The sentence is written for a person and deliberately drops the platform's own
 * wording, which ends by advising the reader to configure a higher `max_instances`
 * — advice for us, not for a visitor. It also states that the retry is automatic,
 * because it is: the client asks again on its own, and telling someone to "try
 * again" while it is already trying invites them to hammer a pool that is full.
 */
export function atCapacityBody(): AtCapacityBody {
  return {
    error: "at_capacity",
    message:
      "All live-demo slots are busy right now. Trying again in a moment — no need to change anything.",
    retryAfterSeconds: AT_CAPACITY_RETRY_AFTER_SECONDS,
  };
}
