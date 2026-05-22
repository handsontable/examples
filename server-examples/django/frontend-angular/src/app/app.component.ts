import {
  Component,
  ViewChild,
  ViewEncapsulation,
  CUSTOM_ELEMENTS_SCHEMA,
} from '@angular/core';
import { HotTableModule, HotTableComponent } from '@handsontable/angular-wrapper';
import { registerAllModules } from 'handsontable/registry';
import type {
  DataProviderQueryParameters,
  RowsCreatePayload,
  RowUpdatePayload,
  RowMutationPayload,
  RowMutationRemovePayload,
} from 'handsontable/plugins/dataProvider';

registerAllModules();

const API_BASE = '/api/employees/';

// Django REST Framework reads sort as sort[prop]/sort[order] and filters as
// a JSON-encoded array (parsed in views.py with json.loads).
function buildUrl(params: DataProviderQueryParameters): string {
  const query = new URLSearchParams({
    page: String(params.page),
    pageSize: String(params.pageSize),
  });

  if (params.sort?.prop) {
    query.set('sort[prop]', params.sort.prop);
    query.set('sort[order]', params.sort.order ?? 'asc');
  }

  if (params.filters?.length) {
    query.set('filters', JSON.stringify(params.filters));
  }

  return `${API_BASE}?${query.toString()}`;
}

// Django sets the csrftoken cookie on every response; read it and forward it
// as X-CSRFToken on mutating requests.
function getCsrfToken(): string {
  return (
    document.cookie
      .split('; ')
      .find(row => row.startsWith('csrftoken='))
      ?.split('=')[1] ?? ''
  );
}

@Component({
  selector: 'app-root',
  standalone: true,
  encapsulation: ViewEncapsulation.None,
  imports: [HotTableModule],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  templateUrl: './app.component.html',
})
export class AppComponent {
  @ViewChild(HotTableComponent) hotRef!: HotTableComponent;

  private removeConfirmed = false;

  settings = {
    dataProvider: {
      rowId: 'id',

      // Called on every page change, sort, and filter.
      fetchRows: async (queryParameters: DataProviderQueryParameters, { signal }: { signal: AbortSignal }) => {
        const url = buildUrl(queryParameters);
        const res = await fetch(url, { signal });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        // EmployeePagination returns { rows, totalRows } directly.
        return res.json();
      },

      // Fires when the user inserts rows via the context menu.
      onRowsCreate: async (payload: RowsCreatePayload) => {
        const res = await fetch(`${API_BASE}create-rows/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRFToken': getCsrfToken() },
          body: JSON.stringify({ rowsAmount: payload.rowsAmount }),
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();
        const info = data.map((r: { id: number }) => `(id: ${r.id})`).join(', ');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this.hotRef.hotInstance!.getPlugin('notification') as any).showMessage({
          variant: 'success',
          title: 'Row added',
          message: `Created: ${info}`,
          duration: 3000,
        });
        return data;
      },

      // Fires after a cell edit, paste, or autofill batch.
      onRowsUpdate: async (rows: RowUpdatePayload[]) => {
        const res = await fetch(`${API_BASE}update-rows/`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'X-CSRFToken': getCsrfToken() },
          body: JSON.stringify(rows),
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      },

      // Fires after the user confirms deletion.
      onRowsRemove: async (rowIds: unknown[]) => {
        const res = await fetch(`${API_BASE}remove-rows/`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json', 'X-CSRFToken': getCsrfToken() },
          body: JSON.stringify(rowIds),
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this.hotRef.hotInstance!.getPlugin('notification') as any).showMessage({
          variant: 'success',
          title: 'Rows deleted',
          message: `Deleted ${rowIds.length} row${rowIds.length !== 1 ? 's' : ''}`,
          duration: 3000,
        });
      },
    },

    beforeRowsMutation: (operation: 'create' | 'update' | 'remove', payload: RowMutationPayload): false | void => {
      if (operation === 'remove' && !this.removeConfirmed) {
        const { rowsRemove } = payload as RowMutationRemovePayload;
        const hot = this.hotRef.hotInstance!;
        const count = rowsRemove.length;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const notification = (hot.getPlugin('notification') as any);
        const id = notification.showMessage({
          variant: 'warning',
          title: 'Delete rows',
          message: `Delete ${count} row${count !== 1 ? 's' : ''}? This cannot be undone.`,
          duration: 0,
          actions: [
            {
              label: 'Delete',
              type: 'primary',
              callback: () => {
                notification.hide(id);
                this.removeConfirmed = true;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (hot.getPlugin('dataProvider') as any)
                  .removeRows(rowsRemove)
                  .finally(() => {
                    this.removeConfirmed = false;
                  });
              },
            },
            {
              label: 'Cancel',
              type: 'secondary',
              callback: () => notification.hide(id),
            },
          ],
        });
        return false;
      }
    },

    pagination: { pageSize: 10 },
    columnSorting: true,
    filters: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dropdownMenu: ['filter_by_condition', 'filter_action_bar'] as any,
    contextMenu: true,
    emptyDataState: true,
    notification: true,

    colHeaders: ['First Name', 'Last Name', 'Department', 'Role', 'Salary'],
    columns: [
      { data: 'first_name', type: 'text' },
      { data: 'last_name',  type: 'text' },
      { data: 'department', type: 'text' },
      { data: 'role',       type: 'text' },
      { data: 'salary',     type: 'numeric', numericFormat: { pattern: '$0,0' } },
    ],

    rowHeaders: true,
    height: 500,
    width: '100%',
    autoWrapRow: true,
    licenseKey: 'non-commercial-and-evaluation',
  };
}
