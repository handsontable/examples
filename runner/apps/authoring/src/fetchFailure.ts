/**
 * Is `error` the browser's opaque transport failure — the request never completed,
 * so there is no status, no body, and nothing about our host in it?
 *
 * Sentry DEMOS-2X / DEMOS-2Y. Deliberately shape-based and NOT gated on
 * `navigator.onLine`: unlike the Tier-1 compiler-asset branch in tier1Report.ts,
 * the populations here (a woken tab, a navigation that cancelled its in-flight
 * fetches) both report `online: true`, so that conjunct would suppress nothing.
 *
 * Every way our own origin fails at these callsites yields a *different* object —
 * `Error("versions 503")`, `Error("starter not found: … (404)")`, or a SyntaxError
 * from res.json() over an SPA-fallback HTML body — so narrowing to this shape
 * retires the visitor-network population without silencing a host defect.
 *
 * Import-free by construction (same reason as `reportingGate.ts` and
 * `tier1Report.ts`): `node --test` imports this module directly, under
 * `--experimental-strip-types`, so `pipeline/fetch-failure.test.mjs` can pin the
 * decision without pulling in `@sentry/react` or `import.meta.env`.
 *
 * Matched on a message *substring*, not on the Sentry issue title. DEMOS-2X's title
 * is `TypeError: Failed to fetch (demos.handsontable.com)`, and — contrary to this
 * module's original assumption — that host suffix is NOT stripped by the time
 * `error.message` reaches this `.catch`: DEMOS-2X's latest events (2026-09-08,
 * releases `930f6a52` and `e32cdcdf`, both after the `^failed to fetch$` gate landed
 * in commit 590cb58b2 / PR #274) still carry `Failed to fetch (demos.handsontable.com)`
 * verbatim, and that gate — the only caller of `fetchVersions` is gated on it — has
 * never once matched it, so the "demotion" it was meant to apply has never taken
 * effect in production. The shape below now accepts one optional parenthesised
 * suffix so the gate actually reaches the population it was written for. Verified by
 * observation (Step 0a, this plan): `route.abort("failed")` under Chromium raises
 * exactly `TypeError: Failed to fetch`, i.e. without a suffix — so both the bare and
 * suffixed forms are real, observed wordings and both must match.
 *
 * One named regex per engine wording — in the style of `isPreviewPortUnreachable`
 * (`workers/api/src/preview-boot.ts`) — rather than one fused pattern, so a wording
 * this table does not cover shows up as a new Sentry event instead of being folded
 * in silently.
 *
 * The Chromium row is anchored (`^...$`) rather than a loose substring match, with
 * the host suffix carved out as a single optional `(?: \([^)]*\))?` group immediately
 * before the `$` — so the suffix, when present, must be the very end of the message.
 * Chromium also raises `TypeError: "Failed to fetch dynamically imported module:
 * <url>"` for a deploy-rotated chunk served under SPA fallback — a real host defect
 * this codebase already treats as one (`packages/runtime/src/transpile.ts`, Sentry
 * DEMOS-15 / DEV-2569). An unanchored `/failed to fetch/i` matches that message too,
 * silencing a defect class it has no business touching; the anchor plus the narrow
 * optional group still excludes it, because that wording is not "Failed to fetch"
 * plus a trailing `(...)` — it has different words after the colon. The bare
 * transport failure this module exists for is always the whole message or the whole
 * message plus a parenthesised host, never a prefix of a longer one. Firefox and
 * Safari stay loose: Firefox's real wording carries a trailing period
 * (`NetworkError when attempting to fetch resource.`), so a `$`-anchored version would
 * break the one wording it exists to match, and no over-match has been demonstrated
 * for either engine.
 */
const OPAQUE_TRANSPORT_MESSAGES = [
  // Chrome/Chromium/Edge — verified against `route.abort("failed")` (Step 0a) for the
  // bare form; the optional `(host)` suffix is the actual production wording seen in
  // Sentry DEMOS-2X (e.g. `Failed to fetch (demos.handsontable.com)`, releases
  // `930f6a52` / `e32cdcdf`, 2026-09-08). Nothing in this codebase appends it (grepped);
  // which layer does — the browser itself vs. the Sentry SDK's fetch instrumentation —
  // is not verified.
  /^failed to fetch(?: \([^)]*\))?$/i,
  /networkerror when attempting to fetch resource/i, // Firefox
  /load failed/i, // Safari
];

export function isOpaqueNetworkFailure(error: unknown): boolean {
  // Duck-typed on `name`/`message` rather than `instanceof TypeError` — the same
  // cross-realm caution as the rest of this codebase's error classifiers, though
  // unlikely to matter at these same-window fetch callsites.
  if (typeof error !== "object" || error === null) return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  if (name !== "TypeError" || typeof message !== "string") return false;
  return OPAQUE_TRANSPORT_MESSAGES.some((re) => re.test(message));
}
