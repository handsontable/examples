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
function paletteSource(entries: [string, string][], presetVar: string): string {
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
    lines.push(`    ${lit(ramp)}: {`, `      ...${presetVar}[${lit(ramp)}],`);
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
    `import tokensPreset from 'handsontable/themes/static/variables/tokens/${state.tokens}';`,
    `import colorsPreset from 'handsontable/themes/static/variables/colors/${state.colors}';`,
    `import iconsPreset from 'handsontable/themes/static/variables/icons/${state.icons}';`,
    "",
    "const THEME_NAME = 'custom-theme';",
    "",
    "const config = {",
    "  tokens: tokensPreset,",
    palette.length ? `  colors: {\n${paletteSource(palette, "colorsPreset")}\n  },` : "  colors: colorsPreset,",
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

  if (tokens.length > 0) {
    lines.push(
      "export const customTheme = getTheme(THEME_NAME).params({",
      "  tokens: {",
      ...tokens.map(([k, v]) => `    ${lit(k)}: ${lit(v)},`),
      "  },",
      "});",
    );
  } else {
    lines.push("export const customTheme = getTheme(THEME_NAME);");
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

  void typescript;
  return `${lines.join("\n")}\n`;
}

/**
 * The code to copy into a real application.
 *
 * Identical to what is written into the demo, and that is the point: with the
 * JS API there is no gap between "what the playground did" and "what you paste
 * into your app" — the panel is not translating between two mechanisms.
 */
export function buildThemeSnippet(state: ThemeState): string {
  return `${buildThemeModule(state, true)}\n// then hand it to the grid:  <HotTable theme={customTheme} … />\n`;
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
const IMPORT_LINE = (dir: string, displaced?: string) =>
  `import { customTheme } from '${dir}${THEME_MODULE_BASENAME}'; // ${MARKER}`
  + (displaced ? ` restore:${jsSafe(JSON.stringify(displaced))}` : "");

/** The `themeName` a previous apply displaced, if any. */
function displacedThemeName(source: string): string | null {
  const marker = source.split("\n").find((line) => line.includes(MARKER));
  const payload = marker?.match(/\brestore:("(?:[^"\\]|\\.)*")/)?.[1];
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
 * Three shapes cover every starter in the catalog:
 *   `<HotTable …>`                     — React and Vue wrappers, add a prop
 *   `new Handsontable(el, { … })`      — vanilla JS/TS and Astro, add a setting
 *   `const gridSettings … = { … }`     — Angular, add a setting
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

    let next: { source: string; displaced: string | null } | null = null;

    // 1. JSX/Vue wrapper element. Take over an existing `themeName`/`theme`
    //    prop rather than adding a second one — several starters set their own.
    if (/<(HotTable|hot-table)\b/.test(source)) {
      next = swapInPlace(source, THEME_NAME_ATTR, "theme={customTheme}")
        ?? swapInPlace(source, /\btheme=\{[^}]*\}/, "theme={customTheme}")
        ?? { source: source.replace(/<(HotTable|hot-table)\b/, "<$1 theme={customTheme}"), displaced: null };
    } else if (/new Handsontable\(\s*[A-Za-z_$][\w$]*\s*,\s*\{/.test(source)) {
      // 2. Vanilla settings object.
      next = swapInPlace(source, THEME_NAME_SETTING, "theme: customTheme,")
        ?? {
          source: source.replace(
            /(new Handsontable\(\s*[A-Za-z_$][\w$]*\s*,\s*\{)/, "$1\n  theme: customTheme,"),
          displaced: null,
        };
    } else if (/gridSettings[^=]*=\s*\{/.test(source)) {
      // 3. Angular's settings object.
      next = swapInPlace(source, THEME_NAME_SETTING, "theme: customTheme,")
        ?? {
          source: source.replace(/(gridSettings[^=]*=\s*\{)/, "$1\n    theme: customTheme,"),
          displaced: null,
        };
    }

    if (!next) continue;

    // Relative path from the edited file back to the module at the root.
    const depth = path.split("/").filter(Boolean).length - 1;
    const dir = depth > 0 ? "../".repeat(depth) : "./";
    return { path, contents: `${IMPORT_LINE(dir, next.displaced ?? undefined)}\n${next.source}` };
  }

  return null;
}

/** A `themeName` prop, e.g. `themeName="ht-theme-main"`. */
const THEME_NAME_ATTR = /\bthemeName\s*=\s*["'][^"']*["']/;
/** A `themeName` setting, e.g. `themeName: 'ht-theme-main',`. */
const THEME_NAME_SETTING = /\bthemeName\s*:\s*["'][^"']*["'],?/;

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

/** Does the example look like TypeScript? Decides the module's extension. */
function isTypescript(files: Record<string, string>): boolean {
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

    changes.push({
      path,
      contents: source
        .split("\n")
        .filter((line) => !line.includes(MARKER))
        .join("\n")
        // Function replacers, not `$1…` strings: a `$` inside the restored
        // value would otherwise be read as a substitution pattern.
        // `\s*` rather than `\n\s*`: a settings object written on one line
        // still has to be un-wired, and it would otherwise keep a
        // `theme: customTheme` referring to an import that has just gone.
        .replace(/(\s*)theme=\{customTheme\}/g, (_m, ws: string) =>
          (restore && isAttr ? ws + restore : ""))
        .replace(/(\s*)theme: customTheme,/g, (_m, ws: string) =>
          (restore && !isAttr ? ws + restore : "")),
    });
  }
  changes.push({
    path: themeModulePath(files),
    contents: "// Theme cleared.\nexport const customTheme = undefined;\n",
  });
  return changes;
}

/** Shown when no grid construction was recognised. */
export function manualImportHint(files: Record<string, string>): string {
  return `import { customTheme } from '.${themeModulePath(files).replace(/\.(t|j)s$/, "")}';  →  theme={customTheme}`;
}

export { isPristine };
