import type { Catalog, CatalogEntry } from "@handsontable/demo-runtime";
import catalogJson from "../../../catalog.json";

export const catalog = catalogJson as unknown as Catalog;

export function getEntry(framework: string): CatalogEntry {
  const e = catalog.examples.find((x) => x.framework === framework);
  if (!e) throw new Error(`unknown framework: ${framework}`);
  return e;
}

/** Curated version options for the picker; the current value is always included. */
export const VERSION_OPTIONS = ["18.0.0", "17.6.2", "17.0.1", "16.0.0", "15.3.0"];
export const DEFAULT_VERSION = "18.0.0";
