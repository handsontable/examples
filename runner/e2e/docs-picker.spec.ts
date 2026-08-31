import { test, expect, type Page, type Route } from "@playwright/test";
import { activeEditor, stubShell } from "./helpers";

// The docs example picker's search box (DEV-2530 item 5). The guide's opening
// beat tells users to *search* the picker rather than drill the categories —
// and until this spec, nothing proved the search box at all. docs-examples.
// spec.ts covers the two-column tree (drill-down, collapse, keyboard walking);
// this file covers the flattened search view that replaces it while a query is
// typed.
//
// What makes search worth its own spec is cross-category reach: `searchLeaves`
// (apps/authoring/src/docs-catalog.ts) matches every term against each leaf's
// *full breadcrumb path*, across all categories and both sections
// (DOCUMENTATION and RECIPES) at once. A plausible regression — scoping the
// search to the active category, the way the un-searched view is scoped —
// would still pass every drill-down test and every "search narrows" smoke;
// only a fixture with the same phrase planted in several categories can catch
// it. Hence the fixture below, not a slice of the real ~1,450-example
// manifest.
//
// Everything is deterministic: the catalog is NOT bundled — App.tsx fetches
// `/docs-examples/<bucket>/manifest.json` at boot and hands the rows to the
// picker — so the manifest, the example artifacts, and the Sandpack hosts are
// all stubbed. Whether a picked example then *renders* is the live suites'
// job; the strongest oracle available without a bundler is the `?docs=` URL
// plus the editor showing the fetched artifact's source, and that is what the
// selection tests assert.

/** One manifest row per category; every field the app reads (App.tsx renders
 *  the trigger from guideTitle/exampleTitle, the picker model from breadcrumb).
 *  Same shape as docs-examples.spec.ts's `manifestItem` — redeclared here
 *  because the fixture *content* is this spec's whole point: the phrase
 *  "context menu" is planted in three categories (two DOCUMENTATION, one
 *  RECIPES — recipes breadcrumbs run a level deeper, the exact shape
 *  `searchLeaves` flattens), plus one decoy that must never match. One
 *  framework variant each, so a pick resolves to exactly one docsPath and the
 *  URL oracle can be exact. */
const FIXTURE = [
  {
    breadcrumb: ["Columns", "Adding and removing columns"],
    guide: "guides/columns/column-adding/column-adding.md",
    guideTitle: "Adding and removing columns",
    docsPath: "guides/columns/column-adding/react/example2.tsx",
    exampleId: "example2",
    exampleTitle: "Add and remove columns from the context menu",
    docPermalink: "/column-adding",
  },
  {
    breadcrumb: ["Rows", "Adding and removing rows"],
    guide: "guides/rows/row-adding/row-adding.md",
    guideTitle: "Adding and removing rows",
    docsPath: "guides/rows/row-adding/react/example3.tsx",
    exampleId: "example3",
    exampleTitle: "Add and remove rows from the context menu",
    docPermalink: "/row-adding",
  },
  {
    breadcrumb: ["Recipes", "Context menu", "Conditional entries"],
    guide: "recipes/context-menu/conditional-entries/conditional-entries.md",
    guideTitle: "Conditional entries",
    docsPath: "recipes/context-menu/conditional-entries/react/example1.tsx",
    exampleId: "example1",
    exampleTitle: "Standard example",
    docPermalink: "/conditional-entries",
  },
  // The decoy: proves search *filters*, not just flattens. Shares nothing with
  // "context menu" anywhere in its path.
  {
    breadcrumb: ["Cell features", "Selection"],
    guide: "guides/cell-features/selection/selection.md",
    guideTitle: "Selection",
    docsPath: "guides/cell-features/selection/react/example1.tsx",
    exampleId: "example1",
    exampleTitle: "Standard example",
    docPermalink: "/selection",
  },
] as const;

const ROWS_DOCS_PATH = FIXTURE[1].docsPath;

/** Stub the docs catalog: the manifest at boot, and one artifact per fixture
 *  row for the selection tests. Trimmed from docs-examples.spec.ts's
 *  `installRouteFixtures` — that helper's knobs (missing buckets, SPA-fallback
 *  hosts, request logs) are load-error machinery this spec never exercises.
 *  Route order matters: the artifact glob also matches manifest.json, and
 *  Playwright resolves routes last-registered-first, so the manifest route
 *  goes second. */
async function installDocsCatalog(page: Page) {
  await stubShell(page); // versions stub → latest 18.0.0 → bucket "18.0"
  await page.route("**/docs-examples/*/*.json", async (route: Route) => {
    const url = new URL(route.request().url());
    const [, bucket, file] = url.pathname.match(/\/docs-examples\/([^/]+)\/(.+)\.json$/) ?? [];
    const path = decodeURIComponent(file ?? "").replace(/__/g, "/");
    const row = FIXTURE.find((r) => r.docsPath === path);
    if (!row) {
      await route.fulfill({ status: 404, body: "not found" });
      return;
    }
    // Minimal Tier-1 CatalogEntry (same skeleton as docs-examples.spec.ts's
    // `fixtureEntry`). The `fixture =` marker is what the editor oracle reads:
    // it names the artifact that was fetched, so a selection that loaded the
    // wrong example — or none — cannot fake the assertion.
    await route.fulfill({
      json: {
        framework: "react",
        displayName: "React",
        tier: 1,
        engine: "sandpack",
        sandpackTemplate: "react-ts",
        sandpackEnvironment: "parcel",
        container: null,
        htWrappers: ["@handsontable/react-wrapper"],
        entry: "/src/App.tsx",
        htmlEntry: "/index.html",
        devCommand: null,
        buildCommand: "vite build",
        outputDir: "dist",
        outputGlob: null,
        staticExport: false,
        spaMode: false,
        port: null,
        installCommand: "pnpm install",
        htCoreRange: "18.0.0",
        fileCount: 3,
        assets: [],
        skipped: [],
        docsPath: path,
        breadcrumb: [...row.breadcrumb],
        guide: row.guide,
        guideTitle: row.guideTitle,
        exampleId: row.exampleId,
        lang: "tsx",
        files: {
          "/src/App.tsx": `export const fixture = "${bucket}:${path}";\n`,
          "/index.html": `<div id="root"></div>`,
          "/package.json": JSON.stringify({
            dependencies: { handsontable: "18.0.0", "@handsontable/react-wrapper": "18.0.0" },
          }, null, 2),
        },
      },
    });
  });
  await page.route("**/docs-examples/*/manifest.json", async (route: Route) => {
    const bucket = new URL(route.request().url()).pathname.split("/").at(-2) ?? "";
    await route.fulfill({
      json: {
        bucket,
        docsBranch: "e2e-fixture",
        generatedFrom: "e2e fixture",
        // Matches the stubbed latest, so opening an example takes the clean
        // (unpinned) path — version pinning has its own spec.
        hotVersion: "18.0.0",
        count: FIXTURE.length,
        examples: FIXTURE.map((row) => ({
          bucket,
          docsPath: row.docsPath,
          file: row.docsPath.replace(/\//g, "__") + ".json",
          breadcrumb: [...row.breadcrumb],
          guide: row.guide,
          guideTitle: row.guideTitle,
          exampleId: row.exampleId,
          exampleTitle: row.exampleTitle,
          docPermalink: row.docPermalink,
          framework: "react",
          displayName: "React",
        })),
      },
    });
  });
}

/** Open the picker from the React starter and wait for the open to settle.
 *  The focus check is not decoration: the cascader focuses its search input
 *  from a `setTimeout(…, 0)` (DocsCascader.tsx), so typing before that lands
 *  races the focus — the same trap docs-examples.spec.ts documents for its
 *  keyboard tests. Starting on a *starter* (not a docs example) also makes the
 *  selection tests honest — the `?docs=` URL the oracle looks for cannot be
 *  there already. */
async function openPicker(page: Page) {
  await page.goto("/?example=react");
  await page.getByRole("button", { name: /React/ }).first().click();
  const search = page.getByPlaceholder("Search examples…");
  await expect(search).toBeFocused();
  return search;
}

/** The flattened results list that replaces the two-column body while a query
 *  is typed. Scoped by its accessible name so the assertions can never leak
 *  onto the category listbox. */
function results(page: Page) {
  return page.getByRole("listbox", { name: "Search results" }).getByRole("option");
}

// The promise: one query searches the WHOLE catalog. `searchLeaves` matches
// against each leaf's full breadcrumb path, so a phrase that lives in three
// categories — spanning both the DOCUMENTATION and RECIPES sections, whose
// breadcrumbs are even shaped differently — surfaces all three, breadcrumb
// visible on every row so same-named examples stay tellable apart. Counting
// per-category (and pinning the total) is the oracle because the credible
// regression leaves *some* results: a search scoped to the active category
// would still find the Columns row and pass any "results appear" check.
test("search surfaces matches from every category, across both sections", async ({ page }) => {
  await installDocsCatalog(page);
  const search = await openPicker(page);

  await search.fill("context menu");

  // One hit per planted category…
  await expect(results(page).filter({ hasText: "Adding and removing columns" })).toHaveCount(1);
  await expect(results(page).filter({ hasText: "Adding and removing rows" })).toHaveCount(1);
  await expect(results(page).filter({ hasText: "Conditional entries" })).toHaveCount(1);
  // …and nothing else: the decoy ("Cell features ▸ Selection") must not ride
  // along, or "search" has degraded to "flatten".
  await expect(results(page)).toHaveCount(3);

  // Each row renders the full breadcrumb trail, not just the leaf title — the
  // recipe row's deeper path proves the flattening kept every level.
  await expect(
    results(page).filter({ hasText: "Recipes ▸ Context menu ▸ Conditional entries ▸ Standard example" }),
  ).toHaveCount(1);
});

// The promise: clicking a search result actually opens that example. The
// oracle is the `?docs=` URL (the app's routing contract for docs examples,
// asserted exactly — the fixture has one framework per example, so there is
// exactly one right answer) plus the editor showing the fetched artifact's
// marker. URL alone would pass a regression where navigation happens but the
// artifact never loads; the marker names bucket AND path, so loading the
// wrong example fails too. Rendering is the live suites' job (docs-examples
// E2E_LIVE tests).
test("clicking a search result loads that example", async ({ page }) => {
  await installDocsCatalog(page);
  const search = await openPicker(page);

  await search.fill("context menu");
  await results(page).filter({ hasText: "Adding and removing rows" }).click();

  await expect(page).toHaveURL(/docs=guides%2Frows%2Frow-adding%2Freact%2Fexample3\.tsx/);
  await expect(activeEditor(page)).toContainText(`18.0:${ROWS_DOCS_PATH}`);
  // Choosing dismisses the popover — a picker that stays open over the loaded
  // example blocks the editor it just filled.
  await expect(page.getByRole("dialog", { name: "Choose an example" })).toHaveCount(0);
});

// The promise: the guide's search-first flow works without touching the mouse.
// ArrowDown from the search box must enter the RESULTS list while a query is
// live (`onSearchKeyDown` branches on `searching`), and Enter on a result must
// choose it (`onResultKeyDown`) — a code path none of docs-examples.spec.ts's
// keyboard tests reach, since they all walk the un-searched tree. The query
// matches exactly one leaf ("rows" rules out the other two "context menu"
// carriers), so first-result-Enter has one right outcome.
test("a search result is choosable by keyboard straight from the search box", async ({ page }) => {
  await installDocsCatalog(page);
  const search = await openPicker(page);

  await search.fill("rows context");
  await expect(results(page)).toHaveCount(1);

  await page.keyboard.press("ArrowDown");
  await expect(results(page).first()).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/docs=guides%2Frows%2Frow-adding%2Freact%2Fexample3\.tsx/);
});

// The promise: a query that matches nothing says so. The stale-results
// scenario is staged deliberately — real results first, then garbage — because
// the regression this guards (results not recomputed on query change, or the
// empty branch never rendering) shows the PREVIOUS hits under the new query.
// A test that only ever typed garbage would pass a picker frozen on its last
// good result set... as long as there never was one.
test("a garbage query shows the empty state, not stale results", async ({ page }) => {
  await installDocsCatalog(page);
  const search = await openPicker(page);

  // Populate the results view first, so staleness has something to be stale with.
  await search.fill("context menu");
  await expect(results(page)).toHaveCount(3);

  await search.fill("xyzzy plugh");

  await expect(page.getByText("No matching examples.")).toBeVisible();
  await expect(results(page)).toHaveCount(0);
});
