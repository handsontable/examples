// Platform limits on storage keys and object names built from request input.
// Import-free so pipeline specs can load it directly under strip-types.

const encoder = new TextEncoder();

/** Workers KV rejects a key over 512 UTF-8 bytes (and an empty one) by throwing. */
export const KV_KEY_MAX_BYTES = 512;

/** R2 rejects an object key over 1024 UTF-8 bytes by throwing. */
export const R2_KEY_MAX_BYTES = 1024;

/** Longest client-supplied Tier-2 session id we accept; minted ids are ~30 bytes. */
export const SESSION_ID_MAX_BYTES = 128;

const byteLength = (value: string): number => encoder.encode(value).length;

/** True when `key` is a legal KV key, measured in UTF-8 bytes rather than UTF-16 units. */
export function kvKeyFits(key: string): boolean {
  const bytes = byteLength(key);
  return bytes > 0 && bytes <= KV_KEY_MAX_BYTES;
}

/** True when `key` is a legal R2 object key. */
export function r2KeyFits(key: string): boolean {
  const bytes = byteLength(key);
  return bytes > 0 && bytes <= R2_KEY_MAX_BYTES;
}

/** True when a client-supplied session id is short enough to become a KV key suffix and a DO name. */
export function sessionIdFits(sessionId: string): boolean {
  const bytes = byteLength(sessionId);
  return bytes > 0 && bytes <= SESSION_ID_MAX_BYTES;
}

/** What `/api/versions/exists` accepts: a semver or npm dist-tag shape, ASCII only. */
export const VERSION_QUERY_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;
