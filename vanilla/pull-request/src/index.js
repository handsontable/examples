import '../node_modules/handsontable/dist/handsontable.full.css';
import Handsontable from 'handsontable';

function getDebugInfo() {
  let debug = 'Handsontable:';
  debug += ` ${Handsontable.version}`;
  debug += ` (${Handsontable.buildDate})`;
  return debug;
}

const container = document.getElementById('handsontable');
const data = Handsontable.helper.createSpreadsheetData(50, 25);

const hot = new Handsontable(container, {
  data: data,
  colHeaders: true,
  rowHeaders: true,
  width: 600,
  height: 500,
  contextMenu: true,
  manualColumnFreeze: true,
  fixedRowsTop: 3,
  fixedColumnsLeft: 3,
  fixedRowsBottom: 3,
  manualColumnMove: true,
  manualColumnResize: true,
  manualRowResize: true,
  manualRomMove: true,
  dropdownMenu: true,
  filters: true,
  columnSorting: true,
  comments: true,
  licenseKey: 'non-commercial-and-evaluation',
});

document.body.append(getDebugInfo());
