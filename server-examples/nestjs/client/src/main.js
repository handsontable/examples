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

  if (params.sort) {
    query.set('sort[column]', params.sort.column);
    query.set('sort[order]', params.sort.order);
  }

  if (params.filters && params.filters.length > 0) {
    params.filters.forEach((filter, i) => {
      query.set(`filters[${i}][prop]`, filter.prop);
      query.set(`filters[${i}][condition]`, filter.condition);
      filter.value.forEach((v, j) => {
        query.set(`filters[${i}][value][${j}]`, String(v));
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

const hot = new Handsontable(container, {
  dataProvider: {
    rowId: 'id',

    fetchRows: async (params, { signal }) => {
      const url = buildUrl('http://localhost:3000/tickets', params);
      const res = await fetch(url, { signal });

      if (!res.ok) throw new Error(`Server error ${res.status}`);

      return res.json();
    },

    onRowsCreate: async (payload) => {
      const res = await fetch('http://localhost:3000/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) throw new Error(`Create failed: ${res.status}`);

      return res.json();
    },

    onRowsUpdate: async (rows) => {
      const res = await fetch('http://localhost:3000/tickets', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rows.map(({ id, changes }) => ({ id, ...changes }))),
      });

      if (!res.ok) throw new Error(`Update failed: ${res.status}`);
    },

    onRowsRemove: async (rowIds) => {
      const res = await fetch('http://localhost:3000/tickets', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rowIds),
      });

      if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
    },
  },

  pagination: { pageSize: 5 },

  columnSorting: true,
  filters: true,
  dropdownMenu: true,

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
