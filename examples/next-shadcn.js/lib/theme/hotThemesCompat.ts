// Resolution stub for Handsontable majors below 17, where the
// `handsontable/themes` subpath does not exist in the package `exports` map.
// `next.config.ts` aliases the themes subpaths here so the bundler can resolve
// them; the runtime version gate in DataGrid.tsx means none of these are ever
// called on those majors.
export function registerTheme(): never {
  throw new Error("handsontable/themes is not available below Handsontable 17");
}

export function getTheme(): never {
  throw new Error("handsontable/themes is not available below Handsontable 17");
}

export function hasTheme(): boolean {
  return false;
}

export default {};
