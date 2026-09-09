import { stableBucketVersions } from "@handsontable/demo-runtime";
import type { Catalog, CatalogIndexEntry } from "@handsontable/demo-runtime";
import catalogJson from "../../../catalog.json";
import docsBucketsJson from "../../../docs-buckets.json";
import { fetchWithDiagnostics, type FetchDiagnostics } from "./fetchDiagnostics.js";

// The index only (~15 KB): framework rows without files. Full starter
// artifacts are lazy-fetched per version bucket — see starter-catalog.ts.
export const catalog = catalogJson as unknown as Catalog;

/** Committed docs-example bucket keys (Sentry DEMOS-1C). Static, like
 *  `catalog.buckets` for starters — a fetched index would reintroduce the
 *  SPA-fallback failure class it exists to remove, and add a round trip
 *  before the picker can render. The JSON import must live here, not in
 *  docs-catalog.ts: pipeline/docs-catalog.test.mjs imports docs-catalog.ts
 *  directly under --experimental-strip-types, and node cannot resolve a bare
 *  (attribute-less) JSON import — catalog.ts is already Vite-only for
 *  exactly this reason. */
export const docsBuckets: string[] = docsBucketsJson.buckets;

export function getEntry(framework: string): CatalogIndexEntry {
  const e = catalog.examples.find((x) => x.framework === framework);
  if (!e) throw new Error(`unknown framework: ${framework}`);
  return e;
}

/**
 * Fallback version options — what the picker shows until /api/versions responds,
 * and what it keeps showing when that fetch fails (`App.tsx`, versions-fetch).
 *
 * Derived from the committed starter buckets rather than hand-typed (DEV-2735).
 * The literal list this replaces was set once by feature work and nothing ever
 * bumped it: it still offered 18.0.0 as the newest choice months after 18.1.0
 * became npm `latest`, so a visitor whose /api/versions call had not landed yet
 * could not pick the current release at all. `bucketVersions` is rewritten by
 * the weekly bucket re-pin, so this now moves on its own — and every entry has
 * a bucket behind it, which a hand-typed npm version does not guarantee.
 */
export const VERSION_OPTIONS = stableBucketVersions(catalog.bucketVersions);
/** What an unparameterised visit starts on, and the sentinel `App.tsx` reads as
 *  "the visitor has not chosen" before swapping in npm `latest`. */
export const DEFAULT_VERSION = VERSION_OPTIONS[0];

/**
 * Fetch real published versions from the API (npm-backed).
 *
 * A thin caller over `fetchWithDiagnostics` (DEV-2859): the retry + timeout
 * policy and the attempt bookkeeping live there, import-free and unit-tested;
 * this function stays exactly what it was for the one line that a Sentry
 * population (DEMOS-2X) already groups on — `if (!res.ok) throw new Error(...)`
 * is byte-identical, so that grouping does not move. The `diagnostics` on the
 * success path let the caller (App.tsx) tell a retried-then-recovered blip
 * from a clean first try, without this module importing Sentry.
 */
export async function fetchVersions(
  apiBase: string,
): Promise<{ latest: string | null; next: string | null; versions: string[]; diagnostics: FetchDiagnostics }> {
  const { res, diagnostics } = await fetchWithDiagnostics(`${apiBase}/api/versions`);
  if (!res.ok) throw new Error(`versions ${res.status}`);
  const body = (await res.json()) as { latest: string | null; next: string | null; versions: string[] };
  return { ...body, diagnostics };
}

/** Is `version` an exact published Handsontable version on npm? Used to detect
 * an unresolvable deep-linked next-dist-tag build (e.g. a local docs build's
 * own commit stamp that was never published). Fails open (true) on a network
 * error OR a stalled request (a caller may be blocking the runtime mount on
 * this resolving) so a transient hiccup doesn't override the user's
 * requested version or hang the preview forever. */
export async function checkVersionExists(apiBase: string, version: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(
      `${apiBase}/api/versions/exists?v=${encodeURIComponent(version)}`,
      { signal: controller.signal },
    );
    if (!res.ok) return true;
    const body = (await res.json()) as { exists: boolean };
    return body.exists;
  } catch {
    return true;
  } finally {
    clearTimeout(timer);
  }
}
