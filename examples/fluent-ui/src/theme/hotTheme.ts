import Handsontable from 'handsontable';

// Handsontable's JS themes API (`handsontable/themes`) exists only from major
// 17 — on 15/16 the subpath is missing from the package `exports` map. Gate on
// the runtime version: on >= 17 build the custom Fluent theme with the themes
// API, on 15/16 fall back to the CSS-based horizon theme (whose stylesheet
// FluentHotTable.tsx already imports statically on every major).
export type HotThemeProps = { theme: unknown } | { themeName: string };

const HOT_MAJOR = Number(String(Handsontable.version).split('.')[0]);

export async function buildHotThemeProps(): Promise<HotThemeProps> {
  if (HOT_MAJOR >= 17) {
    const { buildFluentTheme } = await import('./fluentDataGridTheme');
    return { theme: buildFluentTheme() };
  }

  return { themeName: 'ht-theme-horizon' };
}
