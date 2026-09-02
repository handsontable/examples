// The shipped preset data, imported straight from Handsontable (DEV-2199).
//
// The panel needs these to show a token's *resolved* value: `borderRadius` is
// `"sizing.size_1"`, which is `"4px"` — a text box showing the raw reference is
// no use to anyone. Theme-builder does exactly this in `src/utils/themes.ts`.
//
// These are leaf data modules (~18 KB for a token preset, <1 KB for a colour
// one), not the grid, so importing them doesn't pull Handsontable into the
// bundle.
//
// These are this app's own copy — the fallback and the synchronous first render.
// The panel resolves against the version the *demo* is pinned to, fetched at
// runtime by `presetsFor.ts`, because the presets do move: `tokens/main` is 262
// keys at 17.0.1 and 285 at 18.1.0. `colors/*`, `density` and `sizing` happen to
// be byte-identical across 17 → 18, so most of what the Foundation tab shows is
// stable either way (DEV-2560).

import sizing from "handsontable/themes/static/variables/sizing";
import density from "handsontable/themes/static/variables/density";

import mainTokens from "handsontable/themes/static/variables/tokens/main";
import horizonTokens from "handsontable/themes/static/variables/tokens/horizon";
import classicTokens from "handsontable/themes/static/variables/tokens/classic";

import mainColors from "handsontable/themes/static/variables/colors/main";
import horizonColors from "handsontable/themes/static/variables/colors/horizon";
import classicColors from "handsontable/themes/static/variables/colors/classic";
import antColors from "handsontable/themes/static/variables/colors/ant";
import shadcnColors from "handsontable/themes/static/variables/colors/shadcn";
import materialColors from "handsontable/themes/static/variables/colors/material";

import type { ColorsPreset, DensityVariant, TokensPreset, TokenValue } from "./vocabulary.js";

export type { TokenValue };
export type TokenMap = Record<string, TokenValue>;
export type ColorsMap = Record<string, unknown>;

export const SIZING = sizing as unknown as Record<string, string>;
export const DENSITY = density as unknown as Record<DensityVariant, Record<string, string>>;

const TOKENS: Record<TokensPreset, TokenMap> = {
  main: mainTokens as unknown as TokenMap,
  horizon: horizonTokens as unknown as TokenMap,
  classic: classicTokens as unknown as TokenMap,
};

const COLORS: Record<ColorsPreset, ColorsMap> = {
  main: mainColors as unknown as ColorsMap,
  horizon: horizonColors as unknown as ColorsMap,
  classic: classicColors as unknown as ColorsMap,
  ant: antColors as unknown as ColorsMap,
  shadcn: shadcnColors as unknown as ColorsMap,
  material: materialColors as unknown as ColorsMap,
};

export function presetTokens(preset: TokensPreset): TokenMap {
  return TOKENS[preset] ?? TOKENS.main;
}

export function presetColors(preset: ColorsPreset): ColorsMap {
  return COLORS[preset] ?? COLORS.main;
}

export function densitySizes(variant: DensityVariant): Record<string, string> {
  return DENSITY[variant] ?? DENSITY.default;
}

/**
 * The Handsontable these presets came from — the `handsontable` dependency of
 * `apps/authoring/package.json`, which `pipeline/theme-presets-version.test.mjs`
 * keeps in step.
 *
 * Named because the panel says so out loud: when a demo's own version cannot be
 * loaded, the fallback note has to name the version whose numbers are on screen.
 */
export const BUNDLED_VERSION = "18.1.0";

/**
 * The nine colours every theme is built from.
 *
 * Theme-builder's `COMMON_COLORS_KEYS`. They matter to the colour control
 * because pointing a token at one of these (`tokens.accentColor`) inherits its
 * light *and* dark variant for free, whereas picking a raw colour only sets the
 * scheme you are currently looking at.
 */
export const COMMON_COLORS_KEYS = [
  "borderColor",
  "accentColor",
  "foregroundColor",
  "foregroundSecondaryColor",
  "backgroundColor",
  "backgroundSecondaryColor",
  "placeholderColor",
  "readOnlyColor",
  "disabledColor",
] as const;
