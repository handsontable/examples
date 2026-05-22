import Handsontable from 'handsontable/base';
import { registerAllModules } from 'handsontable/registry';

registerAllModules();

/**
 * Builds a URL with query parameters, skipping undefined and null values.
 *
 * @param {string} base - The base path (e.g. '/api/products').
 * @param {Object} params - Key/value pairs to append as query parameters.
 * @returns {string} The assembled URL string.
 */
function buildUrl(base, params) {
  const url = new URL(base, window.location.origin);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

// Get the DOM element where Handsontable will be rendered.
const container = document.querySelector('#example1');

let removeConfirmed = false;

const hot = new Handsontable(container, {
  // Column definitions map to the fields returned by the Spring Boot API.
  columns: [
    { data: 'id', title: 'ID', readOnly: true, width: 60 },
    { data: 'name', title: 'Name', width: 200 },
    { data: 'sku', title: 'SKU', width: 120 },
    { data: 'category', title: 'Category', width: 130 },
    {
      data: 'price',
      title: 'Price',
      type: 'numeric',
      numericFormat: { pattern: '0,0.00', culture: 'en-US' },
      width: 100,
    },
    { data: 'stock', title: 'Stock', type: 'numeric', width: 80 },
  ],
  colHeaders: true,
  rowHeaders: true,
  height: 450,
  width: '100%',
  // Enable server-side column sorting.
  columnSorting: true,
  // Enable column filter dropdowns.
  filters: true,
  dropdownMenu: true,
  // Show 10 rows per page; the server returns the matching slice.
  pagination: { pageSize: 10 },
  // Show a placeholder message when no rows match the active filters.
  emptyDataState: true,
  // Show an error toast when a fetch or mutation request fails.
  notification: true,
  dataProvider: {
    // 'id' is the primary key returned by the Spring Boot API.
    rowId: 'id',
    /**
     * Fetches a page of products from the Spring Boot REST API.
     *
     * Handsontable passes the current page, pageSize, sort state, and active
     * filters. The function maps them to Spring Boot query parameters and
     * returns { rows, totalRows } so the grid can render pagination controls.
     *
     * The AbortSignal in the second argument lets the browser cancel
     * in-flight requests when the user quickly changes pages or filters.
     */
    fetchRows: async ({ page, pageSize, sort, filters }, { signal }) => {
      const url = buildUrl('/api/products', {
        page,
        pageSize,
        sortProp: sort?.prop,
        sortOrder: sort?.order,
        // Transform HOT's { prop, conditions: [{ name, args }] } format into
        // the { column, value } shape the Spring backend expects.
        filters: filters ? JSON.stringify(
          filters.map(f => ({
            column: f.prop,
            value: f.conditions?.[0]?.args?.[0] ?? '',
          }))
        ) : undefined,
      });
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`Failed to fetch products: ${res.status}`);
      const json = await res.json();
      // The Spring Boot controller returns { rows, totalRows }.
      return { rows: json.rows, totalRows: json.totalRows };
    },
    /**
     * Sends a request to create one or more empty rows on the server.
     *
     * The payload shape is { position, referenceRowId, rowsAmount }, which
     * matches the CreateRowsPayload DTO in ProductController.
     */
    onRowsCreate: async (payload) => {
      const res = await fetch('/api/products/create-rows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`Failed to create rows: ${res.status}`);
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
    /**
     * Sends changed cell values to the server.
     *
     * Each element in the array is { id, changes } where changes is a map
     * of column name to new value -- matching UpdateRowPayload on the server.
     */
    onRowsUpdate: async (rows) => {
      const res = await fetch('/api/products/update-rows', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rows),
      });
      if (!res.ok) throw new Error(`Failed to update rows: ${res.status}`);
    },
    /**
     * Sends an array of row IDs to delete on the server.
     */
    onRowsRemove: async (rowIds) => {
      const res = await fetch('/api/products/remove-rows', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rowIds),
      });
      if (!res.ok) throw new Error(`Failed to remove rows: ${res.status}`);
    },
  },
  contextMenu: true,

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

  licenseKey: 'non-commercial-and-evaluation',
});
