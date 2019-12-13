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
  width: 600,
  height: 500,
  rowHeaders: true,
  colHeaders: true,
  licenseKey: 'non-commercial-and-evaluation',
});

document.body.append(getDebugInfo());
