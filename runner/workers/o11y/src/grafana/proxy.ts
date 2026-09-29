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

/** Never forwarded to the container: `cookie` carries our own session
 *  cookies; `x-o11y-grafana-user` is set BY this Worker; a client-supplied
 *  value of either must never reach Grafana. `cf-container-target-port`
 *  is stripped so a client can never steer a proxied request at Loki. */
const STRIPPED_HEADERS = ["cookie", "x-o11y-grafana-user", "cf-container-target-port"];

/** A dashboard's own auto-refresh must not call `wake("visit")` like a
 *  real page load — that would re-start a stopped box on every refresh, at
 *  the ADR §A cost model's full awake-hour rate. Fetch Metadata tells them
 *  apart: real navigation sends `sec-fetch-dest: document`, background
 *  fetch sends `empty`. Fails OPEN when absent, since the real waste
 *  vector always carries the header. Only gates STARTING a stopped box. */
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

/** Reads `req`'s body verbatim, buffered rather than piped (see the note
 *  below on why), refusing once the byte count crosses `maxBytes`. Cancels
 *  the reader (not merely releasing its lock) the moment it detects the
 *  overflow, so nothing keeps pumping past the cap — an absent or wrong
 *  `Content-Length` must not bypass this. */
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
    // An unauthenticated request must NEVER wake the box. A top-level
    // navigation gets a real sign-in redirect; everything else gets 401
    // JSON, which also recovers a session that expired mid-use on a
    // background panel-refresh call without navigating away.
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

  // Checked before the box is ever touched — an oversized request must
  // not wake a stopped box. `Content-Length` is only a pre-check;
  // `readCappedArrayBuffer` below is the real enforcement.
  if (contentLengthExceeds(req, GRAFANA_PROXY_MAX_BYTES)) return payloadTooLargeResponse();

  const box = getGrafanaBoxStub(env);

  if (!isTopLevelNavigation(req) && !(await box.isAwake())) {
    // A background request reaching a STOPPED box: never start it. Serve
    // the waking page instead of a bare error, so a stale open tab
    // degrades quietly.
    return wakingPageResponse();
  }

  try {
    // Idempotent: an already-running box returns its existing wake
    // record; `wake()` refuses only while the container is stopping.
    await box.wake("visit");
  } catch {
    return wakingPageResponse();
  }

  if (!(await box.isReady())) {
    // A request that only ever saw the waking page still counts as
    // visitor activity — otherwise a visit wake with an empty backlog
    // would SIGTERM itself before anyone "visited". Called AFTER
    // `wake()`: `#doWake` resets this same key at wake-start.
    await box.noteVisitorActivity();
    return wakingPageResponse();
  }

  // Renews activity again now that a real request is about to reach
  // Grafana — keeps the "renew only on HTTP requests" rule honest even
  // after a stale waking-page hit from before boot.
  await box.noteVisitorActivity();

  // Reuse the ORIGINAL request's URL verbatim: Grafana behind a sub-path
  // needs `Host` and path preserved exactly; `containerFetch` only
  // rewrites the scheme.
  //
  // The body is read in full HERE, buffered rather than piped: when the
  // box answers without reading a piped body (the live-path/Loki-allowlist
  // refusals, the not-running 503s), this Worker would otherwise send that
  // response while the runtime is still pumping the incoming body into the
  // DO subrequest, throwing a stream error.
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
  // body-bearing `Request` sent via RPC serialises as a stream, which
  // throws inside the box DO. See `GrafanaBox.fetch`'s doc comment.
  return box.fetch(upstream);
};
