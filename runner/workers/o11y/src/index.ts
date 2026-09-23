// The o11y worker's entry point (observability contract §1). Scaffold only
// (T00): every contract route answers `501`, no gates, no ingest, no drain —
// wave-1 tasks (T02–T09) register real handlers through `router.ts` (T02).
//
// Durable Object classes are exported from here, as Workers requires.

import type { Env } from "./env.js";

export { InboxWriter, GrafanaBox } from "./env.js";

interface RouteStub {
  method: "GET" | "POST";
  /** Exact path, or a prefix when it ends in `/*` — same convention `router.ts`
   *  (T02) uses. */
  path: string;
}

/** Every route contract §1 lists, as a scaffold stub. T02's `registerRoute`
 *  (COMMON.md interface 2) replaces this list with real handlers. */
const ROUTES: readonly RouteStub[] = [
  { method: "POST", path: "/telemetry/collect" },
  { method: "POST", path: "/telemetry/lite" },
  { method: "POST", path: "/telemetry/v1/logs" },
  { method: "POST", path: "/telemetry/deploy" },
  { method: "POST", path: "/telemetry/hooks/sentry" },
  { method: "GET", path: "/grafana/*" },
  { method: "POST", path: "/grafana/_o11y/reopen" },
  { method: "GET", path: "/grafana/_o11y/admin/*" },
];

function matches(route: RouteStub, method: string, pathname: string): boolean {
  if (route.method !== method) return false;
  if (route.path.endsWith("/*")) return pathname.startsWith(route.path.slice(0, -1));
  return pathname === route.path;
}

export default {
  async fetch(request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const known = ROUTES.some((route) => matches(route, request.method, url.pathname));
    if (!known) return new Response("Not Found", { status: 404 });
    return new Response("Not Implemented — o11y worker scaffold (T00); route logic lands in T02–T09.", {
      status: 501,
    });
  },
} satisfies ExportedHandler<Env>;
