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

/**
 * Converts Handsontable's DataProviderQueryParameters into a query string
 * that NestJS can parse with @Query() + class-transformer.
 *
 * NestJS expects nested objects as bracket notation:
 *   sort[column]=status&sort[order]=asc
 *   filters[0][prop]=status&filters[0][condition]=eq&filters[0][value][0]=open
 */
function buildUrl(base: string, params: DataProviderQueryParameters): string {
  const query = new URLSearchParams();

  query.set('page', String(params.page));
  query.set('pageSize', String(params.pageSize));

  if (params.sort?.prop) {
    query.set('sort[column]', params.sort.prop);
    query.set('sort[order]', params.sort.order);
  }

  if (params.filters?.length) {
    let idx = 0;
    params.filters.forEach(({ prop, conditions }) => {
      (conditions || []).forEach(({ name, args }) => {
        if (!name) return;
        query.set(`filters[${idx}][prop]`, prop);
        query.set(`filters[${idx}][condition]`, name);
        (args || []).forEach((v, j) => {
          query.set(`filters[${idx}][value][${j}]`, String(v));
        });
        idx++;
      });
    });
  }

  return `${base}?${query.toString()}`;
}

export default function App() {
  const hotRef = useRef<HotTableRef>(null);
  const removeConfirmedRef = useRef(false);
  const statusRef = useRef<HTMLSpanElement>(null);

  const settings = useMemo(() => ({
    dataProvider: {
      rowId: 'id',

      // Called on every page change, sort, and filter.
      fetchRows: async (params: DataProviderQueryParameters, { signal }: { signal: AbortSignal }) => {
        const url = buildUrl('/tickets', params);
        const res = await fetch(url, { signal });

        if (!res.ok) throw new Error(`Server error ${res.status}`);

        return res.json();
      },

      // Fires when the user inserts rows via the context menu.
      onRowsCreate: async (payload: RowsCreatePayload) => {
        const newRows = Array.from({ length: payload.rowsAmount }, () => ({
          subject: 'New ticket',
          status: 'open',
          priority: 'medium',
          assignee: '',
          createdAt: new Date().toISOString().slice(0, 10),
        }));

        const res = await fetch('/tickets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(newRows),
        });

        if (!res.ok) throw new Error(`Create failed: ${res.status}`);

        const data = await res.json();
        const info = data.map((r: { id: string }) => `(id: ${r.id})`).join(', ');
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
      // Sends only changed fields alongside the row id.
      onRowsUpdate: async (rows: RowUpdatePayload[]) => {
        const res = await fetch('/tickets', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          body: JSON.stringify(rows.map((row: any) => ({ id: row.id, ...row.changes }))),
        });

        if (!res.ok) throw new Error(`Update failed: ${res.status}`);
      },

      // Fires after the user confirms deletion.
      onRowsRemove: async (rowIds: unknown[]) => {
        const res = await fetch('/tickets', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(rowIds),
        });

        if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (hotRef.current!.hotInstance!.getPlugin('notification') as any).showMessage({
          variant: 'success',
          title: 'Rows deleted',
          message: `Deleted ${rowIds.length} row${rowIds.length !== 1 ? 's' : ''}`,
          duration: 3000,
        });
      },
    },

    // beforeRowsMutation is sync — show confirmation dialog, cancel original,
    // re-issue after user confirms.
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

    // Updates the status label after every fetch (direct DOM, no re-render).
    afterDataProviderFetch: (result: { totalRows: number }) => {
      if (statusRef.current) {
        statusRef.current.textContent = `${result.totalRows} tickets total`;
      }
    },

    pagination: { pageSize: 5 },
    columnSorting: true,
    filters: true,
    dropdownMenu: true,
    contextMenu: true,
    emptyDataState: true,
    notification: true,

    colHeaders: ['ID', 'Subject', 'Status', 'Priority', 'Assignee', 'Created'],
    columns: [
      { data: 'id',        type: 'text',     readOnly: true, width: 80 },
      { data: 'subject',   type: 'text',     width: 300 },
      {
        data: 'status',
        type: 'dropdown',
        source: ['open', 'in-progress', 'resolved', 'closed'],
        width: 120,
      },
      {
        data: 'priority',
        type: 'dropdown',
        source: ['low', 'medium', 'high', 'critical'],
        width: 100,
      },
      { data: 'assignee',  type: 'text',     width: 150 },
      {
        data: 'createdAt',
        type: 'date',
        dateFormat: { year: 'numeric', month: '2-digit', day: '2-digit' },
        width: 120,
      },
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
        <h1>Support Tickets — Handsontable + NestJS + React</h1>
        <p>Server-side pagination, sorting, and filtering via NestJS · right-click a row for more CRUD actions</p>
        <span id="status-label" ref={statusRef}></span>
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
