import type { Catalog, CatalogEntry } from "@handsontable/demo-runtime";
import catalogJson from "../../../catalog.json";

export const catalog = catalogJson as unknown as Catalog;

export function getEntry(framework: string): CatalogEntry {
  const e = catalog.examples.find((x) => x.framework === framework);
  if (!e) throw new Error(`unknown framework: ${framework}`);
  return e;
}

/** Fallback version options (used until /api/versions responds). */
export const VERSION_OPTIONS = ["18.0.0", "17.1.0", "17.0.1"];
export const DEFAULT_VERSION = "18.0.0";

/** Fetch real published versions from the API (npm-backed). */
export async function fetchVersions(
  apiBase: string,
): Promise<{ latest: string | null; next: string | null; versions: string[] }> {
  const res = await fetch(`${apiBase}/api/versions`);
  if (!res.ok) throw new Error(`versions ${res.status}`);
  return (await res.json()) as { latest: string | null; next: string | null; versions: string[] };
}

/** Is `version` an exact published Handsontable version on npm? Used to detect
 * an unresolvable deep-linked next-dist-tag build (e.g. a local docs build's
 * own commit stamp that was never published). Fails open (true) on a network
 * error so a transient hiccup doesn't override the user's requested version. */
export async function checkVersionExists(apiBase: string, version: string): Promise<boolean> {
  try {
    const res = await fetch(`${apiBase}/api/versions/exists?v=${encodeURIComponent(version)}`);
    if (!res.ok) return true;
    const body = (await res.json()) as { exists: boolean };
    return body.exists;
  } catch {
    return true;
  }
}
