// Small helpers shared by every gate (ADR §B.5). Its own file, not a copy
// inside each gate, since more than one gate needs a constant-time compare
// (`secret.ts`, `sentry.ts`) and every gate needs the same "write an
// `o11y.ingest` dropped point, then answer" shape (`respond.ts` builds on
// this — see that file for the actual point-writing).

/** Compare two strings without leaking where they first differ. Workers has
 *  no `crypto.timingSafeEqual`, so this is hand-rolled — mirrors
 *  `workers/api/src/constant-time.ts`, not imported from it (that file lives
 *  in a different worker's source tree; duplicating nineteen lines is
 *  cheaper than a cross-worker dependency). */
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** HMAC-SHA256 of `body` under `secret`, lowercase hex — Sentry's webhook
 *  signature scheme (`sentry.ts`) and a general-purpose primitive any future
 *  HMAC gate can reuse. */
export async function hmacSha256Hex(secret: string, body: ArrayBuffer | string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bodyBytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const sig = await crypto.subtle.sign("HMAC", key, bodyBytes);
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 of `text`, lowercase hex — used by `normalise/hash.ts` for the
 *  dedupe hash (ADR §B.2 step 2), exported here because every gate/normalise
 *  module already imports this file. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The production hostname every o11y route lives on (`docs/observability-contract.md`
 *  §1). Not derived from `env` — Faro requests are same-origin only, and a Worker
 *  reads its own hostname off the request, so there is nothing to inject; kept as one
 *  named constant so a future domain change is a one-line edit. */
export const PRODUCTION_HOST = "demos.handsontable.com";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

/** ADR §B.5 host gate for `collect`/`lite`: the production host, or `localhost`
 *  only when `O11Y_ENV === "local"`. Reads `Origin` first, falling back to
 *  `Referer` (Faro's `beforeSend`/transport always sets `Origin` on same-origin
 *  POSTs; `Referer` is the defensive fallback for a client that only sets that). */
export function requestHost(req: Request): string | null {
  const origin = req.headers.get("Origin") ?? req.headers.get("Referer");
  if (!origin) return null;
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
}

export function isAllowedHost(host: string | null, o11yEnv: "production" | "local"): boolean {
  if (host === PRODUCTION_HOST) return true;
  if (o11yEnv === "local" && host !== null && LOCAL_HOSTS.has(host)) return true;
  return false;
}
