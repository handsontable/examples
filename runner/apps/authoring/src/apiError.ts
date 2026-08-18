// What an API failure means, in one place (DEV-2534).
//
// Before this module every caller hand-copied
// `throw new Error(body.error || "…failed (status)")`, which is how the Worker's
// wire string `{"error":"unauthorized"}` — sent from 15 places in
// `workers/api/src/index.ts` — ended up rendered to users as the word
// "unauthorized" and reported to Sentry as five separate issues (DEMOS-3, -6,
// -7, -B, -W). A 401 does not mean "unauthorized"; it means the session that was
// valid when the tab opened has since expired.
//
// This module only *describes* the failure. It deliberately does not act on it:
// the caller decides. `App.tsx` must not be redirected to the broker on a failed
// Save, because the user's edits live only in that tab's memory until the PATCH
// lands, while `MyDemos.tsx` has no unsaved state and can send them straight to
// sign-in. That split is the whole reason this returns a value instead of
// navigating.
//
// TWO CONSTRAINTS ON THIS FILE, both load-bearing:
//
//  1. It imports nothing. `pipeline/api-error.test.mjs` loads it directly under
//     `node --experimental-strip-types`, where a sibling `./x.js` specifier does
//     not resolve (the same rule `demoOwners.ts` records).
//  2. Erasable syntax only — no parameter properties, no `enum`. Both compile
//     fine and both hard-fail the type-stripping loader at import time, with an
//     error that points at this file rather than at the rule it broke.

/** What kind of failure this is, from the client's point of view. */
export type ApiFailureKind = "session-expired" | "forbidden" | "other";

/** The copy for the two classified branches, exported so the e2e spec can assert
 *  the exact strings rather than a regex that drifts from them. */
export const SESSION_EXPIRED_MESSAGE = "Your session expired. Sign in again to continue.";
export const FORBIDDEN_MESSAGE =
  "This demo belongs to someone else — only its owner can change it.";

/** Whatever JSON the Worker put in the error body. Both fields are optional
 *  because a 401 from a proxy, or a body that failed to parse, has neither. */
export interface ApiErrorBody {
  error?: string;
  detail?: string;
}

export interface ApiFailureOptions {
  /**
   * Ignore `body.error` for the unclassified statuses and use the caller's own
   * fallback copy instead.
   *
   * For the callsites that never read `body.error` in the first place —
   * `MyDemos`'s list and revoke, which throw their own sentences. Without this,
   * migrating them onto the shared helper would newly render the Worker's wire
   * string where a human sentence used to be, which is the same defect this
   * ticket is fixing, pointed the other way.
   */
  preferFallback?: boolean;
}

/** The caller's own copy for a failure this module has nothing better to say
 *  about. A function form exists for callers that inline their `fetch` and so
 *  have no `res` in scope to interpolate the status from. */
export type ApiFallback = string | ((status: number) => string);

/**
 * A described HTTP failure.
 *
 * `reportable` is read by `reportError` in `sentry.ts`: one gate there silences
 * the expired-session half of every existing callsite without touching any of
 * them. An ownership 403 is deliberately still reportable — the UI only draws
 * Save and Delete on a demo it believes is the user's, so a refusal is a genuine
 * UI/server disagreement worth an issue (DEV-2544), not noise.
 */
export class ApiError extends Error {
  status: number;
  kind: ApiFailureKind;
  reportable: boolean;

  constructor(message: string, status: number, kind: ApiFailureKind, reportable: boolean) {
    super(message);
    // Without this the class name is minified away and Sentry groups every
    // ApiError under whatever single letter the bundler picked.
    this.name = "ApiError";
    this.status = status;
    this.kind = kind;
    this.reportable = reportable;
  }
}

function resolveFallback(fallback: ApiFallback, status: number): string {
  return typeof fallback === "function" ? fallback(status) : fallback;
}

/**
 * Turn a non-OK response into the error the user should see.
 *
 * Pure: it takes the already-parsed body rather than the `Response`, so it is
 * testable without a fetch fake — and it takes the *whole* body, not just
 * `body.error`, or the 403 branch could not see `detail`.
 */
export function describeApiFailure(
  status: number,
  body: ApiErrorBody,
  fallback: ApiFallback,
  options: ApiFailureOptions = {},
): ApiError {
  if (status === 401) {
    // `body.error` is discarded on purpose. That discard is precisely what stops
    // the Worker's "unauthorized" from reaching a toast, and the branch must not
    // depend on a body that a proxy or a network edge may not have sent at all.
    return new ApiError(SESSION_EXPIRED_MESSAGE, status, "session-expired", false);
  }
  if (status === 403) {
    // The ownership refusals the browser actually hits send a bare
    // `{"error":"forbidden"}` (index.ts:887 and :954), so ownership is the
    // primary sentence and `detail` — sent only by the MCP route — refines it.
    const detail = typeof body.detail === "string" ? body.detail.trim() : "";
    const message = detail ? `${FORBIDDEN_MESSAGE} (${detail})` : FORBIDDEN_MESSAGE;
    return new ApiError(message, status, "forbidden", true);
  }
  const serverMessage = options.preferFallback ? "" : (body.error ?? "");
  return new ApiError(serverMessage || resolveFallback(fallback, status), status, "other", true);
}

/** Narrows to the one failure that means "sign in again". */
export function isSessionExpired(error: unknown): error is ApiError {
  return error instanceof ApiError && error.kind === "session-expired";
}
