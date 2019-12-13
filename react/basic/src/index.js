import '../node_modules/handsontable/dist/handsontable.full.css';
import React from 'react';
import ReactDOM from 'react-dom';
import Handsontable from 'handsontable';
import { HotTable } from '@handsontable/react';

function getDebugInfo() {
  let debug = 'Handsontable:';
  debug += ` v${Handsontable.version}`;
  debug += ` (${Handsontable.buildDate})`;
  debug += ' Wrapper:';
  debug += ` v${HotTable.version}`;
  debug += ' React:';
  debug += ` v${React.version}`;
  return debug;
}

const data = Handsontable.helper.createSpreadsheetData(50, 25);
const settings = {
  colHeaders: true,
  rowHeaders: false,
  width: 600,
  height: 500,
  licenseKey: 'non-commercial-and-evaluation',
};

function App() {
  return <HotTable data={data} settings={settings} />;
}

const rootElement = document.getElementById('app');
ReactDOM.render(
  <div>
    <App />
    {getDebugInfo()}
  </div>,
  rootElement,
);
