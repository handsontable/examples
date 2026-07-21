import { useEffect, useState } from 'react';
import { ThemeProvider, createTheme, CssBaseline } from '@mui/material';
import { HotTable, HotColumn } from '@handsontable/react-wrapper';
import { registerAllModules } from 'handsontable/registry';
import { buildHotThemeProps, type HotThemeProps } from './hotTheme';

registerAllModules();

const muiTheme = createTheme({ palette: { mode: 'light' } });

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
  const [themeProps, setThemeProps] = useState<HotThemeProps | null>(null);

  useEffect(() => {
    let cancelled = false;
    buildHotThemeProps(muiTheme).then((props) => {
      if (!cancelled) setThemeProps(props);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!themeProps) {
    return null;
  }

  return (
    <ThemeProvider theme={muiTheme}>
      <CssBaseline />
      <div style={{ padding: 16 }}>
        <HotTable
          {...themeProps}
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
