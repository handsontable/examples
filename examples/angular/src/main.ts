import { enableProdMode, VERSION as AngularVersion } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';

import { DataGridComponent } from './data-grid/data-grid.component';
import { environment } from './environments/environment';

import { HotTableModule } from '@handsontable/angular-wrapper';
import Handsontable from 'handsontable';

if (environment.production) {
  enableProdMode();
}

console.log(
  `Handsontable: v${Handsontable.version} (${Handsontable.buildDate}) Wrapper: v${HotTableModule.version} Angular: v${AngularVersion.full}`
);

bootstrapApplication(DataGridComponent)
  .catch((err) => console.error(err));
