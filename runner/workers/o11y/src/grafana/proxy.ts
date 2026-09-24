// `/grafana/*` (ADR §B.5/§H, task "Grafana access" scope; gate replaced by
// controller decision K1 — see gates/session.ts's own header): verify the
// Worker's own session cookie, wake (idempotent), strip the cookie and any
// client-supplied auth headers, set `x-o11y-grafana-user`, proxy to port
// 3000, renew activity only once the request actually reaches this far —
// never for a request served the waking page.

import { isBrowserNavigation, sanitizeNext, verifySession } from "../gates/session.js";
import { getGrafanaBoxStub } from "../box.js";
import { wakingPageResponse } from "./waking-page.js";
import type { Env } from "../env.js";
import type { RouteHandler } from "../router.js";

/** Never forwarded to the container. `cookie` carries our own
 *  `o11y_session`/`o11y_login` (verified fresh by this Worker, never
 *  Grafana's business — `auth.proxy` with `enable_login_token=false` keeps
 *  no session of its own); `x-o11y-grafana-user` is set BY this Worker from
 *  the verified identity below — a client-supplied value of either must
 *  never reach Grafana. `cf-container-target-port` is the base
 *  `Container.fetch()`'s port selector: `GrafanaBox.fetch` ignores it and
 *  always targets port 3000, and stripping it here too means a client can
 *  never aim a proxied request at Loki's 3100 even if that override
 *  regresses. */
const STRIPPED_HEADERS = ["cookie", "x-o11y-grafana-user", "cf-container-target-port"];

/** F2 fix (final review, B-I3 "an open Grafana tab defeats the 4h cap"): a
 *  dashboard's own auto-refresh `fetch()`/XHR calls (every panel, on the
 *  `"refresh"` interval every dashboard JSON sets — 1m/5m) used to call
 *  `wake("visit")` exactly like a real page load, which MINTS A FRESH WAKE
 *  (and a fresh 4-hour hard cap) if the box has since stopped — an open tab
 *  left running past the cap re-starts the box within a minute of the cap
 *  firing, indefinitely, at the ADR §A cost model's full awake-hour rate.
 *  Modern browsers (everything Grafana 11 supports) tag every request with
 *  Fetch Metadata headers: a real top-level navigation — the address bar, a
 *  link, or the waking page's own `<meta http-equiv="refresh">` poll (ADR
 *  §A's own wording: that poll IS a real HTTP request and must still count
 *  as activity/be able to wake a booting box) — sends
 *  `sec-fetch-dest: document`; a background `fetch()`/XHR sends
 *  `sec-fetch-dest: empty`. Fails OPEN when the header is absent entirely
 *  (an old browser, `curl`, most test/tooling requests) rather than closed:
 *  the real attack/waste vector (a dashboard's own auto-refresh JS) always
 *  carries the header in every browser Grafana ships to, so treating an
 *  absent header as "assume navigation" costs nothing in practice while
 *  keeping this compatible with non-Fetch-Metadata callers. Only gates
 *  STARTING a stopped box — once already awake, `wake()` stays safe
 *  (idempotent) to call from anything, which is what keeps "actively
 *  viewing a dashboard" renewing activity normally. */
function isTopLevelNavigation(req: Request): boolean {
  const dest = req.headers.get("sec-fetch-dest");
  if (dest === null) return true;
  return dest === "document";
}

export const handleGrafana: RouteHandler = async (req, env) => {
  const identity = await verifySession(req, env);
  if (!identity) {
    // K1: an unauthenticated request must NEVER wake the box — this branch
    // returns before `getGrafanaBoxStub` is even called, below. A top-level
    // navigation gets a real sign-in redirect; everything else (an XHR, a
    // fetch, an asset request) gets 401 JSON, which is also what recovers a
    // session that expired mid-use on one of Grafana's own background
    // panel-refresh calls (see the session cookie's own doc comment on
    // expiry) — Grafana's frontend surfaces that as a failed panel rather
    // than navigating, and the person's next real navigation (reload, or a
    // link) hits the branch below and gets a clean re-auth redirect instead.
    if (isBrowserNavigation(req)) {
      const url = new URL(req.url);
      const next = sanitizeNext(url.pathname + url.search, env);
      return new Response(null, {
        status: 302,
        headers: { Location: `/grafana/_o11y/login?next=${encodeURIComponent(next)}` },
      });
    }
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const box = getGrafanaBoxStub(env);

  if (!isTopLevelNavigation(req) && !(await box.isAwake())) {
    // A background request reaching a STOPPED box: never start it. Serve
    // the waking page (matches what `wake()` throwing mid-stop already does
    // below) rather than a bare error, so a stale open tab's own background
    // poll degrades quietly instead of surfacing a fetch error.
    return wakingPageResponse();
  }

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

  // Z1: the DO's `fetch()` handler, never the `containerFetch` RPC method.
  // A `Request` passed to an RPC method has its body sent as an RPC stream,
  // and every POST proxied that way (each panel query) printed
  // `ReadableStream received over RPC disconnected prematurely` in the box
  // DO. See `GrafanaBox.fetch`'s doc comment (box.ts), which also keeps
  // every gate (live-path block, Loki allowlists, not-running 503s) and
  // pins the port to Grafana's 3000.
  return box.fetch(upstream);
};
