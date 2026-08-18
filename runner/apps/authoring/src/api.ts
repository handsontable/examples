// The shared response reader every authed `fetch` in this app goes through
// (DEV-2534).
//
// `apiError.ts` decides what a failure *means*; this decides what to do about it
// before the caller ever sees it. There is exactly one side effect here, and it
// is the reason this file exists separately from the leaf: an expired session
// clears the token immediately, so the dead credential cannot drive another
// request and the next `currentUser()` answers null instead of round-tripping a
// token the broker has already rejected.
//
// Not testable in `pipeline/` — it imports `auth.js`, which reads
// `sessionStorage` and `import.meta.env`. The 401 path is covered end to end in
// `e2e/authed-actions.spec.ts`, which asserts `hot_token` is gone afterwards.

import { clearSession } from "./auth.js";
import {
  ApiError,
  describeApiFailure,
  type ApiFallback,
  type ApiErrorBody,
  type ApiFailureOptions,
} from "./apiError.js";

async function failureFor(
  res: Response,
  fallback: ApiFallback,
  options?: ApiFailureOptions,
): Promise<ApiError> {
  // `.catch` because an error body is not guaranteed to be JSON — a 502 from an
  // edge in front of the Worker is HTML, and letting that parse failure throw
  // would replace the described failure with a SyntaxError.
  const body = (await res.json().catch(() => ({}))) as ApiErrorBody;
  const error = describeApiFailure(res.status, body, fallback, options);
  if (error.kind === "session-expired") clearSession();
  return error;
}

/** Read a JSON response, throwing a described `ApiError` when it is not OK. */
export async function readApiJson<T>(
  res: Response,
  fallback: ApiFallback,
  options?: ApiFailureOptions,
): Promise<T> {
  if (!res.ok) throw await failureFor(res, fallback, options);
  return (await res.json()) as T;
}

/** The same check for the endpoints that answer with no body — `DELETE` returns
 *  204, and `Response.ok` already covers the whole 2xx range. */
export async function assertApiOk(
  res: Response,
  fallback: ApiFallback,
  options?: ApiFailureOptions,
): Promise<void> {
  if (!res.ok) throw await failureFor(res, fallback, options);
}
