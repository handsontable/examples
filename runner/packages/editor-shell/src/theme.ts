// Single source of branding tokens for the authoring shell and the public viewer.
// White-label: our tokens only — no CodeSandbox marks anywhere in the UI.
// (Sandpack is Apache-2.0; its license notice lives in source, never in the UI.)
//
// Two modes, emitted as CSS custom properties on the root element (ADR-0028).
// `theme.color.*` and `theme.shadow.*` are `var(--hot-…)` *references*, not literal
// values — the browser resolves them at paint time, so a frozen style object built
// from them still flips when the mode changes. That is what lets `styles.ts` stay a
// module-level `const` instead of becoming a hook.
//
// This file is the only place a colour literal may appear. The three exceptions
// outside it are the SVG logo assets, the pre-paint `html`/`body` background in
// `apps/authoring/index.html` (which runs before these variables exist), and the
// generated seti-ui file-icon palette in `src/icons/generated/` — upstream brand
// colours, identical in both modes, regenerated from source (ADR-0024).

export type ThemeMode = "light" | "dark";

/** Attribute on `<html>` that selects the mode. Set pre-paint by an inline script. */
export const THEME_ATTR = "data-hot-theme";
/** `localStorage` key holding an explicit user choice. Absent ⇒ follow the OS. */
export const THEME_STORAGE_KEY = "hot-theme";
/** `localStorage` key holding the editor/preview split as a 0–1 fraction of the
 *  body width. Absent ⇒ the designed 50%. */
export const SPLIT_STORAGE_KEY = "hot-split";

// ---------------------------------------------------------------------------
// Palettes. Neutrals are the Handsontable `horizon` ramp, read off the Figma
// variables on frames 48:6560 (light) and 31:6438 (dark).
// ---------------------------------------------------------------------------

const LIGHT_COLORS = {
  accent: "#1A42E8", // Handsontable blue — brand, mode-invariant
  accentHover: "#1233bf",
  accentContrast: "#ffffff", // text/icons drawn *on* accent
  accentContrastSoft: "rgba(255, 255, 255, 0.4)", // dimmed, on accent (spinner track)
  // Brand blue as *text* (links, selected labels) and as a thin mark on a neutral
  // ground — the inverse of `accentContrast`. Identical to `accent` in light, where
  // #1A42E8 on #ffffff is 6.5:1; the dark half exists because `accent` there is
  // 2.3:1 on `surfaceRaised`, which is what made the chat panel's suggestions read
  // as disabled. Fills, rings and the tab underline keep plain `accent`: they carry
  // `accentContrast` text or no text at all.
  accentText: "#1A42E8",
  accentSoft: "#1A42E814", // tinted fill (was `${accent}14`)
  accentBorder: "#1A42E833", // tinted border (was `${accent}33`)
  accentSelection: "#1A42E844",
  // The editor/preview seam while hovered or dragged (85:11001). Sampled off the
  // two drag frames: light is plain `accent`, dark is *lifted* — #4669F6, which is
  // neither `accent` nor dark `accentHover` (#3b5cf0). Hence its own pair.
  splitterActive: "#1A42E8",

  // Four elevation steps, sampled off the dark frame 31:6438 — which is the only
  // one that separates them, since light collapses onto #ffffff / #f7f7f9:
  //   sunken #000000  <  surface #070604  <  muted #19191c  <  raised #222222
  surface: "#ffffff", // app ground: row-2 bar, preview surround
  surfaceSunken: "#f7f7f9", // recessed: the left sidebar
  surfaceMuted: "#f7f7f9", // content panes: editor, status bars
  surfaceRaised: "#ffffff", // top bar, popovers, dialogs, drawers
  border: "#e7e7e9", // horizon/palette/100
  // Outline of a transparent control (top-bar buttons) — *not* `border`. Dark's
  // `border` is #222222, which is `surfaceRaised`: an outline-only button drawn
  // on the 72px bar disappeared entirely and read as bare text. The dark frames
  // draw that outline one step up the ramp, horizon/palette/600 (sampled on the
  // Download button, `72:15648`, over the #222222 bar). Light deliberately keeps
  // `border`'s value: #e7e7e9 on #ffffff already reads, and it is the shipped
  // palette/100. The light frame `48:6560` samples the outline at #f7f7f9 —
  // fainter than what we ship, considered and not adopted.
  controlBorder: "#e7e7e9", // horizon/palette/100
  text: "#262624", // horizon/palette/700
  textMuted: "#727272",
  // Neutral row/button rollover. 0.10, down from 0.16: on white surfaces the
  // old value read as a selection rather than a hover — most visibly on the
  // Style panel's rows and its tab strip.
  hover: "rgba(120, 130, 150, 0.1)",

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
  // `accent` lifted until it clears AA as body text on the raised surfaces the
  // panels and dialogs are painted with. Measured: 5.1:1 on `surfaceRaised`
  // (#222222), 6.4:1 on `surface` (#070604), 5.3:1 on `surfaceMuted` (#19191c).
  // #4669F6 (`splitterActive`) was tried first and reaches only 3.5:1 — fine for a
  // 3px seam, short of text. Like dark `textMuted`, this is a value the design has
  // not ruled on; flag it at design review (DEV-2173).
  accentText: "#6E8CFA",
  accentSoft: "#1A42E829",
  accentBorder: "#1A42E84d",
  accentSelection: "#1A42E855",
  splitterActive: "#4669F6", // measured on 85:9970 — brand blue lifted off the dark ground

  surface: "#070604", // horizon/palette/950
  surfaceSunken: "#000000", // horizon/black
  surfaceMuted: "#19191c", // horizon/palette/900
  surfaceRaised: "#222222", // horizon/palette/800
  border: "#222222",
  controlBorder: "#353535", // horizon/palette/600 — see the light note above
  text: "#d1d1d4",
  // The Figma variable is #727272, which lands at ~3.9:1 on #070604 — under AA.
  // Lightened deliberately; flag at design review.
  textMuted: "#8f8f94",
  hover: "rgba(255, 255, 255, 0.08)",

  editorBg: "#19191c", // matches the editor pane in 31:6438
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
    mono: `"Fira Code", "JetBrains Mono", "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace`,
  },
  /** The design's whole type scale, read off frame `48:6560` — two sizes, four
   *  roles. Every text in the frame is one of these; nothing is 13px, and
   *  hierarchy is carried by colour and tracking, not extra sizes. Spread one of
   *  these into a style object rather than writing `fontSize` by hand — the 13px
   *  the shell shipped with was exactly the kind of drift this exists to stop.
   *   - `base`  12/20: primary UI text — pills, tabs, buttons, body copy (48:6583)
   *   - `small` 10/20: secondary lines — descriptions, status bar (48:6758, 48:6742)
   *   - `row`   12/16: dense tree rows — files, dependency URLs. The frame draws
   *     these at 10 (72:16918); raised to 12 by decision — 10px file names were
   *     too small to read — with the 16px line kept so the 24px rows stay 24.
   *   - `label` 10/20 +0.8px: uppercase section headers (48:6752) */
  type: {
    base: { fontSize: 12, lineHeight: "20px" },
    small: { fontSize: 10, lineHeight: "20px" },
    row: { fontSize: 12, lineHeight: "16px" },
    label: { fontSize: 10, lineHeight: "20px", letterSpacing: "0.8px" },
  },
  radius: { sm: "4px", md: "8px", lg: "12px" },
  space: (n: number) => `${n * 4}px`,
} as const;

export type Theme = typeof theme;

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

/** The shell's one animation. It lives here rather than in a `<style>` inside
 *  `Spinner` because T5 renders spinners in four places (boot overlay, refresh
 *  overlay, syncing pill, the app's splash) and a per-instance `<style>` duplicates
 *  the rule once per mount. It cannot live in the consuming app's global block
 *  either — `editor-shell` has to stay self-contained. */
const KEYFRAMES = `@keyframes hot-spin{to{transform:rotate(360deg)}}`;

/** Light lives on bare `:root` so it is also the fallback if the attribute is
 *  missing (e.g. the inline pre-paint script threw). */
export const THEME_CSS = [
  block(":root", "light", LIGHT_COLORS, LIGHT_SHADOWS),
  block(`:root[${THEME_ATTR}="dark"]`, "dark", DARK_COLORS, DARK_SHADOWS),
  // The font stacks as variables, for the same reason the colours are: component
  // stylesheets (the app's `panels.css`, the shell's `installCss` strings) have no
  // way to reach the TS constants, and a stack pasted into CSS drifts.
  `:root{--hot-font-ui:${theme.font.ui};--hot-font-mono:${theme.font.mono}}`,
  KEYFRAMES,
].join("\n");

const STYLE_ID = "hot-theme-vars";

/** Inject a stylesheet once, keyed by id. The shell can't import `.css` files —
 *  it ships as source and typechecks standalone — so components that need real
 *  selectors (pseudo-elements, hover, attribute states) register a CSS string at
 *  module scope with this instead. Values in those strings must be `var(--hot-…)`
 *  references, never literals: the mode flip works by swapping variables. */
export function installCss(id: string, css: string): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(id)) return;
  const el = document.createElement("style");
  el.id = id;
  el.textContent = css;
  document.head.appendChild(el);
}

/** Inject `THEME_CSS` once. Called at module scope below, so the variables exist
 *  before React's first paint regardless of which module pulled `theme.ts` in. */
export function installThemeCss(): void {
  installCss(STYLE_ID, THEME_CSS);
}

installThemeCss();
