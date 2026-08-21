// Persistent API tokens — the credential's own rules (DEV-2583, ADR-0037).
//
// Imports nothing and touches no binding, so `pipeline/api-token.test.mjs` can
// load it directly under `node --experimental-strip-types`, where a sibling
// `./x.js` specifier does not resolve — the same rule `demos-list.ts` records.
// Every D1 access lives in `token-store.ts`.
//
// A token is `hot_pat_<id>_<secret>`: the id is public (it is the D1 primary
// key, the display form, and what DELETE /api/tokens/:id names) and the secret
// is never stored. Only a SHA-256 digest of the whole string is kept, which is
// sound because this is a 256-bit random secret rather than a password — there
// is no dictionary to run and no low-entropy guess space to grind, so a work
// factor would cost every authenticated request and defend nothing (ADR-0037).

export const PAT_PREFIX = "hot_pat_";

/** Matches `normalizeProfileInput`'s cap on a display name — a label, not prose. */
export const MAX_TOKEN_NAME = 64;

const ID_CHARS = 16;
/** base64url over 32 bytes. Unpadded, so a fixed 43 characters. */
const SECRET_CHARS = 43;

/**
 * The one true shape. Parsed positionally rather than by splitting on `_`,
 * because base64url includes `_` and the secret may therefore contain one.
 */
const TOKEN_RE = new RegExp(
  `^${PAT_PREFIX}([0-9a-f]{${ID_CHARS}})_([A-Za-z0-9_-]{${SECRET_CHARS}})$`,
);

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Unpadded base64url — the alphabet a URL, a header and a shell all survive. */
function base64url(bytes: Uint8Array): string {
  let raw = "";
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Mint a token. The plaintext is returned once, to be handed to the caller and
 * then forgotten: only `hashToken(token)` is ever stored.
 */
export function mintToken(): { id: string; token: string } {
  const id = hex(crypto.getRandomValues(new Uint8Array(ID_CHARS / 2)));
  const secret = base64url(crypto.getRandomValues(new Uint8Array(32)));
  return { id, token: `${PAT_PREFIX}${id}_${secret}` };
}

/**
 * The public id inside a well-formed token, or null.
 *
 * Strict on purpose: a malformed `hot_pat_…` must be refused here rather than
 * fall through to the broker path, which would post our own permanent
 * credential to a third-party host (ADR-0037).
 */
export function parseTokenId(raw: string | null | undefined): string | null {
  const match = TOKEN_RE.exec(raw ?? "");
  return match ? match[1]! : null;
}

/**
 * Is this bearer value ours to verify?
 *
 * The prefix and nothing else. This decides *which* path a credential takes, so
 * it must answer without validating: a malformed token of ours is still ours,
 * and is refused locally rather than forwarded.
 */
export function isTokenBearerValue(raw: string | null | undefined): boolean {
  return (raw ?? "").startsWith(PAT_PREFIX);
}

/** SHA-256 hex of the whole token string — the only form we store. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return hex(new Uint8Array(digest));
}

/**
 * The `last_used_at` bound: the start of the hour containing `nowIso`.
 *
 * Used as `UPDATE … WHERE last_used_at IS NULL OR last_used_at < ?`, which
 * bounds the hot auth path to one effective write per token per clock hour in a
 * single atomic statement — no read-then-write, so nothing to race, and no
 * `ctx` to thread through the two dozen `authenticate()` call sites.
 */
export function touchThreshold(nowIso: string): string {
  const at = new Date(nowIso);
  at.setUTCMinutes(0, 0, 0);
  return at.toISOString();
}

/**
 * The `{ name }` a mint request carries. Required, unlike a display name: a
 * permanent credential nobody can identify in the list is one nobody dares
 * revoke.
 */
export function normalizeTokenName(
  body: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  const raw = (body as { name?: unknown } | null)?.name;
  if (typeof raw !== "string") return { ok: false, error: "name is required" };
  const value = raw.trim();
  if (!value) return { ok: false, error: "name is required" };
  if (value.length > MAX_TOKEN_NAME) {
    return { ok: false, error: `name must be ${MAX_TOKEN_NAME} characters or fewer` };
  }
  return { ok: true, value };
}
