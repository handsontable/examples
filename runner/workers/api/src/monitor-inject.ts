// Tier-2 half of demo-runtime monitoring (DEV-2527). Temporary; removal path in
// docs/run-and-deploy.md.
//
// Kept out of index.ts and free of Cloudflare imports so `pipeline/` can exercise
// the gate directly — it decides whether every anonymous visitor's preview reports,
// which is the highest-volume decision in the feature.

import { injectLiteReporterIntoHtml, injectReporterIntoHtml, type LiteReporterConfig } from "@handsontable/demo-runtime/monitor";
import { injectSchemeIntoHtml } from "@handsontable/demo-runtime/scheme";
import { HT_MAJORS, type HtMajor } from "@handsontable/demo-runtime/telemetry";

/** Just the vars this module reads, so a test needs no full `Env`. */
export interface MonitorEnv {
  MONITOR_DEMOS?: string;
  PREVIEW_HOST?: string;
}

/**
 * Inject the monitor into a proxied preview document.
 *
 * Done at the proxy seam rather than by adding a file to the session's file map:
 * Next and Nuxt have no `index.html`, so a file-level injection would silently cover
 * only some frameworks. Every Tier-2 document passes through this one call.
 *
 * Gated on both the flag and the production host — the same pairing the Sentry init
 * uses, so `wrangler dev` never rewrites anything.
 *
 * Only `text/html` is touched; every other asset is returned untouched (and, in the
 * caller, still streamed). An encoded body is left alone too: decoding it here to
 * insert a script would cost more than the diagnostics are worth, and getting it
 * wrong would corrupt the preview.
 *
 * `Content-Length` is dropped rather than recomputed — the body is replaced, and a
 * stale length is a truncated page.
 */
export async function injectMonitor(
  response: Response,
  env: MonitorEnv,
  productionHost: string,
): Promise<Response> {
  if (env.MONITOR_DEMOS !== "1" || env.PREVIEW_HOST !== productionHost) return response;
  const type = response.headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("text/html")) return response;
  const encoding = response.headers.get("content-encoding");
  if (encoding && encoding.toLowerCase() !== "identity") return response;
  // A WebSocket upgrade (HMR) has no body to read and must pass through untouched.
  const withSocket = response as Response & { webSocket?: unknown };
  if (withSocket.webSocket || !response.body) return response;
  // Read a clone, never the response itself. `text()` consumes the body, so a throw
  // partway through the read (buffer limit, timeout, a truncated upstream) would
  // leave the caller returning a drained response — a blank iframe, caused by the
  // very catch that exists to stop monitoring from breaking a preview. Cloning keeps
  // the original body intact and streamable on that path.
  const copy = response.clone();
  try {
    const html = await copy.text();
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(injectReporterIntoHtml(html), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return response;
  }
}

/**
 * Inject the colour-scheme receiver into a proxied preview document (DEV-2561).
 *
 * Same seam and same guards as `injectMonitor`, and for the same reason: Next and
 * Nuxt have no `index.html`, so a file-level injection would silently cover only
 * some frameworks.
 *
 * Deliberately **ungated** where the monitor is gated on `MONITOR_DEMOS` and the
 * production host. The monitor is opt-in diagnostics whose absence costs nothing
 * visible; this receiver is the only channel by which the shell's toggle reaches a
 * Tier-2 grid (ADR-0035), so gating it would make the shipped feature depend on a
 * diagnostics flag, and would leave `wrangler dev` unable to exercise it at all.
 *
 * Kept separate from `injectMonitor` rather than folded into it precisely because
 * the gates differ. The two compose at the call site; each is a no-op when its own
 * marker is already present, so order does not matter.
 */
export async function injectScheme(response: Response): Promise<Response> {
  const type = response.headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("text/html")) return response;
  const encoding = response.headers.get("content-encoding");
  if (encoding && encoding.toLowerCase() !== "identity") return response;
  // A WebSocket upgrade (HMR) has no body to read and must pass through untouched.
  const withSocket = response as Response & { webSocket?: unknown };
  if (withSocket.webSocket || !response.body) return response;
  // Read a clone, never the response itself — see `injectMonitor` for why a throw
  // partway through a direct read leaves the caller with a drained body.
  const copy = response.clone();
  try {
    const html = await copy.text();
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(injectSchemeIntoHtml(html), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return response;
  }
}

// ---- T08: lite beacon injection, `/d` and `/embed` (ADR §C.5, contract §9) ----
//
// A wholly different seam from `injectMonitor`/`injectScheme` above: those guard
// a *proxied* Tier-2 response (arbitrary upstream bytes, unknown encoding, must
// clone before reading). `share.ts#serveDemoAsset` already reads its own R2
// object once, already knows it is `text/html` (`hitPath.endsWith(".html")`),
// and never gzip-encodes what it stores — so there is nothing to clone and no
// encoding to sniff there. `injectLiteHtml` below is the guard this seam
// actually needs (HTML-only, content-type checked) on a plain string, not a
// `Response` — a `Response`-wrapping guard here would cost a second full read
// of the body on `/d`/`/embed`'s own hottest path only to recover a size this
// task also has to compute. `injectLiteReporterIntoHtml`'s own idempotency
// marker still makes a second pass a no-op, matching `injectMonitor`/
// `injectScheme`'s "same marker, either seam" guarantee.

/** A next-channel ref, either shape `version.ts#isNextPrereleaseVersion`/
 *  `ANY_NEXT_VERSION_RE` recognise: the nightly `0.0.0-next-<hash>-<date>` or a
 *  dotted prerelease like `19.0.0-next.1`. Not imported from `version.ts`
 *  (`ANY_NEXT_VERSION_RE` is not exported) — restated here rather than widen
 *  that module's surface for one more caller. */
const NEXT_VERSION_RE = /^\d+\.\d+\.\d+-next[.-]/i;
const NIGHTLY_NEXT_RE = /^0\.0\.0-next-/i;

/**
 * `DemoRow.ht_version` (a validated ref: an exact release, or a next-channel
 * prerelease — never the pre-DEV-2565 `"latest"` sentinel today, but this
 * still degrades to `"none"` rather than throwing if one ever reaches here) →
 * contract §3's `hot.ht_major`. A next-channel build maps to `"next"`, never
 * `"none"`: the nightly's own major is always `0` under plain semver parsing,
 * which is exactly the case `version.ts`'s own `NEXT_PRERELEASE_RE` exists to
 * special-case, and a dotted `19.0.0-next.1` prerelease is not a released `19`
 * either.
 */
export function htMajorFromVersion(htVersion: string | null | undefined): HtMajor {
  const v = (htVersion ?? "").trim();
  if (!v) return "none";
  if (NEXT_VERSION_RE.test(v) || NIGHTLY_NEXT_RE.test(v)) return "next";
  const major = /^(\d+)\./.exec(v)?.[1];
  return major && (HT_MAJORS as readonly string[]).includes(major) ? (major as HtMajor) : "none";
}

/**
 * Inject the standalone lite reporter into an already-in-hand HTML string —
 * `text/html` only (checked against `contentType`, the same guard family as
 * `injectMonitor`/`injectScheme`) and identity-encoded only (checked against
 * `contentEncoding`, when the caller has one to offer — `serveDemoAsset`'s own
 * R2 puts never set one, so its call site passes `null`, but the guard exists
 * regardless: decoding to inject would risk corrupting the served document,
 * `injectMonitor`'s own reasoning, restated for a plain string rather than a
 * `Response`). Idempotent (delegates to `injectLiteReporterIntoHtml`'s own
 * marker check): a second pass over an already-injected document is a no-op.
 */
export function injectLiteHtml(
  html: string,
  contentType: string,
  contentEncoding: string | null | undefined,
  config: LiteReporterConfig,
): string {
  if (!contentType.toLowerCase().includes("text/html")) return html;
  if (contentEncoding && contentEncoding.toLowerCase() !== "identity") return html;
  return injectLiteReporterIntoHtml(html, config);
}
