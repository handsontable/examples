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

/**
 * Where an injected tag goes in a document the runner did not write (DEV-2724).
 *
 * `<head>` first, then — and this is the fix — *before* the `<body>` open tag rather
 * than after it, then the whole document as a last resort.
 *
 * Inserting after `<body>` is what leaked the monitor onto `/share/:id` as a wall of
 * plain page text. Tier 1's classic bundler renders the demo's body inside its own
 * document shell, and it slices that body out with a regex before assigning it:
 *
 *     if (html.includes("<body>")) { const bodyMatcher = /<body.*>([\s\S]*)<\/body>/m; … }
 *     document.body.innerHTML = body;
 *
 * `.` does not cross a newline but `.*` is greedy, so `<body.*>` runs to the **last
 * `>` on the `<body>` line** — which, once we had inserted there, was our own
 * `<script>`'s. The open tag was swallowed by the match and the receiver's source
 * became the first text node of the body: the whole reporter, comments and all,
 * rendered above the demo. (`document.body.innerHTML` never executes an injected
 * script anyway, so nothing was lost by moving out of the body — Tier 1 is served by
 * the module-entry injection, which is why `withInjections` does both.)
 *
 * Only documents with **no `<head>`** ever reached that branch, which is why the
 * starters never showed it and a `create_demo` demo did: no `<head>`, and the body's
 * own content starting on the line *after* `<body>` — the shape both fixtures pin
 * (`pipeline/inject-html.test.mjs`, `e2e/preview-injection-leak.spec.ts`), and the
 * only one the placement matters for. A document that is a single line throughout
 * leaves the bundler's capture group empty, so it assigns the whole document and the
 * tag survives as a real `<script>` element either way.
 *
 * Before `<body>` is also right for the browser. A classic inline script there is
 * parsed in the "before head" insertion mode, so it lands in the implicit `<head>`
 * and executes during head parse — still ahead of the demo's own scripts, which is
 * the ordering the monitor needs. And it adds no whitespace text node of its own,
 * which is the DEV-2580 constraint above.
 */
export function insertInjectedTag(html: string, tag: string): string {
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }
  const body = /<body\b[^>]*>/i.exec(html);
  if (body) return html.slice(0, body.index) + tag + html.slice(body.index);
  return tag + html;
}
