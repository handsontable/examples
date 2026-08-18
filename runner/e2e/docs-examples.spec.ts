import { test, expect } from "@playwright/test";

// End-to-end tests for the docs-example playground UI. Deterministic tests do
// not depend on the external Sandpack bundler; the live-render test does and is
// gated behind E2E_LIVE=1 (run against prod in the post-deploy smoke).

const REACT_EXAMPLE = "/?docs=guides/columns/column-adding/react/example2.tsx";
const DOCS_PATH = "guides/columns/column-adding/react/example2.tsx";
const NEXT_VERSION = "19.0.0-next.1";

const FRAMEWORKS = [
  ["react", "React", "tsx"],
  ["typescript", "TypeScript", "ts"],
  ["javascript", "JavaScript", "js"],
  ["vue", "Vue", "vue"],
  ["angular", "Angular", "ts"],
] as const;

function docsPath(framework: string, exampleId: string, extension: string) {
  return `guides/columns/column-adding/${framework}/${exampleId}.${extension}`;
}

function manifestItem(bucket: string, framework: string, displayName: string, path: string, exampleId: string) {
  return {
    bucket,
    docsPath: path,
    file: path.replace(/\//g, "__") + ".json",
    breadcrumb: ["Columns", "Adding and removing columns"],
    guide: "guides/columns/column-adding/column-adding.md",
    guideTitle: "Adding and removing columns",
    exampleId,
    exampleTitle: exampleId === "example2"
      ? "Add and remove columns from the context menu"
      : "Standard example",
    docPermalink: "/column-adding",
    framework,
    displayName,
  };
}

function fixtureItems(bucket: string) {
  return FRAMEWORKS.flatMap(([framework, displayName, extension]) => [
    manifestItem(bucket, framework, displayName, docsPath(framework, "example1", extension), "example1"),
    manifestItem(bucket, framework, displayName, docsPath(framework, "example2", extension), "example2"),
  ]);
}

function fixtureEntry(bucket: string, path: string, generatedVersion: string) {
  const framework = path.split("/").at(-2) ?? "react";
  const source = `export const fixture = "${bucket}:${path}";\n`;
  return {
    framework,
    displayName: FRAMEWORKS.find(([name]) => name === framework)?.[1] ?? framework,
    tier: 1,
    engine: "sandpack",
    sandpackTemplate: "react-ts",
    sandpackEnvironment: "parcel",
    container: null,
    htWrappers: framework === "react" ? ["@handsontable/react-wrapper"] : [],
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
    htCoreRange: generatedVersion,
    fileCount: 3,
    assets: [],
    skipped: [],
    docsPath: path,
    breadcrumb: ["Columns", "Adding and removing columns"],
    guide: "guides/columns/column-adding/column-adding.md",
    guideTitle: "Adding and removing columns",
    exampleId: path.includes("example2") ? "example2" : "example1",
    lang: "tsx",
    files: {
      "/src/App.tsx": source,
      // No Handsontable stylesheet — matches what the wrapper emits since
      // DEV-2207 (core self-injects and applies `mainTheme` from 17.0.0). This
      // fixture used to invent a third CSS URL shape the pipeline never produced.
      "/index.html": `<div id="root"></div>`,
      "/package.json": JSON.stringify({
        dependencies: {
          handsontable: generatedVersion,
          ...(framework === "react" ? { "@handsontable/react-wrapper": generatedVersion } : {}),
        },
      }, null, 2),
    },
  };
}

/** What the deployed host actually answers for a missing docs asset.
 *
 *  apps/authoring/wrangler.jsonc sets `not_found_handling: "single-page-application"`,
 *  so Workers Assets serves 200 + index.html for every miss under /docs-examples/.
 *  These fixtures used to answer 404 — the dev-server shape — which is why the
 *  DEV-2535 misclassification stayed green through the whole suite. */
async function spaFallback(route: import("@playwright/test").Route) {
  await route.fulfill({
    status: 200,
    contentType: "text/html",
    body: `<!doctype html><html><head></head><body><div id="root"></div></body></html>`,
  });
}

async function installRouteFixtures(
  page: import("@playwright/test").Page,
  {
    latest = "18.0.0",
    availableBuckets = ["18.0", "next"],
    missingPaths = [],
    missingArtifacts = [],
    notFoundStatus = 200,
    requests = [],
  }: {
    latest?: string;
    availableBuckets?: string[];
    /** Dropped from the manifest *and* missing as an artifact. */
    missingPaths?: string[];
    /** Listed in the manifest but missing as an artifact — the DEV-2130 class,
     *  the only way to reach the `loadDocsExample` guard. */
    missingArtifacts?: string[];
    /** 200 = the deployed SPA-fallback host (default). 404 = the dev server. */
    notFoundStatus?: 200 | 404;
    requests?: string[];
  } = {},
) {
  const miss = async (route: import("@playwright/test").Route) => {
    if (notFoundStatus === 404) {
      await route.fulfill({ status: 404, body: "not found" });
      return;
    }
    await spaFallback(route);
  };
  await page.route("**/api/versions", (route) => route.fulfill({
    json: {
      latest,
      next: NEXT_VERSION,
      versions: ["18.0.0", "17.1.0", NEXT_VERSION],
    },
  }));
  await page.route("https://sandpack.codesandbox.io/**", (route) => route.abort());
  await page.route("https://sandpack-bundler.codesandbox.io/**", (route) => route.abort());
  await page.route("**/docs-examples/*/*.json", async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname);
    const [, bucket, file] = url.pathname.match(/\/docs-examples\/([^/]+)\/(.+)$/) ?? [];
    const path = decodeURIComponent(file ?? "").replace(/\.json$/, "").replace(/__/g, "/");
    if (
      !bucket
      || !availableBuckets.includes(bucket)
      || missingPaths.includes(path)
      || missingArtifacts.includes(path)
    ) {
      await miss(route);
      return;
    }
    const generatedVersion = bucket === "next" ? "19.0.0-next.0" : "18.0.0";
    await route.fulfill({ json: fixtureEntry(bucket, path, generatedVersion) });
  });
  await page.route("**/docs-examples/*/manifest.json", async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname);
    const bucket = url.pathname.split("/").at(-2) ?? "";
    if (!availableBuckets.includes(bucket)) {
      await miss(route);
      return;
    }
    // `missingArtifacts` deliberately stays listed here: the row must survive
    // the manifest check at App.tsx so the failure comes from the artifact fetch.
    const examples = fixtureItems(bucket).filter((item) => !missingPaths.includes(item.docsPath));
    await route.fulfill({
      json: {
        bucket,
        docsBranch: bucket === "next" ? "develop" : `prod-docs/${bucket}`,
        generatedFrom: "e2e fixture",
        hotVersion: bucket === "next" ? "19.0.0-next.0" : "18.0.0",
        count: examples.length,
        examples,
      },
    });
  });
}

/** The *visible* editor.
 *
 *  Scoped to the shown pane since T12 (DEV-2169): every open tab keeps its own
 *  CodeMirror instance mounted so switching files preserves undo history, so a bare
 *  `.cm-content` matches one element per open tab and trips strict mode as soon as a
 *  test opens a second file. */
function editor(page: import("@playwright/test").Page) {
  return page.locator('[data-pane-active="true"] .cm-content');
}

// Since T2 (DEV-2156) the version and framework pickers are custom listboxes in
// the preview bar, not a native <select> and a button group — `selectOption`
// and `aria-pressed` no longer apply. Open the trigger, click the option.
async function pickFromMenu(
  page: import("@playwright/test").Page,
  menu: "Handsontable version" | "Framework",
  option: string,
) {
  await page.getByRole("button", { name: menu, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

test("opens a docs example: breadcrumb, framework picker, docs link", async ({ page }) => {
  await installRouteFixtures(page);
  await page.goto(REACT_EXAMPLE);

  // The picker trigger shows "<breadcrumb> · <example title>" (no framework).
  const trigger = page.getByRole("button", { name: /Adding and removing columns/ });
  await expect(trigger).toBeVisible();

  // Framework picker: the active variant labels the trigger, the rest sit in its
  // menu with the active one selected.
  const framework = page.getByRole("button", { name: "Framework", exact: true });
  await expect(framework).toContainText("React");
  await framework.click();
  await expect(page.getByRole("option", { name: "React", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  for (const fw of ["TypeScript", "JavaScript", "Vue", "Angular"]) {
    await expect(page.getByRole("option", { name: fw, exact: true })).toBeVisible();
  }
  await page.keyboard.press("Escape");

  // The docs link is an icon button now; its label carries the meaning.
  const docsLink = page.getByRole("link", { name: /documentation page/i });
  await expect(docsLink).toHaveAttribute(
    "href",
    "https://handsontable.com/docs/react-data-grid/column-adding/",
  );
});

test("cascader drills down and highlights the current selection", async ({ page }) => {
  await installRouteFixtures(page);
  await page.goto(REACT_EXAMPLE);
  await page.getByRole("button", { name: /Adding and removing columns/ }).click();

  // Search box + top-level groups present.
  await expect(page.getByPlaceholder("Search examples…")).toBeVisible();
  await expect(page.getByText("Starter templates", { exact: true })).toBeVisible();

  // Opening reveals the current selection: its category is active and its group
  // is forced open, so the row is on screen and marked selected. (The leaf label
  // is an exact match; the trigger/banner show a longer truncated string.)
  const current = page.getByText("Add and remove columns from the context menu", { exact: true });
  await expect(current).toBeVisible();
  await expect(page.getByRole("treeitem", { selected: true })).toHaveCount(1);

  // Search narrows results.
  await page.getByPlaceholder("Search examples…").fill("context menu");
  await expect(page.getByText(/Adding and removing columns ▸ Add and remove columns/).first()).toBeVisible();
});

// The popover is positioned against the *pill*, not the trigger's wrapper, and
// the design sizes it to the pill (`72:18028`). That holds only while nothing
// between the two is positioned — so it survives on a `position` nobody thinks
// to check. DEV-2170 broke it by putting the mark beside the cascader while the
// wrapper was still `relative`: the popover slid 28px right and lost 28px, and
// `top: calc(100% + 4px)` had been resolving against the wrapper's 16px trigger
// height all along, overlapping the pill by 6px. Geometry, because that is the
// only thing that catches it.
test("the cascader popover stays aligned to the example pill", async ({ page }) => {
  await installRouteFixtures(page);
  await page.goto(REACT_EXAMPLE);

  const trigger = page.getByRole("button", { name: /Adding and removing columns/ });
  await trigger.click();
  const popover = page.getByRole("dialog", { name: "Choose an example" });
  await expect(popover).toBeVisible();

  const geo = await page.evaluate(() => {
    const pop = document.querySelector('[role="dialog"][aria-label="Choose an example"]')!;
    // The pill is the 36px-high absolutely-positioned box holding the trigger.
    let pill = pop.parentElement!;
    while (pill && Math.round(pill.getBoundingClientRect().height) !== 36) pill = pill.parentElement!;
    const p = pop.getBoundingClientRect();
    const l = pill.getBoundingClientRect();
    return {
      dx: Math.round(p.left - l.left),
      dWidth: Math.round(p.width - l.width),
      gapBelowPill: Math.round(p.top - l.bottom),
    };
  });

  // 1px each side is the pill's border: the popover fills its padding box.
  expect(Math.abs(geo.dx)).toBeLessThanOrEqual(2);
  expect(Math.abs(geo.dWidth)).toBeLessThanOrEqual(4);
  // Below the pill, not overlapping it.
  expect(geo.gapBelowPill).toBeGreaterThan(0);
  expect(geo.gapBelowPill).toBeLessThanOrEqual(8);
});

test("cascader section headers collapse and re-expand", async ({ page }) => {
  await installRouteFixtures(page);
  await page.goto(REACT_EXAMPLE);
  await page.getByRole("button", { name: /Adding and removing columns/ }).click();

  // The focusable `treeitem` wraps the whole node (ARIA requires it to contain the
  // group it expands), so `aria-expanded` is asserted there but the click has to go
  // to the visible header row — the node's own centre is over an example.
  const node = page.getByRole("treeitem", { name: "Adding and removing columns" });
  const toggle = node.locator(".hot-casc-header");
  const group = page.getByRole("group", { name: "Adding and removing columns" });
  await expect(node).toHaveAttribute("aria-expanded", "true");
  await expect(group).toBeVisible();

  await toggle.click();
  await expect(node).toHaveAttribute("aria-expanded", "false");
  await expect(group).toHaveCount(0);

  await toggle.click();
  await expect(group).toBeVisible();
});

test("cascader is keyboard navigable", async ({ page }) => {
  await installRouteFixtures(page);
  await page.goto("/?example=react"); // start on a starter
  await page.getByRole("button", { name: /React/ }).first().click();

  // The search input takes focus on open; ArrowDown walks into the category
  // column, ArrowRight crosses into the examples, Enter selects.
  await expect(page.getByPlaceholder("Search examples…")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { name: "Starter templates" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { name: "Columns" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("treeitem", { name: "Adding and removing columns" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/docs=guides%2Fcolumns%2Fcolumn-adding%2F.+example1/);
});

test("hovering a category keeps the example column keyboard-navigable", async ({ page }) => {
  await installRouteFixtures(page);
  await page.goto("/?example=react");
  await page.getByRole("button", { name: /React/ }).first().click();

  // Wait for the open to settle before typing, as the test above does. The
  // cascader focuses its search input from a `setTimeout(…, 0)`
  // (`DocsCascader.tsx:131`), so arrow keys pressed before that lands are either
  // swallowed or undone by it — a race that only shows up under load.
  await expect(page.getByPlaceholder("Search examples…")).toBeFocused();

  // Walk into the example column, then hover a *different* category. That swaps
  // the column out and unmounts the focused row — focus used to fall to <body>
  // and every further arrow key was swallowed.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("treeitem", { name: "Adding and removing columns" })).toBeFocused();

  await page.getByRole("option", { name: "Starter templates" }).hover();

  // Focus survived the swap — it sits on the rebuilt column's first row...
  const rows = page.getByRole("treeitem");
  await expect(rows.first()).toBeFocused();
  // ...and arrow keys still move it, which is what the bug swallowed.
  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(1)).toBeFocused();
});

test("switching framework updates the URL", async ({ page }) => {
  await installRouteFixtures(page);
  await page.goto(REACT_EXAMPLE);
  await pickFromMenu(page, "Framework", "Vue");
  await expect(page).toHaveURL(/docs=guides%2Fcolumns%2Fcolumn-adding%2Fvue%2Fexample2\.vue/);
});

test("selecting an example from the cascader loads it", async ({ page }) => {
  await installRouteFixtures(page);
  await page.goto("/?example=react"); // start on a starter
  await page.getByRole("button", { name: /React/ }).first().click(); // open picker
  await page.getByText("Columns", { exact: true }).click();
  // Scoped to the group rather than the whole popover: every group under a
  // category renders at once now, and "Standard example" is the commonest title
  // in the manifest — unscoped, it is a strict-mode violation, not a miss.
  await page
    .getByRole("group", { name: "Adding and removing columns" })
    .getByText("Standard example", { exact: true })
    .click();
  await expect(page).toHaveURL(/docs=guides%2Fcolumns%2Fcolumn-adding%2F.+example1/);
});

test("unresolved docs path shows a not-found screen, not the default starter", async ({ page }) => {
  await installRouteFixtures(page, { missingPaths: ["guides/does/not/exist.tsx"] });
  await page.goto("/?docs=guides/does/not/exist.tsx&v=18.0.0");

  await expect(page.getByText("Example not found")).toBeVisible();
  await expect(page.getByText("guides/does/not/exist.tsx")).toBeVisible();

  // The real regression guard: no starter/preview iframe ever mounts behind the
  // not-found screen. Asserting only the message would also pass a version that
  // shows it while the default starter still boots underneath (today's bug).
  await expect(page.locator("iframe")).toHaveCount(0);
});

test("clean version switch replaces docs source from the target bucket", async ({ page }) => {
  const requests: string[] = [];
  await installRouteFixtures(page, { requests });
  await page.goto(`/?docs=${DOCS_PATH}&v=18.0.0`);
  await expect(editor(page)).toContainText(`18.0:${DOCS_PATH}`);

  await pickFromMenu(page, "Handsontable version", NEXT_VERSION);

  await expect(editor(page)).toContainText(`next:${DOCS_PATH}`);
  expect(requests).toContain(`/docs-examples/18.0/${DOCS_PATH.replace(/\//g, "__")}.json`);
  expect(requests).toContain(`/docs-examples/next/${DOCS_PATH.replace(/\//g, "__")}.json`);
});

test("dirty version switch preserves edits, re-pins, and warns", async ({ page }) => {
  await installRouteFixtures(page);
  await page.goto(`/?docs=${DOCS_PATH}&v=18.0.0`);
  await expect(editor(page)).toContainText(`18.0:${DOCS_PATH}`);
  await editor(page).fill("export const userEdit = true;");

  await pickFromMenu(page, "Handsontable version", NEXT_VERSION);

  await expect(editor(page)).toContainText("export const userEdit = true;");
  await expect(page.getByText(/content may not match the selected version API/i)).toBeVisible();
  await page.getByTitle("/package.json").click();
  await expect(editor(page)).toContainText(`"handsontable": "${NEXT_VERSION}"`);
});

test("same docs path uses isolated next and release cache entries", async ({ page }) => {
  const requests: string[] = [];
  await installRouteFixtures(page, { latest: NEXT_VERSION, requests });
  await page.goto(`/?docs=${DOCS_PATH}&v=${NEXT_VERSION}`);
  await expect(editor(page)).toContainText(`next:${DOCS_PATH}`);

  await pickFromMenu(page, "Handsontable version", "18.0.0");

  await expect(editor(page)).toContainText(`18.0:${DOCS_PATH}`);
  expect(requests.filter((path) => path.endsWith(`${DOCS_PATH.replace(/\//g, "__")}.json`))).toEqual([
    `/docs-examples/next/${DOCS_PATH.replace(/\//g, "__")}.json`,
    `/docs-examples/18.0/${DOCS_PATH.replace(/\//g, "__")}.json`,
  ]);
});

test("a version without a bucket leaves only starters in the picker", async ({ page }) => {
  const requests: string[] = [];
  await installRouteFixtures(page, { requests });
  await page.goto("/?example=react&v=17.1.0");
  await page.getByRole("button", { name: /React/ }).first().click();

  await expect(page.getByText("Starter templates", { exact: true })).toBeVisible();
  await expect(page.getByText("Columns", { exact: true })).toHaveCount(0);
  expect(requests).toContain("/docs-examples/17.1/manifest.json");
});

test("an open docs example with no target bucket stops preview and remains recoverable", async ({ page }) => {
  await installRouteFixtures(page);
  await page.goto(`/?docs=${DOCS_PATH}&v=18.0.0`);
  await expect(editor(page)).toContainText(`18.0:${DOCS_PATH}`);

  await pickFromMenu(page, "Handsontable version", "17.1.0");

  await expect(page.getByText(/No documentation examples are available for Handsontable 17\.1\.0/).first()).toBeVisible();
  await expect(page.locator("section[aria-label='Preview'] iframe")).toHaveAttribute("src", "about:blank");
  await page.getByRole("button", { name: /React/ }).first().click();
  await expect(page.getByText("Starter templates", { exact: true })).toBeVisible();
  await page.getByText("Starter templates", { exact: true }).click();
  // The stranded docs example must not leave a starter looking like the current
  // selection. Asserted on `aria-selected` — the design has no checkmark glyph,
  // so a text assertion would now pass no matter what the picker highlighted.
  const reactStarter = page.getByRole("treeitem", { name: "React (Vite, TS)" });
  await expect(reactStarter).toHaveAttribute("aria-selected", "false");
});

test("an open docs example with no target bucket is classified the same on a 404 host", async ({ page }) => {
  // The dev server and any correctly configured host still answer 404. Keeps
  // that path covered now that the fixture default is the deployed SPA shape.
  await installRouteFixtures(page, { notFoundStatus: 404 });
  await page.goto(`/?docs=${DOCS_PATH}&v=18.0.0`);
  await expect(editor(page)).toContainText(`18.0:${DOCS_PATH}`);

  await pickFromMenu(page, "Handsontable version", "17.1.0");

  await expect(page.getByText(/No documentation examples are available for Handsontable 17\.1\.0/).first()).toBeVisible();
});

test("a deep link into a bucket-less version shows not-found, not a retry prompt", async ({ page }) => {
  await installRouteFixtures(page);
  await page.goto(`/?docs=${DOCS_PATH}&v=17.1.0`);

  await expect(page.getByText("Example not found")).toBeVisible();
  // The half nothing pinned before DEV-2535: a permanently absent bucket used
  // to render the transient screen, offering a retry for a condition that will
  // never resolve on its own.
  await expect(page.getByText("Example temporarily unavailable")).toHaveCount(0);
  await expect(page.getByText(/Try again later/)).toHaveCount(0);
  await expect(page.locator("iframe")).toHaveCount(0);
});

test("a deep link whose manifest row has no artifact shows not-found", async ({ page }) => {
  // The DEV-2130 class: the row survives the manifest check, so the failure can
  // only come from the artifact fetch — the second `res.ok`-only hole. The
  // `missingPaths` test above never reaches `loadDocsExample` at all.
  await installRouteFixtures(page, { missingArtifacts: [DOCS_PATH] });
  await page.goto(`/?docs=${DOCS_PATH}&v=18.0.0`);

  await expect(page.getByText("Example not found")).toBeVisible();
  await expect(page.getByText("Example temporarily unavailable")).toHaveCount(0);
  await expect(page.locator("iframe")).toHaveCount(0);
});

// Live render — needs the external Sandpack bundler; opt-in via E2E_LIVE=1.
// @smoke: the post-deploy subset (DEV-2203) uses this as its docs-example canary.
test("live: a JavaScript example renders a Handsontable grid", { tag: "@smoke" }, async ({ page }) => {
  test.skip(process.env.E2E_LIVE !== "1", "set E2E_LIVE=1 to run live-render checks");
  test.setTimeout(120_000);
  // (column-adding was removed from the docs; accessibility example1 is a
  // data-rich vanilla example that exists in every bucket.)
  await page.goto("/?docs=guides/accessibility/accessibility/javascript/example1.js");
  // Sandpack renders the preview into a nested iframe; find the grid inside it.
  const preview = page.frameLocator("iframe").first();
  await expect(preview.getByText("Hodkiewicz - Hintz").first()).toBeVisible({ timeout: 90_000 });
});

// DEV-2175: the TypeScript variant has its own wrapper output (`src/main.ts`
// importing `../index.ts`), and the client-side transpile renames both files to
// `.js`. Every TS docs example died on "Could not find module in path:
// '../index.ts'" while the `.js` sibling above rendered fine — so the JS test
// alone does not cover this path.
test("live: a TypeScript example renders a Handsontable grid", async ({ page }) => {
  test.skip(process.env.E2E_LIVE !== "1", "set E2E_LIVE=1 to run live-render checks");
  test.setTimeout(120_000);
  const moduleErrors: string[] = [];
  page.on("console", (m) => {
    if (/Could not find module|ModuleNotFound/i.test(m.text())) moduleErrors.push(m.text());
  });
  await page.goto("/?docs=guides/accessibility/accessibility/javascript/example1.ts");
  const preview = page.frameLocator("iframe").first();
  await expect(preview.getByText("Hodkiewicz - Hintz").first()).toBeVisible({ timeout: 90_000 });
  expect(moduleErrors, "no unresolved module specifiers after the .ts → .js rename").toHaveLength(0);
});

// DEV-2129: vanilla-JS/TS examples using ES2020 optional chaining (`?.`) / nullish
// (`??`) must render. They parse-failed under the old `parcel` Sandpack env
// (babel-standalone 6.26); the fix routes them through `create-react-app-typescript`
// (babel 7). Guards against a regression back to a transpiler that predates `?.`.
test("live: a vanilla example using optional chaining renders", async ({ page }) => {
  test.skip(process.env.E2E_LIVE !== "1", "set E2E_LIVE=1 to run live-render checks");
  test.setTimeout(120_000);
  const syntaxErrors: string[] = [];
  page.on("console", (m) => {
    if (/SyntaxError|Unexpected token/i.test(m.text())) syntaxErrors.push(m.text());
  });
  // `example1.js` (rating) uses `star?.dataset.value`; the `.ts` sibling exercises the
  // TypeScript variant of the same parcel→cra-ts fix.
  await page.goto("/?docs=recipes/cell-types/rating/javascript/example1.js");
  const preview = page.frameLocator("iframe").first();
  await expect(preview.locator(".handsontable td").first()).toBeVisible({ timeout: 90_000 });
  expect(syntaxErrors, "no babel parse errors on ES2020 syntax").toHaveLength(0);
});

// DEV-2129: rendering alone is not enough — the Sandpack environment must also
// share Handsontable's internal module registry across entry points, or every
// options-configured plugin is silently dead (`getPlugin()` returns undefined,
// context menu never opens). The `create-react-app(-typescript)` environments
// duplicate the registry; only `parcel` (fed pre-transpiled sources) is safe.
// These guards check plugin *behavior*, so a render-only regression like the
// original PR #76 verification gap cannot recur.
test("live: a vanilla example's context menu plugin works", async ({ page }) => {
  test.skip(process.env.E2E_LIVE !== "1", "set E2E_LIVE=1 to run live-render checks");
  test.setTimeout(120_000);
  // guides/accessibility example1 configures `contextMenu: true`.
  await page.goto("/?docs=guides/accessibility/accessibility/javascript/example1.js");
  const preview = page.frameLocator("iframe").first();
  await expect(preview.locator(".handsontable td").first()).toBeVisible({ timeout: 90_000 });
  await preview.locator(".handsontable td").first().click({ button: "right" });
  await expect(preview.locator(".htContextMenu").first()).toBeVisible({ timeout: 15_000 });
});

// Most React docs examples are written for the automatic JSX runtime and never
// `import React` — the classic-runtime output we feed parcel must inject its
// own factory import ("React is not defined" prod regression, 2026-07-24). The
// dialog guard below can't catch this class: that example happens to import
// React. Guard with a modern-import-style example.
test("live: a React example that never imports React renders", async ({ page }) => {
  test.skip(process.env.E2E_LIVE !== "1", "set E2E_LIVE=1 to run live-render checks");
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("console", (m) => {
    if (/React is not defined|ReferenceError/i.test(m.text())) errors.push(m.text());
  });
  // selection example1 imports only hooks: `import { useRef, useState, useEffect } from 'react'`.
  await page.goto("/?docs=guides/cell-features/selection/react/example1.tsx");
  const preview = page.frameLocator("iframe").first();
  await expect(preview.locator(".handsontable td").first()).toBeVisible({ timeout: 90_000 });
  expect(errors, "no ReferenceError from compiled JSX").toHaveLength(0);
});

test("live: a React example's getPlugin() call works", async ({ page }) => {
  test.skip(process.env.E2E_LIVE !== "1", "set E2E_LIVE=1 to run live-render checks");
  test.setTimeout(120_000);
  // guides/dialog example1 calls `hotInstance.getPlugin('dialog').show(...)` on
  // mount — the exact call that crashed (bug C). The dialog content appearing
  // proves the plugin registry reached the grid.
  await page.goto("/?docs=guides/dialog/dialog/react/example1.tsx");
  const preview = page.frameLocator("iframe").first();
  await expect(preview.locator(".handsontable td").first()).toBeVisible({ timeout: 90_000 });
  await expect(
    preview.getByText("This is a basic dialog with default configuration.").first(),
  ).toBeVisible({ timeout: 30_000 });
});
