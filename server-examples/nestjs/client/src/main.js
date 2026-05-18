import Handsontable from 'handsontable/base';
import { registerAllModules } from 'handsontable/registry';

registerAllModules();

// ---------------------------------------------------------------------------
// URL builder
// ---------------------------------------------------------------------------

/**
 * Converts Handsontable's DataProviderQueryParameters into a query string
 * that NestJS can parse with @Query() + class-transformer.
 *
 * NestJS expects nested objects as bracket notation:
 *   sort[column]=status&sort[order]=asc
 *   filters[0][prop]=status&filters[0][condition]=eq&filters[0][value][0]=open
 */
function buildUrl(base, params) {
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

// ---------------------------------------------------------------------------
// Handsontable configuration
// ---------------------------------------------------------------------------

const container = document.querySelector('#example1');
const statusLabel = document.querySelector('#status-label');

let removeConfirmed = false;

const hot = new Handsontable(container, {
  dataProvider: {
    rowId: 'id',

    fetchRows: async (params, { signal }) => {
      const url = buildUrl('/tickets', params);
      const res = await fetch(url, { signal });

      if (!res.ok) throw new Error(`Server error ${res.status}`);

      return res.json();
    },

    onRowsCreate: async ({ rowsAmount }) => {
      const newRows = Array.from({ length: rowsAmount }, () => ({
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
      const info = data.map(r => `(id: ${r.id})`).join(', ');
      hot.getPlugin('notification').showMessage({
        variant: 'success',
        title: 'Row added',
        message: `Created: ${info}`,
        duration: 3000,
      });
      return data;
    },

    onRowsUpdate: async (rows) => {
      const res = await fetch('/tickets', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rows.map(({ id, changes }) => ({ id, ...changes }))),
      });

      if (!res.ok) throw new Error(`Update failed: ${res.status}`);
    },

    onRowsRemove: async (rowIds) => {
      const res = await fetch('/tickets', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rowIds),
      });

      if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
      hot.getPlugin('notification').showMessage({
        variant: 'success',
        title: 'Rows deleted',
        message: `Deleted ${rowIds.length} row${rowIds.length !== 1 ? 's' : ''}`,
        duration: 3000,
      });
    },
  },

  beforeRowsMutation(operation, payload) {
    if (operation === 'remove' && !removeConfirmed) {
      const count = payload.rowsRemove.length;
      const notification = hot.getPlugin('notification');
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
              removeConfirmed = true;
              hot.getPlugin('dataProvider').removeRows(payload.rowsRemove).finally(() => {
                removeConfirmed = false;
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
    { data: 'createdAt', type: 'date',     dateFormat: 'YYYY-MM-DD', width: 120 },
  ],

  rowHeaders: true,
  height: 'auto',
  width: '100%',
  autoWrapRow: true,
  licenseKey: 'non-commercial-and-evaluation',

  afterDataProviderFetch(result) {
    if (statusLabel) {
      statusLabel.textContent = `${result.totalRows} tickets total`;
    }
  },
});
