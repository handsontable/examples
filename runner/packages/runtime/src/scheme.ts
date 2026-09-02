// The shell's colour scheme, carried into the preview document (DEV-2561).
//
// The preview is cross-origin on both tiers — Sandpack's bundler host for Tier 1,
// `<port>-<id>-<token>.demos.handsontable.com` for Tier 2 — so the shell's
// `data-hot-theme` attribute and the `color-scheme` it emits stop at the iframe
// boundary. Nothing inherits across it. This module is the bridge: a small
// receiver injected into the preview document, which listens for the shell's mode
// and re-declares `color-scheme` over whatever the demo's theme resolved to.
//
// Why `color-scheme` and not a theme swap: every Handsontable token that differs
// between light and dark is a `light-dark()` pair, and `color-scheme` is the
// single declaration that makes all of them pick a side. Re-declaring it flips the
// whole grid without touching the demo's theme, its files, or its JS.
//
// There *is* an API route — a stock `theme: mainTheme` demo leaves a builder
// registered under `main`, so `getTheme('main').setColorScheme(mode)` would work —
// and it is deliberately not taken. This receiver is injected as a plain
// `<script>` on the HTML path, outside the demo's module graph, with no way to
// reach its Handsontable instance. The API route would also have to guess the
// theme name, which differs per demo (`main`, `custom-theme`, or a starter's own).
// A CSS declaration is the one lever that is identical on both injection paths and
// needs to know nothing about the demo.
//
// One copy serves both tiers, exactly as `monitor.ts` does, and for the same
// reason: the API worker already depends on this package, so a second copy in
// `workers/api` would be a second set of rules to keep in sync.

import { injectedScriptTag, insertInjectedTag } from "./inject-html.js";

/** The `postMessage` discriminator. Also the injection idempotency marker. */
export const SCHEME_MESSAGE_TYPE = "hot-runner-scheme";

/**
 * What the shell can ask for.
 *
 * `auto` is *stand down*, not "follow the OS" — the receiver drops its override and
 * whatever the demo itself declares takes effect. For a starter pinned to
 * `colorScheme: 'light'` that is light; for a docs example that ships
 * `ht-theme-main-dark` it is that example's dark; for a theme built with
 * `colorScheme: 'auto'` it is `light dark`, which then genuinely follows the OS.
 * The shell sends it whenever the demo owns its own scheme (ADR-0035).
 */
export type SchemeMode = "light" | "dark" | "auto";

/** Shell → preview. */
export interface SchemeMessage {
  source: typeof SCHEME_MESSAGE_TYPE;
  mode: SchemeMode;
}

/** Preview → shell, once per document. The iframe is recreated on every rebuild,
 *  so this is the only reliable moment to (re)send the mode. */
export interface SchemeReadyMessage {
  source: typeof SCHEME_MESSAGE_TYPE;
  ready: true;
}

/** True when `message` is the preview announcing a fresh receiver. */
export function isSchemeReady(message: unknown): message is SchemeReadyMessage {
  const value = message as Partial<SchemeReadyMessage> | null;
  return !!value && value.source === SCHEME_MESSAGE_TYPE && value.ready === true;
}

/** The element id the receiver owns on its fallback path, so the override can be
 *  found and replaced rather than accumulating one `<style>` per message. The
 *  primary path adopts a constructed stylesheet and creates no element at all —
 *  see `SCHEME_RECEIVER_SOURCE`. */
export const SCHEME_STYLE_ID = "hot-runner-scheme";

/**
 * The receiver, as source to inject.
 *
 * `!important` is load-bearing and was measured, not assumed. `ThemeManager`
 * prepends its own `<style>` *inside* the theme wrapper element, so its
 * `.ht-theme-main { color-scheme: … }` rule and this one have equal specificity and
 * theirs is later in document order — without `!important` this rule changes
 * nothing at all. Verified against production: the same rule plain left
 * `color-scheme` at `light dark`; with `!important` the grid flipped whole.
 *
 * The override is a document-level rule rather than an inline style on the wrapper
 * because a remount replaces that element and takes the inline style with it. A
 * stylesheet keyed on `[class*="ht-theme-"]` also covers a demo that mounts more
 * than one grid.
 *
 * It is carried by a *constructed* stylesheet on `document.adoptedStyleSheets`
 * rather than a `<style>` element, which is load-bearing and was measured
 * (DEV-2580). A remix preview hydrates with `hydrateRoot(document, …)` on React 18,
 * which strict-matches every child of `<head>`; the shell answers this receiver's
 * `ready` while the head is still parsing, so a `<style>` appended there lands
 * *before* hydration and is exactly as fatal as the injected `<script>` was — the
 * document is thrown away and client-rendered ("Hydration failed because the initial
 * UI does not match what was rendered on the server", React #418). Measured against
 * the remix starter: an override `<style>` present at hydration reproduces it on its
 * own. An adopted sheet is not a node, so no hydrator can see it.
 *
 * `adoptedStyleSheets` is an ObservableArray, not an Array — hence
 * `Array.prototype.slice.call` and an assignment back, which also preserves any
 * sheet the demo adopted itself. `auto` detaches ours by identity rather than
 * blanking it, so "no override" stays observable from the outside.
 *
 * Once the adopted path has failed the receiver latches onto the fallback for the
 * life of the document (`fallbackOnly`). Without the latch, a `<style>` created
 * because the constructor threw is never taken away again: `auto` reaches the adopted
 * branch, finds no sheet of ours, reports success, and leaves the override in place.
 * A failure *after* a sheet was already adopted detaches it on the way out, so the
 * two carriers can never both hold a mode.
 *
 * The `<style>` fallback is kept for a browser without constructible stylesheets
 * (older Safari, where `new CSSStyleSheet()` throws): there, the toggle keeps
 * working and a React 18 document hydrator keeps mismatching. A browser-gated
 * residue on the record, not a silent hole.
 *
 * Written as ES5 by hand and never transpiled: on Tier 1 the parcel path runs babel
 * 6 over injected code, which will not parse anything newer. No timestamp, no id,
 * no iteration-dependent ordering — `SandpackRuntime.sameFiles` skips the compile
 * when the sandbox is unchanged, and a receiver that differed between two builds of
 * the same sources would turn every keystroke into a real diff.
 */
export const SCHEME_RECEIVER_SOURCE = `(function () {
  if (typeof window === 'undefined' || window.parent === window) { return; }
  if (window.__hotRunnerScheme) { return; }
  window.__hotRunnerScheme = true;
  var STYLE_ID = ${JSON.stringify(SCHEME_STYLE_ID)};
  var SOURCE = ${JSON.stringify(SCHEME_MESSAGE_TYPE)};
  var sheet = null;
  var fallbackOnly = false;
  function rule(mode) {
    return '[class*="ht-theme-"]{color-scheme:' + mode + ' !important;}';
  }
  function canAdopt() {
    return typeof CSSStyleSheet === 'function'
      && !!CSSStyleSheet.prototype
      && typeof CSSStyleSheet.prototype.replaceSync === 'function'
      && !!document.adoptedStyleSheets;
  }
  function applyAdopted(mode) {
    var on = mode === 'light' || mode === 'dark';
    if (!sheet) {
      if (!on) { return true; }
      try { sheet = new CSSStyleSheet(); } catch (e) { return false; }
    }
    var sheets = Array.prototype.slice.call(document.adoptedStyleSheets);
    var at = sheets.indexOf(sheet);
    if (!on) {
      if (at !== -1) { sheets.splice(at, 1); document.adoptedStyleSheets = sheets; }
      return true;
    }
    try {
      sheet.replaceSync(rule(mode));
    } catch (e) {
      // Detach on the way out. An adopted sheet left carrying the *previous* mode
      // outranks the fallback element that is about to be created, so the stale
      // scheme would win and no later message could clear it.
      if (at !== -1) { sheets.splice(at, 1); document.adoptedStyleSheets = sheets; }
      return false;
    }
    if (at === -1) { sheets.push(sheet); document.adoptedStyleSheets = sheets; }
    return true;
  }
  function applyElement(mode) {
    var el = document.getElementById(STYLE_ID);
    if (mode !== 'light' && mode !== 'dark') {
      if (el && el.parentNode) { el.parentNode.removeChild(el); }
      return;
    }
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(el);
    }
    el.textContent = rule(mode);
  }
  function apply(mode) {
    if (!fallbackOnly && canAdopt() && applyAdopted(mode)) { return; }
    fallbackOnly = true;
    applyElement(mode);
  }
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.source !== SOURCE || typeof data.mode !== 'string') { return; }
    apply(data.mode);
  });
  window.parent.postMessage({ source: SOURCE, ready: true }, '*');
})();`;

/**
 * One physical line, for a JS entry.
 *
 * Appended rather than prepended, which the monitor cannot do and this can. The
 * monitor has to be hooked before the demo's own scripts, because a fault raised
 * while they evaluate is exactly what it is there to catch. This receiver only
 * answers a message, and a demo that threw on evaluation has no grid to re-theme —
 * so it can go last, and the compile positions the visitor is shown stay exactly
 * right instead of shifting by one (DEV-2557).
 */
export const SCHEME_MODULE_LINE = `try{(0,eval)(${JSON.stringify(SCHEME_RECEIVER_SOURCE)})}catch(e){}`;

/** True when `source` already carries the receiver. */
function alreadyInjected(source: string): boolean {
  return source.indexOf(SCHEME_MESSAGE_TYPE) !== -1;
}

/**
 * Insert the receiver into an HTML document.
 *
 * Unlike the monitor's, this one does not have to run before the demo's own
 * scripts — it only reacts to a message, and the shell (re)sends on `ready`. It is
 * still placed in `<head>` for the same reason the monitor is: it is the one
 * insertion point every document has, and being early costs nothing.
 *
 * Inserted with no surrounding whitespace, and the tag deletes its own element
 * (see `inject-html.ts`): a React 18 hydrator that owns the whole document — remix's
 * `hydrateRoot(document, …)` — strict-matches every child of `<head>`, and a leftover
 * newline text node fails that match exactly as the `<script>` element does. Both
 * halves were measured against the remix starter; either one alone still throws
 * React #418 (DEV-2580).
 *
 * The insertion point itself is `insertInjectedTag` — shared with the monitor, and
 * *before* `<body>` in a document with no `<head>`, which is what DEV-2724 turned on.
 *
 * Returns `html` unchanged when it is already injected.
 */
export function injectSchemeIntoHtml(html: string): string {
  if (alreadyInjected(html)) return html;
  return insertInjectedTag(html, injectedScriptTag(SCHEME_RECEIVER_SOURCE));
}

/**
 * Add the receiver to the file map the Tier-1 bundler will see.
 *
 * `entryPath` is the resolved sandbox entry — an HTML file for the `parcel` and
 * `static` environments, a JS module otherwise. Both are handled.
 *
 * Returns `files` unchanged when the entry is missing from the map: that is
 * `setupFrom`'s error to raise, with its own message (DEV-2130), and it must not
 * become "the colour-scheme bridge broke the preview".
 */
export function injectSchemeReceiver(
  files: Record<string, string>,
  entryPath: string,
): Record<string, string> {
  const source = files[entryPath];
  if (source === undefined) return files;
  if (alreadyInjected(source)) return files;
  const injected = entryPath.toLowerCase().endsWith(".html")
    ? injectSchemeIntoHtml(source)
    : source + "\n" + SCHEME_MODULE_LINE;
  return { ...files, [entryPath]: injected };
}
