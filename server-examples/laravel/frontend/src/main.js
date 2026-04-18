import Handsontable from 'handsontable/base';
import { registerAllModules } from 'handsontable/registry';
import 'handsontable/dist/handsontable.full.min.css';

registerAllModules();

// Serializes fetchRows query parameters into a URL query string that Laravel
// reads via request()->input().
//
// Handsontable sends:
//   sort:    { prop: 'name', order: 'asc' }  or  null
//   filters: [{ prop: 'price', condition: { name: 'gt', args: [100] } }]  or  null
//
// Laravel reads:
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

// For Blade-rendered pages, inject via <meta name="csrf-token" content="{{ csrf_token() }}">.
// For this standalone SPA the API routes are stateless so the header is a no-op,
// but it's kept here so the code mirrors the recipe exactly.
function csrfToken() {
  return document.querySelector('meta[name="csrf-token"]')?.content ?? '';
}

const container = document.querySelector('#example1');

const hot = new Handsontable(container, {
  dataProvider: {
    // rowId must match the primary key returned by the Laravel model.
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
        headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrfToken() },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },

    // Fires after a cell edit, paste, or autofill batch.
    // rows: [{ id, changes: { price: 149.99 }, rowData: {...} }, ...]
    onRowsUpdate: async (rows) => {
      const res = await fetch('/api/products', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrfToken() },
        body: JSON.stringify(rows),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },

    // Fires after the user confirms deletion.
    // rowIds: [4, 7, 12]
    onRowsRemove: async (rowIds) => {
      const res = await fetch('/api/products', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrfToken() },
        body: JSON.stringify(rowIds),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
  },

  // Return false to cancel the operation before it reaches the server.
  beforeRowsMutation(operation, payload) {
    if (operation === 'remove') {
      const count = payload.rowsRemove.length;
      // eslint-disable-next-line no-alert
      return window.confirm(`Delete ${count} row${count !== 1 ? 's' : ''}? This cannot be undone.`);
    }
  },

  pagination: { pageSize: 10 },
  columnSorting: true,
  filters: true,
  dropdownMenu: true,
  contextMenu: true,
  emptyDataState: true,
  notification: true,

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
