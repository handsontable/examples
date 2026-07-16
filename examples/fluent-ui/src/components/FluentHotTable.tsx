import { HotTable, HotColumn } from '@handsontable/react-wrapper';
import { registerAllModules } from 'handsontable/registry';
import 'handsontable/styles/handsontable.min.css';
import 'handsontable/styles/ht-theme-horizon.min.css';

import { fluentDataGridTheme } from '../theme/fluentDataGridTheme';

registerAllModules();

const data = [
  { team: 'Design', owner: 'Ava', status: 'In progress', priority: 'High' },
  { team: 'Platform', owner: 'Noah', status: 'Blocked', priority: 'Medium' },
  { team: 'Docs', owner: 'Liam', status: 'Done', priority: 'Low' },
];

export default function FluentHotTable() {
  return (
    <HotTable
      theme={fluentDataGridTheme}
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
