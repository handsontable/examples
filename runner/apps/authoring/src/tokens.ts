// Client for the persistent API tokens routes (DEV-2583, ADR-0037).
//
// Shaped like `profile.ts`: inline `fetch`, the shared `readApiJson` /
// `assertApiOk` describers, and the same `authHeaders()` idiom. There is no
// caching here on purpose — a listing of live credentials must never be painted
// from a stale copy, because the one question it answers is "what is still able
// to act as us right now".

import { assertApiOk, readApiJson } from "./api.js";
import { getToken } from "./auth.js";

/** A token as the listing shows it. No digest, no plaintext — the server never
 *  selects the former and only ever answers the latter once, on mint. */
export interface ApiToken {
  id: string;
  name: string;
  created_by: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
}

/** The mint response: the listing row plus the one and only sight of the token. */
export interface MintedToken extends ApiToken {
  token: string;
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const FALLBACK = (status: number) => `Request failed (${status}).`;

export async function fetchTokens(apiBase: string): Promise<ApiToken[]> {
  const body = await readApiJson<{ tokens: ApiToken[] }>(
    await fetch(`${apiBase}/api/tokens`, { headers: authHeaders(), cache: "no-store" }),
    FALLBACK,
  );
  return body.tokens;
}

export async function mintApiToken(apiBase: string, name: string): Promise<MintedToken> {
  return readApiJson<MintedToken>(
    await fetch(`${apiBase}/api/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ name }),
    }),
    FALLBACK,
  );
}

export async function revokeApiToken(apiBase: string, id: string): Promise<void> {
  await assertApiOk(
    await fetch(`${apiBase}/api/tokens/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: authHeaders(),
    }),
    FALLBACK,
  );
}
