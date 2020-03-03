import { Component, VERSION as AngularVersion } from '@angular/core';
import { HotTableModule } from '@handsontable/angular';
import Handsontable from 'handsontable';
import '../../node_modules/handsontable/dist/handsontable.full.css';

const data = Handsontable.helper.createSpreadsheetData(50, 25);

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent {
  public settings: Handsontable.GridSettings = {
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
    manualRowMove: true,
    dropdownMenu: true,
    filters: true,
    columnSorting: true,
    comments: true,
    licenseKey: 'non-commercial-and-evaluation',
  }

  public getDebugInfo() {
    let debug = 'Handsontable:';
    debug += ` v${Handsontable.version}`;
    debug += ` (${Handsontable.buildDate})`;
    debug += ' Wrapper:';
    debug += ` v${HotTableModule.version}`;
    debug += ' Angular:';
    debug += ` v${AngularVersion.full}`;
    return debug;
  }
}
