// Turning a token's stored value into something a human can read (DEV-2199).
//
// Ported from theme-builder `src/utils/helpers.ts`. A token value is rarely a
// literal — it is usually a reference, sometimes a chain of them:
//
//   accentColor          ["colors.primary.500", "colors.primary.300"]  (light, dark)
//   borderRadius         "sizing.size_1"                → "4px"
//   cellHorizontalPadding "density.cellHorizontal"      → "sizing.size_2" → "8px"
//   headerRowBackgroundColor "tokens.backgroundSecondaryColor" → … → "#f5f5f5ff"
//
// Everything here is pure: given the preset data and the current overrides, work
// out what a token actually evaluates to.

import type { ColorsMap, TokenMap, TokenValue } from "./presets.js";
import type { ColorScheme } from "./vocabulary.js";

/**
 * Everything a reference can point at, plus the scheme that picks a
 * `[light, dark]` half.
 *
 * `sizing` is a field rather than the module-level `SIZING` import it used to be
 * (DEV-2560): the panel resolves against the Handsontable version the *demo* is
 * pinned to, and a value baked in at module scope is the one thing a caller
 * cannot override. Passing the whole set as one object is what makes forgetting
 * it a type error rather than a silent fall back to this app's own version.
 */
export interface ResolveContext {
  colors: ColorsMap;
  tokens: TokenMap;
  density: Record<string, string>;
  sizing: Record<string, string>;
  colorScheme: ColorScheme;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

/** `getNestedValue(colors, "primary.500")`. */
export function getNestedValue(obj: unknown, path: string): unknown {
  if (!obj) return undefined;
  let current: unknown = obj;
  for (const key of path.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Follow a value through however many layers of reference it has.
 *
 * A `[light, dark]` pair picks the side matching the colour scheme first, then
 * keeps resolving — the chosen side is itself usually a `colors.` reference.
 */
export function resolveTokenValue(value: unknown, ctx: ResolveContext): unknown {
  if (Array.isArray(value) && value.length >= 2
    && typeof value[0] === "string" && typeof value[1] === "string") {
    const picked = ctx.colorScheme === "light" ? value[0] : value[1];
    return resolveTokenValue(picked, ctx);
  }

  if (typeof value === "string") {
    for (const [prefix, source] of [
      ["tokens.", ctx.tokens],
      ["colors.", ctx.colors],
      ["sizing.", ctx.sizing],
      ["density.", ctx.density],
    ] as const) {
      if (value.startsWith(prefix)) {
        // A token pointing at itself would spin forever; the presets don't do
        // that, but an override typed by hand could.
        const next = getNestedValue(source, value.slice(prefix.length));
        if (next === value) return value;
        return resolveTokenValue(next, ctx);
      }
    }
  }

  return value;
}

/**
 * A short label for what a token is *pointing at*, rather than what it
 * evaluates to: "Background Secondary Color", "primary-500", or the literal.
 */
export function tokenValueLabel(value: TokenValue | undefined, colorScheme: ColorScheme): string {
  let name = value;

  if (Array.isArray(name)) name = name[colorScheme === "light" ? 0 : 1];
  if (typeof name !== "string") return "";

  if (name.startsWith("tokens.")) {
    return name
      .slice("tokens.".length)
      .replace(/([A-Z])/g, " $1")
      .trim()
      .split(/\s+/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(" ");
  }

  if (name.startsWith("colors.")) return name.slice("colors.".length).split(".").join("-");
  if (name.startsWith("sizing.") || name.startsWith("density.")) {
    return name.slice(name.indexOf(".") + 1);
  }

  return name;
}

/**
 * Write a colour into one half of a `[light, dark]` pair.
 *
 * Picking a raw colour only means "in the scheme I'm looking at" — the other
 * scheme keeps whatever it had, so switching to dark doesn't reveal a grid
 * silently restyled behind your back. A token that was a single string becomes
 * the same colour in both, which is what theme-builder does.
 */
export function mergeForColorScheme(
  current: TokenValue | undefined,
  next: string,
  colorScheme: ColorScheme,
): [string, string] {
  const pair = Array.isArray(current) && current.length >= 2;
  if (!pair) return [next, next];

  const [light, dark] = [String((current as string[])[0]), String((current as string[])[1])];
  return colorScheme === "light" ? [next, dark] : [light, next];
}

/**
 * The preset with the panel's overrides layered on, which is what a token
 * actually resolves against — an override can itself be the target of another
 * token's `tokens.` reference, so they have to be merged before resolving.
 */
export function effectiveTokens(preset: TokenMap, params: Record<string, TokenValue>): TokenMap {
  return { ...preset, ...params };
}

/** Ramp overrides are stored flat (`"primary.500"`, `"white"`); the resolver
 *  walks a nested object, so fold them back in. */
export function effectiveColors(preset: ColorsMap, palette: Record<string, string>): ColorsMap {
  const merged: Record<string, unknown> = { ...preset };
  for (const [key, value] of Object.entries(palette)) {
    if (!value) continue;
    const dot = key.indexOf(".");
    if (dot === -1) {
      merged[key] = value;
      continue;
    }
    const [group, step] = [key.slice(0, dot), key.slice(dot + 1)];
    const current = merged[group];
    merged[group] = { ...(isPlainObject(current) ? current : {}), [step]: value };
  }
  return merged;
}

export function effectiveDensity(
  preset: Record<string, string>,
  overrides: Record<string, string>,
): Record<string, string> {
  const merged = { ...preset };
  for (const [key, value] of Object.entries(overrides)) if (value) merged[key] = value;
  return merged;
}
