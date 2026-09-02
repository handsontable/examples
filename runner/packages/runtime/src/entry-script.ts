// Does a demo's HTML entry actually load a module? (DEV-2741)
//
// A demo saved with `index.html` = `<div id="grid"></div>` and nothing else renders
// exactly that: an empty div, everywhere. Both consumers of the HTML entry derive the
// module graph from its `<script>` tags and neither has a fallback —
//
//   - Tier 1: `resolveSandboxEntry` makes the HTML file the sandbox entry for every
//     `parcel`/`static` example (sandbox-entry.ts), and the bundler's HTML transpiler
//     walks its `<script src>` tags. No tag, no module, no grid — and no error either,
//     because the compile succeeds. `withInjections` writes the monitor and the scheme
//     receiver into the JS entry as well, so a preview where `window.__hotRunnerScheme`
//     is undefined is the tell that the module never ran at all.
//   - `/d/:id`: `vite build` reads the same document. Its `dist/` comes out holding the
//     authored HTML and no bundle, which `runBuild`'s only output check — "did it emit
//     *any* file?" — accepts as a successful build.
//
// The same failure class as DEV-2130 ("compiles fine, executes nothing, no banner"),
// which its entry-exists guard cannot see: `/index.html` is present, it is just inert.
//
// The rule here is deliberately the weak one — *some* script, not *the catalog's* entry.
// A demo whose document loads `/src/main.js` while the catalog's `entry` says
// `/index.js` builds and renders fine on both paths, and refusing it would be a false
// rejection of working work. What never renders is a document with no script at all, or
// one whose only local scripts point at files that were not sent.

import { toFilesKey } from "./html-urls.js";

/** `<script …>`, open tag only. Two copies rather than one shared `/g`: `test()` on a
 *  global regex advances `lastIndex` and would make the next call answer differently. */
const SCRIPT_TAG_ALL = /<script\b[^>]*>/gi;
const SCRIPT_TAG = /<script\b[^>]*>/i;

/**
 * The `src` of a `<script>` open tag, single- double- or unquoted.
 *
 * Anchored on the whitespace that separates HTML attributes rather than on `\b`, which
 * also fires between the `-` and the `s` of `data-src` — reading a lazy-loading idiom's
 * `data-src` as the script's real source, and refusing a document that renders fine.
 */
const SRC_ATTRIBUTE = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/i;

/** `<!-- … -->`, including one that never closes (the parser discards the rest too). */
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;

/**
 * The document with its comments removed, which is what both scans below run over.
 *
 * A commented-out `<script>` is the likeliest way a working demo loses its entry — an
 * author disables the tag rather than deleting it — and it is the one input where
 * getting this wrong is silent in both directions: counted as a script, the repair
 * no-ops and the preview goes blank with no error; counted as a *live* src, a document
 * whose real tag sits below the comment reads as dangling and is refused.
 */
function stripComments(html: string): string {
  return html.indexOf("<!--") === -1 ? html : html.replace(HTML_COMMENT, "");
}

/**
 * An HTML `src` reduced to the file it names: query and fragment dropped first.
 *
 * `src="/index.js?v=2"` is a real thing to write and resolves to `/index.js` for every
 * bundler that reads this document. `toFilesKey` alone would hand back `/index.js?v=2`,
 * which is in no file map — and this decides a hard refusal, not (as at `toFilesKey`'s
 * two other call sites) whether to re-create a `<link>`.
 */
function scriptTarget(value: string): string | null {
  return toFilesKey(value.replace(/[?#].*$/, ""));
}

export type EntryScriptProblem =
  /** The document holds no `<script>` at all. */
  | { kind: "no-script" }
  /** Every local `<script src>` points at a file that is not in the map. */
  | { kind: "dangling"; targets: string[] };

/** Every `src` in the document that names a file rather than a URL the browser fetches. */
export function localScriptTargets(html: string): string[] {
  const out: string[] = [];
  for (const tag of stripComments(html).match(SCRIPT_TAG_ALL) ?? []) {
    const src = SRC_ATTRIBUTE.exec(tag);
    if (!src) continue;
    const value = src[1] ?? src[2] ?? src[3] ?? "";
    const key = scriptTarget(value);
    if (key !== null) out.push(key);
  }
  return out;
}

/** True when the document carries at least one live `<script>` tag of any kind. */
export function hasAnyScript(html: string): boolean {
  return SCRIPT_TAG.test(stripComments(html));
}

/**
 * Why this HTML entry will render nothing, or `null` when it will run something.
 *
 * A document with an external or inline script is left alone: it may well be a CDN demo,
 * and this cannot tell the difference between one and a mistake.
 */
export function entryScriptProblem(
  html: string,
  files: Record<string, string>,
): EntryScriptProblem | null {
  if (!hasAnyScript(html)) return { kind: "no-script" };
  const targets = localScriptTargets(html);
  if (targets.length === 0) return null; // inline and/or external only — not ours to judge
  if (targets.some((path) => files[path] !== undefined)) return null;
  return { kind: "dangling", targets };
}

/** The tag the starters emit, and the one a repair adds. */
export function entryScriptTag(entry: string): string {
  return `<script type="module" src="${entry}"></script>`;
}

/**
 * Add the missing entry `<script>` to an HTML entry that has none.
 *
 * Before `</body>` when the document has one, appended otherwise — position is not load-
 * bearing (both bundlers resolve the tag by `src`, not by document order), so a fragment
 * simply gains the tag at the end. Returns `html` unchanged whenever the document already
 * has a script of any kind, so it is safe to run on every read and idempotent on its own
 * output.
 */
export function ensureEntryScript(html: string, entry: string): string {
  if (hasAnyScript(html)) return html;
  const tag = entryScriptTag(entry);
  // The captured run of whitespace is reused so the tag lands on its own line at the
  // body's own indentation instead of being wedged against `</body>`.
  const close = /(\n[ \t]*)?<\/body\s*>/i.exec(html);
  if (close) {
    const gap = close[1] ?? "\n";
    return html.slice(0, close.index) + gap + tag + html.slice(close.index);
  }
  return html.endsWith("\n") ? `${html}${tag}\n` : `${html}${tag}`;
}
