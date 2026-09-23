// `/grafana/*` (ADR §B.5/§H, task "Grafana access" scope): verify Access,
// wake (idempotent), strip client auth headers, set `x-o11y-grafana-user`,
// proxy to port 3000, renew activity only once the request actually reaches
// this far — never for a request served the waking page.

import { verifyAccess } from "../gates/access.js";
import { getGrafanaBoxStub } from "../box.js";
import { wakingPageResponse } from "./waking-page.js";
import type { Env } from "../env.js";
import type { RouteHandler } from "../router.js";

/** Never forwarded to the container — either verified fresh by this Worker
 *  (`Cf-Access-Jwt-Assertion`) or set BY this Worker from the verified
 *  identity (`x-o11y-grafana-user`, `auth.proxy`'s header) — a
 *  client-supplied value of either must never reach Grafana. */
const STRIPPED_HEADERS = ["cf-access-jwt-assertion", "x-o11y-grafana-user"];

export const handleGrafana: RouteHandler = async (req, env) => {
  const identity = await verifyAccess(req, env);
  if (!identity) return new Response("Forbidden", { status: 403 });

  const box = getGrafanaBoxStub(env);

  try {
    // Idempotent: an already-running box returns its existing wake record;
    // `wake()` itself refuses (throws) only while `container is stopping`
    // (T01 fix round C1) — the waking page's own meta-refresh retries.
    await box.wake("visit");
  } catch {
    return wakingPageResponse();
  }

  if (!(await box.isReady())) return wakingPageResponse();

  // Renew activity only now — a request that only ever saw the waking page
  // (the box was asleep or still booting) never counted as Grafana traffic,
  // matching ADR §A's "renews the activity timer only on HTTP requests to
  // `/grafana/*`" read narrowly: a request Grafana itself never answered is
  // not a Grafana request yet.
  await box.noteVisitorActivity();

  // Reuse the ORIGINAL request's URL verbatim (Host, path, query
  // untouched) — the task's own Trap: "Grafana behind a sub-path needs
  // `Host` and path preserved exactly." `containerFetch`'s only URL
  // transform is scheme (`https:` → `http:`); the destination TCP port is
  // resolved by the Container binding itself, not by whatever hostname the
  // URL string names, so there is no need (and no benefit) to rewrite it to
  // a synthetic origin the way `isReady()`'s own `/ready`/`/grafana/api/health`
  // probes do (those endpoints do not care about `Host` at all).
  const upstream = new Request(req.url, req);
  for (const h of STRIPPED_HEADERS) upstream.headers.delete(h);
  upstream.headers.set("x-o11y-grafana-user", identity.email);

  return box.containerFetch(upstream, 3000);
};
