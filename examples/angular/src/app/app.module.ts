import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { HotTableModule } from '@handsontable/angular-wrapper';
import { DataGridComponent } from '../data-grid/data-grid.component';

@NgModule({
  declarations: [],
  imports: [BrowserModule, HotTableModule, DataGridComponent],
  providers: [],
  bootstrap: [DataGridComponent],
})
export class AppModule {}
