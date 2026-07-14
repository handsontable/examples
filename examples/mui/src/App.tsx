import { ThemeProvider, createTheme, CssBaseline } from '@mui/material';
import { HotTable, HotColumn } from '@handsontable/react-wrapper';
import { registerAllModules } from 'handsontable/registry';
import { getTheme, hasTheme, registerTheme } from 'handsontable/themes';
import tokensHorizon from 'handsontable/themes/static/variables/tokens/horizon';
import iconsHorizon from 'handsontable/themes/static/variables/icons/horizon';

registerAllModules();

const muiTheme = createTheme({ palette: { mode: 'light' } });

const THEME_NAME = 'mui-data-grid';

const muiTableTheme = (() => {
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
})();

interface Person {
  name: string;
  age: number;
  country: string;
  active: boolean;
}

const data: Person[] = [
  { name: 'Alice', age: 28, country: 'USA', active: true },
  { name: 'Bob', age: 34, country: 'UK', active: false },
  { name: 'Carla', age: 41, country: 'Germany', active: true },
];

export default function App() {
  return (
    <ThemeProvider theme={muiTheme}>
      <CssBaseline />
      <div style={{ padding: 16 }}>
        <HotTable
          theme={muiTableTheme}
          data={data}
          colHeaders={['Name', 'Age', 'Country', 'Active']}
          rowHeaders={true}
          autoWrapRow={true}
          width="100%"
          height="auto"
          licenseKey="non-commercial-and-evaluation"
        >
          <HotColumn data="name" width={160} />
          <HotColumn data="age" type="numeric" width={100} />
          <HotColumn data="country" width={160} />
          <HotColumn data="active" type="checkbox" className="htCenter" width={120} />
        </HotTable>
      </div>
    </ThemeProvider>
  );
}
