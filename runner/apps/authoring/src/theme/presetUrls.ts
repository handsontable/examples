// Where a *specific* Handsontable version's preset data lives (DEV-2560).
//
// The panel is built against one pinned Handsontable (see `BUNDLED_VERSION`),
// but a demo runs whatever the version picker says, and the presets are not
// frozen: `tokens/main` is 262 keys at 17.0.1 and 285 at 18.1.0. A resolved
// value shown from the wrong version is a confidently wrong number, which is
// worse than the empty box it replaced.
//
// jsDelivr rather than unpkg (which `packages/runtime/src/dep-shims.ts` uses for
// its own job): both serve these files with `access-control-allow-origin: *`,
// jsDelivr marks them `immutable`, and the modules are leaf data with no imports
// of their own, so a browser can `import()` one directly. The authoring app
// declares no CSP; if one is ever added, `script-src` has to list this host or
// every panel silently falls back to the bundled copy.
//
// Deliberately importless — the same reason `theme/color.ts` is: the node test
// suite loads it directly, and nothing here needs the app.

export const PRESET_CDN = "https://cdn.jsdelivr.net/npm/handsontable";

/** Mirrors `NEXT_PRERELEASE_RE` in `packages/runtime/src/version.ts`. Copied
 *  rather than imported: that module is a build artifact (`dist/`), and pulling
 *  it in here would put a compiled package in the theme directory's import
 *  graph, which is what silently turns the codegen harnesses into skips. */
const NEXT_PRERELEASE_RE = /^0\.0\.0-next-[0-9a-f]+-\d{8}$/i;

/**
 * Can this version's presets be fetched at all?
 *
 * A plain release and a `next` stamp are both real npm versions, so jsDelivr has
 * them. A pkg.pr.new ref is a bare build id or a URL — not on npm, nothing to
 * fetch. Versions below 17 are not excluded here: they have no
 * `themes/static/variables` at all, but the panel is gated off there
 * (`THEME_API_MIN_MAJOR` in `App.tsx`), so this never sees one.
 */
export function canLoadPresets(version: string): boolean {
  const v = version.trim();
  if (!v) return false;
  return /^\d+\.\d+\.\d+$/.test(v) || NEXT_PRERELEASE_RE.test(v);
}

export type PresetKind = "sizing" | "density" | "tokens" | "colors";

/**
 * The ESM module for one preset file at one version.
 *
 * `sizing` and `density` are single modules; `tokens` and `colors` are one module
 * per preset name, so those need `preset`.
 */
export function presetUrl(version: string, kind: PresetKind, preset?: string): string {
  const leaf = preset ? `${kind}/${preset}` : kind;
  return `${PRESET_CDN}@${version}/themes/static/variables/${leaf}.mjs`;
}
