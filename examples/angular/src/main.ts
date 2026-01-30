import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { DataGridComponent } from './app/data-grid.component';

bootstrapApplication(DataGridComponent, appConfig).catch((err) =>
  console.error(err)
);
