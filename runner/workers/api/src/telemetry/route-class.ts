// Route classification for `blob10 route_class` (contract §4) and the
// per-request structured line's `route_class` field — one low-cardinality
// label per route shape, dynamic ids collapsed to `:id`. Pure string
// manipulation (no Request/URL types) so `pipeline/` can call it directly with
// a bare pathname.
//
// Covers every route `index.ts` matches on `parts[0]`/`parts[1]` as of this
// task; an unmatched path falls back to a coarse `api/<first two segments>`
// (or `other`) rather than an unbounded one-label-per-path cardinality blowup.

export function routeClassOf(method: string, pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return "root";
  if (parts[0] === "d") return parts.length >= 2 ? "d/:id" : "d";
  if (parts[0] === "embed") return parts.length >= 2 ? "embed/:id" : "embed";
  if (parts[0] !== "api") return "other";

  const p1 = parts[1];
  if (p1 === undefined) return "api";

  if (p1 === "session") {
    if (parts.length <= 2) return "api/session";
    if (parts.length === 3) return "api/session/:id";
    return `api/session/:id/${parts[3]}`;
  }
  if (p1 === "mcp" && parts[2] === "demos") {
    return parts.length > 3 ? "api/mcp/demos/:id" : "api/mcp/demos";
  }
  if (p1 === "demos") {
    if (parts.length <= 2) return "api/demos";
    return parts.length > 3 ? `api/demos/:id/${parts[3]}` : "api/demos/:id";
  }
  if (p1 === "versions") return parts[2] === "exists" ? "api/versions/exists" : "api/versions";
  if (p1 === "payload") return parts.length > 2 ? "api/payload/:id" : "api/payload";
  if (p1 === "chat") return parts[2] === "event" ? "api/chat/event" : "api/chat";
  if (p1 === "admin") return parts.length > 2 ? `api/admin/${parts[2]}` : "api/admin";
  if (p1 === "tokens") return parts.length > 2 ? "api/tokens/:id" : "api/tokens";
  if (p1 === "profile") return "api/profile";
  if (p1 === "import" || p1 === "theme" || p1 === "beacon" || p1 === "health" || p1 === "budget" || p1 === "settings") {
    return `api/${p1}`;
  }
  return `api/${parts.slice(1, 2).join("/")}` || "api";
}

/** Best-effort `hot.demo_id` extraction from the same route shapes, when the
 *  path names one. Never throws, never guesses past the routes above. */
export function demoIdFromPath(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  if ((parts[0] === "d" || parts[0] === "embed") && parts[1]) return parts[1];
  if (parts[0] === "api" && parts[1] === "demos" && parts[2]) return parts[2];
  if (parts[0] === "api" && parts[1] === "mcp" && parts[2] === "demos" && parts[3]) return parts[3];
  return "";
}
