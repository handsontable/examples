// @ts-nocheck
// The `handsontable/themes` imports below only resolve on Handsontable >= 17;
// on 15/16 the bundler redirects them to hotThemesCompat.ts (see
// vite.config.ts), but `tsc -b` knows nothing about that alias, so type
// checking is disabled for this file to survive builds on those majors.
import { getTheme, hasTheme, registerTheme } from 'handsontable/themes';
import iconsHorizon from 'handsontable/themes/static/variables/icons/horizon';
import tokensHorizon from 'handsontable/themes/static/variables/tokens/horizon';
import colorsFluent from './colorsFluent';

const THEME_NAME = 'fluent-data-grid';

export function buildFluentTheme() {
  if (hasTheme(THEME_NAME)) {
    return getTheme(THEME_NAME);
  }

  return registerTheme(THEME_NAME, {
    icons: iconsHorizon,
    colors: colorsFluent,
    tokens: tokensHorizon,
  }).params({
    tokens: {
      fontFamily: "'Segoe UI', 'Segoe UI Web (West European)', system-ui, sans-serif",
      fontSize: '14px',
      lineHeight: '20px',
      headerFontWeight: '600',
      foregroundColor: '#242424',
      foregroundSecondaryColor: '#616161',
      backgroundColor: '#ffffff',
      backgroundSecondaryColor: '#fafafa',
      borderColor: '#e1dfdd',
      cellVerticalBorderColor: '#e1dfdd',
      headerBackgroundColor: '#f5f5f5',
      headerForegroundColor: '#242424',
      rowCellOddBackgroundColor: '#ffffff',
      rowCellEvenBackgroundColor: '#ffffff',
      rowHeaderOddBackgroundColor: '#ffffff',
      rowHeaderEvenBackgroundColor: '#ffffff',
      cellHorizontalPadding: '12px',
      cellVerticalPadding: '10px',
      barHorizontalPadding: '12px',
      barVerticalPadding: '8px',
      menuItemHorizontalPadding: '12px',
      menuItemVerticalPadding: '8px',
      borderRadius: '8px',
      cellSelectionBorderColor: '#0f6cbd',
      cellSelectionBackgroundColor: '#deecf9',
    },
  });
}
