// The Handsontable theming vocabulary, mirrored from theme-builder (DEV-2047).
//
// Sources, so this stays checkable against them:
//   * preset names — theme-builder `src/utils/themes.ts` (TOKENS / COLORS /
//     ICONS / COLOR_SCHEMES / DENSITY_VARIANTS)
//   * token names — Handsontable's own "Theme customization → Variables
//     reference" docs page, which lists every token in both forms:
//     `CSS: --ht-accent-color` / `JS: accentColor`
//
// That dual form is why this file exists in one place: the panel edits JS-style
// names because that is what theme-builder and the AI assistant speak, and the
// generated stylesheet needs the CSS ones. Deriving one from the other by rule
// (camelCase → kebab-case, prefixed) keeps them from drifting apart.

export const TOKENS_PRESETS = ["main", "horizon", "classic"] as const;
export const COLORS_PRESETS = ["main", "horizon", "classic", "ant", "shadcn", "material"] as const;
export const ICONS_PRESETS = ["main", "horizon"] as const;
export const COLOR_SCHEMES = ["light", "dark"] as const;
export const DENSITY_VARIANTS = ["compact", "default", "comfortable"] as const;

export type TokensPreset = (typeof TOKENS_PRESETS)[number];
export type ColorsPreset = (typeof COLORS_PRESETS)[number];
export type IconsPreset = (typeof ICONS_PRESETS)[number];
export type ColorScheme = (typeof COLOR_SCHEMES)[number];
export type DensityVariant = (typeof DENSITY_VARIANTS)[number];

/** What the panel is currently describing. Mirrors theme-builder's store:
 *  a preset config, per-token overrides, the colour ramps underneath them, and
 *  optional per-size density values. */
export interface ThemeState {
  tokens: TokensPreset;
  colors: ColorsPreset;
  icons: IconsPreset;
  colorScheme: ColorScheme;
  density: DensityVariant;
  /** JS-style token name -> value, e.g. { accentColor: "#1A42E8" }. */
  params: Record<string, string>;
  /** The colour ramps the tokens are derived from (theme-builder's
   *  `themePalette`): brand ramp, neutral scale, and the two base colours. */
  palette: Record<string, string>;
  /** Per-size density overrides on top of the preset, keyed by the density
   *  token's short name (`gap`, `barsHorizontal`, `menuItemVertical`, …). */
  densitySizes: Record<string, string>;
}

export const DEFAULT_THEME: ThemeState = {
  tokens: "main",
  colors: "main",
  icons: "main",
  colorScheme: "light",
  density: "default",
  params: {},
  palette: {},
  densitySizes: {},
};

/**
 * The colour ramps, named as the docs' variables reference does.
 *
 * These sit a layer below the tokens: `accentColor` derives from
 * `colors.primary.500`, so recolouring the brand is one edit here rather than
 * a dozen token overrides. Theme-builder makes the same distinction, and its
 * assistant is told to set the whole primary ramp for "make it purple" and a
 * single token for "make the header red".
 */
export const PRIMARY_STEPS = ["100", "200", "300", "400", "500", "600"] as const;
export const NEUTRAL_STEPS = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"] as const;

/** `primary.500` -> `--ht-colors-primary-500`; `white` -> `--ht-colors-white`. */
export function paletteVariable(key: string): string {
  return `--ht-colors-${key.replace(/\./g, "-")}`;
}

/**
 * Density tokens, which the reference groups under `--ht-density-*`.
 * Choosing a preset sets them all; these let one be nudged afterwards.
 */
export const DENSITY_SIZES: TokenDef[] = [
  { name: "gap", label: "Gap", kind: "size" },
  { name: "barsHorizontal", label: "Bars — horizontal", kind: "size" },
  { name: "barsVertical", label: "Bars — vertical", kind: "size" },
  { name: "buttonHorizontal", label: "Button — horizontal", kind: "size" },
  { name: "buttonVertical", label: "Button — vertical", kind: "size" },
  { name: "inputHorizontal", label: "Input — horizontal", kind: "size" },
  { name: "inputVertical", label: "Input — vertical", kind: "size" },
  { name: "menuHorizontal", label: "Menu — horizontal", kind: "size" },
  { name: "menuVertical", label: "Menu — vertical", kind: "size" },
  { name: "menuItemHorizontal", label: "Menu item — horizontal", kind: "size" },
  { name: "menuItemVertical", label: "Menu item — vertical", kind: "size" },
  { name: "dialogHorizontal", label: "Dialog — horizontal", kind: "size" },
  { name: "dialogVertical", label: "Dialog — vertical", kind: "size" },
];

/** `barsHorizontal` -> `--ht-density-bars-horizontal`. */
export function densityVariable(name: string): string {
  return `--ht-density-${name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()}`;
}

/**
 * A bare Google Font family name, as opposed to a CSS font stack.
 *
 * Theme-builder loads the font for you when you type "VT323"; a stack like
 * `Inter, sans-serif` is the user supplying their own and must not be fetched.
 */
export function googleFontFamily(value: string | undefined): string | null {
  const family = (value ?? "").trim().replace(/^['"]|['"]$/g, "");
  if (!family || family.includes(",") || family.length > 60) return null;
  return /^[A-Za-z0-9][A-Za-z0-9 ]*$/.test(family) ? family : null;
}

export type TokenKind = "color" | "size" | "text" | "weight";

export interface TokenDef {
  /** JS name, as used by theme params and by the AI assistant's tool schema. */
  name: string;
  label: string;
  kind: TokenKind;
  /** Shown under the control when the token is not self-explanatory. */
  hint?: string;
}

export interface TokenGroup {
  title: string;
  tokens: TokenDef[];
}

/**
 * The tokens the panel exposes.
 *
 * Not every token in the reference — that page lists well over a hundred, most
 * of which nobody reaches for. This is theme-builder's own vetted set: the
 * `COMMON_COLORS_KEYS` from its themes module plus the tokens its AI assistant
 * is allowed to write, which is the list its team decided was worth surfacing.
 * Anything outside it is still reachable by editing the generated stylesheet,
 * which is a real file in the example.
 */
export const TOKEN_GROUPS: TokenGroup[] = [
  {
    title: "Typography",
    tokens: [
      { name: "fontFamily", label: "Font family", kind: "text", hint: "Any Google Font name, or a CSS font stack" },
      { name: "fontSize", label: "Font size", kind: "size" },
      { name: "fontWeight", label: "Font weight", kind: "weight" },
      { name: "lineHeight", label: "Line height", kind: "size" },
      { name: "fontSizeSmall", label: "Small font size", kind: "size" },
      { name: "lineHeightSmall", label: "Small line height", kind: "size" },
      { name: "letterSpacing", label: "Letter spacing", kind: "size" },
    ],
  },
  {
    title: "Colors",
    tokens: [
      { name: "accentColor", label: "Accent", kind: "color", hint: "Selection, focus and active states" },
      { name: "foregroundColor", label: "Foreground", kind: "color" },
      { name: "backgroundColor", label: "Background", kind: "color" },
      { name: "borderColor", label: "Border", kind: "color" },
      { name: "foregroundSecondaryColor", label: "Foreground (secondary)", kind: "color" },
      { name: "backgroundSecondaryColor", label: "Background (secondary)", kind: "color" },
      { name: "placeholderColor", label: "Placeholder", kind: "color" },
      { name: "readOnlyColor", label: "Read-only", kind: "color" },
      { name: "disabledColor", label: "Disabled", kind: "color" },
    ],
  },
  {
    title: "Header",
    tokens: [
      { name: "headerBackgroundColor", label: "Background", kind: "color" },
      { name: "headerForegroundColor", label: "Foreground", kind: "color" },
      { name: "headerFontWeight", label: "Font weight", kind: "weight" },
      { name: "headerHighlightedBackgroundColor", label: "Highlighted background", kind: "color" },
      { name: "headerHighlightedForegroundColor", label: "Highlighted foreground", kind: "color" },
      { name: "headerActiveBackgroundColor", label: "Active background", kind: "color" },
      { name: "headerActiveForegroundColor", label: "Active foreground", kind: "color" },
      { name: "headerActiveBorderColor", label: "Active border", kind: "color" },
    ],
  },
  {
    title: "Cells",
    tokens: [
      { name: "cellHorizontalPadding", label: "Horizontal padding", kind: "size" },
      { name: "cellVerticalPadding", label: "Vertical padding", kind: "size" },
      { name: "cellHorizontalBorderColor", label: "Horizontal border", kind: "color" },
      { name: "cellVerticalBorderColor", label: "Vertical border", kind: "color" },
      { name: "cellSelectionBorderColor", label: "Selection border", kind: "color" },
      { name: "cellSelectionBackgroundColor", label: "Selection background", kind: "color" },
    ],
  },
  {
    title: "Frame",
    tokens: [
      { name: "wrapperBorderRadius", label: "Corner radius", kind: "size" },
      { name: "wrapperBorderColor", label: "Wrapper border", kind: "color" },
      { name: "gapSize", label: "Gap", kind: "size" },
      { name: "iconSize", label: "Icon size", kind: "size" },
      { name: "tableTransition", label: "Transition", kind: "text", hint: "e.g. 0.15s ease" },
    ],
  },
  {
    title: "Shadow",
    tokens: [
      { name: "shadowColor", label: "Colour", kind: "color" },
      { name: "shadowOpacity", label: "Opacity", kind: "text" },
      { name: "shadowBlur", label: "Blur", kind: "size" },
      { name: "shadowX", label: "Offset X", kind: "size" },
      { name: "shadowY", label: "Offset Y", kind: "size" },
    ],
  },
];

export const ALL_TOKENS: TokenDef[] = TOKEN_GROUPS.flatMap((g) => g.tokens);

/** `accentColor` -> `--ht-accent-color`, the mapping the docs' variables
 *  reference prints beside every token. */
export function cssVariable(jsName: string): string {
  return `--ht-${jsName.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()}`;
}

/** The class Handsontable puts a themed instance in, per tokens preset. */
export function themeClass(state: ThemeState): string {
  return `ht-theme-${state.tokens}${state.colorScheme === "dark" ? "-dark" : ""}`;
}

/** True when nothing has been changed away from the shipped defaults. */
export function isPristine(state: ThemeState): boolean {
  return (
    state.tokens === DEFAULT_THEME.tokens
    && state.colors === DEFAULT_THEME.colors
    && state.icons === DEFAULT_THEME.icons
    && state.colorScheme === DEFAULT_THEME.colorScheme
    && state.density === DEFAULT_THEME.density
    && Object.keys(state.params).length === 0
    && Object.keys(state.palette).length === 0
    && Object.keys(state.densitySizes).length === 0
  );
}
