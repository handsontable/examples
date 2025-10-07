import Handsontable from 'handsontable';
import 'handsontable/styles/handsontable.min.css';
import 'handsontable/styles/ht-theme-main.min.css';

import { data } from './src/constants';

import { alignHeaders, addClassesToRows } from './src/hooksCallbacks';

const example = document.getElementById('example1');
if (example) {
  new Handsontable(example, {
    data,
    height: 450,
    colWidths: [170, 222, 130, 120, 120, 130, 156],
    colHeaders: [
      'Company name',
      'Name',
      'Sell date',
      'In stock',
      'Qty',
      'Order ID',
      'Country',
    ],
    columns: [
      { data: 1, type: 'text' },
      { data: 3, type: 'text' },
      {
        data: 4,
        type: 'date',
        allowInvalid: false,
      },
      {
        data: 6,
        type: 'checkbox',
        className: 'htCenter',
      },
      {
        data: 7,
        type: 'numeric',
      },
      { data: 5, type: 'text' },
      { data: 2, type: 'text' },
    ],
    autoWrapRow: true,
    dropdownMenu: true,
    hiddenColumns: {
      indicators: true,
    },
    contextMenu: true,
    multiColumnSorting: true,
    filters: true,
    rowHeaders: true,
    afterGetColHeader: alignHeaders,
    beforeRenderer: addClassesToRows,
    themeName: 'ht-theme-main',
    licenseKey: 'non-commercial-and-evaluation',
  });

  console.log(
    `Handsontable: v${Handsontable.version} (${Handsontable.buildDate})`
  );
} else {
  console.error("Element with ID 'example1' not found.");
}
