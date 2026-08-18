import { useMemo, useState } from 'react';
import { Block } from 'baseui/block';
import { LightTheme } from 'baseui';
import { registerAllModules } from 'handsontable/registry';
import { getTheme, hasTheme, registerTheme } from 'handsontable/themes';
import iconsHorizon from 'handsontable/themes/static/variables/icons/horizon';
import tokensHorizon from 'handsontable/themes/static/variables/tokens/horizon';
import { HotTable } from '@handsontable/react-wrapper';
import type Handsontable from 'handsontable';
import './styles.css';

registerAllModules();

interface Movie {
  selected: boolean;
  title: string;
  category: string;
  three: number;
  negStd: number;
  accounting: string;
  customColor: string;
}

const rows: Movie[] = [
  { selected: true, title: 'Avatar', category: 'F', three: 3, negStd: 3, accounting: '$3', customColor: 'yellow' },
  { selected: true, title: 'The Blind Side', category: 'F', three: 0, negStd: 0, accounting: '$0', customColor: 'purple' },
  { selected: false, title: 'The Dark Knight', category: 'F', three: 5, negStd: 5, accounting: '$5', customColor: 'blue' },
  { selected: false, title: 'ET: The Extra-Terrestrial', category: 'F', three: 2, negStd: 2, accounting: '$2', customColor: 'green' },
  { selected: false, title: 'Finding Nemo', category: 'F', three: 7, negStd: 7, accounting: '$7', customColor: 'red' },
  { selected: false, title: 'Inside Out', category: 'F', three: 4, negStd: 4, accounting: '$4', customColor: 'yellow' },
  { selected: false, title: 'The Incredibles', category: 'F', three: 9, negStd: 9, accounting: '$9', customColor: 'purple' },
  { selected: false, title: 'Toy Story', category: 'F', three: 6, negStd: 6, accounting: '$6', customColor: 'blue' },
  { selected: false, title: 'Up', category: 'F', three: 11, negStd: 11, accounting: '$11', customColor: 'green' },
];

const colorMap: Record<string, string> = {
  yellow: '#f0e400',
  purple: '#6d00b3',
  blue: '#0035ff',
  green: '#0f8a00',
  red: '#f31212',
};

function colorRenderer(
  _instance: Handsontable,
  td: HTMLTableCellElement,
  _row: number,
  _col: number,
  _prop: string | number,
  value: string
) {
  td.textContent = '';
  td.style.whiteSpace = 'nowrap';
  td.style.color = '#111827';

  const dot = document.createElement('span');
  dot.style.display = 'inline-block';
  dot.style.width = '14px';
  dot.style.height = '14px';
  dot.style.borderRadius = '2px';
  dot.style.marginRight = '10px';
  dot.style.verticalAlign = 'middle';
  dot.style.background = colorMap[value] || '#9ca3af';

  const label = document.createElement('span');
  label.textContent = String(value || '');
  label.style.verticalAlign = 'middle';

  td.appendChild(dot);
  td.appendChild(label);

  return td;
}

type FilterMode = 'all' | 'checked' | 'unchecked';

const THEME_NAME = 'base-data-grid';

function createHotTheme() {
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
    // Base Web's light palette, stated as literals — see the note in the MUI
    // starter for why the scheme has to be explicit alongside them.
    colorScheme: 'light',
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

export default function App() {
  const [filterMode, setFilterMode] = useState<FilterMode>('all');

  const filteredRows = useMemo(() => {
    if (filterMode === 'checked') {
      return rows.filter((row) => row.selected === true);
    }
    if (filterMode === 'unchecked') {
      return rows.filter((row) => row.selected === false);
    }

    return rows;
  }, [filterMode]);

  const hotTheme = useMemo(() => createHotTheme(), []);

  return (
    <Block padding="scale700" backgroundColor="backgroundPrimary">
      <h2 className="table-title">Handsontable with Base Web</h2>

      <div className="filter-row">
        <label htmlFor="movie-filter">Filter</label>
        <select
          id="movie-filter"
          value={filterMode}
          onChange={(event) => setFilterMode(event.target.value as FilterMode)}
        >
          <option value="all">All rows</option>
          <option value="checked">Checked only</option>
          <option value="unchecked">Unchecked only</option>
        </select>
      </div>

      <div className="table-shell">
        <HotTable
          theme={hotTheme}
          data={filteredRows}
          width={600}
          // Fixed to fit all 9 rows exactly (no leftover space below the grid).
          // `height="auto"` isn't used here: this table's row count changes at
          // runtime via the filter, and "auto" watches the container for resizes,
          // which loops when the container's own size is driven by that same content.
          height={304}
          rowHeaders={false}
          colHeaders={['', 'title', 'categorical', 'three', 'neg std', 'accounting', 'custom color']}
          licenseKey="non-commercial-and-evaluation"
          autoWrapRow={false}
          autoWrapCol={false}
          columns={[
            { data: 'selected', type: 'checkbox', className: 'htCenter', width: 60 },
            { data: 'title', type: 'text', width: 260 },
            { data: 'category', type: 'text', width: 95 },
            { data: 'three', type: 'numeric', width: 85 },
            { data: 'negStd', type: 'numeric', width: 95 },
            { data: 'accounting', type: 'text', className: 'htRight', width: 115 },
            { data: 'customColor', renderer: colorRenderer, width: 170 },
          ]}
        />
      </div>
    </Block>
  );
}
