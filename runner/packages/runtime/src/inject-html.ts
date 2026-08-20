// Why an injected `<script>` deletes its own element (DEV-2580).
//
// `injectReporterIntoHtml` (monitor.ts) and `injectSchemeIntoHtml` (scheme.ts) both
// insert their receiver as the first child of `<head>` in a document the
// framework's server has already rendered. Remix's client entry is
// `hydrateRoot(document, …)` on React 18, which strict-matches every child of
// `<head>`: a node the server never rendered is a hydration mismatch, so the whole
// document is thrown away and client-rendered. That is what took remix @ 15/16/17/18
// red in the nightly starter matrix — React #418 followed by #423, surfacing as
// "Hydration failed because the initial UI does not match what was rendered on the
// server" at `RenderErrorBoundary`, an SSR flash for the visitor, and (a detail worth
// knowing) the re-render wiping the receiver's own `<style>` override with it.
//
// So the tag removes itself while it runs. Both injections are classic inline
// scripts, which execute during head parse — before the framework's own deferred
// module scripts, let alone hydration — and removing the element does not stop the
// script already executing. By the time any hydrator reads the DOM, the head is the
// one the server sent.
//
// This is the fix rather than "inject outside the hydrated document" (for remix
// there is no outside — the document *is* the root) or "inject only for non-SSR
// frameworks" (that deletes the colour-scheme bridge, ADR-0035, for exactly the
// frameworks it was built for; and the `proxyToSandbox` seam does not know the
// framework).
//
// Removal runs *before* the payload rather than in a `finally` after it: the payload
// is allowed to throw, and the ordering needs no bookkeeping to be correct. It is an
// IIFE rather than a bare `var` because an inline classic script's `var` lands on
// `window`, and the demo's globals are not ours to crowd.
//
// ES5 by hand, byte-deterministic, for the two reasons the receivers document: babel
// 6 parses the Tier-1 parcel entry, and `SandpackRuntime.sameFiles` skips the compile
// when the sandbox is unchanged.

/** Deletes the executing script element. Guarded: `document.currentScript` is null
 *  for a module or async script, and monitoring must never be why a preview fails. */
export const SELF_REMOVING_PRELUDE =
  `(function(){var s=document.currentScript;if(s&&s.parentNode){s.parentNode.removeChild(s);}})();`;

/** Wrap injected source as a `<script>` tag that leaves no node behind. */
export function injectedScriptTag(source: string): string {
  return `<script>${SELF_REMOVING_PRELUDE}\n${source}</script>`;
}
