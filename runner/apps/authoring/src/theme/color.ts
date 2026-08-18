// Making a preset colour usable by `<input type="color">` (DEV-2560).
//
// The shipped presets are 8-digit hex — `colors/main` has `white: "#ffffffff"`,
// `primary.500: "#1a42e8ff"`, `transparent: "#ffffff00"` — and a native colour
// input accepts nothing but `#rrggbb`. Until now the panel only ever bound
// *overrides* into those inputs, so the mismatch never showed: an unset step
// rendered `#ffffff` at 35% opacity and the real value lived in a `title`.
// Showing the preset value means normalising it first.
//
// Alpha is dropped rather than approximated. A colour input cannot express it,
// and the stored override keeps whatever the user picked, so nothing is lost
// except in the one case where the preset itself is fully transparent — hence
// `isTransparentHex`, so a swatch can say so instead of looking white.
//
// Deliberately importless, so the node test suite can load it directly under
// --experimental-strip-types (the same reason `workers/api/src/theme-ramp.ts`
// has no imports).

const HEX = /^#([0-9a-fA-F]{3,8})$/;

/**
 * The `#rrggbb` a colour input can take, or `fallback` when the value is not a
 * hex colour at all — `rgba()`, `transparent`, a CSS variable, a `colors.*`
 * reference or an empty string.
 */
export function hexInputValue(value: string | undefined, fallback = "#000000"): string {
  const digits = HEX.exec((value ?? "").trim())?.[1];
  if (!digits) return fallback;
  // 3 and 4 digits are shorthand, each nibble doubled; 6 and 8 carry the pair
  // per channel already. 5 and 7 are not colours.
  if (digits.length === 3 || digits.length === 4) {
    return `#${digits.slice(0, 3).split("").map((d) => d + d).join("")}`.toLowerCase();
  }
  if (digits.length === 6 || digits.length === 8) return `#${digits.slice(0, 6)}`.toLowerCase();
  return fallback;
}

/**
 * Is this a hex colour whose alpha is zero? `transparent: "#ffffff00"` would
 * otherwise paint a swatch indistinguishable from white.
 */
export function isTransparentHex(value: string | undefined): boolean {
  const digits = HEX.exec((value ?? "").trim())?.[1];
  if (!digits) return false;
  if (digits.length === 8) return digits.slice(6) === "00";
  if (digits.length === 4) return digits[3] === "0";
  return false;
}
