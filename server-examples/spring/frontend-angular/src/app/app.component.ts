import {
  Component,
  ViewChild,
  ViewEncapsulation,
  CUSTOM_ELEMENTS_SCHEMA,
} from '@angular/core';
import {
  HotTableModule,
  HotTableComponent,
  type GridSettings,
} from '@handsontable/angular-wrapper';
import { registerAllModules } from 'handsontable/registry';
import type {
  DataProviderQueryParameters,
  RowsCreatePayload,
  RowUpdatePayload,
  RowMutationPayload,
  RowMutationRemovePayload,
} from 'handsontable/plugins/dataProvider';

registerAllModules();

const API_BASE = '/api/products';

// Spring Boot reads camelCase params (sortProp, sortOrder, pageSize) and a
// simplified JSON filter array: [{ column, value }].
function buildUrl(params: DataProviderQueryParameters): string {
  const query = new URLSearchParams({
    page: String(params.page),
    pageSize: String(params.pageSize),
  });

  if (params.sort?.prop) {
    query.set('sortProp', params.sort.prop);
    query.set('sortOrder', params.sort.order ?? 'asc');
  }

  if (params.filters?.length) {
    query.set(
      'filters',
      JSON.stringify(
        params.filters.map(f => ({
          column: f.prop,
          value: f.conditions?.[0]?.args?.[0] ?? '',
        }))
      )
    );
  }

  return `${API_BASE}?${query.toString()}`;
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

  settings: GridSettings = {
    dataProvider: {
      rowId: 'id',

      // Called on every page change, sort, and filter.
      fetchRows: async (queryParameters: DataProviderQueryParameters, { signal }: { signal: AbortSignal }) => {
        const url = buildUrl(queryParameters);
        const res = await fetch(url, { signal });

        if (!res.ok) throw new Error(`Failed to fetch products: ${res.status}`);

        // Spring Boot controller returns { rows, totalRows } directly.
        const json = await res.json();
        return { rows: json.rows, totalRows: json.totalRows };
      },

      // Fires when the user inserts rows via the context menu.
      // The full RowsCreatePayload ({ position, referenceRowId, rowsAmount })
      // is forwarded as-is to the CreateRowsPayload DTO in ProductController.
      onRowsCreate: async (payload: RowsCreatePayload) => {
        const res = await fetch(`${API_BASE}/create-rows`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (!res.ok) throw new Error(`Failed to create rows: ${res.status}`);

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
        const res = await fetch(`${API_BASE}/update-rows`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(rows),
        });

        if (!res.ok) throw new Error(`Failed to update rows: ${res.status}`);
      },

      // Fires after the user confirms deletion.
      // rowIds: plain array of IDs matching List<Long> in ProductController.
      onRowsRemove: async (rowIds: unknown[]) => {
        const res = await fetch(`${API_BASE}/remove-rows`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(rowIds),
        });

        if (!res.ok) throw new Error(`Failed to remove rows: ${res.status}`);
      },
    },

    // `operation` is typed `string` to match Handsontable's hook signature —
    // narrowing it to the union it actually carries ('create' | 'update' |
    // 'remove') is rejected contravariantly under strictFunctionTypes.
    beforeRowsMutation: (operation: string, payload: RowMutationPayload): false | void => {
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

    columns: [
      { data: 'id',       title: 'ID',       readOnly: true, width: 60 },
      { data: 'name',     title: 'Name',      width: 200 },
      { data: 'sku',      title: 'SKU',       width: 120 },
      { data: 'category', title: 'Category',  width: 130 },
      {
        data: 'price',
        title: 'Price',
        type: 'numeric',
        locale: 'en-US',
        numericFormat: { minimumFractionDigits: 2, maximumFractionDigits: 2 },
        width: 100,
      },
      { data: 'stock', title: 'Stock', type: 'numeric', width: 80 },
    ],

    colHeaders: true,
    rowHeaders: true,
    height: 450,
    width: '100%',
    columnSorting: true,
    filters: true,
    dropdownMenu: true,
    pagination: { pageSize: 10 },
    emptyDataState: true,
    notification: true,
    contextMenu: true,
    licenseKey: 'non-commercial-and-evaluation',
  };
}
