// `/grafana/*` (ADR §B.5/§H — see gates/session.ts's own header): verify
// the Worker's own session cookie, wake (idempotent), strip the cookie and
// any client-supplied auth headers, set `x-o11y-grafana-user`, proxy to
// port 3000, renew activity only once the request actually reaches this
// far — never for a request served the waking page.

import { isBrowserNavigation, sanitizeNext, verifySession } from "../gates/session.js";
import { GRAFANA_PROXY_MAX_BYTES, contentLengthExceeds } from "../gates/limits.js";
import { BodyTooLargeError } from "../normalise/read-body.js";
import { getGrafanaBoxStub } from "../box.js";
import { wakingPageResponse } from "./waking-page.js";
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

/** A dashboard's own auto-refresh `fetch()`/XHR calls (every panel, on the
 *  `"refresh"` interval every dashboard JSON sets) must not call
 *  `wake("visit")` the same way a real page load does: that mints a fresh
 *  wake (and a fresh 4-hour hard cap) if the box has since stopped, so an
 *  open tab left running past the cap would re-start the box within a
 *  minute of the cap firing, indefinitely, at the ADR §A cost model's full
 *  awake-hour rate. Modern browsers (everything Grafana 11 supports) tag
 *  every request with Fetch Metadata headers: a real top-level navigation —
 *  the address bar, a link, or the waking page's own
 *  `<meta http-equiv="refresh">` poll (ADR §A's own wording: that poll IS a
 *  real HTTP request and must still count as activity) — sends
 *  `sec-fetch-dest: document`; a background `fetch()`/XHR sends
 *  `sec-fetch-dest: empty`. Fails OPEN when the header is absent entirely
 *  (an old browser, `curl`, most test/tooling requests): the real
 *  attack/waste vector (a dashboard's own auto-refresh JS) always carries
 *  the header in every browser Grafana ships to, so treating an absent
 *  header as "assume navigation" costs nothing in practice. Only gates
 *  STARTING a stopped box — once already awake, `wake()` stays safe
 *  (idempotent) to call from anything, which is what keeps "actively
 *  viewing a dashboard" renewing activity normally. */
function isTopLevelNavigation(req: Request): boolean {
  const dest = req.headers.get("sec-fetch-dest");
  if (dest === null) return true;
  return dest === "document";
}

function payloadTooLargeResponse(): Response {
  return new Response(JSON.stringify({ error: "payload too large" }), {
    status: 413,
    headers: { "content-type": "application/json" },
  });
}

/** Reads `req`'s body verbatim (this route forwards it exactly as
 *  received, buffered rather than piped — see the note below on why — so
 *  this never decompresses, unlike `normalise/read-body.ts`'s
 *  `readCappedBytes`), refusing once the byte count crosses `maxBytes`.
 *  Reads only as much of the stream as it takes to detect the overflow, and
 *  CANCELS the reader (not merely releasing its lock) the moment it does,
 *  so nothing keeps pumping past the cap — the same "`Content-Length` is
 *  only a hint" reasoning `read-body.ts` documents applies here too: an
 *  absent or wrong `Content-Length` must not bypass this. */
async function readCappedArrayBuffer(req: Request, maxBytes: number): Promise<ArrayBuffer> {
  if (!req.body) return new ArrayBuffer(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new BodyTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

export const handleGrafana: RouteHandler = async (req, env) => {
  const identity = await verifySession(req, env);
  if (!identity) {
    // An unauthenticated request must NEVER wake the box — this branch
    // returns before `getGrafanaBoxStub` is even called, below. A
    // top-level navigation gets a real sign-in redirect; everything else
    // (an XHR, a fetch, an asset request) gets 401 JSON, which is also
    // what recovers a session that expired mid-use on one of Grafana's own
    // background panel-refresh calls (see the session cookie's own doc
    // comment on expiry) — Grafana's frontend surfaces that as a failed
    // panel rather than navigating, and the person's next real navigation
    // (reload, or a link) hits the branch below and gets a clean re-auth
    // redirect instead.
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

  // Checked before the box is ever touched — an oversized request must not
  // wake a stopped box or renew its activity timer. `Content-Length` is
  // only a pre-check (a client can omit it or lie);
  // `readCappedArrayBuffer` below is the real enforcement.
  if (contentLengthExceeds(req, GRAFANA_PROXY_MAX_BYTES)) return payloadTooLargeResponse();

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
    // `wake()` itself refuses (throws) only while the container is
    // stopping — the waking page's own meta-refresh retries. No activity
    // is noted here: nothing actually started (or is still running from
    // before), so there is no wake to keep alive yet.
    await box.wake("visit");
  } catch {
    return wakingPageResponse();
  }

  if (!(await box.isReady())) {
    // A request that only ever saw the waking page still counts as
    // visitor activity: a visit wake with an empty backlog would
    // otherwise SIGTERM itself ~20s after boot (`#finishDrain`'s quiet
    // check reads `lastGrafanaActivityMs() === null` — nobody had ever
    // "visited"). The waking page's own `meta refresh` poll IS a real HTTP
    // request to `/grafana/*` (ADR §A's own renewal wording), so it counts
    // the same way a proxied request does. Called AFTER `wake()` (never
    // before): `#doWake` resets this same storage key at wake-start, so
    // noting activity before that call would just be wiped.
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
  // untouched): Grafana behind a sub-path needs `Host` and path preserved
  // exactly. `containerFetch`'s only URL transform is scheme (`https:` →
  // `http:`); the destination TCP port is resolved by the Container
  // binding itself, not by whatever hostname the URL string names, so
  // there is no need to rewrite it to a synthetic origin the way
  // `isReady()`'s own `/ready`/`/grafana/api/health` probes do.
  //
  // The body is read in full HERE, before the box sees the request, and
  // forwarded as a buffer rather than piped from `req.body`. When the box
  // answers without reading a piped body (the live-path/Loki-allowlist
  // refusals, the not-running 503s), this Worker would otherwise send that
  // response while the runtime is still pumping the incoming body into the
  // DO subrequest, printing `Uncaught TypeError: Can't read from request
  // stream after response has been sent.` Under `wrangler dev`, a body of
  // about 20 KB also made the dev proxy fail the request with a 500
  // instead of passing on the box's 404. Grafana's own request bodies are
  // small JSON (panel queries, dashboard saves), and this route is
  // reachable only with a verified session.
  let body: ArrayBuffer | null = null;
  if (req.body) {
    try {
      // Enforced again here, not just against the `Content-Length` hint
      // above — an absent or wrong header must not let an oversized body
      // reach the buffer at all.
      body = await readCappedArrayBuffer(req, GRAFANA_PROXY_MAX_BYTES);
    } catch (err) {
      if (err instanceof BodyTooLargeError) return payloadTooLargeResponse();
      // The client went away mid-upload: nothing is left to answer.
      return new Response(null, { status: 400 });
    }
  }
  const upstream = new Request(req.url, { method: req.method, headers: req.headers, body, redirect: req.redirect });
  for (const h of STRIPPED_HEADERS) upstream.headers.delete(h);
  upstream.headers.set("x-o11y-grafana-user", identity.email);

  // The DO's `fetch()` handler, never the `containerFetch` RPC method: a
  // `Request` passed to an RPC method has its body sent as an RPC stream,
  // and every POST proxied that way (each panel query) would print
  // `ReadableStream received over RPC disconnected prematurely` in the box
  // DO. See `GrafanaBox.fetch`'s doc comment (box.ts), which also keeps
  // every gate (live-path block, Loki allowlists, not-running 503s) and
  // pins the port to Grafana's 3000.
  return box.fetch(upstream);
};
