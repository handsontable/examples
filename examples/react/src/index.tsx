import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import Handsontable from 'handsontable';
import { HotTable, HotColumn } from '@handsontable/react-wrapper';
import { data } from './constants';

import { addClassesToRows, alignHeaders } from './hooksCallbacks';

import 'handsontable/styles/handsontable.min.css';
import 'handsontable/styles/ht-theme-main.min.css';

const App = () => {
  return (
    <HotTable
      data={data}
      height={450}
      colWidths={[170, 222, 130, 120, 120, 130, 156]}
      colHeaders={[
        'Company name',
        'Name',
        'Sell date',
        'In stock',
        'Qty',
        'Order ID',
        'Country',
      ]}
      dropdownMenu={true}
      hiddenColumns={{
        indicators: true,
      }}
      contextMenu={true}
      multiColumnSorting={true}
      filters={true}
      rowHeaders={true}
      afterGetColHeader={alignHeaders}
      beforeRenderer={addClassesToRows}
      manualRowMove={true}
      autoWrapRow={true}
      navigableHeaders={true}
      themeName="ht-theme-main"
      licenseKey="non-commercial-and-evaluation"
    >
      <HotColumn data={1} />
      <HotColumn data={3} />
      <HotColumn data={4} type="date" allowInvalid={false} />
      <HotColumn data={6} type="checkbox" className="htCenter" />
      <HotColumn data={7} type="numeric" />
      <HotColumn data={5} />
      <HotColumn data={2} />
    </HotTable>
  );
};

const rootElement = document.getElementById('root');

createRoot(rootElement as HTMLElement).render(<App />);

console.log(
  `Handsontable: v${Handsontable.version} (${Handsontable.buildDate}) Wrapper: v${HotTable.version} React: v${React.version}`
);