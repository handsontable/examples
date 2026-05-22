import { useRef, useMemo } from 'react';
import { HotTable, HotTableRef } from '@handsontable/react-wrapper';
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

const API_BASE = '/api/orders';

// Rails reads flat params (page_size, sort_prop, sort_order) and bracket-notation
// filters (filters[0][prop], filters[0][condition], filters[0][value]).
function buildUrl(params: DataProviderQueryParameters): string {
  const query = new URLSearchParams({
    page: String(params.page),
    page_size: String(params.pageSize),
  });

  if (params.sort?.prop) {
    query.set('sort_prop', params.sort.prop);
    query.set('sort_order', params.sort.order ?? 'asc');
  }

  if (params.filters?.length) {
    let idx = 0;
    params.filters.forEach(({ prop, conditions }) => {
      (conditions || []).forEach(({ name, args }) => {
        if (!name) return;
        query.set(`filters[${idx}][prop]`, prop);
        query.set(`filters[${idx}][condition]`, name);
        query.set(`filters[${idx}][value]`, args?.[0] != null ? String(args[0]) : '');
        idx++;
      });
    });
  }

  return `${API_BASE}?${query.toString()}`;
}

export default function App() {
  const hotRef = useRef<HotTableRef>(null);
  const removeConfirmedRef = useRef(false);

  const settings = useMemo(() => ({
    dataProvider: {
      rowId: 'id',

      // Called on every page change, sort, and filter.
      fetchRows: async (queryParameters: DataProviderQueryParameters, { signal }: { signal: AbortSignal }) => {
        const url = buildUrl(queryParameters);
        const res = await fetch(url, { signal });

        if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);

        const json = await res.json();
        return { rows: json.rows, totalRows: json.total_rows };
      },

      // Fires when the user inserts rows via the context menu.
      onRowsCreate: async (payload: RowsCreatePayload) => {
        const newRows = Array.from({ length: payload.rowsAmount }, () => ({
          order_number: `ORD-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
          customer: 'New Customer',
          status: 'pending',
          total: 0,
        }));

        const res = await fetch(`${API_BASE}/create_rows`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rows: newRows }),
        });

        if (!res.ok) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const err = await res.json().catch(() => ({}) as any);
          throw new Error(err.error || `Create failed: ${res.status}`);
        }

        const json = await res.json();
        const info = json.rows
          .map((r: { order_number: string }) => `(order: ${r.order_number})`)
          .join(', ');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (hotRef.current!.hotInstance!.getPlugin('notification') as any).showMessage({
          variant: 'success',
          title: 'Row added',
          message: `Created: ${info}`,
          duration: 3000,
        });
        return json.rows;
      },

      // Fires after a cell edit, paste, or autofill batch.
      onRowsUpdate: async (rows: RowUpdatePayload[]) => {
        const res = await fetch(`${API_BASE}/update_rows`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            rows: rows.map(r => ({ id: r.id, changes: r.changes })),
          }),
        });

        if (!res.ok) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const err = await res.json().catch(() => ({}) as any);
          throw new Error(err.error || `Update failed: ${res.status}`);
        }
      },

      // Fires after the user confirms deletion.
      onRowsRemove: async (rowIds: unknown[]) => {
        const res = await fetch(`${API_BASE}/remove_rows`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ row_ids: rowIds }),
        });

        if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
      },
    },

    beforeRowsMutation: (operation: 'create' | 'update' | 'remove', payload: RowMutationPayload): false | void => {
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dropdownMenu: ['filter_by_condition', 'filter_action_bar'] as any,
    contextMenu: true,
    emptyDataState: true,
    notification: true,
    dialog: true,

    colHeaders: ['Order #', 'Customer', 'Status', 'Total', 'Created'],
    columns: [
      { data: 'order_number', type: 'text' },
      { data: 'customer',     type: 'text' },
      { data: 'status',       type: 'text' },
      { data: 'total',        type: 'numeric', numericFormat: { pattern: '$0,0.00' } },
      { data: 'created_at',   type: 'date', dateFormat: 'YYYY-MM-DD', readOnly: true },
    ],

    rowHeaders: true,
    height: 'auto',
    width: '100%',
    autoWrapRow: true,
    licenseKey: 'non-commercial-and-evaluation',
  }), []);

  return (
    <>
      <header>
        <h1>Order Management — Handsontable + Rails + React</h1>
        <p>Server-side pagination, sorting, and filtering via Rails API · right-click a row for more CRUD actions</p>
      </header>

      <nav>
        <a href="/">JS</a>
        <a href="/angular.html">Angular</a>
        <a href="/react.html" className="active">React</a>
      </nav>

      <div id="example1">
        {/* React wrapper spreads settings as individual props, not a 'settings' object */}
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <HotTable ref={hotRef} {...(settings as any)} />
      </div>
    </>
  );
}
