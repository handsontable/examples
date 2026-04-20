import Handsontable from 'handsontable/base';
import 'handsontable/styles/handsontable.min.css';
import 'handsontable/styles/ht-theme-main.min.css';

import {
  registerCellType,
  NumericCellType,
  DateCellType,
} from 'handsontable/cellTypes';

import {
  registerPlugin,
  ColumnSorting,
  DataProvider,
  Dialog,
  DropdownMenu,
  EmptyDataState,
  Filters,
  Pagination,
} from 'handsontable/plugins';

registerCellType(NumericCellType);
registerCellType(DateCellType);
registerPlugin(ColumnSorting);
registerPlugin(DataProvider);
registerPlugin(Dialog);
registerPlugin(DropdownMenu);
registerPlugin(EmptyDataState);
registerPlugin(Filters);
registerPlugin(Pagination);

const API_BASE = 'http://localhost:3000/api/orders';

/**
 * Serializes dataProvider query params into a URL the Rails controller understands.
 *
 * Filters arrive from Handsontable as:
 *   [{ prop, operation, conditions: [{ name, args }] }]
 *
 * The Rails controller expects the flat bracket format:
 *   filters[0][prop]=...&filters[0][condition]=...&filters[0][value]=...
 */
function buildUrl(base, { page, pageSize, sort, filters }) {
  const params = new URLSearchParams();

  params.set('page', page);
  params.set('page_size', pageSize);

  if (sort?.prop) {
    params.set('sort_prop', sort.prop);
    params.set('sort_order', sort.order ?? 'asc');
  }

  if (filters?.length) {
    let idx = 0;
    filters.forEach(({ prop, conditions }) => {
      (conditions || []).forEach(({ name, args }) => {
        if (!name) return;
        params.set(`filters[${idx}][prop]`, prop);
        params.set(`filters[${idx}][condition]`, name);
        params.set(`filters[${idx}][value]`, args?.[0] ?? '');
        idx++;
      });
    });
  }

  return `${base}?${params.toString()}`;
}

const container = document.getElementById('app');

new Handsontable(container, {
  dataProvider: {
    rowId: 'id',

    fetchRows: async ({ page, pageSize, sort, filters }, { signal }) => {
      const url = buildUrl(API_BASE, { page, pageSize, sort, filters });
      const res = await fetch(url, { signal });

      if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);

      const json = await res.json();

      return { rows: json.rows, totalRows: json.total_rows };
    },

    onRowsCreate: async (rows) => {
      const res = await fetch(`${API_BASE}/create_rows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Create failed: ${res.status}`);
      }

      const json = await res.json();
      return json.rows;
    },

    onRowsUpdate: async (rows) => {
      const res = await fetch(`${API_BASE}/update_rows`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows: rows.map((r) => ({ id: r.id, changes: r.changes })),
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Update failed: ${res.status}`);
      }
    },

    onRowsRemove: async (rowIds) => {
      const res = await fetch(`${API_BASE}/remove_rows`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ row_ids: rowIds }),
      });

      if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
    },
  },

  pagination:    { pageSize: 10 },
  columnSorting: true,
  filters:       true,
  dropdownMenu:  ['filter_by_condition', 'filter_action_bar'],
  emptyDataState: true,
  dialog:        true,

  colHeaders: ['Order #', 'Customer', 'Status', 'Total', 'Created'],
  columns: [
    { data: 'order_number', type: 'text' },
    { data: 'customer',     type: 'text' },
    { data: 'status',       type: 'text' },
    { data: 'total',        type: 'numeric', numericFormat: { pattern: '$0,0.00' } },
    { data: 'created_at',  type: 'date', dateFormat: 'YYYY-MM-DD', readOnly: true },
  ],

  rowHeaders:  true,
  height:      'auto',
  licenseKey:  'non-commercial-and-evaluation',
});
