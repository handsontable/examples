// One length-independent string comparison, for the two credential paths that
// need it: the MCP shared secret (`auth.ts`) and a persistent API token's stored
// digest (`token-store.ts`).
//
// Its own module rather than an export of either caller: `auth.ts` imports
// `token-store.ts`, so `token-store.ts` importing `auth.ts` back would make the
// graph cyclic. Imports nothing itself, so it loads under bare
// `--experimental-strip-types` alongside the other leaves.
//
// Workers has no `crypto.timingSafeEqual`, which is why this is hand-rolled.

/** Compare two strings without leaking where they first differ. */
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
