// Filling the gaps in a colour ramp the model only half-supplied (DEV-2197).
//
// "Corporate navy blue" came back as primary.100/300/400/500/600 — no 200 —
// while the assistant's message said it had applied a navy palette. The panel
// deep-merges a ramp over the preset's, so the missing step keeps the preset's
// colour and a navy ramp holds one blue rung in the middle. It reads as a
// rendering bug rather than a missing value, which is why it went unnoticed.
//
// The prompt already asks for all six steps and usually gets them. This is the
// second lock: the whitelist in theme-ai.ts can produce the same symptom on its
// own by dropping a single malformed value, and no prompt wording protects
// against that.
//
// Deliberately importless, so the node test suite can load it directly under
// --experimental-strip-types without pulling in the worker's environment.

/** The brand ramp, lightest to darkest. */
export const PRIMARY_RAMP = ["100", "200", "300", "400", "500", "600"] as const;
/** The neutral scale. Note the uneven ends — 50 and 950 sit half a step out. */
export const NEUTRAL_RAMP = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"] as const;

interface Rgba { r: number; g: number; b: number; a: number }

function parse(hex: string): Rgba | null {
  const m = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(hex.trim());
  if (!m) return null;
  const digits = m[1]!;
  const at = (i: number) => parseInt(digits.slice(i, i + 2), 16);
  return { r: at(0), g: at(2), b: at(4), a: digits.length === 8 ? at(6) : 255 };
}

function format({ r, g, b, a }: Rgba, withAlpha: boolean): string {
  const hex = (c: number) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}${withAlpha ? hex(a) : ""}`;
}

/**
 * Mix two colours in sRGB.
 *
 * sRGB rather than a perceptual space because that is what the panel's own
 * brand-ramp generator does (`StylePanel.tsx` `rampFrom`, which blends toward
 * white and black by fixed amounts). A gap filled on a different curve would
 * sit visibly off the ramp it is patching — the same class of defect this is
 * here to remove. The worker cannot import from the app, so the choice is
 * duplicated; it must not disagree.
 */
function mix(from: Rgba, to: Rgba, t: number): Rgba {
  const at = (a: number, b: number) => a + (b - a) * t;
  return { r: at(from.r, to.r), g: at(from.g, to.g), b: at(from.b, to.b), a: at(from.a, to.a) };
}

/**
 * Complete a partially-supplied ramp.
 *
 * Missing steps are interpolated between their nearest supplied neighbours and
 * clamped to the nearest neighbour past either end. Interpolation runs on the
 * step's *number*, not its position in the list, so the uneven 50 and 950 ends
 * of the neutral scale land where their names say they should.
 *
 * A ramp with fewer than two supplied steps is returned untouched: one step on
 * its own is a deliberate single-colour change, not a broken recolour, and
 * inventing five more colours around it would be a worse answer than the one
 * the model gave.
 */
export function completeRamp(
  supplied: Readonly<Record<string, string>>,
  steps: readonly string[],
): Record<string, string> {
  const known = steps
    .map((step) => ({ step, at: Number(step), rgba: parse(supplied[step] ?? "") }))
    .filter((s): s is { step: string; at: number; rgba: Rgba } => s.rgba !== null);

  if (known.length < 2 || known.length === steps.length) return { ...supplied };

  const withAlpha = Object.values(supplied).some((v) => /^#[0-9a-fA-F]{8}$/.test(v.trim()));
  const filled: Record<string, string> = { ...supplied };

  for (const step of steps) {
    if (known.some((k) => k.step === step)) continue;
    const at = Number(step);
    const before = [...known].reverse().find((k) => k.at < at);
    const after = known.find((k) => k.at > at);

    const rgba = before && after
      ? mix(before.rgba, after.rgba, (at - before.at) / (after.at - before.at))
      : (before ?? after)!.rgba;

    filled[step] = format(rgba, withAlpha);
  }

  return filled;
}
