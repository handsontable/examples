// @ts-nocheck
// The `handsontable/themes` imports below only resolve on Handsontable >= 17;
// on 15/16 the bundler redirects them to hotThemesCompat.ts (see
// vite.config.ts), but `tsc -b` knows nothing about that alias, so type
// checking is disabled for this file to survive builds on those majors.
import type { Theme } from '@mui/material';
import { getTheme, hasTheme, registerTheme } from 'handsontable/themes';
import tokensHorizon from 'handsontable/themes/static/variables/tokens/horizon';
import iconsHorizon from 'handsontable/themes/static/variables/icons/horizon';

const THEME_NAME = 'mui-data-grid';

export function buildMuiTheme(muiTheme: Theme) {
  if (hasTheme(THEME_NAME)) {
    return getTheme(THEME_NAME);
  }

  return registerTheme(THEME_NAME, {
    icons: iconsHorizon,
    colors: {
      palette: {
        50: muiTheme.palette.grey[50],
        100: muiTheme.palette.grey[100],
        200: muiTheme.palette.grey[200],
        300: muiTheme.palette.grey[300],
        400: muiTheme.palette.grey[400],
        500: muiTheme.palette.grey[500],
        600: muiTheme.palette.grey[600],
        700: muiTheme.palette.grey[700],
        800: muiTheme.palette.grey[800],
        900: muiTheme.palette.grey[900],
        950: muiTheme.palette.grey[900],
      },
      primary: {
        100: muiTheme.palette.primary.light,
        200: muiTheme.palette.primary.light,
        300: muiTheme.palette.primary.main,
        400: muiTheme.palette.primary.main,
        500: muiTheme.palette.primary.dark,
        600: muiTheme.palette.primary.dark,
      },
      white: muiTheme.palette.background.paper,
      black: muiTheme.palette.text.primary,
      transparent: 'transparent',
    },
    tokens: tokensHorizon,
  }).params({ tokens: { borderRadius: '4px' } });
}
