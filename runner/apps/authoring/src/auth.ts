// Handsontable Google login broker client (ADR-0007). Internal team only —
// the broker rejects non-@handsontable.com accounts. The token is per-user,
// per-session; kept in sessionStorage, never persisted or logged.

import { reportError } from "./sentry.js";

const BROKER = import.meta.env.VITE_LOGIN_BROKER_URL || "https://mcp-auth-proxy-j0tb.onrender.com";
const TOKEN_KEY = "hot_token";
/** The cached profile (DEV-2166). Declared beside the token because it shares
 *  the token's lifetime, and because `logout()` has to know to drop it — see
 *  `profile.ts` for why the cache exists at all. */
export const PROFILE_CACHE_KEY = "hot_profile";

export interface User {
  email: string;
  sub?: string;
  exp?: number;
}

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

/** Resolve the current user: consume a fresh #token from the broker redirect,
 *  else use the stored token. Returns null if not signed in / token invalid. */
export async function currentUser(): Promise<User | null> {
  // Local dev bypass — set VITE_DEV_USER in .env.local; never set in production.
  const devUser = import.meta.env.VITE_DEV_USER as string | undefined;
  if (devUser) return { email: devUser };

  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get("error")) {
    console.error("login error:", hash.get("error"));
    return null;
  }
  let token = hash.get("token") || getToken();
  if (hash.get("token")) {
    token = hash.get("token");
    sessionStorage.setItem(TOKEN_KEY, token!);
    history.replaceState(null, "", location.pathname + location.search); // strip token from URL
  }
  if (!token) return null;

  try {
    const res = await fetch(`${BROKER}/broker/userinfo`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      sessionStorage.removeItem(TOKEN_KEY);
      return null;
    }
    return (await res.json()) as User;
  } catch (error) {
    // The broker being unreachable presents as "signed out" with no explanation,
    // and every write endpoint then rejects.
    reportError(error, "broker-userinfo");
    return null;
  }
}

export function login(): void {
  // Include the query so the deep-linked example/version survives the round-trip.
  const returnTo = location.origin + location.pathname + location.search;
  location.href = `${BROKER}/broker/login?return_to=${encodeURIComponent(returnTo)}`;
}

/**
 * Drop the stored credentials without navigating anywhere.
 *
 * Split out of `logout()` for DEV-2534: a request that comes back 401 has to
 * discard the token too — the broker has already rejected it, and keeping it
 * means every later call carries a credential that will be refused while
 * `currentUser()` keeps paying for the round trip that discovers this. That path
 * must *not* reload or redirect, though: the tab may be holding unsaved work,
 * which is why this is the half of `logout()` without the navigation.
 */
export function clearSession(): void {
  sessionStorage.removeItem(TOKEN_KEY);
  // The cached profile (DEV-2166) goes with the token, or the next person to
  // sign in on this tab sees the previous one's name and avatar until the
  // network corrects it. Removed by name rather than `sessionStorage.clear()`:
  // this key is ours, the rest of the origin's storage is not.
  sessionStorage.removeItem(PROFILE_CACHE_KEY);
}

/**
 * Drop the session and leave the page.
 *
 * `returnTo` matters on the auth-gated routes. Reloading in place is correct on
 * `/` and `/share/:id`, which work fine anonymously — the visitor keeps the
 * example they were looking at. But `/edit/:id` and `/my-demos` answer a null
 * user by calling `login()`, so a reload there sends the person who just logged
 * out straight back to the broker with `return_to` pointing at the page they
 * were trying to leave. Those callers pass a public surface instead.
 */
export function logout(returnTo?: string): void {
  clearSession();
  if (returnTo) {
    location.href = returnTo;
    return;
  }
  location.reload();
}
