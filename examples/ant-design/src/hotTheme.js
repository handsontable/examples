import Handsontable from 'handsontable';

// Handsontable's JS themes API (`handsontable/themes`) exists only from major
// 17 — on 15/16 the subpath is missing from the package `exports` map. Gate on
// the runtime version: on >= 17 build the custom Ant theme with the themes
// API, on 15/16 fall back to the CSS-based horizon theme, which every
// supported major ships.
const HOT_MAJOR = Number(String(Handsontable.version).split('.')[0]);

export async function buildHotThemeProps() {
  if (HOT_MAJOR >= 17) {
    const { buildAntTheme } = await import('./hotThemeModern');
    return { theme: buildAntTheme() };
  }

  await Promise.all([
    import('handsontable/styles/handsontable.min.css'),
    import('handsontable/styles/ht-theme-horizon.min.css'),
  ]);
  return { themeName: 'ht-theme-horizon' };
}
