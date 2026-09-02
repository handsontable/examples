import { useRef, useMemo } from 'react';
import {
  HotTable,
  type HotTableProps,
  type HotTableRef,
} from '@handsontable/react-wrapper';
import { registerAllModules } from 'handsontable/registry';
import type {
  DataProviderQueryParameters,
  RowsCreatePayload,
  RowUpdatePayload,
  RowMutationPayload,
  RowMutationRemovePayload,
} from 'handsontable/plugins/dataProvider';
import './styles.css';

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

export default function App() {
  const hotRef = useRef<HotTableRef>(null);
  const removeConfirmedRef = useRef(false);

  const settings = useMemo<HotTableProps>(() => ({
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
        (hotRef.current!.hotInstance!.getPlugin('notification') as any).showMessage({
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
        (hotRef.current!.hotInstance!.getPlugin('notification') as any).showMessage({
          variant: 'success',
          title: 'Rows deleted',
          message: `Deleted ${rowIds.length} row${rowIds.length !== 1 ? 's' : ''}`,
          duration: 3000,
        });
      },
    },

    // `operation` is typed `string` to match Handsontable's hook signature —
    // narrowing it to the union it actually carries ('create' | 'update' |
    // 'remove') is rejected contravariantly under strictFunctionTypes.
    beforeRowsMutation: (operation: string, payload: RowMutationPayload): false | void => {
      if (operation === 'remove' && !removeConfirmedRef.current) {
        const { rowsRemove } = payload as RowMutationRemovePayload;
        const hot = hotRef.current!.hotInstance!;
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
                removeConfirmedRef.current = true;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (hot.getPlugin('dataProvider') as any)
                  .removeRows(rowsRemove)
                  .finally(() => {
                    removeConfirmedRef.current = false;
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
    dropdownMenu: ['filter_by_condition', 'filter_action_bar'],
    contextMenu: true,
    emptyDataState: true,
    notification: true,

    colHeaders: ['First Name', 'Last Name', 'Department', 'Role', 'Salary'],
    columns: [
      { data: 'first_name', type: 'text' },
      { data: 'last_name',  type: 'text' },
      { data: 'department', type: 'text' },
      { data: 'role',       type: 'text' },
      {
        data: 'salary',
        type: 'numeric',
        numericFormat: { style: 'currency', currency: 'USD', maximumFractionDigits: 0 },
      },
    ],

    rowHeaders: true,
    height: 500,
    width: '100%',
    autoWrapRow: true,
    licenseKey: 'non-commercial-and-evaluation',
  }), []);

  return (
    <>
      <header>
        <h1>Employee Directory — Handsontable + Django + React</h1>
        <p>Server-side pagination, sorting, and filtering via Django REST Framework · right-click a row for more CRUD actions</p>
      </header>

      <nav>
        <a href="/">JS</a>
        <a href="/angular.html">Angular</a>
        <a href="/react.html" className="active">React</a>
      </nav>

      <div id="example1">
        {/* React wrapper spreads settings as individual props, not a 'settings' object */}
        <HotTable ref={hotRef} {...settings} />
      </div>
    </>
  );
}
