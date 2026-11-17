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

import { presetColors, presetTokens, densitySizes, COMMON_COLORS_KEYS, SIZING } from "./presets.js";
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
  const ctx = { tokens, colors, density, sizing: SIZING, colorScheme: state.colorScheme };
  return RESTING_TOKENS
    .map((key) => `${key}=${String(resolveTokenValue(tokens[key], ctx))}`)
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

/**
 * Short tags for what an answer changed — the "primary ramp updated, 3 tokens"
 * line Theme Builder puts under each chat reply (DEV-4070).
 *
 * Computed from the two states rather than from the answer, for the same reason
 * `mergeSuggestion` is: the answer is a claim, and a value the theme already had
 * is not a change. Order follows the panel's tabs — presets, ramps, tokens.
 */
export function describeChanges(prev: ThemeState, next: ThemeState): string[] {
  const tags: string[] = [];
  if (prev.tokens !== next.tokens) tags.push(`${next.tokens} token mapping`);
  if (prev.colors !== next.colors) tags.push(`${next.colors} colors`);
  if (prev.icons !== next.icons) tags.push(`${next.icons} icons`);
  if (prev.colorScheme !== next.colorScheme) tags.push(`${next.colorScheme} scheme`);
  if (prev.density !== next.density) tags.push(`${next.density} density`);

  const changedKeys = (a: Record<string, TokenValue>, b: Record<string, TokenValue>) =>
    Object.keys(b).filter((key) => !sameValue(a[key], b[key]));
  const palette = changedKeys(prev.palette, next.palette);
  if (palette.some((key) => key.startsWith("primary."))) tags.push("brand ramp");
  if (palette.some((key) => key.startsWith("palette."))) tags.push("neutral ramp");
  if (palette.includes("white") || palette.includes("black")) tags.push("white/black");

  const tokens = changedKeys(prev.params, next.params).length;
  if (tokens) tags.push(tokens === 1 ? "1 token" : `${tokens} tokens`);
  return tags;
}

/** One message in the Theme builder's styling chat. */
export interface ThemeChatMessage {
  role: "user" | "assistant";
  content: string;
  /** Assistant only: `describeChanges` for the answer, empty when nothing moved. */
  tags?: string[];
  /** Assistant only: what the panel adds to the model's claim — the
   *  nothing-changed and interaction-only notes. */
  note?: string;
}

/** What the server is sent as conversation history: the turns before the
 *  current request, text only. The server normalises the shape again, so this
 *  only has to be sensible, not authoritative. */
export function historyForRequest(messages: readonly ThemeChatMessage[], limit = 10): { role: "user" | "assistant"; content: string }[] {
  return messages.slice(-limit).map(({ role, content }) => ({ role, content }));
}

/** Theme Builder's empty-state chips, so an empty chat is not a blank box. */
export const CHAT_SUGGESTIONS: readonly string[] = [
  "Retro terminal theme",
  "Change brand color to green",
  "Dark mode",
  "Pastel color palette",
  "Change font to Playfair Display",
];
