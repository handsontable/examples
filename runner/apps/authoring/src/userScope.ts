// Sentry user-context wiring (DEV-2859). Deliberately trivial and
// decision-free — the decisions (what id to mint, what auth_mode is, how to
// hash an email) live in `identity.ts`, which is import-free and unit-tested.
// This module cannot be: it imports `@sentry/react` via `./sentry.js`, which
// `node --test` cannot resolve (same reason as `sentry.ts` itself).
//
// Wrapped in `reportingEnabled` throughout: off-host (local dev, CI, a
// Playwright run against production — see `reportingGate.ts`) this must write
// no storage key and call no Sentry API, the same guarantee the rest of the
// reporting surface makes.

import { Sentry, reportingEnabled } from "./sentry.js";
import { authMode, hashedUserId, visitorId, type AuthModeInputs } from "./identity.js";

/** Mirrors `PAT_PREFIX` in auth.ts (see identity.ts's `authMode`). Duplicated
 *  rather than imported: auth.ts already imports this module's sibling
 *  `sentry.ts`, and a cycle back into auth.ts is not worth avoiding a second
 *  literal. */
const PAT_PREFIX = "hot_pat_";

/**
 * `identity.ts`'s `visitorId` catches a throwing storage's *method calls*
 * (`getItem`/`setItem`) — but in a locked-down environment (Safari with all
 * site storage denied by policy) merely reading the global `sessionStorage`
 * accessor can itself throw, at the argument-evaluation site, before
 * `visitorId` ever gets a value to call a method on. This is the one path in
 * this whole feature that could white-screen the app it exists to observe, so
 * the access is guarded here rather than assumed safe. */
function safeSessionStorage(): Storage | { getItem(): null; setItem(): void } {
  try {
    return sessionStorage;
  } catch {
    return { getItem: () => null, setItem: () => {} };
  }
}

/**
 * Seed anonymous context. Called synchronously from `main.tsx`, before
 * `createRoot`, so a crash while the module graph is still evaluating is
 * already attributable to a visitor id. Never calls `currentUser()` — that
 * would round-trip the Render-hosted broker and add its latency to every
 * route, including the ones that need no identity at all.
 */
export function seedAnonymousContext(): void {
  if (!reportingEnabled) return;
  const id = visitorId(safeSessionStorage());
  Sentry.setUser({ id });
  Sentry.setTag("auth_mode", "anonymous");
}

export interface ApplyUserContextInputs {
  /** `import.meta.env.VITE_DEV_USER`, forwarded from the caller so this module
   *  stays free of `import.meta.env` reads (it already imports the SDK, so
   *  that constraint is about keeping the *set of things* that changes small,
   *  not about testability — this file was never going to be node-importable). */
  devUser?: string;
  token?: string | null;
}

/**
 * Upgrade (or re-seed) the user context once identity is known: the
 * dev-bypass early return and the resolved-user return in `auth.ts`'s
 * `currentUser()`.
 *
 * Never sets `email`, `username`, or any raw address — only the hash from
 * `identity.ts`. `sendDefaultPii` stays unset in `sentry.ts`; this function is
 * the only place a `User`'s identity reaches Sentry at all, and it never
 * reaches for the field that would leak it.
 */
export async function applyUserContext(
  user: { email: string } | null,
  { devUser, token }: ApplyUserContextInputs,
): Promise<void> {
  if (!reportingEnabled) return;
  const mode = authMode({ devUser, token, user } satisfies AuthModeInputs, PAT_PREFIX);
  if (!user) {
    resetUserContext();
    return;
  }
  // The dev-bypass email is hashed like any other — see `authMode`'s note on
  // why `auth_mode` itself is what makes a `dev-bypass` leak visible, not a
  // special case here.
  const id = await hashedUserId(user.email);
  Sentry.setUser({ id });
  Sentry.setTag("auth_mode", mode);
}

/**
 * Drop back to an anonymous identity: the 401 path in `currentUser()` and
 * `clearSession()`. Re-mints from `visitorId` rather than clearing the user
 * entirely, so a signed-out session still carries *some* identity instead of
 * reverting to the pre-DEV-2859 "no user context at all" state.
 */
export function resetUserContext(): void {
  if (!reportingEnabled) return;
  const id = visitorId(safeSessionStorage());
  Sentry.setUser({ id });
  Sentry.setTag("auth_mode", "anonymous");
}
