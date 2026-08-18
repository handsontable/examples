// The preset data for the version the *demo* runs, not the one this app is built
// with (DEV-2560).
//
// Four leaf modules per (version, tokens preset, colors preset): `sizing`,
// `density`, `tokens/<preset>` and `colors/<preset>`, together about 20 KB. They
// are plain ESM with a default export and no imports of their own, so a dynamic
// `import()` straight off jsDelivr is the whole mechanism — no bundling step, no
// worker route, no committed snapshots to regenerate whenever a major moves.
//
// Nothing inside `theme/` imports this file, and nothing here imports outside
// `theme/`. Both directions matter: `pipeline/theme-wiring.test.mjs` copies this
// directory into a tmp dir and runs it under `--experimental-strip-types`, and an
// import it cannot resolve turns all eighteen of its cases into skips that read
// as a green run. Only `StylePanel.tsx` — outside `theme/`, in neither harness —
// loads this.

import { BUNDLED_VERSION, DENSITY, presetColors, presetTokens, SIZING } from "./presets.js";
import type { ColorsMap, TokenMap } from "./presets.js";
import { canLoadPresets, type PresetKind, presetUrl } from "./presetUrls.js";
import type { ColorsPreset, DensityVariant, TokensPreset } from "./vocabulary.js";

/** A resolvable set of preset data, whatever version it came from. */
export interface PresetSet {
  /** The version whose numbers these are — not necessarily the one asked for. */
  version: string;
  /** True when the ask could not be honoured and this is the bundled copy. */
  fallback: boolean;
  sizing: Record<string, string>;
  density: Record<DensityVariant, Record<string, string>>;
  tokens: TokenMap;
  colors: ColorsMap;
}

/**
 * How long to wait for jsDelivr before showing the bundled numbers instead.
 *
 * A dynamic `import()` cannot be aborted — there is no `AbortController` for it,
 * unlike the `fetch` calls elsewhere in the app — so this is the only way a hung
 * response does not leave the panel resolving forever. Generous, because the
 * cost of waiting is a stale-looking panel while the cost of giving up early is
 * wrong numbers.
 */
const LOAD_TIMEOUT_MS = 4000;

/**
 * One promise per module URL, not per (version, preset) tuple.
 *
 * Flipping the tokens preset then costs one request rather than four, and
 * switching back costs none. `dep-shims.ts` caches the same way, including the
 * `catch` that evicts a rejection so one flaky load does not poison the entry.
 */
const moduleCache = new Map<string, Promise<Record<string, unknown>>>();

function loadModule(url: string): Promise<Record<string, unknown>> {
  const cached = moduleCache.get(url);
  if (cached) return cached;

  const pending = (async () => {
    // `@vite-ignore`: the specifier is a runtime URL, and without this Vite tries
    // to resolve and bundle it at build time.
    const mod = await import(/* @vite-ignore */ url) as { default?: unknown };
    const data = mod.default;
    // A CDN that answers an unknown path with an HTML error page, or a future
    // package that changes the export shape, must not reach the resolver as a
    // half-object.
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error(`not a preset module: ${url}`);
    }
    return data as Record<string, unknown>;
  })();

  moduleCache.set(url, pending);
  pending.catch(() => moduleCache.delete(url));
  return pending;
}

/** This app's own presets — the synchronous first render, and the fallback. */
export function bundledPresets(
  tokens: TokensPreset,
  colors: ColorsPreset,
  fallback = false,
): PresetSet {
  return {
    version: BUNDLED_VERSION,
    fallback,
    sizing: SIZING,
    density: DENSITY,
    tokens: presetTokens(tokens),
    colors: presetColors(colors),
  };
}

function fetchPreset(version: string, kind: PresetKind, preset?: string) {
  return loadModule(presetUrl(version, kind, preset));
}

/**
 * The presets for `version`, or the bundled ones with `fallback: true` when they
 * cannot be had — an unfetchable ref, a network failure, a timeout.
 *
 * Never rejects. A panel that shows this app's numbers and says so is useful; a
 * panel that shows an error where a colour ramp should be is not.
 */
export async function loadPresets(
  version: string,
  tokens: TokensPreset,
  colors: ColorsPreset,
): Promise<PresetSet> {
  // The pinned version is not a fallback — those *are* the right numbers.
  if (version === BUNDLED_VERSION) return bundledPresets(tokens, colors);
  // An unfetchable ref is: the panel is showing this app's numbers for someone
  // else's version, which is exactly what the note exists to say.
  if (!canLoadPresets(version)) return bundledPresets(tokens, colors, true);

  const timeout = new Promise<PresetSet>((resolve) => {
    setTimeout(() => resolve(bundledPresets(tokens, colors, true)), LOAD_TIMEOUT_MS);
  });

  const loading = (async (): Promise<PresetSet> => {
    try {
      const [sizing, density, tokenMap, colorMap] = await Promise.all([
        fetchPreset(version, "sizing"),
        fetchPreset(version, "density"),
        fetchPreset(version, "tokens", tokens),
        fetchPreset(version, "colors", colors),
      ]);
      return {
        version,
        fallback: false,
        sizing: sizing as Record<string, string>,
        density: density as unknown as Record<DensityVariant, Record<string, string>>,
        tokens: tokenMap as TokenMap,
        colors: colorMap as ColorsMap,
      };
    } catch {
      return bundledPresets(tokens, colors, true);
    }
  })();

  return Promise.race([loading, timeout]);
}
