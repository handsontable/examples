// The signed-in user's profile (DEV-2166) — name, description, avatar.
//
// Why this caches in sessionStorage rather than just fetching on mount: there is
// no client-side router anywhere in this app, so every navigation is a full page
// load, and the avatar is on the top bar of *every* signed-in page. Worse,
// `GET /api/profile` costs the Worker a `/broker/userinfo` round trip to a
// Render-hosted service before it answers. Fetching on each load would put that
// on the editor's critical path for every click. Cached, the monogram or the
// last-known avatar paints immediately and the network answer only corrects it.
//
// Two things keep the cache from ever showing one user another's name: `logout()`
// drops this key along with the token, and every read is checked against the
// email it was stored for — a token swap that never went through `logout()`
// (the broker redirect hash sets one directly) would otherwise leave the
// previous user's avatar painted until the network answered. It is not a
// security boundary either way: the server decides whose row this is.

import { getToken, PROFILE_CACHE_KEY } from "./auth.js";
import { reportError } from "./sentry.js";

/** Mirrors `ProfileView` in `workers/api/src/profile-store.ts`. */
export interface Profile {
  email: string;
  /** Always populated — the stored name, else derived from the address
   *  (`name.surname` -> `Name Surname`, ADR-0007). */
  display_name: string;
  /** What is actually in the row. `null` means "not set", which is what the
   *  Settings form shows as an empty field rather than pre-filling the default
   *  and making it look saved. */
  saved_name: string | null;
  description: string | null;
  avatar_url: string | null;
  initial: string;
}

const CACHE_KEY = PROFILE_CACHE_KEY;

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** The cached profile, but only if it belongs to `email`. A stale row from a
 *  previous sign-in in the same tab is discarded rather than painted. */
export function cachedProfile(email: string): Profile | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const profile = JSON.parse(raw) as Profile;
    return profile.email === email ? profile : null;
  } catch {
    // Corrupt or unavailable storage is not worth an error path — the fetch
    // below is authoritative either way.
    return null;
  }
}

export function cacheProfile(profile: Profile | null): void {
  try {
    if (profile) sessionStorage.setItem(CACHE_KEY, JSON.stringify(profile));
    else sessionStorage.removeItem(CACHE_KEY);
  } catch {
    /* storage full or blocked; the app works uncached */
  }
}

async function readJson(res: Response): Promise<Profile> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Request failed (${res.status}).`);
  }
  return (await res.json()) as Profile;
}

export async function fetchProfile(apiBase: string): Promise<Profile> {
  const profile = await readJson(await fetch(`${apiBase}/api/profile`, { headers: authHeaders() }));
  cacheProfile(profile);
  return profile;
}

export async function saveProfile(
  apiBase: string,
  input: { display_name: string | null; description: string | null },
): Promise<Profile> {
  const profile = await readJson(
    await fetch(`${apiBase}/api/profile`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(input),
    }),
  );
  cacheProfile(profile);
  return profile;
}

/** The file is sent as the raw body: the server sniffs its leading bytes and
 *  ignores whatever `Content-Type` we set, so a multipart wrapper would buy
 *  nothing but parsing. */
export async function uploadAvatar(apiBase: string, file: File): Promise<Profile> {
  const profile = await readJson(
    await fetch(`${apiBase}/api/profile/avatar`, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream", ...authHeaders() },
      body: file,
    }),
  );
  cacheProfile(profile);
  return profile;
}

export async function removeAvatar(apiBase: string): Promise<Profile> {
  const profile = await readJson(
    await fetch(`${apiBase}/api/profile/avatar`, { method: "DELETE", headers: authHeaders() }),
  );
  cacheProfile(profile);
  return profile;
}

/**
 * Read-only access for the surfaces that merely *display* the profile — the top
 * bar on every page, and the My Demos author line. Returns the cached value
 * first (possibly null) and refreshes in the background.
 *
 * A failure here is deliberately silent: the fallbacks derived from the email
 * are always correct enough to render, and a toast about a profile nobody asked
 * for would be noise on a page that is doing something else.
 */
export function loadProfileInBackground(
  apiBase: string,
  onResolved: (profile: Profile) => void,
): () => void {
  let live = true;
  void fetchProfile(apiBase)
    .then((profile) => { if (live) onResolved(profile); })
    .catch((e) => reportError(e, "profile-load"));
  return () => { live = false; };
}
