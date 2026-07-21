// Resolution stub for Handsontable majors below 17, where the
// `handsontable/themes` subpath does not exist in the package `exports` map.
// `vite.config.ts` aliases the themes subpaths here so the bundler can resolve
// them; the runtime version gate in hotTheme.ts means none of these are ever
// called on those majors.
const unavailable = (): never => {
  throw new Error('handsontable/themes is not available below Handsontable 17');
};

export const registerTheme = unavailable;
export const getTheme = unavailable;
export const hasTheme = (): boolean => false;
export const mainTheme = {};
export const horizonTheme = {};
export const classicTheme = {};

export default {};
