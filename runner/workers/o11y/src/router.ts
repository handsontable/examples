// COMMON.md pinned interface 2. `registerRoute(method, path, handler)` — T03,
// T04, T08 plug their own routes in through this, never by editing
// `index.ts`'s dispatch logic directly.

import type { Env } from "./env.js";

export type RouteMethod = "GET" | "POST" | "*";
export type RouteHandler = (req: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;

interface Route {
  method: RouteMethod;
  path: string;
  isPrefix: boolean;
  handler: RouteHandler;
}

const routes: Route[] = [];

/** `path` is exact, or a prefix when it ends in `/*` (same convention the T00
 *  scaffold's `ROUTES` list already used). Throws on a duplicate
 *  `method`+`path` registration — a silent second registration shadowing the
 *  first would be a much harder bug to find than a boot-time throw (T02-D,
 *  see the task Outcome). */
export function registerRoute(method: RouteMethod, path: string, handler: RouteHandler): void {
  const isPrefix = path.endsWith("/*");
  if (routes.some((r) => r.method === method && r.path === path)) {
    throw new Error(`registerRoute: duplicate registration for ${method} ${path}`);
  }
  routes.push({ method, path, isPrefix, handler });
}

/** Test-only: clears every registration — `pipeline/o11y-routes.test.mjs`
 *  and friends re-register routes per test file, and `node --test` reuses
 *  the module's top-level state across files that import `index.ts` more
 *  than once is not a concern here (`node --test` isolates each spec file
 *  into its own process), but within *one* file that imports `index.ts`
 *  more than once (never done today) this would matter. Exported for
 *  completeness, not currently called by production code. */
export function clearRoutes(): void {
  routes.length = 0;
}

function matches(route: Route, method: string, pathname: string): boolean {
  if (route.method !== "*" && route.method !== method) return false;
  if (route.isPrefix) return pathname.startsWith(route.path.slice(0, -1));
  return pathname === route.path;
}

/**
 * Finds the best match for `method`/`pathname`: an exact-path route beats
 * every prefix route, and among prefix routes the longest `path` wins (so
 * `/grafana/_o11y/reopen` — T03's exact route — beats `/grafana/*` — T01's
 * catch-all — regardless of registration order).
 */
export function findRoute(method: string, pathname: string): RouteHandler | null {
  let best: Route | null = null;
  for (const route of routes) {
    if (!matches(route, method, pathname)) continue;
    if (best === null) {
      best = route;
      continue;
    }
    const bestIsExact = !best.isPrefix;
    const routeIsExact = !route.isPrefix;
    if (routeIsExact && !bestIsExact) {
      best = route; // exact beats prefix
    } else if (routeIsExact === bestIsExact && route.path.length > best.path.length) {
      best = route; // longer prefix (or, among exacts, cannot tie — unique per method+path)
    }
  }
  return best?.handler ?? null;
}

/** Dispatches through the registry; `null` means no registered route
 *  matched (the caller, `index.ts`, answers `501` for a known contract path
 *  with no handler yet, `404` otherwise — see its own dispatcher). */
export async function routeRequest(req: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  const url = new URL(req.url);
  const handler = findRoute(req.method, url.pathname);
  if (!handler) return null;
  return handler(req, env, ctx);
}
