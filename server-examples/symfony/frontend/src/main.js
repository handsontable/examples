import Handsontable from 'handsontable/base';
import { registerAllModules } from 'handsontable/registry';

registerAllModules();

// Serializes fetchRows query parameters into a URL query string that Symfony
// reads via $request->query->all().
//
// Handsontable sends:
//   sort:    { prop: 'name', order: 'asc' }  or  null
//   filters: [{ prop: 'price', condition: { name: 'gt', args: [100] } }]  or  null
//
// Symfony reads:
//   sort[prop], sort[order]
//   filters[0][prop], filters[0][condition], filters[0][value], filters[0][value2]
function buildUrl(base, { page, pageSize, sort, filters }) {
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
  });

  if (sort) {
    params.set('sort[prop]', sort.prop);
    params.set('sort[order]', sort.order);
  }

  if (filters) {
    filters.forEach((filter, i) => {
      params.set(`filters[${i}][prop]`, filter.prop);
      params.set(`filters[${i}][condition]`, filter.condition.name);
      const args = filter.condition.args ?? [];
      if (args[0] != null) params.set(`filters[${i}][value]`, String(args[0]));
      if (args[1] != null) params.set(`filters[${i}][value2]`, String(args[1]));
    });
  }

  return `${base}?${params}`;
}

const container = document.querySelector('#example1');

let removeConfirmed = false;

const hot = new Handsontable(container, {
  dataProvider: {
    // rowId must match the primary key returned by the Symfony controller.
    rowId: 'id',

    // Called on every page change, sort, and filter.
    fetchRows: async ({ page, pageSize, sort, filters }, { signal }) => {
      const url = buildUrl('/api/products', { page, pageSize, sort, filters });
      const res = await fetch(url, { signal });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const json = await res.json();
      return { rows: json.data, totalRows: json.total };
    },

    // Fires when the user inserts rows via the context menu.
    // payload: { position: 'above'|'below', referenceRowId, rowsAmount }
    onRowsCreate: async (payload) => {
      const res = await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },

    // Fires after a cell edit, paste, or autofill batch.
    // rows: [{ id, changes: { price: 149.99 }, rowData: {...} }, ...]
    onRowsUpdate: async (rows) => {
      const res = await fetch('/api/products', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rows),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },

    // Fires after the user confirms deletion.
    // rowIds: [4, 7, 12]
    onRowsRemove: async (rowIds) => {
      const res = await fetch('/api/products', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rowIds),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
  },

  // beforeRowsMutation is sync (checks for a strict `=== false` return), so
  // we can't await an async prompt inline. Instead: cancel the original
  // attempt, show a notification with Delete/Cancel actions, and on Delete
  // re-issue the remove via the DataProvider API. The flag lets the second
  // pass through without re-prompting.
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

  pagination: { pageSize: 10 },
  columnSorting: true,
  filters: true,
  dropdownMenu: true,
  contextMenu: true,
  emptyDataState: true,
  notification: true,

  width: '100%',
  height: 'auto',
  rowHeaders: true,
  colHeaders: ['Name', 'SKU', 'Category', 'Price', 'Stock'],
  columns: [
    { data: 'name', type: 'text' },
    { data: 'sku', type: 'text', readOnly: true },
    {
      data: 'category',
      type: 'dropdown',
      source: ['Electronics', 'Accessories', 'Storage', 'Networking', 'Peripherals'],
    },
    { data: 'price', type: 'numeric', numericFormat: { pattern: '$0,0.00' } },
    { data: 'stock', type: 'numeric' },
  ],
  licenseKey: 'non-commercial-and-evaluation',
});

export default hot;
