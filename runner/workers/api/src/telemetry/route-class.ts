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

/** Minor triage item 8 (C-M11's request-line sub-item): the shape a REAL demo
 *  id takes — `share.ts#shortId()`'s own alphabet (8 random bytes, each
 *  `.toString(36)`, joined and sliced to 10 — lowercase alphanumeric) or a
 *  legacy "fixed id (render-ms compat)" one (`share.ts`'s `args.id`, same
 *  doc comment) — both stay inside a conservative alphanumeric-plus-
 *  hyphen/underscore shape, well under this bound. A raw, unresolved path
 *  segment (a crawler probing `/d/<garbage>`, `/d/';DROP TABLE--`, a stray
 *  `<script>`, or just an implausibly long guess) almost never matches this
 *  shape, so it is rejected here the same way the share-view 404 path
 *  already rejects an unresolved id — without a KV/D1 lookup on every
 *  request line just to log `hot.demo_id`. */
const DEMO_ID_SHAPE_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Best-effort `hot.demo_id` extraction from the same route shapes, when the
 *  path names one. Never throws, never guesses past the routes above, and
 *  never returns a path segment that isn't even shaped like a real demo id
 *  (minor triage item 8). */
export function demoIdFromPath(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  let candidate = "";
  if ((parts[0] === "d" || parts[0] === "embed") && parts[1]) candidate = parts[1];
  else if (parts[0] === "api" && parts[1] === "demos" && parts[2]) candidate = parts[2];
  else if (parts[0] === "api" && parts[1] === "mcp" && parts[2] === "demos" && parts[3]) candidate = parts[3];
  return DEMO_ID_SHAPE_RE.test(candidate) ? candidate : "";
}

/** Minor triage item 8 (`x-hot-session` half): the shape `x-hot-session` is
 *  allowed to take — the browser facade's page-load id
 *  (`packages/runtime/src/telemetry/facade.ts#mintPageLoadId`) is either a
 *  `crypto.randomUUID()` v4 UUID, or its defensive `plid-<base36>-<base36>`
 *  fallback for a runtime without Web Crypto. Anything else is a
 *  client-controlled header value up to the header size limit, not a real
 *  session id, and must not land verbatim in Loki structured metadata.
 *  Lives here (not `lines.ts`, which imports `./resource.js` and so cannot
 *  be `node --test`-imported directly — see this file's own header) so it
 *  stays unit-testable the same way `demoIdFromPath` is. */
const SESSION_ID_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|plid-[0-9a-z]+-[0-9a-z]+)$/;

/** Keeps `raw` (the `x-hot-session` header value) only when it matches the
 *  facade's own page-load id shape — `""` (never logged) otherwise. */
export function validSessionId(raw: string | null): string {
  return raw !== null && SESSION_ID_RE.test(raw) ? raw : "";
}
