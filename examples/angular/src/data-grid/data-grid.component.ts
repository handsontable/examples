import {
  Component,
  ViewEncapsulation,
  CUSTOM_ELEMENTS_SCHEMA,
} from '@angular/core';
import { PredefinedMenuItemKey } from 'handsontable/plugins/contextMenu';
import { HotTableModule } from '@handsontable/angular-wrapper';

import { getData } from './utils/constants';
import { alignHeaders, addClassesToRows } from './utils/hooks-callbacks';

@Component({
  encapsulation: ViewEncapsulation.None,
  selector: 'data-grid',
  templateUrl: './data-grid.component.html',
  styleUrls: ['./data-grid.scss'],
  imports: [HotTableModule],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
})
export class DataGridComponent {
  initialData = getData();
  gridSettings = {
    height: 450,
    colWidths: [180, 220, 140, 120, 120, 120, 140],
    colHeaders: [
      'Company Name',
      'Name',
      'Sell date',
      'In stock',
      'Quantity',
      'Order ID',
      'Country',
    ],
    contextMenu: [
      'cut',
      'copy',
      '---------',
      'row_above',
      'row_below',
      'remove_row',
      '---------',
      'alignment',
      'make_read_only',
      'clear_column',
    ] as PredefinedMenuItemKey[],
    dropdownMenu: true,
    hiddenColumns: {
      indicators: true,
    },
    multiColumnSorting: true,
    filters: true,
    rowHeaders: true,
    headerClassName: 'htLeft',
    beforeRenderer: addClassesToRows,
    manualRowMove: true,
    autoWrapRow: true,
    autoWrapCol: true,
    autoRowSize: true,
    manualRowResize: true,
    manualColumnResize: true,
    navigableHeaders: true,
    imeFastEdit: true,
    columns: [
      { data: 1 },
      { data: 3 },
      { data: 4, type: 'date', allowInvalid: false },
      { data: 6, type: 'checkbox', className: 'htCenter' },
      { data: 7, type: 'numeric' },
      { data: 5 },
      { data: 2 },
    ],
    themeName: 'ht-theme-main',
    licenseKey: 'non-commercial-and-evaluation',
  };
}
