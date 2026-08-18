import { getTheme, hasTheme, registerTheme } from 'handsontable/themes';
import iconsHorizon from 'handsontable/themes/static/variables/icons/horizon';
import tokensHorizon from 'handsontable/themes/static/variables/tokens/horizon';
import colorsFluent from './colorsFluent';

const THEME_NAME = 'fluent-data-grid';

export const fluentDataGridTheme = hasTheme(THEME_NAME)
  ? getTheme(THEME_NAME)
  : registerTheme(THEME_NAME, {
      // Fluent's light palette, stated as literals — see the note in the MUI
      // starter for why the scheme has to be explicit alongside them.
      colorScheme: 'light',
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
