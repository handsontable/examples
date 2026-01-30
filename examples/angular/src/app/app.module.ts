import { NgModule, CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { HotTableModule } from '@handsontable/angular-wrapper';
import { DataGridComponent } from '../data-grid/data-grid.component';

@NgModule({
  declarations: [DataGridComponent],
  imports: [BrowserModule, HotTableModule],
  bootstrap: [DataGridComponent],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
})
export class AppModule {}
