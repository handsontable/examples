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

/** A docs resource the host did not serve. Distinct from a transient fetch or
 *  parse failure because the two produce different UI and different Sentry tags.
 *
 *  On the deployed host a miss is NOT a 404: apps/authoring/wrangler.jsonc sets
 *  `not_found_handling: "single-page-application"`, so Workers Assets answers
 *  200 + index.html for anything missing under /docs-examples/. An HTML body is
 *  the 404 the host refused to send. */
export class DocsResourceMissingError extends Error {
  readonly docsResourceMissing = true;

  constructor(message: string) {
    super(message);
    this.name = "DocsResourceMissingError";
  }
}

export function isDocsResourceMissing(error: unknown): boolean {
  return error instanceof Error
    && (error as { docsResourceMissing?: boolean }).docsResourceMissing === true;
}

/** Fetch JSON from the docs asset host, telling "the host has no such file"
 *  apart from "the request failed". `describe` is carried into the message, so
 *  it must name the bucket — that is what makes Sentry group per bucket (one
 *  bucket failing is user traffic, every bucket at once is a broken deploy). */
async function fetchDocsJson<T>(url: string, describe: string): Promise<T> {
  const res = await fetch(url);
  // The dev server and any correctly configured host answer 404 here; in
  // production this branch is effectively dead (see DocsResourceMissingError).
  if (res.status === 404) throw new DocsResourceMissingError(`${describe} not found (404)`);
  if (!res.ok) throw new Error(`${describe} failed (${res.status})`);
  const type = res.headers.get("content-type") ?? "";
  // Content-type first, so the ~800 KB happy-path manifest is still parsed by
  // `res.json()` without an extra JS-side string copy.
  if (/\bjson\b/i.test(type)) {
    try {
      return (await res.json()) as T;
    } catch (cause) {
      // A truncated or half-uploaded artifact served correctly as JSON. Left as a
      // plain (transient) Error — the host does have the file — but re-thrown with
      // `describe` so it still carries the bucket key. A bare `res.json()` reject
      // here would surface as the very `SyntaxError: Unexpected token '<'` this
      // ticket is retiring, with nothing in the message to group on.
      throw new Error(`${describe} unparseable JSON (200 ${type})`, { cause });
    }
  }
  const body = await res.text();
  if (/^\s*</.test(body)) {
    throw new DocsResourceMissingError(
      `${describe} not found (SPA fallback: 200 ${type || "no content-type"})`,
    );
  }
  try {
    // JSON served with a wrong or absent content-type is still JSON.
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`${describe} unparseable (200 ${type || "no content-type"})`);
  }
}

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

const manifestPromises = new Map<string, Promise<DocsManifest>>();

/** Fetch (once per bucket) and cache a docs example manifest. */
export function fetchDocsManifest(bucket: string): Promise<DocsManifest> {
  let manifestPromise = manifestPromises.get(bucket);
  if (!manifestPromise) {
    manifestPromise = fetchDocsJson<DocsManifest>(
      `${BASE}/${bucket}/manifest.json`,
      `docs manifest for bucket "${bucket}"`,
    ).catch((e) => {
      manifestPromises.delete(bucket); // allow retry
      throw e;
    });
    manifestPromises.set(bucket, manifestPromise);
  }
  return manifestPromise;
}

// ---------------------------------------------------------------------------
// Picker model (T7)
//
// `DocsCascader` renders a fixed two-column popover (`72:18028`): a sectioned
// category column on the left, and one example column on the right whose entries
// sit under collapsible section headers. Everything below turns the flat manifest
// into exactly that shape, so the component stays presentation-only.
// ---------------------------------------------------------------------------

/** One framework option for an example (populates the separate framework picker). */
export interface FrameworkOption {
  framework: string;
  displayName: string;
  docsPath: string;
}

/** What selecting a row hands back to `App`. Frameworks are *not* a tree level —
 *  they are collapsed onto the leaf and picked by the row-2 framework pill. */
export type PickerLeaf =
  | { kind: "docsExample"; frameworks: FrameworkOption[] }
  | { kind: "starter"; framework: string };

export interface PickerItem {
  /** Docs: `${guide}|${exampleId}`. Starter: `starter:${framework}`. Matches `selectedKey`. */
  key: string;
  label: string;
  leaf: PickerLeaf;
}

export interface PickerGroup {
  key: string;
  /** Section-header text. Empty for depth-1 categories, which render ungrouped. */
  header: string;
  items: PickerItem[];
}

export interface PickerCategory {
  /** Namespaced — `Recipes|Cell Types` and `Cell Types` are different categories. */
  key: string;
  label: string;
  groups: PickerGroup[];
}

export interface PickerSection {
  /** Label above a run of categories. `null` for the leading starters row. */
  label: string | null;
  categories: PickerCategory[];
}

export interface PickerLeafRef {
  key: string;
  leaf: PickerLeaf;
  /** Full breadcrumb down to the example — the search haystack and result label. */
  path: string[];
  categoryKey: string;
  groupKey: string;
}

export interface PickerModel {
  sections: PickerSection[];
  leaves: PickerLeafRef[];
  /** Leaf key → where it lives, so opening the popover can reveal the selection. */
  locate: Map<string, { categoryKey: string; groupKey: string }>;
}

export const STARTERS_CATEGORY_KEY = "__starters";

/** Recipes examples carry a breadcrumb one level deeper than every other guide
 *  (`["Recipes", "Cell Types", "Star Rating"]`). Rather than growing a third
 *  column for 152 of ~1,450 examples, its sub-categories are promoted to the
 *  left column under a `RECIPES` label — which makes every category's remaining
 *  breadcrumb exactly one segment, i.e. exactly one level of section headers. */
const RECIPES = "Recipes";

/** Build the two-column picker model. Category and example order follow the
 *  manifest, which the importer already emits alphabetically. */
export function buildPickerModel(
  items: DocsManifestItem[],
  starters: { framework: string; displayName: string }[],
): PickerModel {
  const categories = new Map<string, PickerCategory>();
  const groups = new Map<string, PickerGroup>();
  const leaves: PickerLeafRef[] = [];
  const locate = new Map<string, { categoryKey: string; groupKey: string }>();

  const category = (key: string, label: string) => {
    let c = categories.get(key);
    if (!c) {
      c = { key, label, groups: [] };
      categories.set(key, c);
    }
    return c;
  };

  const group = (cat: PickerCategory, header: string) => {
    const key = `${cat.key}\u0000${header}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, header, items: [] };
      groups.set(key, g);
      cat.groups.push(g);
    }
    return g;
  };

  // Starter templates: one category, one headerless group.
  const starterCat = category(STARTERS_CATEGORY_KEY, "Starter templates");
  const starterGroup = group(starterCat, "");
  for (const s of starters) {
    const key = `starter:${s.framework}`;
    const leaf: PickerLeaf = { kind: "starter", framework: s.framework };
    starterGroup.items.push({ key, label: s.displayName, leaf });
    leaves.push({
      key,
      leaf,
      path: ["Starter templates", s.displayName],
      categoryKey: starterCat.key,
      groupKey: starterGroup.key,
    });
    locate.set(key, { categoryKey: starterCat.key, groupKey: starterGroup.key });
  }

  // Collapse each example's framework variants onto a single leaf first, so the
  // same example never appears once per framework.
  const merged = new Map<string, { it: DocsManifestItem; frameworks: FrameworkOption[] }>();
  for (const it of items) {
    const key = `${it.guide}|${it.exampleId}`;
    let m = merged.get(key);
    if (!m) {
      m = { it, frameworks: [] };
      merged.set(key, m);
    }
    m.frameworks.push({ framework: it.framework, displayName: it.displayName, docsPath: it.docsPath });
  }

  const docCats: PickerCategory[] = [];
  const recipeCats: PickerCategory[] = [];

  for (const [key, { it, frameworks }] of merged) {
    // Recipes takes two breadcrumb segments to name its category, everything
    // else takes one. Whatever remains becomes the section header — always
    // zero segments (depth-1 guides) or one.
    const isRecipe = it.breadcrumb[0] === RECIPES && it.breadcrumb.length > 1;
    const catDepth = isRecipe ? 2 : 1;
    const catLabel = it.breadcrumb[catDepth - 1] ?? it.guideTitle;
    const catKey = isRecipe ? `${RECIPES}|${catLabel}` : catLabel;

    const known = categories.has(catKey);
    const cat = category(catKey, catLabel);
    if (!known) (isRecipe ? recipeCats : docCats).push(cat);

    const g = group(cat, it.breadcrumb.slice(catDepth).join(" ▸ "));
    const leaf: PickerLeaf = { kind: "docsExample", frameworks };
    g.items.push({ key, label: it.exampleTitle, leaf });
    leaves.push({
      key,
      leaf,
      path: [...it.breadcrumb, it.exampleTitle],
      categoryKey: cat.key,
      groupKey: g.key,
    });
    locate.set(key, { categoryKey: cat.key, groupKey: g.key });
  }

  const sections: PickerSection[] = [{ label: null, categories: [starterCat] }];
  if (docCats.length) sections.push({ label: "Documentation", categories: docCats });
  if (recipeCats.length) sections.push({ label: RECIPES, categories: recipeCats });

  return { sections, leaves, locate };
}

/** Cap on rendered search hits — the flat list is unusable long before this, and
 *  it bounds the DOM when a one-letter query matches most of the manifest. */
const SEARCH_LIMIT = 200;

/** AND-match every whitespace-separated term against the full breadcrumb path. */
export function searchLeaves(model: PickerModel, query: string): PickerLeafRef[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/);
  const out: PickerLeafRef[] = [];
  for (const l of model.leaves) {
    const hay = l.path.join(" ▸ ").toLowerCase();
    if (terms.every((t) => hay.includes(t))) out.push(l);
    if (out.length >= SEARCH_LIMIT) break;
  }
  return out;
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
  const entry = await fetchDocsJson<DocsCatalogEntry>(
    `${BASE}/${bucket}/${file}`,
    `docs example ${docsPath} in bucket "${bucket}"`,
  );
  entryCache.set(cacheKey, entry);
  return entry;
}
