// Carry the demo's authored `<head>` into a Tier-1 live preview (DEV-2576).
//
// The classic bundler renders the demo's `<body>` inside its *own* document shell
// and discards the authored `<head>`. Measured inside a live preview: `document.title`
// is "Sandbox - CodeSandbox" and `document.querySelectorAll('link[rel=stylesheet]')`
// is empty, while the bundler's input FS still holds the authored `/index.html`
// complete with its tags. So a demo whose theme CSS is a CDN `<link>` renders with
// core styles only — `--ht-*` undefined, cell padding `0px`, borders falling back to
// the demo's own `--ht-foreground-color` — while `/d/:id`, which serves the real
// HTML, looks right. `withInjections` already distrusts the head for a `<script>`
// and injects into the JS entry as well; this is the same belt for head *assets*.
//
// Deliberately **not** carried:
//
// - **Local stylesheets.** Measured, not assumed: a probe payload on the deployed
//   runner showed `<link rel="stylesheet" href="./styles.css">` already applying in
//   the preview (the bundler resolves the local URL through the module graph, which
//   is also why `transpile.ts` has to prune links whose target is missing) while the
//   authored inline `<style>` beside it did not. Re-emitting it would apply the same
//   rules twice and drag the file's text into the injected line.
// - **Any other local URL.** `fetch()` from inside the preview for `/index.js`,
//   `./index.js`, `/index.html` and `/package.json` all answer `200 text/html` with
//   CodeSandbox's own SPA shell — the sandbox files are not served over HTTP. A
//   re-created local `<link rel=icon>` would render that document as an icon.
// - **`<script>`.** Re-evaluating the demo's own module is a worse bug than a missing
//   head. A CDN `<script>` in the head therefore still does not reach the preview;
//   `normalizeCdnGlobals` in the API worker converts the recognised ones to npm
//   imports at import time.
// - **`<meta charset>` / `<meta http-equiv>`.** Parse-time directives that do nothing
//   when set from script, and a re-created `http-equiv="refresh"` would navigate the
//   preview away.

import { toFilesKey } from "./html-urls.js";

/** Marker, idempotency guard, and the attribute that tags every node we create. */
export const HEAD_ASSETS_MARKER = "hot-runner-head";

const MARK_ATTRIBUTE = `data-${HEAD_ASSETS_MARKER}`;

export type HeadAsset =
  | { kind: "title"; text: string }
  | { kind: "style"; css: string; media?: string }
  | { kind: "element"; tag: "link" | "meta"; attrs: [string, string][] };

const HEAD_RE = /<head\b[^>]*>([\s\S]*?)<\/head>/i;
/** Where the implicit head ends when the document declares none. */
const BODY_OPEN_RE = /<body\b/i;
/** Removed before scanning: by injection time the head already holds our own
 *  `<script>` receivers, and a commented-out tag is not an asset. */
const SCRIPT_BLOCK_RE = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
const COMMENT_RE = /<!--[\s\S]*?-->/g;

// `>` is legal inside a quoted attribute value (`content="x > y"`), and a `[^>]*`
// tag matcher truncates there — `attributesOf` then reads the rest of the value as
// attribute *names*, so the authored value is lost and unrelated attributes ride
// along. Quoted runs are therefore matched as units.
const TAG_BODY = String.raw`(?:"[^"]*"|'[^']*'|[^>])`;
const TOKEN_RE = new RegExp(
  `<title\\b${TAG_BODY}*>([\\s\\S]*?)<\\/title>`
  + `|<style\\b(${TAG_BODY}*)>([\\s\\S]*?)<\\/style>`
  + `|<(link|meta)\\b(${TAG_BODY}*?)\\/?>`,
  "gi",
);
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function attributesOf(raw: string): [string, string][] {
  const attrs: [string, string][] = [];
  ATTR_RE.lastIndex = 0;
  let match = ATTR_RE.exec(raw);
  while (match !== null) {
    // A bare attribute (`defer`, `async`) has no value group; `""` is what
    // `setAttribute` would store for it anyway.
    attrs.push([match[1] ?? "", match[2] ?? match[3] ?? match[4] ?? ""]);
    match = ATTR_RE.exec(raw);
  }
  return attrs;
}

const valueOf = (attrs: [string, string][], name: string): string | undefined =>
  attrs.find(([key]) => key.toLowerCase() === name)?.[1];

/**
 * The assets in a demo's `<head>` that the preview cannot obtain any other way, in
 * document order. Document order is the whole ordering story: it is what reproduces
 * the authored cascade, and it is what makes the emitted payload a pure function of
 * the HTML (see `headAssetsModuleLine`).
 */
export function extractHeadAssets(html: string): HeadAsset[] {
  // `<head>` is optional in HTML — a document that omits it still has an implicit
  // one, and `/d/:id` renders such a demo themed because the browser parses it that
  // way. Falling back to "everything before <body>" keeps the two paths in step.
  const head = HEAD_RE.exec(html);
  let scope: string;
  if (head !== null) {
    scope = head[1] ?? "";
  } else {
    const body = BODY_OPEN_RE.exec(html);
    scope = body === null ? html : html.slice(0, body.index);
  }
  const inner = scope.replace(SCRIPT_BLOCK_RE, "").replace(COMMENT_RE, "");

  const assets: HeadAsset[] = [];
  TOKEN_RE.lastIndex = 0;
  let token = TOKEN_RE.exec(inner);
  while (token !== null) {
    const [, titleText, styleAttrs, styleCss, tagName, tagAttrs] = token;

    if (titleText !== undefined) {
      assets.push({ kind: "title", text: titleText });
    } else if (styleCss !== undefined) {
      const media = valueOf(attributesOf(styleAttrs ?? ""), "media");
      // `<style media="print">` applied to the screen would be a new bug, so the
      // media query travels with the block or the block does not travel.
      assets.push(media === undefined ? { kind: "style", css: styleCss } : { kind: "style", css: styleCss, media });
    } else if (tagName !== undefined) {
      const tag = tagName.toLowerCase() as "link" | "meta";
      const attrs = attributesOf(tagAttrs ?? "");
      if (tag === "meta") {
        const named = attrs.some(([key]) => {
          const lower = key.toLowerCase();
          return lower === "charset" || lower === "http-equiv";
        });
        if (!named) assets.push({ kind: "element", tag, attrs });
      } else {
        const href = valueOf(attrs, "href");
        // No href is nothing to load; a local URL is either already handled by the
        // bundler (stylesheets) or unfetchable in this sandbox (everything else).
        if (href !== undefined && toFilesKey(href) === null) {
          assets.push({ kind: "element", tag, attrs });
        }
      }
    }
    token = TOKEN_RE.exec(inner);
  }
  return assets;
}

/**
 * The receiver, as source to inject: constant code, with the demo's assets handed in
 * as an argument.
 *
 * Written as ES5 by hand and never transpiled, for the reason `scheme.ts` and
 * `monitor.ts` say: on Tier 1 the classic bundler runs its own 2018-era babel over
 * the module entry, and a parse failure there presents as a blank preview with no
 * error card. `pipeline/head-assets.test.mjs` gates it with acorn at `ecmaVersion: 5`,
 * because `new Function` in modern node would accept plenty that babel refuses.
 *
 * The per-asset guards make the payload inert when the head *was* preserved — the
 * head-dropping is measured on the parcel path, and `vue-cli` is not — so it can be
 * applied to every entry that declares an `htmlEntry` without risking a second copy
 * of every stylesheet.
 *
 * Deliberately *no* `window`-level "already ran" latch, unlike `scheme.ts` and
 * `monitor.ts`. Those two register listeners, which must be hooked once; this one
 * creates DOM nodes, and the bundler resets the preview document on a recompile
 * (`pushUpdate`'s own comment: "the bundler's no-change path resets the document
 * without re-evaluating any module"). A latch on `window` — which survives that
 * reset — would make every compile after the first leave the head empty, while
 * buying nothing the per-asset guards do not already provide.
 */
const RECEIVER_HEAD = `(function (assets) {
  if (typeof document === 'undefined' || !assets || !assets.length) { return; }
  var MARK = '${MARK_ATTRIBUTE}';
  var head = document.head || document.getElementsByTagName('head')[0] || document.documentElement;

  /* The demo has already built its grid against an unstyled DOM by the time this
     runs, and a cross-origin stylesheet lands later still. A generic bubbling
     resize is the demo-agnostic way to ask for a re-measure — Handsontable's own
     listener calls refreshDimensions() — and it is bounded at 1 + one per link. */
  function nudge() {
    try {
      var event = document.createEvent('Event');
      event.initEvent('resize', true, false);
      window.dispatchEvent(event);
    } catch (e) {}
  }
  function relOf(node) {
    /* node.rel is the reflected property every real link has; getAttribute is the
       fallback for anything that only carries the attribute. */
    var value = node.rel;
    if (value === undefined || value === null) {
      value = node.getAttribute ? node.getAttribute('rel') : null;
    }
    return (value || '').toLowerCase();
  }
  /* Keyed on rel *and* href, not href alone: a preload link and a stylesheet link
     for the same URL are the canonical CDN idiom, and an href-only guard appends the
     preload and then skips the stylesheet as a duplicate — leaving the demo
     unstyled, which is the bug this file exists to fix. */
  function hasLink(url, rel) {
    var links = document.getElementsByTagName('link');
    for (var i = 0; i < links.length; i += 1) {
      if (links[i].href === url && relOf(links[i]) === rel) { return true; }
    }
    return false;
  }
  function hasStyle(css) {
    var styles = document.getElementsByTagName('style');
    for (var i = 0; i < styles.length; i += 1) {
      if ((styles[i].textContent || '') === css) { return true; }
    }
    return false;
  }

  for (var i = 0; i < assets.length; i += 1) {
    var asset = assets[i];
    if (asset.kind === 'title') {
      /* Decoded the way the parser would have: a title is RCDATA, so entities are
         text and a tag inside it never becomes a node. */
      var box = document.createElement('textarea');
      box.innerHTML = asset.text;
      document.title = box.value;
      continue;
    }
    if (asset.kind === 'style') {
      if (hasStyle(asset.css)) { continue; }
      var style = document.createElement('style');
      style.setAttribute(MARK, '');
      if (asset.media) { style.setAttribute('media', asset.media); }
      style.appendChild(document.createTextNode(asset.css));
      head.appendChild(style);
      continue;
    }
    var element = document.createElement(asset.tag);
    for (var j = 0; j < asset.attrs.length; j += 1) {
      try { element.setAttribute(asset.attrs[j][0], asset.attrs[j][1]); } catch (e) {}
    }
    if (asset.tag === 'link') {
      /* element.href is the resolved absolute URL, which is what an existing link
         reports too — comparing the authored strings would miss a match. */
      if (hasLink(element.href, relOf(element))) { continue; }
      element.onload = nudge;
      element.onerror = nudge;
    }
    element.setAttribute(MARK, '');
    head.appendChild(element);
  }
  nudge();
})(`;

const RECEIVER_TAIL = `);`;

export function headAssetsSource(assets: HeadAsset[]): string {
  return RECEIVER_HEAD + JSON.stringify(assets) + RECEIVER_TAIL;
}

/**
 * `JSON.stringify` of a string, without its surrounding quotes.
 *
 * U+2028 and U+2029 are escaped by hand because `JSON.stringify` leaves them raw:
 * they are legal inside an ES2019+ string literal but are LineTerminators in ES5, so
 * one of them anywhere in a demo's `<title>` or `<style>` (a paste out of a word
 * processor is enough) makes the emitted line unparseable for the 2018-era babel the
 * classic bundler runs — presenting as the blank preview with no error card that this
 * module's ES5 discipline exists to avoid. The module's own acorn gate cannot catch
 * it: that covers the constant receiver, not the demo-derived payload.
 */
const jsonInner = (value: string): string => {
  const quoted = JSON.stringify(value);
  return quoted.slice(1, quoted.length - 1).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
};

/**
 * The two halves of the injected line, exported so `stripInjectedHeadAssets` stays
 * coupled to the injection instead of matching a shape — the failure mode
 * `stripInjectedReporter` documents: a regex over the injected shape keeps passing
 * its own tests while silently ceasing to match a reworded injection.
 *
 * The decomposition is exact rather than approximate: JSON string escaping is
 * per-character, so `JSON.stringify(A + B + C)` is `"` + esc(A) + esc(B) + esc(C) + `"`.
 */
export const HEAD_ASSETS_LINE_PREFIX = `try{(0,eval)("${jsonInner(RECEIVER_HEAD)}`;
export const HEAD_ASSETS_LINE_SUFFIX = `${jsonInner(RECEIVER_TAIL)}")}catch(e){}`;

/**
 * One physical line, for a JS entry.
 *
 * Appended rather than prepended. Unlike the monitor's, this line is not a constant —
 * it carries the demo's own bytes — so the DEV-2557 pathology cannot be undone after
 * the fact by an exact-string strip on every path: babel's code frame prints the two
 * lines *above* a fault verbatim, so a prepended line buries a syntax error on
 * authored line 1 and `MONITOR_COMPILE_MESSAGE_MAX` then cuts the caret away.
 * Appending keeps it out of the frame for every fault except one within two lines of
 * EOF, and leaves every compile position the visitor is shown exactly where it is.
 *
 * Prepending would not buy the ordering it looks like it buys, either: a dynamically
 * inserted cross-origin `<link>` never blocks script execution, so the stylesheet
 * lands after the demo's module body either way. That is what `nudge` is for.
 */
export function headAssetsModuleLine(assets: HeadAsset[]): string {
  return HEAD_ASSETS_LINE_PREFIX + jsonInner(JSON.stringify(assets)) + HEAD_ASSETS_LINE_SUFFIX;
}

/** Replace the injected line in a compile message with a short marker. */
export function stripInjectedHeadAssets(message: string): string {
  const start = message.indexOf(HEAD_ASSETS_LINE_PREFIX);
  if (start === -1) return message;
  const end = message.indexOf(HEAD_ASSETS_LINE_SUFFIX, start);
  if (end === -1) return message;
  return `${message.slice(0, start)}<${HEAD_ASSETS_MARKER}>${message.slice(end + HEAD_ASSETS_LINE_SUFFIX.length)}`;
}

/** True when `source` already carries the payload. */
function alreadyInjected(source: string): boolean {
  return source.indexOf(MARK_ATTRIBUTE) !== -1;
}

/**
 * Re-create the HTML entry's head assets from the module entry.
 *
 * Cross-file, which is why it is not one more step in `withInjections`' reduce: it
 * reads `htmlPath` and writes `modulePath`. Returns the same object when there is
 * nothing to do — including the common case of a starter whose head holds only a
 * charset and a script, so the overwhelming majority of demos see byte-for-byte the
 * sandbox they see today.
 *
 * Never throws, and never pre-empts the "entry file not found" error `setupFrom`
 * raises for a missing entry (DEV-2130): a missing file here is a same-object return,
 * not a second, worse error.
 */
export function injectHeadAssets(
  files: Record<string, string>,
  htmlPath: string | null | undefined,
  modulePath: string,
): Record<string, string> {
  if (!htmlPath) return files;
  // The document is the module: whatever env this is, it is served as authored and
  // there is no head to carry.
  if (modulePath.toLowerCase().endsWith(".html")) return files;
  const html = files[htmlPath];
  const source = files[modulePath];
  if (html === undefined || source === undefined) return files;
  if (alreadyInjected(source)) return files;

  const assets = extractHeadAssets(html);
  if (assets.length === 0) return files;
  return { ...files, [modulePath]: `${source}\n${headAssetsModuleLine(assets)}` };
}
