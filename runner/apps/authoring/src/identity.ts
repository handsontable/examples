// Visitor / user identity decisions for Sentry context (DEV-2859).
//
// Import-free by construction, same reason and same constraint as
// `reportingGate.ts` / `fetchFailure.ts` / `sessionDiagnostics.ts`: this is the
// one piece of `pipeline/*.test.mjs` can import directly under
// `--experimental-strip-types`, because the Sentry-touching wiring
// (`userScope.ts`, `main.tsx`, `auth.ts`) imports `@sentry/react` and/or reads
// `import.meta.env`, neither of which node resolves. Do not let this file grow
// imports — a sibling `./x.js` specifier does not resolve under strip-types
// either (verified empirically against a throwaway probe file).
//
// WHY THIS EXISTS AT ALL: every `setUser` call in `apps/**` turns out to be
// React local state — nothing ever calls `Sentry.setUser`, `Sentry.setTag`, or
// sets `sendDefaultPii`. That is why every Sentry issue in this project reports
// `users: 0`, and why a "0 users" reading misled an earlier triage into
// suppressing a population that was, in fact, affecting real visitors.

/** Storage the visitor id is minted into and read from. A narrow structural
 *  type (not `Storage` itself) so a test can hand in a throwing fake without
 *  implementing the full Web Storage interface. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Same key `auth.ts` uses for the broker/API token — sessionStorage, not
 *  localStorage. Deliberately: localStorage would mint a new persistent
 *  pseudonymous identifier on a public site, which is a bigger privacy
 *  commitment than this instrumentation is trying to make. The cost of that
 *  choice is stated once, here, because it is easy to forget while reading a
 *  Sentry issue: a reload mints a new id, so `users` on an anonymous issue
 *  counts *sessions*, not people. It is a floor, not a headcount. */
const VISITOR_ID_KEY = "hot_sid";

function randomId(): string {
  // `crypto.randomUUID` is available in every browser this app supports and
  // in Node 22 (used by the test only to prove the mint path is exercised).
  return `s_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

/**
 * Read the existing visitor id, or mint and persist one.
 *
 * Must tolerate a throwing storage without throwing itself — Safari private
 * mode (and any browser with storage disabled by policy) throws on
 * `sessionStorage.getItem`/`setItem`, and an identity helper crashing the app
 * it exists to observe would be exactly backwards. A storage that throws
 * degrades to "a fresh id every call", which is honest: nothing persisted, so
 * nothing to read back next time either.
 */
export function visitorId(storage: KeyValueStorage): string {
  try {
    const existing = storage.getItem(VISITOR_ID_KEY);
    if (existing) return existing;
    const minted = randomId();
    storage.setItem(VISITOR_ID_KEY, minted);
    return minted;
  } catch {
    return randomId();
  }
}

/**
 * `"u_" + sha256(lowercased, trimmed email).slice(0, 16)`, via `crypto.subtle`
 * (available in every browser this app supports, and in Node >= 19 including
 * the Node 22 this test suite runs under).
 *
 * Privacy, stated honestly rather than oversold: over a known internal
 * address list (this is a Google-login-gated internal tool — see auth.ts) a
 * truncated hash is reversible *by us*, e.g. by hashing every
 * @handsontable.com address and comparing. The goal is "never ship a raw
 * address to a third party" (Sentry), not anonymisation against someone who
 * already has the address list. No `email`, no `username`, no raw address is
 * ever set anywhere in this module or its callers.
 */
export async function hashedUserId(email: string): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const bytes = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `u_${hex.slice(0, 16)}`;
}

export type AuthMode = "anonymous" | "google" | "api-token" | "dev-bypass";

export interface AuthModeInputs {
  /** `import.meta.env.VITE_DEV_USER` — truthy means the local dev bypass in
   *  `auth.ts`'s `currentUser()` short-circuited. Passed in as a value, never
   *  read here, so this module stays import-free of `import.meta.env`. */
  devUser?: string;
  /** The stored broker/API token (`getToken()` in auth.ts), or null/undefined
   *  when signed out. */
  token?: string | null;
  /** The resolved user, when `currentUser()` succeeded. */
  user?: { email: string } | null;
}

/** Mirrors `PAT_PREFIX` in auth.ts — passed in rather than imported, same
 *  reason every other input here is passed in. */
export function authMode({ devUser, token, user }: AuthModeInputs, patPrefix: string): AuthMode {
  // Checked first and independent of `user`: the dev bypass in auth.ts returns
  // a `User` too (`{ email: devUser }`), so `auth_mode` would otherwise read
  // "google" for a local dev session. This value doubles as a tripwire for the
  // exact leak the `dist` grep in AGENTS.md exists to catch — a build that
  // reports `dev-bypass` traffic in production means `VITE_DEV_USER` shipped.
  if (devUser) return "dev-bypass";
  if (!user) return "anonymous";
  if (token?.startsWith(patPrefix)) return "api-token";
  return "google";
}
