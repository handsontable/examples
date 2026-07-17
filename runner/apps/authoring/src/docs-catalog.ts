// Loader for the documentation-guide example catalog.
//
// The importer (runner/pipeline/import-docs.mjs) emits, under
// apps/authoring/public/docs-examples/:
//   - <bucket>/manifest.json — metadata list driving the grouped dropdown
//   - <bucket>/<encoded-docsPath>.json — one full CatalogEntry per example, lazy-fetched
//
// Examples are opened by their docs content path via the `?docs=` URL param, e.g.
//   /?docs=guides/columns/column-adding/javascript/example1.ts

import type { CatalogEntry } from "@handsontable/demo-runtime";

const BASE = "/docs-examples";

export interface DocsManifestItem {
  bucket: string;
  docsPath: string;
  file: string;
  breadcrumb: string[];
  guide: string;
  guideTitle: string;
  exampleId: string;
  /** Human title, e.g. "Standard example" or a heading from the docs page. */
  exampleTitle: string;
  /** Docs page permalink, e.g. "/column-adding". */
  docPermalink: string;
  framework: string;
  displayName: string;
}

export interface DocsManifest {
  bucket: string;
  docsBranch: string;
  generatedFrom: string;
  hotVersion: string;
  count: number;
  examples: DocsManifestItem[];
}

/** A CatalogEntry plus the docs metadata the importer attaches. */
export type DocsCatalogEntry = CatalogEntry & {
  docsPath: string;
  breadcrumb: string[];
  guide: string;
  guideTitle: string;
  exampleId: string;
  lang: string;
};

/** One breadcrumb group of examples, for rendering <optgroup>s. */
export interface DocsGroup {
  label: string; // breadcrumb joined with " ▸ "
  items: DocsManifestItem[];
}

const manifestPromises = new Map<string, Promise<DocsManifest>>();

/** Fetch (once per bucket) and cache a docs example manifest. */
export function fetchDocsManifest(bucket: string): Promise<DocsManifest> {
  let manifestPromise = manifestPromises.get(bucket);
  if (!manifestPromise) {
    manifestPromise = fetch(`${BASE}/${bucket}/manifest.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`docs manifest ${r.status}`);
        return r.json() as Promise<DocsManifest>;
      })
      .catch((e) => {
        manifestPromises.delete(bucket); // allow retry
        throw e;
      });
    manifestPromises.set(bucket, manifestPromise);
  }
  return manifestPromise;
}

/** Group manifest items by their breadcrumb path, preserving manifest order. */
export function groupByBreadcrumb(items: DocsManifestItem[]): DocsGroup[] {
  const groups = new Map<string, DocsGroup>();
  for (const it of items) {
    const label = it.breadcrumb.join(" ▸ ");
    let g = groups.get(label);
    if (!g) {
      g = { label, items: [] };
      groups.set(label, g);
    }
    g.items.push(it);
  }
  return [...groups.values()];
}

/** A short per-option label: "example1 · React (TS)". */
export function optionLabel(it: DocsManifestItem): string {
  return `${it.exampleId} · ${it.displayName}`;
}

const entryCache = new Map<string, DocsCatalogEntry>();

/** Fetch and cache one bucket's full CatalogEntry by its docsPath. */
export async function loadDocsExample(
  bucket: string,
  docsPath: string,
): Promise<DocsCatalogEntry> {
  const cacheKey = `${bucket}:${docsPath}`;
  const cached = entryCache.get(cacheKey);
  if (cached) return cached;
  const file = docsPath.replace(/\//g, "__") + ".json";
  const res = await fetch(`${BASE}/${bucket}/${file}`);
  if (!res.ok) throw new Error(`docs example not found: ${docsPath} (${res.status})`);
  const entry = (await res.json()) as DocsCatalogEntry;
  entryCache.set(cacheKey, entry);
  return entry;
}
