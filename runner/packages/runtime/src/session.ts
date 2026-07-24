// Shared Tier-2 session-id minting. The client (ContainerRuntime) mints the id
// before POST /api/session so a tab close mid-create can already DELETE it; the
// Worker mints one only when a request carries none. Both sides MUST produce
// the same shape — proxyToSandbox routes preview hosts by it
// (<port>-<sessionId>-<token>.<base> allows [a-z0-9-]) and the tombstone/DELETE
// scheme keys on it — so the format lives here, in the one module both import.
//
// Ids must be unique per create: the Worker tombstones a deleted id for 10
// minutes and tears down any session recreated under it in that window.

/** Mint a preview-hostname-safe, unique Tier-2 session id. */
export function mintSessionId(framework: string): string {
  return `${framework.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomSuffix()}`;
}

/** 8 chars of randomness; randomUUID is secure-context-only (plain-HTTP
 *  LAN-IP device testing lacks it), so fall back to getRandomValues. */
function randomSuffix(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().slice(0, 8);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
