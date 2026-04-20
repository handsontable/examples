import Handsontable from 'handsontable/base';
import 'handsontable/styles/handsontable.min.css';
import 'handsontable/styles/ht-theme-main.min.css';

import {
  registerPlugin,
  DataProvider,
  DropdownMenu,
  Filters,
  ColumnSorting,
  Pagination,
  EmptyDataState,
  ContextMenu,
} from 'handsontable/plugins';

import {
  registerCellType,
  NumericCellType,
  TextCellType,
} from 'handsontable/cellTypes';

registerPlugin(DataProvider);
registerPlugin(DropdownMenu);
registerPlugin(Filters);
registerPlugin(ColumnSorting);
registerPlugin(Pagination);
registerPlugin(EmptyDataState);
registerPlugin(ContextMenu);

registerCellType(NumericCellType);
registerCellType(TextCellType);

// ---------------------------------------------------------------------------
// CSRF: Django sets a csrftoken cookie on every response.
// Read it and send it as X-CSRFToken on mutating requests.
// With the Vite proxy in vite.config.js, /api/* is forwarded to Django on
// the same origin, so the cookie is accessible without any special CORS config.
// ---------------------------------------------------------------------------
function getCsrfToken() {
  return document.cookie
    .split('; ')
    .find((row) => row.startsWith('csrftoken='))
    ?.split('=')[1];
}

// ---------------------------------------------------------------------------
// Build the URL for fetchRows.
//
// dataProvider calls fetchRows with:
//   { page, pageSize, sort, filters }
//
// sort   → { prop: string, order: 'asc'|'desc' } | null
// filters → DataProviderFilterColumn[] | null
//           [{ prop, operation, conditions: [{ name, args }] }]
//
// Vite proxies /api/* → http://localhost:8000, so we use a relative URL.
// ---------------------------------------------------------------------------
const API_BASE = '/api/employees/';

function buildUrl({ page, pageSize, sort, filters }) {
  const params = new URLSearchParams();

  params.set('page', page);
  params.set('pageSize', pageSize);

  if (sort?.prop) {
    params.set('sort[prop]', sort.prop);
    params.set('sort[order]', sort.order ?? 'asc');
  }

  // Pass the full filter payload as JSON so Django can parse the nested structure.
  if (filters?.length) {
    params.set('filters', JSON.stringify(filters));
  }

  return `${API_BASE}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Initialize Handsontable with the dataProvider plugin.
// ---------------------------------------------------------------------------
const container = document.querySelector('#example1');

const hot = new Handsontable(container, {
  themeName: 'ht-theme-main',

  dataProvider: {
    // rowId tells dataProvider which field uniquely identifies each row.
    // Django's auto-increment primary key is used here.
    rowId: 'id',

    // Called on mount and whenever page, sort, or filters change.
    fetchRows: async ({ page, pageSize, sort, filters }, { signal }) => {
      const url = buildUrl({ page, pageSize, sort, filters });
      const res = await fetch(url, { signal });

      if (!res.ok) {
        throw new Error(`Fetch failed: ${res.status}`);
      }

      // pagination.py maps { count, results } → { rows, totalRows }, so we
      // can return the JSON directly without any client-side transformation.
      return res.json();
    },

    // Called when the user adds new rows via the context menu.
    // rows is an array of objects without ids.
    onRowsCreate: async (rows) => {
      const res = await fetch(`${API_BASE}create-rows/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRFToken': getCsrfToken(),
        },
        body: JSON.stringify(rows),
      });

      if (!res.ok) {
        throw new Error(`Create failed: ${res.status}`);
      }

      // Return the created rows so dataProvider updates its row map with
      // the server-assigned ids.
      return res.json();
    },

    // Called when the user edits cells.
    // rows is an array of partial objects: { id, ...changedFields }.
    onRowsUpdate: async (rows) => {
      const res = await fetch(`${API_BASE}update-rows/`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRFToken': getCsrfToken(),
        },
        body: JSON.stringify(rows),
      });

      if (!res.ok) {
        throw new Error(`Update failed: ${res.status}`);
      }
    },

    // Called when the user deletes rows.
    // rowIds is an array of id values.
    onRowsRemove: async (rowIds) => {
      const res = await fetch(`${API_BASE}remove-rows/`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRFToken': getCsrfToken(),
        },
        body: JSON.stringify(rowIds),
      });

      if (!res.ok) {
        throw new Error(`Delete failed: ${res.status}`);
      }
    },
  },

  // Show 10 rows per page; users can change this via the pagination UI.
  pagination: { pageSize: 10 },

  // Server-side single-column sort. dataProvider passes { prop, order } to fetchRows.
  columnSorting: true,

  // Server-side column filters. dataProvider passes the conditions array to fetchRows.
  filters: true,
  dropdownMenu: ['filter_by_condition', 'filter_action_bar'],

  // Show an illustration when fetchRows returns zero rows (e.g. filter matches nothing).
  emptyDataState: true,

  contextMenu: true,

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
});

export { hot };
