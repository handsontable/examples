// Turning a theme into files in the demo (DEV-2047).
//
// Uses Handsontable's JavaScript theme API — registerTheme / params /
// setColorScheme / setDensityType, as documented on the "Theme customization"
// page and as theme-builder itself does. A theme is a real object the grid is
// given, not a pile of CSS variables shadowing one.
//
// That means two things have to land in the example: a module that builds the
// theme, and a reference to it wherever the grid is constructed. The second is
// the awkward half — `new Handsontable(el, {…})`, `<HotTable theme={…}>` and
// Angular's settings object are all different — so the wiring is done by
// recognising those specific shapes, and when none of them match the panel
// says which line to add instead of guessing and corrupting the file.
//
// Several starters already do this by hand (`theme={antTableTheme}`,
// `.setColorScheme("light")`), which is a good sign the generated code reads
// like something a person would have written.

import { googleFontFamily, isPristine, type ThemeState, type TokenValue } from "./vocabulary.js";


/** Files a demo may use as its HTML entry, most specific first. */

/** Drop cleared entries. A `[light, dark]` pair counts as set when either half
 *  is — clearing only one scheme still leaves an override to write. */
const nonEmpty = <T extends TokenValue>(record: Record<string, T>): [string, T][] =>
  Object.entries(record).filter(([, v]) =>
    Array.isArray(v) ? v.some((s) => String(s).trim().length > 0) : String(v).trim().length > 0);

/** The generated theme module, at a fixed path so regenerating replaces it. */
export const THEME_MODULE_BASENAME = "handsontable-theme";
const MARKER = "handsontable-theme";

/**
 * String literals for generated source.
 *
 * JSON.stringify, not hand-rolled quoting: a value typed into the panel — or
 * returned by the styling model — ends up inside a module that the example
 * evaluates, so a backslash or a line terminator that escapes the literal is
 * script injection into a demo other people open. The server whitelists these
 * values too; this is the second lock on the same door.
 *
 * Keys go through it as well, not just values (DEV-2199). They look trustworthy
 * — they come from the token catalogue — but a theme restored from localStorage
 * or arriving in a shared link carries whatever keys it likes, and an unquoted
 * one closes the object literal just as effectively as an unquoted value.
 *
 * U+2028 and U+2029 are escaped by hand because `JSON.stringify` does not touch
 * them and JavaScript treats them as line terminators. That is only cosmetic
 * inside a string literal, but fatal inside the `//` comment the marker uses:
 * the comment ends early and whatever follows becomes executable code.
 */
const jsSafe = (json: string) =>
  json.replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

const lit = (v: TokenValue) => jsSafe(JSON.stringify(v));

/** Dotted palette keys -> a nested object, deep-merged over the preset so
 *  editing one step never drops the ten the preset supplied. */
function paletteSource(entries: [string, string][], presetVar: string, typescript: boolean): string {
  const ramps: Record<string, Record<string, string>> = {};
  const scalars: Record<string, string> = {};
  for (const [key, value] of entries) {
    const dot = key.indexOf(".");
    if (dot === -1) scalars[key] = value;
    else (ramps[key.slice(0, dot)] ??= {})[key.slice(dot + 1)] = value;
  }

  const lines = [`    ...${presetVar},`];
  for (const [ramp, steps] of Object.entries(ramps)) {
    // Bracket notation for the spread, because a ramp name is data too: a dotted
    // key like `foo.bar` would otherwise be pasted straight into member access.
    //
    // The cast is not decoration (DEV-2216): the preset's index signature is
    // `string | Record<string, string>` — a scalar colour or a ramp — so under
    // a type-checking build spreading one element is TS2698, "spread types may
    // only be created from object types". Only ramps are spread here; they are
    // the entries that had a dotted key.
    const rampExpr = `${presetVar}[${lit(ramp)}]`;
    lines.push(
      `    ${lit(ramp)}: {`,
      `      ...${typescript ? `(${rampExpr} as Record<string, string>)` : rampExpr},`,
    );
    for (const [step, value] of Object.entries(steps)) lines.push(`      ${lit(step)}: ${lit(value)},`);
    lines.push("    },");
  }
  for (const [key, value] of Object.entries(scalars)) lines.push(`    ${lit(key)}: ${lit(value)},`);
  return lines.join("\n");
}

/**
 * The theme module written into the demo.
 *
 * Built the way theme-builder builds one at runtime: assemble the full config
 * from the three preset modules, register it under a name (re-initialising on
 * a hot reload rather than registering twice), then layer token overrides
 * through `.params()`. Presets have to go through the config rather than
 * `.params()` because that is the only place `icons` and the density `sizes`
 * are accepted.
 */
export function buildThemeModule(state: ThemeState, typescript: boolean): string {
  const palette = nonEmpty(state.palette);
  const tokens = nonEmpty(state.params);
  // [variant, [[size, value], …]] for every variant that has any override.
  const density = Object.entries(state.densitySizes ?? {})
    .map(([variant, sizes]) => [variant, nonEmpty(sizes ?? {})] as const)
    .filter(([, sizes]) => sizes.length > 0);
  const font = googleFontFamily(state.params.fontFamily);

  const lines = [
    "// Generated by the demo runner's theme panel. Edit freely — it is a normal",
    "// module, and regenerating replaces it.",
    "import { getTheme, hasTheme, registerTheme, reinitTheme } from 'handsontable/themes';",
    // The annotation below needs the type, and only a TypeScript demo can say so.
    ...typescript ? ["import type { ThemeParams } from 'handsontable/themes';"] : [],
    `import tokensPreset from 'handsontable/themes/static/variables/tokens/${state.tokens}';`,
    `import colorsPreset from 'handsontable/themes/static/variables/colors/${state.colors}';`,
    `import iconsPreset from 'handsontable/themes/static/variables/icons/${state.icons}';`,
    "",
    "const THEME_NAME = 'custom-theme';",
    "",
    // Annotated, not bare (DEV-2216). Without a contextual type, `density:
    // "compact"` and `colorScheme: "dark"` widen to `string`, which is not
    // `DensityType` / `ThemeColorScheme` — so `registerTheme(…, config)` is a
    // type error. Angular is the only starter whose dev server type-checks, so
    // there the whole build failed and the preview silently kept serving the
    // last good bundle: no theme, no console error, and every later edit
    // invisible too. The other starters strip types and never noticed.
    `const config${typescript ? ": ThemeParams" : ""} = {`,
    "  tokens: tokensPreset,",
    palette.length
      ? `  colors: {\n${paletteSource(palette, "colorsPreset", typescript)}\n  },`
      : "  colors: colorsPreset,",
    "  icons: iconsPreset,",
    // `sizes` is keyed by density variant, not by size name — see
    // ThemeDensitySizes in handsontable/themes. Emitting the sizes flat put
    // them a level too high and Handsontable ignored them silently, so density
    // overrides never reached the grid at all (DEV-2199). Every variant that
    // has overrides is written, not only the selected one, so switching the
    // grid to comfortable still finds the sizes tuned for it.
    density.length
      ? `  density: {\n    type: ${lit(state.density)},\n    sizes: {\n${
        density.map(([variant, sizes]) =>
          `      ${lit(variant)}: {\n${
            sizes.map(([k, v]) => `        ${lit(k)}: ${lit(v)},`).join("\n")
          }\n      },`).join("\n")
      }\n    },\n  },`
      : `  density: ${lit(state.density)},`,
    `  colorScheme: ${lit(state.colorScheme)},`,
    "};",
    "",
    "// Re-initialise rather than register twice: this module is re-evaluated on",
    "// every hot reload.",
    "if (hasTheme(THEME_NAME)) {",
    "  reinitTheme(THEME_NAME, config);",
    "} else {",
    "  registerTheme(THEME_NAME, config);",
    "}",
    "",
  ];

  // `getTheme` is typed `ThemeBuilder | undefined` — it cannot know the two
  // lines above just registered this name. Under a type-checking build that is
  // TS2532 on `.params(…)`, which is the same silent-stale-preview failure as
  // the config above (DEV-2216), so the assertion says what the branch already
  // guarantees.
  const theme = `getTheme(THEME_NAME)${typescript ? "!" : ""}`;
  if (tokens.length > 0) {
    lines.push(
      `export const customTheme = ${theme}.params({`,
      "  tokens: {",
      ...tokens.map(([k, v]) => `    ${lit(k)}: ${lit(v)},`),
      "  },",
      "});",
    );
  } else {
    lines.push(`export const customTheme = ${theme};`);
  }

  if (font) {
    lines.push(
      "",
      "// The font has to exist in the page before the grid can use it.",
      "const fontLink = document.createElement('link');",
      "fontLink.rel = 'stylesheet';",
      `fontLink.href = ${lit(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(font).replace(/%20/g, "+")}&display=swap`)};`,
      "document.head.appendChild(fontLink);",
    );
  }

  return `${lines.join("\n")}\n`;
}

/**
 * The code to copy into a real application.
 *
 * Identical to what is written into the demo, and that is the point: with the
 * JS API there is no gap between "what the playground did" and "what you paste
 * into your app" — the panel is not translating between two mechanisms.
 *
 * Which means it follows the demo's language too. The TypeScript form carries
 * an annotation and two casts it cannot compile without (DEV-2216), and those
 * are a syntax error the moment they are pasted into a JavaScript file.
 */
export function buildThemeSnippet(state: ThemeState, typescript: boolean): string {
  return `${buildThemeModule(state, typescript)}\n// then hand it to the grid:  <HotTable theme={customTheme} … />\n`;
}

export interface ThemeFileChange {
  path: string;
  contents: string;
}

/** Where the grid is built, and how a theme is handed to it. */
interface WireTarget {
  path: string;
  contents: string;
}

/**
 * The import we add, tagged so we can find our own work later.
 *
 * When wiring displaced a `themeName`, the marker carries it along so **Reset**
 * can put it back (DEV-2199). Without that, apply-then-reset silently left the
 * demo unthemed instead of returning it to `ht-theme-main` — the original was
 * gone and nothing remembered it. Keeping it in the file rather than in panel
 * state means it survives Download, Share and a reload, exactly like the rest
 * of the wiring.
 *
 * JSON.stringify keeps the payload on one line and quoted; never hand-roll it.
 */
const IMPORT_LINE = (dir: string, displaced?: string, displacedClass?: string | null) =>
  `import { customTheme } from '${dir}${THEME_MODULE_BASENAME}'; // ${MARKER}`
  + (displaced ? ` restore:${jsSafe(JSON.stringify(displaced))}` : "")
  + (displacedClass ? ` class:${jsSafe(JSON.stringify(displacedClass))}` : "");

/** The `themeName` a previous apply displaced, if any. */
function displacedThemeName(source: string): string | null {
  return markerPayload(source, "restore");
}

/** The container theme class a previous apply took off, if any. */
function displacedThemeClass(source: string): string | null {
  return markerPayload(source, "class");
}

/** One `key:"…"` payload from the marker comment. Keyed lookup rather than
 *  "the first marked line", because a Vue apply writes a second marked line
 *  (the `setup` shim) and file order must not decide the answer. */
function markerPayload(source: string, key: "restore" | "class"): string | null {
  const pattern = new RegExp(`\\b${key}:("(?:[^"\\\\]|\\\\.)*")`);
  const marker = source.split("\n").find((line) => line.includes(MARKER) && pattern.test(line));
  const payload = marker?.match(pattern)?.[1];
  if (!payload) return null;
  try {
    const value = JSON.parse(payload) as unknown;
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Attach the theme where the grid is constructed.
 *
 * Three construction shapes cover every starter in the catalog:
 *   `<HotTable …>`                     — React and Vue wrappers, add a prop
 *   `new Handsontable(el, { … })`      — vanilla JS/TS and Astro, add a setting
 *   `const gridSettings … = { … }`     — Angular, add a setting
 *
 * The prop's *syntax* is not shared: a Vue SFC takes `:theme="customTheme"`,
 * and JSX in an SFC template is a literal string attribute.
 *
 * But *where the import goes* is a second question, and the answer is per file
 * type (DEV-2197). A plain module takes it at the top; a `.vue` SFC and a
 * `.astro` component both reject an import written above their blocks. So the
 * dispatch below is by extension first, construction shape second.
 *
 * Anything else is left alone. A theme that fails to apply is a puzzle; a
 * component file mangled by an over-eager regex is a lost afternoon.
 */
function wireTheme(files: Record<string, string>): WireTarget | null {
  const candidates = Object.entries(files)
    .filter(([path]) => /\.(t|j)sx?$|\.vue$|\.astro$/.test(path))
    .sort(([a], [b]) => a.length - b.length);

  for (const [path, source] of candidates) {
    if (typeof source !== "string") continue;
    // Already wired by a previous apply: report it as wired rather than
    // telling the user to add a line that is sitting in the file.
    if (source.includes(MARKER)) return { path, contents: source };

    // Relative path from the edited file back to the module at the root.
    const depth = path.split("/").filter(Boolean).length - 1;
    const dir = depth > 0 ? "../".repeat(depth) : "./";

    // The container's CSS theme comes off first: it out-ranks the theme object
    // silently, and in every starter that has one it sits in this same file.
    const unthemed = stripThemeClass(source);
    const base = unthemed?.source ?? source;
    const displacedClass = unthemed?.displaced ?? null;

    const contents = path.endsWith(".vue")
      ? wireVue(base, dir, displacedClass)
      : path.endsWith(".astro")
        ? wireAstro(base, dir, displacedClass)
        : wireModule(base, dir, displacedClass);

    if (contents) return { path, contents };
  }

  return null;
}

/** A plain JS/TS module: the import goes on the first line. */
function wireModule(source: string, dir: string, displacedClass: string | null): string | null {
  let next: { source: string; displaced: string | null } | null = null;

  // 1. JSX wrapper element. Take over an existing `themeName`/`theme` prop
  //    rather than adding a second one — several starters set their own.
  if (/<(HotTable|hot-table)\b/.test(source)) {
    next = swapInPlace(source, THEME_NAME_ATTR, "theme={customTheme}")
      ?? swapInPlace(source, /\btheme=\{[^}]*\}/, "theme={customTheme}")
      ?? { source: source.replace(/<(HotTable|hot-table)\b/, "<$1 theme={customTheme}"), displaced: null };
  } else if (findVanillaSettings(source)) {
    // 2. Vanilla settings object.
    next = wireVanilla(source, "  ");
  } else if (/gridSettings[^=]*=\s*\{/.test(source)) {
    // 3. Angular's settings object.
    next = swapInPlace(source, THEME_NAME_SETTING, "theme: customTheme,")
      ?? swapInPlace(source, THEME_SETTING, "theme: customTheme,")
      ?? {
        source: source.replace(/(gridSettings[^=]*=\s*\{)/, "$1\n    theme: customTheme,"),
        displaced: null,
      };
  }

  if (!next) return null;
  return `${IMPORT_LINE(dir, next.displaced ?? undefined, displacedClass)}\n${next.source}`;
}

/**
 * A Vue single-file component.
 *
 * Three things are different from a plain module, and the old code got all
 * three wrong by treating an SFC as JSX (DEV-2197):
 *
 *   * The binding is `:theme="customTheme"`. `theme={customTheme}` in a Vue
 *     template is a literal string attribute, so the grid received the
 *     characters `{customTheme}` and rendered unthemed.
 *   * The import belongs *inside* the `<script>` block. Above it, the file is
 *     not a valid SFC at all — the whole demo stops compiling.
 *   * Only `<script setup>` exposes its imports to the template. Under the
 *     Options API a top-level `customTheme` is invisible there, so the binding
 *     resolves to undefined; it needs a `setup()` that returns it. Every docs
 *     example is `<script setup>`, but the catalog's Vue starter is not.
 */
function wireVue(source: string, dir: string, displacedClass: string | null): string | null {
  if (!/<(HotTable|hot-table)\b/.test(source)) return null;

  const next = swapInPlace(source, VUE_THEME_NAME_BIND, ':theme="customTheme"')
    ?? swapInPlace(source, THEME_NAME_ATTR, ':theme="customTheme"')
    ?? swapInPlace(source, /:theme="[^"]*"/, ':theme="customTheme"')
    // A theme inside a `:settings` object (nuxt): a `:theme` prop cannot win
    // there — the wrapper ignores every individual prop once `settings` is
    // passed — so the setting itself has to be taken over.
    ?? swapInPlace(source, THEME_SETTING, "theme: customTheme,")
    ?? {
      source: source.replace(/<(HotTable|hot-table)\b/, '<$1 :theme="customTheme"'),
      displaced: null,
    };

  // Re-locate on the edited source rather than the original: the binding above
  // may sit before the script block, which would shift every later offset.
  const script = /<script\b[^>]*>/.exec(next.source);
  if (!script) return null;

  const inserts = [{
    at: script.index + script[0].length,
    text: `\n${IMPORT_LINE(dir, next.displaced ?? undefined, displacedClass)}`,
  }];

  if (!/<script\b[^>]*\bsetup\b/.test(next.source)) {
    // Options API: the import alone is invisible to the template. Carry the
    // marker so Reset takes this line back out along with the import.
    const opener = /(?:defineComponent\(|export default )\{/.exec(next.source);
    if (!opener) return null;
    inserts.push({
      at: opener.index + opener[0].length,
      text: `\n  setup() { return { customTheme }; }, // ${MARKER}`,
    });
  }

  return insertAll(next.source, inserts);
}

/** Splice several insertions in one pass, back to front so earlier offsets
 *  stay valid. */
function insertAll(source: string, inserts: { at: number; text: string }[]): string {
  return [...inserts]
    .sort((a, b) => b.at - a.at)
    .reduce((acc, { at, text }) => acc.slice(0, at) + text + acc.slice(at), source);
}

/**
 * An Astro component.
 *
 * The grid is built in a client `<script>` block, and that is where the import
 * has to go: `.astro` frontmatter runs on the server, so a binding declared
 * between the `---` fences never reaches the browser. Written above the markup
 * — where the old code put it — the import is not code at all, just text in the
 * template.
 */
function wireAstro(source: string, dir: string, displacedClass: string | null): string | null {
  const next = wireVanilla(source, "    ");
  if (!next) return null;

  // Re-locate on the edited source: the settings edit sits inside the block
  // whose opening tag we are about to write after.
  const call = next.source.indexOf("new Handsontable(");
  const open = [...next.source.matchAll(/<script\b[^>]*>/g)]
    .filter((m) => m.index < call).pop();
  if (!open) return null;

  const at = open.index + open[0].length;
  return insertAll(next.source, [{ at, text: `\n${IMPORT_LINE(dir, next.displaced ?? undefined, displacedClass)}` }]);
}

/** A Vue `themeName` binding, e.g. `:themeName="themeName"`. */
const VUE_THEME_NAME_BIND = /:themeName="[^"]*"/;

/**
 * A CSS theme on the grid's container, e.g. `class="ht-theme-main"`.
 *
 * The third alias for the same thing, and the one that silently wins. A theme
 * *object* is only honoured when the container carries no theme class:
 *
 *   } else if (isRootInstance(instance) && !rootContainerThemeClassName
 *              && isObject(settings.theme)) {          // core.js
 *
 * — no warning, unlike the `theme`/`themeName` pair. Five starters (vue,
 * next.js, astro, nuxt, remix) wrap their grid in `<div class="ht-theme-main">`,
 * and every one of them ignored the panel outright until DEV-2197. Passing the
 * theme by *name* instead is not a way out: `StylesHandler.useTheme` demands an
 * `ht-theme-*` name and reads stylesheet variables, never the JS registry, so a
 * registered theme handed over as a string is a class with no CSS behind it.
 */
const THEME_CLASS_ATTR = /\bclass(?:Name)?=(["'])[^"']*\bht-theme-[\w-]+[^"']*\1/;

/** The same attribute with the theme token taken out, and nothing else. Both
 *  directions go through this, so apply and Reset cannot disagree. */
function withoutThemeClass(attribute: string): string {
  return attribute.replace(/(["'])([^"']*)\1/, (_m, quote: string, value: string) => {
    const kept = value.split(/\s+/).filter((name) => name && !/^ht-theme-[\w-]+$/.test(name));
    return `${quote}${kept.join(" ")}${quote}`;
  });
}

/** Take the CSS theme off the container so the theme object can be seen. */
function stripThemeClass(source: string): { source: string; displaced: string } | null {
  const found = THEME_CLASS_ATTR.exec(source)?.[0];
  if (!found) return null;
  const stripped = withoutThemeClass(found);
  if (stripped === found) return null;
  // String search, so the match is treated literally on both legs.
  return { source: source.replace(found, () => stripped), displaced: found };
}

/** How far past `new Handsontable(` the element argument may run before we give
 *  up. It is an expression, not a novel; a longer scan is a lost scan. */
const ELEMENT_ARG_BUDGET = 200;

/**
 * Where a vanilla `new Handsontable(el, settings)` keeps its settings.
 *
 * Hand-scanned rather than matched, because the two shapes a regex missed are
 * both ordinary (DEV-2197, found by `scripts/theme-wiring-census.mjs`):
 *
 *   `new Handsontable(document.getElementById('x'), { … })`  — 3 docs examples
 *   `new Handsontable(container, hotOptions)`                — 13 docs examples
 *
 * The first needs an arbitrary expression before the comma, and a regex wide
 * enough for that is wide enough to swallow a comma inside it. So: walk to the
 * top-level comma, then look at what follows.
 */
function findVanillaSettings(source: string): { at: number } | { name: string } | null {
  const call = source.indexOf("new Handsontable(");
  if (call === -1) return null;

  const start = call + "new Handsontable(".length;
  const limit = Math.min(source.length, start + ELEMENT_ARG_BUDGET);
  let depth = 0;
  let i = start;

  for (; i < limit; i += 1) {
    const c = source[i]!;
    if (c === "'" || c === '"' || c === "`") i = endOfString(source, i);
    else if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return null; // the call closed with a single argument
      depth -= 1;
    } else if (c === "," && depth === 0) break;
  }
  if (i >= limit) return null;

  let at = i + 1;
  while (at < source.length && /\s/.test(source[at]!)) at += 1;
  if (source[at] === "{") return { at: at + 1 };

  const name = /^[A-Za-z_$][\w$]*/.exec(source.slice(at))?.[0];
  return name ? { name } : null;
}

/** The closing quote of the string opening at `at`, or the end of the source. */
function endOfString(source: string, at: number): number {
  const quote = source[at];
  for (let i = at + 1; i < source.length; i += 1) {
    if (source[i] === "\\") i += 1;
    else if (source[i] === quote) return i;
  }
  return source.length;
}

/** Add `theme` to a vanilla settings object, wherever it is written. */
function wireVanilla(source: string, indent: string): { source: string; displaced: string | null } | null {
  const target = findVanillaSettings(source);
  if (!target) return null;

  const swapped = swapInPlace(source, THEME_NAME_SETTING, "theme: customTheme,")
    ?? swapInPlace(source, THEME_SETTING, "theme: customTheme,");
  if (swapped) return swapped;

  // Settings passed by name: wire the literal they were declared from. Without
  // a literal to attach to — a settings object built by a function, say — leave
  // the file alone rather than guess.
  const at = "at" in target
    ? target.at
    : (() => {
      const name = target.name.replace(/\$/g, "\\$");
      const decl = new RegExp(`(?:const|let|var)\\s+${name}\\s*(?::[^=]+)?=\\s*\\{`).exec(source);
      return decl ? decl.index + decl[0].length : null;
    })();

  if (at === null) return null;
  return { source: `${source.slice(0, at)}\n${indent}theme: customTheme,${source.slice(at)}`, displaced: null };
}

/** A `themeName` prop, e.g. `themeName="ht-theme-main"`. */
const THEME_NAME_ATTR = /\bthemeName\s*=\s*["'][^"']*["']/;
/** A `themeName` setting, e.g. `themeName: 'ht-theme-main',`. */
const THEME_NAME_SETTING = /\bthemeName\s*:\s*["'][^"']*["'],?/;
/** A `theme` setting holding a theme object by name, e.g. `theme: mainTheme,`
 *  (DEV-2200 moved every starter onto this form). The identifier-only value
 *  keeps `themeName:` and computed expressions out of the match. */
const THEME_SETTING = /\btheme\s*:\s*[A-Za-z_$][\w$.]*\s*,?/;

/**
 * Put `theme` where `themeName` was.
 *
 * They're aliases — Handsontable warns and ignores `themeName` when both are
 * set — so the old one has to go. Swapping **in place** rather than deleting it
 * and inserting elsewhere buys two things (DEV-2199):
 *
 *   * Reset swaps back and the file is byte-identical to how it arrived.
 *   * It doesn't destroy single-line elements. The previous version deleted the
 *     whole *line* containing `themeName`, so `<HotTable data={data}
 *     themeName="ht-theme-main" />` — all one line — was erased outright,
 *     taking the grid with it.
 */
function swapInPlace(source: string, pattern: RegExp, replacement: string) {
  const found = source.match(pattern)?.[0];
  if (!found) return null;
  // String search, so the match is treated literally on both legs.
  return { source: source.replace(found, replacement), displaced: found };
}

/** Does the example look like TypeScript? Decides the module's extension — and
 *  whether the module may use type syntax at all. */
export function isTypescript(files: Record<string, string>): boolean {
  return Object.keys(files).some((p) => /\.tsx?$/.test(p));
}

export function themeModulePath(files: Record<string, string>): string {
  return `/${THEME_MODULE_BASENAME}.${isTypescript(files) ? "ts" : "js"}`;
}

/**
 * The file edits that apply `state` to a demo: the theme module, plus the one
 * line that hands it to the grid when we can see where that happens.
 */
export function buildThemeChanges(
  files: Record<string, string>,
  state: ThemeState,
): { changes: ThemeFileChange[]; linked: boolean } {
  const changes: ThemeFileChange[] = [
    { path: themeModulePath(files), contents: buildThemeModule(state, isTypescript(files)) },
  ];

  const wired = wireTheme(files);
  if (wired) changes.push({ path: wired.path, contents: wired.contents });
  return { changes, linked: Boolean(wired) };
}

/**
 * Remove the theme again: an inert module, and the wiring taken back out.
 *
 * Where wiring displaced a `themeName`, put it back in the same spot rather
 * than just deleting `theme={customTheme}` — otherwise Reset returns the demo
 * to *unthemed* instead of to how it arrived (DEV-2199).
 */
export function buildResetChanges(files: Record<string, string>): ThemeFileChange[] {
  const changes: ThemeFileChange[] = [];
  for (const [path, source] of Object.entries(files)) {
    if (typeof source !== "string" || !source.includes(MARKER)) continue;

    const restore = displacedThemeName(source);
    // `themeName="x"` went in as an attribute, `themeName: 'x',` as a setting;
    // each swaps back into the slot its replacement occupies.
    const isAttr = restore !== null && /=/.test(restore);
    const restoreClass = displacedThemeClass(source);

    const unwired = source
      .split("\n")
      .filter((line) => !line.includes(MARKER))
      .join("\n")
      // Function replacers, not `$1…` strings: a `$` inside the restored
      // value would otherwise be read as a substitution pattern.
      // `\s*` rather than `\n\s*`: a settings object written on one line
      // still has to be un-wired, and it would otherwise keep a
      // `theme: customTheme` referring to an import that has just gone.
      // The Vue binding first: `:theme="customTheme"` also ends in the
      // characters the settings rule looks for, and a partial match would
      // leave a dangling `:theme=` behind.
      .replace(/(\s*):theme="customTheme"/g, (_m, ws: string) =>
        (restore && isAttr ? ws + restore : ""))
      .replace(/(\s*)theme=\{customTheme\}/g, (_m, ws: string) =>
        (restore && isAttr ? ws + restore : ""))
      .replace(/(\s*)theme: customTheme,/g, (_m, ws: string) =>
        (restore && !isAttr ? ws + restore : ""));

    // The container's CSS theme goes back exactly as it was. Both legs run the
    // attribute through `withoutThemeClass`, so the text Reset looks for is by
    // construction the text apply left behind.
    const contents = restoreClass
      ? unwired.replace(withoutThemeClass(restoreClass), () => restoreClass)
      : unwired;

    changes.push({ path, contents });
  }
  changes.push({
    path: themeModulePath(files),
    contents: "// Theme cleared.\nexport const customTheme = undefined;\n",
  });
  return changes;
}

/** Shown when no grid construction was recognised. The binding differs by
 *  framework, and a React hint on a Vue demo is a hint that does not work. */
export function manualImportHint(files: Record<string, string>): string {
  const specifier = `import { customTheme } from '.${themeModulePath(files).replace(/\.(t|j)s$/, "")}';`;
  const vue = Object.keys(files).some((p) => p.endsWith(".vue"));
  return `${specifier}  →  ${vue ? ':theme="customTheme"' : "theme={customTheme}"}`;
}

export { isPristine };
