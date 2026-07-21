import { useEffect, useState } from 'react';
import { HotTable, HotColumn } from '@handsontable/react-wrapper';
import { registerAllModules } from 'handsontable/registry';
import 'handsontable/styles/handsontable.min.css';
import 'handsontable/styles/ht-theme-horizon.min.css';

import { buildHotThemeProps, type HotThemeProps } from '../theme/hotTheme';

registerAllModules();

const data = [
  { team: 'Design', owner: 'Ava', status: 'In progress', priority: 'High' },
  { team: 'Platform', owner: 'Noah', status: 'Blocked', priority: 'Medium' },
  { team: 'Docs', owner: 'Liam', status: 'Done', priority: 'Low' },
];

export default function FluentHotTable() {
  const [themeProps, setThemeProps] = useState<HotThemeProps | null>(null);

  useEffect(() => {
    let cancelled = false;
    buildHotThemeProps().then((props) => {
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
    <HotTable
      {...themeProps}
      data={data}
      colHeaders={['Team', 'Owner', 'Status', 'Priority']}
      rowHeaders={true}
      width="100%"
      height="auto"
      dropdownMenu={true}
      filters={true}
      licenseKey="non-commercial-and-evaluation"
    >
      <HotColumn data="team" width={180} />
      <HotColumn data="owner" width={140} />
      <HotColumn data="status" width={160} />
      <HotColumn data="priority" width={140} />
    </HotTable>
  );
}
