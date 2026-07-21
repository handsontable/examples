// @ts-nocheck
// The `handsontable/themes` imports below only resolve on Handsontable >= 17;
// on 15/16 the bundler redirects them to hotThemesCompat.ts (see
// vite.config.ts), but `tsc -b` knows nothing about that alias, so type
// checking is disabled for this file to survive builds on those majors.
import { LightTheme } from 'baseui';
import { getTheme, hasTheme, registerTheme } from 'handsontable/themes';
import iconsHorizon from 'handsontable/themes/static/variables/icons/horizon';
import tokensHorizon from 'handsontable/themes/static/variables/tokens/horizon';

const THEME_NAME = 'base-data-grid';

export function buildBaseWebTheme() {
  if (hasTheme(THEME_NAME)) {
    return getTheme(THEME_NAME);
  }

  const c = LightTheme.colors as Record<string, string>;
  const color = (name: string, fallback: string) => c[name] || fallback;

  const colorsBase = {
    palette: {
      50: color('backgroundSecondary', '#f7f7f8'),
      100: color('backgroundSecondary', '#f7f7f8'),
      200: color('backgroundPrimary', '#ffffff'),
      300: color('borderOpaque', '#e2e8f0'),
      400: color('contentTertiary', '#6b7280'),
      500: color('contentSecondary', '#374151'),
      600: color('contentPrimary', '#111827'),
      700: color('contentInverseSecondary', '#d1d5db'),
      800: color('contentInversePrimary', '#f9fafb'),
      900: color('backgroundInversePrimary', '#111827'),
      950: color('backgroundInverseSecondary', '#1f2937'),
    },
    primary: {
      100: color('primaryA', '#dbeafe'),
      200: color('primaryB', '#bfdbfe'),
      300: color('primary', '#276ef1'),
      400: color('primaryHover', '#174eb6'),
      500: color('primaryActive', '#123a8f'),
      600: color('contentPrimary', '#111827'),
    },
    white: color('backgroundPrimary', '#ffffff'),
    black: color('contentPrimary', '#111827'),
    transparent: 'transparent',
  };

  return registerTheme(THEME_NAME, {
    icons: iconsHorizon,
    colors: colorsBase,
    tokens: tokensHorizon,
  }).params({
    tokens: {
      fontFamily: 'Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
      foregroundColor: color('contentPrimary', '#111827'),
      foregroundSecondaryColor: color('contentSecondary', '#374151'),
      backgroundColor: '#ffffff',
      backgroundSecondaryColor: '#f7f7f8',
      barForegroundColor: color('contentPrimary', '#111827'),
      barBackgroundColor: '#ffffff',
      headerForegroundColor: color('contentPrimary', '#111827'),
      headerBackgroundColor: '#ffffff',
      rowCellOddBackgroundColor: '#ffffff',
      rowCellEvenBackgroundColor: '#f7f7f8',
      rowHeaderOddBackgroundColor: '#ffffff',
      rowHeaderEvenBackgroundColor: '#f7f7f8',
      cellHorizontalBorderColor: '#e9edf3',
      cellVerticalBorderColor: '#e9edf3',
      borderColor: '#e2e8f0',
      borderRadius: '10px',
      cellEditorBackgroundColor: '#ffffff',
      cellEditorForegroundColor: '#111827',
      cellEditorBorderColor: color('primary', '#276ef1'),
      cellEditorBorderWidth: '1px',
      cellEditorShadowBlurRadius: '10px',
      cellEditorShadowColor: 'rgba(17,24,39,0.25)',
      inputBackgroundColor: '#ffffff',
      inputForegroundColor: '#111827',
      inputBorderColor: '#cbd5e1',
      inputFocusBorderColor: color('primary', '#276ef1'),
      checkboxBackgroundColor: '#ffffff',
      checkboxBorderColor: '#5b6470',
      checkboxIconColor: '#ffffff',
      checkboxCheckedBackgroundColor: '#111111',
      checkboxCheckedBorderColor: '#111111',
      checkboxCheckedIconColor: '#ffffff',
    },
  });
}
