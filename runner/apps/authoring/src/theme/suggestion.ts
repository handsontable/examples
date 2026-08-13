// What an AI styling answer actually did to the theme (DEV-2497).
//
// "corporate green" came back from /api/theme as a complete, correct green brand
// ramp — and the grid did not change one pixel, because the brand ramp reaches
// only interaction states (selection, focus rings, the active header, checkbox
// and radio) and none of them is on screen until you click something. The panel
// then reported the model's own claim, "Applied a corporate green palette", as
// if it were confirmation. A recolour that does nothing visible and a recolour
// that works looked identical, and so did a flat refusal.
//
// So the merge is done here, in the open, and it says what it did: whether the
// theme moved at all, and whether anything a resting grid paints moved with it.
// The panel can then tell the truth instead of forwarding an assertion.
//
// Pure and inside `theme/`, which is what makes it testable without a browser —
// see pipeline/theme-suggestion.test.mjs.

import { presetColors, presetTokens, densitySizes, COMMON_COLORS_KEYS } from "./presets.js";
import { effectiveColors, effectiveDensity, effectiveTokens, resolveTokenValue } from "./resolve.js";
import type { ThemeState, TokenValue } from "./vocabulary.js";

/** The server's answer, as the panel receives it over the wire. */
export interface ThemeAnswer {
  message?: string;
  /** Single colours as the model answers them, or the `[light, dark]` pair the
   *  endpoint's resting-surface tint emits — the same shape as `params`. */
  tokens?: Record<string, TokenValue>;
  palette?: Record<string, string>;
  config?: Partial<ThemeState>;
}

/**
 * How much of the grid an answer moved.
 *
 *   `none`            — the theme is byte-for-byte what it was. A refusal, or an
 *                       answer whose every value was already set.
 *   `interactionOnly` — the theme changed, but nothing a resting grid paints did.
 *                       The brand-ramp case: real, invisible until you click.
 *   `visible`         — something on screen right now is different.
 */
export type SuggestionEffect = "none" | "interactionOnly" | "visible";

/**
 * The tokens probed to decide `visible`.
 *
 * `COMMON_COLORS_KEYS` minus `accentColor`, plus the header, stripe and grid-line
 * surfaces. The exclusion is the whole point: `accentColor` resolves to
 * `colors.primary.500`, so keeping it would make every brand recolour report as
 * visible and this check would answer its own question wrong.
 */
const RESTING_TOKENS: readonly string[] = [
  ...COMMON_COLORS_KEYS.filter((key) => key !== "accentColor"),
  "headerBackgroundColor",
  "headerRowBackgroundColor",
  "headerFilterBackgroundColor",
  "rowCellOddBackgroundColor",
  "rowCellEvenBackgroundColor",
  "rowHeaderOddBackgroundColor",
  "rowHeaderEvenBackgroundColor",
  "cellHorizontalBorderColor",
  "cellVerticalBorderColor",
  // Typography and metrics are as visible as colour is, and an answer that only
  // changes the font must not be mistaken for one that changes nothing.
  "fontFamily",
  "fontSize",
  "lineHeight",
  "fontWeight",
  "borderRadius",
];

/** Token values are strings or `[light, dark]` pairs; compare either. */
const sameValue = (a: TokenValue | undefined, b: TokenValue | undefined): boolean =>
  a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function sameMap(a: Record<string, TokenValue>, b: Record<string, TokenValue>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (!sameValue(a[key], b[key])) return false;
  return true;
}

/** Did the theme move at all? Compared field by field rather than by serialising
 *  the whole state, because a spread reorders keys without changing a value. */
function sameState(a: ThemeState, b: ThemeState): boolean {
  return a.tokens === b.tokens
    && a.colors === b.colors
    && a.icons === b.icons
    && a.colorScheme === b.colorScheme
    && a.density === b.density
    && sameMap(a.params, b.params)
    && sameMap(a.palette, b.palette)
    && JSON.stringify(a.densitySizes) === JSON.stringify(b.densitySizes);
}

/** What `RESTING_TOKENS` evaluate to under a given theme — the grid's resting
 *  appearance, reduced to a comparable string. */
function restingAppearance(state: ThemeState): string {
  const tokens = effectiveTokens(presetTokens(state.tokens), state.params);
  const colors = effectiveColors(presetColors(state.colors), state.palette);
  const density = effectiveDensity(densitySizes(state.density), state.densitySizes?.[state.density] ?? {});
  return RESTING_TOKENS
    .map((key) => `${key}=${String(resolveTokenValue(tokens[key], colors, tokens, density, state.colorScheme))}`)
    .join("|");
}

/**
 * Merge a server answer onto the current theme, and report what it did.
 *
 * The merge itself is what `describe()` used to do inline: presets replace,
 * tokens and palette layer on top so a follow-up ("now darken the header")
 * refines rather than resets.
 */
export function mergeSuggestion(
  state: ThemeState,
  answer: ThemeAnswer,
): { next: ThemeState; effect: SuggestionEffect } {
  const next: ThemeState = {
    ...state,
    ...(answer.config ?? {}),
    params: { ...state.params, ...(answer.tokens ?? {}) },
    palette: { ...state.palette, ...(answer.palette ?? {}) },
  };

  if (sameState(state, next)) return { next, effect: "none" };
  const effect = restingAppearance(state) === restingAppearance(next) ? "interactionOnly" : "visible";
  return { next, effect };
}

/** The sentence for an answer that changed nothing. Says what to do instead —
 *  a refusal the user cannot act on is only half an answer. */
export const NOTHING_CHANGED_NOTE =
  "That didn’t change the theme. Try naming a colour or an element — “green headers”, "
  + "“thicker selection border”, “dark and compact”.";

/** Appended to the model's own message when the change is real but invisible
 *  until the grid is touched. */
export const INTERACTION_ONLY_NOTE =
  "It shows on selection, focus and active headers — nothing the grid paints at rest uses the brand colour.";
