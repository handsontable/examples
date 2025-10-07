import Handsontable from 'handsontable/base';
import 'handsontable/styles/handsontable.min.css';
import 'handsontable/styles/ht-theme-main.min.css';

import { generateExampleData, isArabicDemoEnabled } from './src/utils';
import './src/styles.css';
import { registerLanguageDictionary, arAR } from 'handsontable/i18n';

// choose cell types you want to use and import them
import {
  registerCellType,
  CheckboxCellType,
  DateCellType,
  DropdownCellType,
  NumericCellType,
} from 'handsontable/cellTypes';

import {
  registerPlugin,
  AutoColumnSize,
  ContextMenu,
  CopyPaste,
  DropdownMenu,
  Filters,
  HiddenColumns,
  HiddenRows,
  ManualRowMove,
  MultiColumnSorting,
  UndoRedo,
} from 'handsontable/plugins';

// Import and register the Comments plugin
import { Comments } from 'handsontable/plugins/comments';
registerPlugin(Comments);

// register imported cell types and plugins
registerPlugin(AutoColumnSize);
registerPlugin(ContextMenu);
registerPlugin(CopyPaste);
registerPlugin(DropdownMenu);
registerPlugin(Filters);
registerPlugin(HiddenColumns);
registerPlugin(HiddenRows);
registerPlugin(ManualRowMove);
registerPlugin(MultiColumnSorting);
registerPlugin(UndoRedo);

// register imported cell types and plugins
registerCellType(DateCellType);
registerCellType(DropdownCellType);
registerCellType(CheckboxCellType);
registerCellType(NumericCellType);

registerLanguageDictionary(arAR);

import { alignHeaders, addClassesToRows } from './src/hooksCallbacks';

const example = document.getElementById('example');

new Handsontable(example, {
  data: generateExampleData(),
  themeName: 'ht-theme-main',
  layoutDirection: isArabicDemoEnabled() ? 'rtl' : 'ltr',
  language: isArabicDemoEnabled() ? arAR.languageCode : 'en-US',
  height: 248,
  width: 587,
  comments: true,
  colWidths: 150,
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
      dateFormat: isArabicDemoEnabled() ? 'M/D/YYYY' : 'DD/MM/YYYY',
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
  cell: [{ row: 1, col: 1, comment: { value: 'Some cool comment here' } }],
  dropdownMenu: true,
  hiddenColumns: {
    indicators: true,
  },
  contextMenu: true,
  multiColumnSorting: true,
  filters: true,
  rowHeaders: true,
  manualRowMove: true,
  navigableHeaders: true,
  autoWrapCol: true,
  afterGetColHeader: alignHeaders,
  beforeRenderer: addClassesToRows,
  licenseKey: 'non-commercial-and-evaluation',
});

console.log(
  `Handsontable: v${Handsontable.version} (${Handsontable.buildDate})`
);
