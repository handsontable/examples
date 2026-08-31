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
 * is `TypeError: Failed to fetch (demos.handsontable.com)`, but the host suffix is
 * appended by the Sentry SDK's own fetch instrumentation
 * (`@sentry/core/build/esm/instrument/fetch.js`) — the `error.message` that actually
 * reaches this `.catch` is just `Failed to fetch`. A classifier written against the
 * title would never fire in production. Verified by observation (Step 0a, this
 * plan): `route.abort("failed")` under Chromium raises exactly
 * `TypeError: Failed to fetch`.
 *
 * One named regex per engine wording — in the style of `isPreviewPortUnreachable`
 * (`workers/api/src/preview-boot.ts`) — rather than one fused pattern, so a wording
 * this table does not cover shows up as a new Sentry event instead of being folded
 * in silently.
 *
 * The Chromium row is anchored (`^...$`) rather than a loose substring match. Chromium
 * also raises `TypeError: "Failed to fetch dynamically imported module: <url>"` for a
 * deploy-rotated chunk served under SPA fallback — a real host defect this codebase
 * already treats as one (`packages/runtime/src/transpile.ts`, Sentry DEMOS-15 /
 * DEV-2569). An unanchored `/failed to fetch/i` matches that message too, silencing a
 * defect class it has no business touching; the bare transport failure this module
 * exists for is always the whole message, never a prefix of a longer one. Firefox and
 * Safari stay loose: Firefox's real wording carries a trailing period
 * (`NetworkError when attempting to fetch resource.`), so a `$`-anchored version would
 * break the one wording it exists to match, and no over-match has been demonstrated
 * for either engine.
 */
const OPAQUE_TRANSPORT_MESSAGES = [
  /^failed to fetch$/i, // Chrome/Chromium/Edge — verified against `route.abort("failed")` (Step 0a)
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
