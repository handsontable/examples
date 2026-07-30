// Single source of branding tokens for the authoring shell and the public viewer.
// White-label: our tokens only — no CodeSandbox marks anywhere in the UI.
// (Sandpack is Apache-2.0; its license notice lives in source, never in the UI.)
//
// Two modes, emitted as CSS custom properties on the root element (ADR-0022).
// `theme.color.*` and `theme.shadow.*` are `var(--hot-…)` *references*, not literal
// values — the browser resolves them at paint time, so a frozen style object built
// from them still flips when the mode changes. That is what lets `styles.ts` stay a
// module-level `const` instead of becoming a hook.
//
// This file is the only place a colour literal may appear. The two exceptions
// outside it are the SVG logo assets and the pre-paint `html`/`body` background in
// `apps/authoring/index.html`, which runs before these variables exist.

export type ThemeMode = "light" | "dark";

/** Attribute on `<html>` that selects the mode. Set pre-paint by an inline script. */
export const THEME_ATTR = "data-hot-theme";
/** `localStorage` key holding an explicit user choice. Absent ⇒ follow the OS. */
export const THEME_STORAGE_KEY = "hot-theme";

// ---------------------------------------------------------------------------
// Palettes. Neutrals are the Handsontable `horizon` ramp, read off the Figma
// variables on frames 48:6560 (light) and 31:6438 (dark).
// ---------------------------------------------------------------------------

const LIGHT_COLORS = {
  accent: "#1A42E8", // Handsontable blue — brand, mode-invariant
  accentHover: "#1233bf",
  accentContrast: "#ffffff", // text/icons drawn *on* accent
  accentContrastSoft: "rgba(255, 255, 255, 0.4)", // dimmed, on accent (spinner track)
  accentSoft: "#1A42E814", // tinted fill (was `${accent}14`)
  accentBorder: "#1A42E833", // tinted border (was `${accent}33`)
  accentSelection: "#1A42E844",

  surface: "#ffffff",
  surfaceMuted: "#f7f7f9", // horizon/palette/50
  surfaceRaised: "#ffffff", // popovers, dialogs, drawers
  border: "#e7e7e9", // horizon/palette/100
  text: "#262624", // horizon/palette/700
  textMuted: "#727272",
  hover: "rgba(120, 130, 150, 0.16)", // neutral row/button rollover

  // Panes that wrap third-party surfaces. `editorBg` sits behind CodeMirror,
  // `previewBg` behind the demo iframe — both must track the shell, because
  // PreviewPane's boot/error overlays paint with `surface` on top of them.
  editorBg: "#ffffff",
  previewBg: "#ffffff",

  danger: "#d1242f",
  dangerBorder: "#f3c2c2",
  warning: "#bf8700",
  success: "#37bc6c",

  scrim: "rgba(15, 23, 32, 0.45)", // modal backdrop
} as const;

type ColorToken = keyof typeof LIGHT_COLORS;

// `Record<ColorToken, string>` makes a missing dark value a type error, so the two
// palettes cannot drift apart.
const DARK_COLORS: Record<ColorToken, string> = {
  accent: "#1A42E8",
  accentHover: "#3b5cf0",
  accentContrast: "#ffffff",
  accentContrastSoft: "rgba(255, 255, 255, 0.4)",
  accentSoft: "#1A42E829",
  accentBorder: "#1A42E84d",
  accentSelection: "#1A42E855",

  surface: "#070604", // horizon/palette/950
  surfaceMuted: "#19191c", // horizon/palette/900
  surfaceRaised: "#222222", // horizon/palette/800
  border: "#222222",
  text: "#d1d1d4",
  // The Figma variable is #727272, which lands at ~3.9:1 on #070604 — under AA.
  // Lightened deliberately; flag at design review.
  textMuted: "#8f8f94",
  hover: "rgba(255, 255, 255, 0.08)",

  editorBg: "#070604",
  previewBg: "#070604",

  danger: "#f0616b",
  dangerBorder: "#5c2226",
  warning: "#e3b341",
  success: "#37bc6c",

  scrim: "rgba(0, 0, 0, 0.6)",
};

const LIGHT_SHADOWS = {
  sm: "0 2px 8px rgba(0, 0, 0, 0.18)", // floating pill / badge
  popover: "0 12px 32px rgba(0, 0, 0, 0.18)",
  dialog: "0 20px 60px rgba(0, 0, 0, 0.25)",
  panel: "-8px 0 24px rgba(0, 0, 0, 0.08)", // right-hand drawer
} as const;

type ShadowToken = keyof typeof LIGHT_SHADOWS;

const DARK_SHADOWS: Record<ShadowToken, string> = {
  sm: "0 2px 8px rgba(0, 0, 0, 0.5)",
  popover: "0 12px 32px rgba(0, 0, 0, 0.55)",
  dialog: "0 20px 60px rgba(0, 0, 0, 0.65)",
  panel: "-8px 0 24px rgba(0, 0, 0, 0.45)",
};

// ---------------------------------------------------------------------------
// Variable references
// ---------------------------------------------------------------------------

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const varName = (group: string, key: string) => `--hot-${group}-${kebab(key)}`;

/** Turn a palette into an identically-keyed map of `var()` references. */
function refs<T extends Record<string, string>>(group: string, src: T): { [K in keyof T]: string } {
  const out = {} as { [K in keyof T]: string };
  for (const key of Object.keys(src) as (keyof T & string)[]) {
    out[key] = `var(${varName(group, key)})`;
  }
  return out;
}

export const theme = {
  color: refs("color", LIGHT_COLORS),
  shadow: refs("shadow", LIGHT_SHADOWS),
  font: {
    ui: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`,
    mono: `"JetBrains Mono", "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace`,
  },
  radius: { sm: "4px", md: "8px", lg: "12px" },
  space: (n: number) => `${n * 4}px`,
} as const;

export type Theme = typeof theme;

/** The resolved literal palette for a mode. For consumers that need a real colour
 *  value rather than a `var()` reference — e.g. a CodeMirror theme definition. */
export function palette(mode: ThemeMode): Record<ColorToken, string> {
  return mode === "dark" ? DARK_COLORS : { ...LIGHT_COLORS };
}

// ---------------------------------------------------------------------------
// Stylesheet
// ---------------------------------------------------------------------------

function block(
  selector: string,
  mode: ThemeMode,
  colors: Record<string, string>,
  shadows: Record<string, string>,
) {
  const decls = [
    // Tells the UA to render native chrome — scrollbars, <select> popups, focus
    // rings, form-control defaults — for this mode. Without it a dark shell keeps
    // light scrollbars, which no token can reach.
    `color-scheme:${mode}`,
    ...Object.entries(colors).map(([k, v]) => `${varName("color", k)}:${v}`),
    ...Object.entries(shadows).map(([k, v]) => `${varName("shadow", k)}:${v}`),
  ];
  return `${selector}{${decls.join(";")}}`;
}

/** Light lives on bare `:root` so it is also the fallback if the attribute is
 *  missing (e.g. the inline pre-paint script threw). */
export const THEME_CSS = [
  block(":root", "light", LIGHT_COLORS, LIGHT_SHADOWS),
  block(`:root[${THEME_ATTR}="dark"]`, "dark", DARK_COLORS, DARK_SHADOWS),
].join("\n");

const STYLE_ID = "hot-theme-vars";

/** Inject `THEME_CSS` once. Called at module scope below, so the variables exist
 *  before React's first paint regardless of which module pulled `theme.ts` in. */
export function installThemeCss(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = THEME_CSS;
  document.head.appendChild(el);
}

installThemeCss();
