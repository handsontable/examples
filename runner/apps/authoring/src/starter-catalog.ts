// Loader for the versioned starter-template catalog (DEV-2213).
//
// The importer (runner/pipeline/import.mjs) emits, under
// apps/authoring/public/starter-examples/:
//   - <bucket>/manifest.json — bucket metadata (hotVersion, membership)
//   - <bucket>/<framework>.json — one full CatalogEntry per starter, lazy-fetched
//
// Buckets are major-only ("15".."18") plus "next"; the bucket for a selected
// version is resolved client-side against `catalog.buckets` (the index knows
// the full set statically, unlike docs, which probe via manifest fetch).

import type { CatalogEntry, CatalogIndexEntry } from "@handsontable/demo-runtime";

const BASE = "/starter-examples";

const entryCache = new Map<string, CatalogEntry>();

/** Fetch and cache one bucket's full starter CatalogEntry. */
export async function loadStarterExample(
  bucket: string,
  framework: string,
): Promise<CatalogEntry> {
  const cacheKey = `${bucket}:${framework}`;
  const cached = entryCache.get(cacheKey);
  if (cached) return cached;
  const res = await fetch(`${BASE}/${bucket}/${framework}.json`);
  if (!res.ok) throw new Error(`starter not found: ${framework} in bucket ${bucket} (${res.status})`);
  const entry = (await res.json()) as CatalogEntry;
  entryCache.set(cacheKey, entry);
  return entry;
}

/**
 * A mountable-shaped entry for the moment before the bucket artifact arrives:
 * the app's `entry` state is a full CatalogEntry, but at first render only the
 * index row exists. Never mounted — the runtime-mount effect is gated until a
 * real artifact replaces it.
 */
export function toPlaceholderEntry(index: CatalogIndexEntry): CatalogEntry {
  return {
    ...index,
    htCoreRange: null,
    // Per-bucket, like htCoreRange: unknown until the bucket artifact lands.
    overrides: [],
    fileCount: 0,
    assets: [],
    skipped: [],
    files: {},
  };
}
