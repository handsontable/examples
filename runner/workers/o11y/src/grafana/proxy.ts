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
    // (T01 fix round C1) — the waking page's own meta-refresh retries. No
    // activity is noted here: nothing actually started (or is still
    // running from before), so there is no wake to keep alive yet.
    await box.wake("visit");
  } catch {
    return wakingPageResponse();
  }

  if (!(await box.isReady())) {
    // F2 fix: a request that only ever saw the waking page still counts as
    // visitor activity. Before this, a visit wake with an empty backlog
    // SIGTERMed itself ~20s after boot: `#finishDrain`'s quiet check
    // (box.ts) read `lastGrafanaActivityMs() === null` — nobody had ever
    // "visited" — and stopped the box the person just opened, because this
    // branch recorded nothing. The waking page's own `meta refresh` poll IS
    // a real HTTP request to `/grafana/*` (ADR §A's own renewal wording),
    // so it counts the same way a proxied request does. Called AFTER
    // `wake()` (never before): `#doWake` resets this same storage key at
    // wake-start (fix round I1), so noting activity before that call would
    // just be wiped — this is what actually keeps it set on every
    // subsequent poll while the box boots.
    await box.noteVisitorActivity();
    return wakingPageResponse();
  }

  // Renews activity again now that a real request is about to reach
  // Grafana itself — once the box is up, this (an actual proxied
  // `/grafana/*` request) is what keeps the "renew only on HTTP requests"
  // rule honest; a stale waking-page hit from before boot does not linger
  // on its own (each call just records "last activity now", not a
  // standing grant).
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
