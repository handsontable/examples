// The Handsontable theming vocabulary (DEV-2047, DEV-2199).
//
// The token catalogue itself is NOT written here — it is vendored verbatim in
// ./tokens.ts from theme-builder's `src/utils/tokens.ts`, and this module only
// derives the shapes the panel wants from it. That split is deliberate: the
// previous version of this file hand-listed ~40 tokens with an invented
// three-way kind, and it had drifted from the real catalogue (see the header of
// ./tokens.ts). Deriving means it cannot drift again.
//
// What stays hand-written here is everything theme-builder keeps *outside*
// TOKENS_MAPPING: the preset stacks, the colour ramps, and the density sizes.
//
// The panel and the generated module both speak the JS token names — the same
// ones theme-builder and the AI assistant use — so nothing here translates into
// CSS. The docs' `CSS: --ht-accent-color` column is only useful for reading.

import { TOKENS_MAPPING, type Token, type TokenGroup, type TokenType } from "./tokens.js";

export { TOKENS_MAPPING };
export type { Token, TokenGroup, TokenType };

export const TOKENS_PRESETS = ["main", "horizon", "classic"] as const;
export const COLORS_PRESETS = ["main", "horizon", "classic", "ant", "shadcn", "material"] as const;
export const ICONS_PRESETS = ["main", "horizon"] as const;
/** Handsontable's own three values, spelled its way so nothing has to translate
 *  (`ThemeColorScheme` in `handsontable/themes`). `auto` resolves to
 *  `color-scheme: light dark`, i.e. the visitor's OS decides — which is also the
 *  only value that lets the shell's own toggle drive the grid (ADR-0035). */
export const COLOR_SCHEMES = ["light", "dark", "auto"] as const;
export const DENSITY_VARIANTS = ["compact", "default", "comfortable"] as const;

export type TokensPreset = (typeof TOKENS_PRESETS)[number];
export type ColorsPreset = (typeof COLORS_PRESETS)[number];
export type IconsPreset = (typeof ICONS_PRESETS)[number];
export type ColorScheme = (typeof COLOR_SCHEMES)[number];
export type DensityVariant = (typeof DENSITY_VARIANTS)[number];

/**
 * A token's value.
 *
 * Not just a string: a colour token carries a `[light, dark]` pair so the two
 * schemes can differ, and either side may be a `colors.` / `tokens.` /
 * `sizing.` / `density.` reference rather than a literal. See ./resolve.ts.
 */
export type TokenValue = string | string[];

/** What the panel is currently describing. Mirrors theme-builder's store:
 *  a preset config, per-token overrides, the colour ramps underneath them, and
 *  optional per-size density values. */
export interface ThemeState {
  tokens: TokensPreset;
  colors: ColorsPreset;
  icons: IconsPreset;
  colorScheme: ColorScheme;
  density: DensityVariant;
  /** JS-style token name -> value, e.g. { accentColor: "#1A42E8" } or
   *  { accentColor: ["colors.primary.500", "colors.primary.300"] }. */
  params: Record<string, TokenValue>;
  /** The colour ramps the tokens are derived from (theme-builder's
   *  `themePalette`): brand ramp, neutral scale, and the two base colours. */
  palette: Record<string, string>;
  /**
   * Per-size density overrides on top of the preset, keyed **by density
   * variant** and then by the size's short name:
   * `{ compact: { gap: "sizing.size_1" } }`.
   *
   * Keyed by variant because that is the shape Handsontable's
   * `ThemeDensitySizes` takes, and because theme-builder lets you tune all
   * three variants, not only the one currently selected — so a theme still
   * behaves when someone switches the grid to comfortable.
   */
  densitySizes: Partial<Record<DensityVariant, Record<string, string>>>;
}

export const DEFAULT_THEME: ThemeState = {
  tokens: "main",
  colors: "main",
  icons: "main",
  // Explicit, and matching what the starters declare: a theme the panel produces
  // should render the same for every reader, not track whichever OS opened it.
  // `auto` is available in the control for anyone who wants the opposite.
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

/**
 * Density sizes, grouped as theme-builder's `DensityModal` groups them.
 *
 * Not part of TOKENS_MAPPING — Handsontable keeps these in `density.sizes`,
 * keyed by short name rather than by token key — so the list is hand-written
 * against `DensitySizeKey` in `handsontable/themes`. All fifteen of them:
 * `cellVertical` and `cellHorizontal` were missing before DEV-2199, which meant
 * cell padding, the density setting people actually reach for, wasn't editable.
 *
 * They borrow the `Token` shape so the same size control renders them.
 */
export const DENSITY_GROUPS: { label: string; tokens: Token[] }[] = [
  { label: "Layout", tokens: [
    { key: "gap", label: "Gap", type: "size", description: "Space between the grid's parts" },
  ] },
  { label: "Cell", tokens: [
    { key: "cellVertical", label: "Vertical", type: "size", description: "Cell padding, top and bottom" },
    { key: "cellHorizontal", label: "Horizontal", type: "size", description: "Cell padding, left and right" },
  ] },
  { label: "Bars", tokens: [
    { key: "barsHorizontal", label: "Horizontal", type: "size", description: "" },
    { key: "barsVertical", label: "Vertical", type: "size", description: "" },
  ] },
  { label: "Button", tokens: [
    { key: "buttonHorizontal", label: "Horizontal", type: "size", description: "" },
    { key: "buttonVertical", label: "Vertical", type: "size", description: "" },
  ] },
  { label: "Dialog", tokens: [
    { key: "dialogHorizontal", label: "Horizontal", type: "size", description: "" },
    { key: "dialogVertical", label: "Vertical", type: "size", description: "" },
  ] },
  { label: "Input", tokens: [
    { key: "inputHorizontal", label: "Horizontal", type: "size", description: "" },
    { key: "inputVertical", label: "Vertical", type: "size", description: "" },
  ] },
  { label: "Menu", tokens: [
    { key: "menuVertical", label: "Vertical", type: "size", description: "" },
    { key: "menuHorizontal", label: "Horizontal", type: "size", description: "" },
    { key: "menuItemVertical", label: "Item vertical", type: "size", description: "" },
    { key: "menuItemHorizontal", label: "Item horizontal", type: "size", description: "" },
  ] },
];

export const DENSITY_SIZE_KEYS: string[] = DENSITY_GROUPS.flatMap((g) => g.tokens.map((t) => t.key));

/**
 * A bare Google Font family name, as opposed to a CSS font stack.
 *
 * Theme-builder loads the font for you when you type "VT323"; a stack like
 * `Inter, sans-serif` is the user supplying their own and must not be fetched.
 */
export function googleFontFamily(value: TokenValue | undefined): string | null {
  const family = (typeof value === "string" ? value : "").trim().replace(/^['"]|['"]$/g, "");
  if (!family || family.includes(",") || family.length > 60) return null;
  return /^[A-Za-z0-9][A-Za-z0-9 ]*$/.test(family) ? family : null;
}

// ---- Derived from TOKENS_MAPPING ---------------------------------------------

/** The two halves of the catalogue, which become the panel's Common and
 *  Component tabs. */
export type TokenArea = "common" | "components";

/**
 * One section of the catalogue, normalised.
 *
 * TOKENS_MAPPING says a section holds *either* a flat `tokens` array (all of
 * `common` does) *or* a `groups` array (all of `components` does). Consumers
 * shouldn't have to branch on that, so a flat section becomes a single unnamed
 * group and every section ends up with the same shape.
 */
export interface TokenSection {
  area: TokenArea;
  label: string;
  description: string;
  groups: TokenGroup[];
}

function sections(area: TokenArea): TokenSection[] {
  return (TOKENS_MAPPING[area] ?? []).map((entry) => ({
    area,
    label: entry.label,
    description: entry.description,
    groups: entry.groups ?? [{ label: "", description: entry.description, tokens: entry.tokens ?? [] }],
  }));
}

/** Typography, Colors, Base, Bar, Shadow. */
export const COMMON_SECTIONS: TokenSection[] = sections("common");

/** Cell, Header, Rows, Buttons, … — one per component, each with sub-groups. */
export const COMPONENT_SECTIONS: TokenSection[] = sections("components");

export const ALL_SECTIONS: TokenSection[] = [...COMMON_SECTIONS, ...COMPONENT_SECTIONS];

/** Every token in the catalogue, in catalogue order. */
export const ALL_TOKENS: Token[] = ALL_SECTIONS.flatMap((s) => s.groups.flatMap((g) => g.tokens));

/** Lookup for the codegen and for resolving `linkedTokens` references. */
export const TOKENS_BY_KEY: ReadonlyMap<string, Token> = new Map(ALL_TOKENS.map((t) => [t.key, t]));

/** The set the AI assistant is allowed to write. Kept as a plain array so the
 *  worker's generated copy can be diffed against it. */
export const TOKEN_KEYS: string[] = ALL_TOKENS.map((t) => t.key);

/** The class Handsontable puts a themed instance in, per tokens preset. */
export function themeClass(state: ThemeState): string {
  // `auto` takes the unsuffixed class: the suffix names a *fixed* dark theme,
  // while `auto` is one theme whose `color-scheme` resolves per visitor.
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
    && densitySizeCount(state) === 0
  );
}

/** How many density sizes are overridden, across every variant. */
export function densitySizeCount(state: ThemeState): number {
  return Object.values(state.densitySizes ?? {})
    .reduce((n, sizes) => n + Object.keys(sizes ?? {}).length, 0);
}

/**
 * Bring a stored theme up to the current shape.
 *
 * `densitySizes` used to be flat (`{ gap: … }`), which was both the wrong shape
 * for Handsontable and ambiguous about which variant it meant. A flat object is
 * read as belonging to the variant the theme was saved with — the only reading
 * that can be right — and anything unrecognised is dropped rather than carried
 * forward to fail somewhere less obvious.
 */
export function migrateThemeState(saved: unknown): ThemeState {
  const state = { ...DEFAULT_THEME, ...(saved as Partial<ThemeState> ?? {}) };
  const sizes = state.densitySizes as unknown;

  if (sizes && typeof sizes === "object") {
    const entries = Object.entries(sizes as Record<string, unknown>);
    const flat = entries.some(([, v]) => typeof v === "string");
    if (flat) {
      const variant = DENSITY_VARIANTS.includes(state.density) ? state.density : DEFAULT_THEME.density;
      state.densitySizes = {
        [variant]: Object.fromEntries(entries.filter(([, v]) => typeof v === "string")),
      } as ThemeState["densitySizes"];
    }
  } else {
    state.densitySizes = {};
  }

  return state;
}
