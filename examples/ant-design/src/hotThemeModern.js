// The `handsontable/themes` imports below only resolve on Handsontable >= 17;
// on 15/16 the bundler redirects them to hotThemesCompat.js (see
// vite.config.js) and the runtime version gate in hotTheme.js keeps this
// module from ever being executed.
import { getTheme, hasTheme, horizonTheme, registerTheme } from 'handsontable/themes';
import colorsAnt from 'handsontable/themes/static/variables/colors/ant';

const THEME_NAME = 'horizon-ant-table';

export function buildAntTheme() {
  if (hasTheme(THEME_NAME)) {
    return getTheme(THEME_NAME);
  }
  return registerTheme(THEME_NAME, horizonTheme)
    .params({
      colors: colorsAnt,
      tokens: {
        borderColor: ['colors.palette.200', 'colors.palette.700'],
        borderRadius: '8px',
        headerBackgroundColor: ['colors.palette.100', 'colors.palette.800'],
        headerFontWeight: '600',
        cellHorizontalBorderColor: ['colors.palette.200', 'colors.palette.700'],
        cellVerticalBorderColor: ['colors.palette.200', 'colors.palette.700'],
        cellHorizontalPadding: '16px',
        cellVerticalPadding: '8px',
        rowCellEvenBackgroundColor: ['colors.white', 'colors.palette.950'],
        rowCellOddBackgroundColor: ['colors.white', 'colors.palette.950'],
        cellReadOnlyBackgroundColor: ['colors.white', 'colors.palette.950'],
        foregroundColor: ['colors.palette.800', 'colors.palette.100'],
        linkColor: ['colors.primary.200', 'colors.primary.100'],
        linkHoverColor: ['colors.primary.100', 'colors.primary.200'],
      },
    })
    .setColorScheme('light')
    .setDensityType('comfortable');
}
