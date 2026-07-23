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
      "/index.html": `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/handsontable@${generatedVersion}/styles/handsontable.min.css"><div id="root"></div>`,
      "/package.json": JSON.stringify({
        dependencies: {
          handsontable: generatedVersion,
          ...(framework === "react" ? { "@handsontable/react-wrapper": generatedVersion } : {}),
        },
      }, null, 2),
    },
  };
}

async function installRouteFixtures(
  page: import("@playwright/test").Page,
  {
    latest = "18.0.0",
    availableBuckets = ["18.0", "next"],
    missingPaths = [],
    requests = [],
  }: {
    latest?: string;
    availableBuckets?: string[];
    missingPaths?: string[];
    requests?: string[];
  } = {},
) {
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
    if (!bucket || !availableBuckets.includes(bucket) || missingPaths.includes(path)) {
      await route.fulfill({ status: 404, body: "not found" });
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
      await route.fulfill({ status: 404, body: "not found" });
      return;
    }
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

function editor(page: import("@playwright/test").Page) {
  return page.locator(".cm-content");
}

test("opens a docs example: breadcrumb, framework picker, docs link", async ({ page }) => {
  await installRouteFixtures(page);
  await page.goto(REACT_EXAMPLE);

  // The picker trigger shows "<breadcrumb> · <example title>" (no framework).
  const trigger = page.getByRole("button", { name: /Adding and removing columns/ });
  await expect(trigger).toBeVisible();

  // Separate framework picker with the active one pressed.
  const react = page.getByRole("button", { name: "React", exact: true });
  await expect(react).toBeVisible();
  await expect(react).toHaveAttribute("aria-pressed", "true");
  for (const fw of ["TypeScript", "JavaScript", "Vue", "Angular"]) {
    await expect(page.getByRole("button", { name: fw, exact: true })).toBeVisible();
  }

  // "See in documentation" points at the correct framework-specific docs page.
  const docsLink = page.getByRole("link", { name: /See in documentation/ });
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

  // The currently-open example is highlighted (✓) and expanded to (the leaf
  // label is an exact match; the trigger/banner show a longer truncated string).
  await expect(page.getByText("Add and remove columns from the context menu", { exact: true })).toBeVisible();

  // Search narrows results.
  await page.getByPlaceholder("Search examples…").fill("context menu");
  await expect(page.getByText(/Adding and removing columns ▸ Add and remove columns/).first()).toBeVisible();
});

test("switching framework updates the URL", async ({ page }) => {
  await installRouteFixtures(page);
  await page.goto(REACT_EXAMPLE);
  await page.getByRole("button", { name: "Vue", exact: true }).click();
  await expect(page).toHaveURL(/docs=guides%2Fcolumns%2Fcolumn-adding%2Fvue%2Fexample2\.vue/);
});

test("selecting an example from the cascader loads it", async ({ page }) => {
  await installRouteFixtures(page);
  await page.goto("/?example=react"); // start on a starter
  await page.getByRole("button", { name: /React/ }).first().click(); // open picker
  await page.getByText("Columns", { exact: true }).click();
  await page.getByText("Adding and removing columns", { exact: true }).click();
  await page.getByText("Standard example", { exact: true }).click();
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

  await page.getByLabel("Handsontable version", { exact: true }).selectOption(NEXT_VERSION);

  await expect(editor(page)).toContainText(`next:${DOCS_PATH}`);
  expect(requests).toContain(`/docs-examples/18.0/${DOCS_PATH.replace(/\//g, "__")}.json`);
  expect(requests).toContain(`/docs-examples/next/${DOCS_PATH.replace(/\//g, "__")}.json`);
});

test("dirty version switch preserves edits, re-pins, and warns", async ({ page }) => {
  await installRouteFixtures(page);
  await page.goto(`/?docs=${DOCS_PATH}&v=18.0.0`);
  await expect(editor(page)).toContainText(`18.0:${DOCS_PATH}`);
  await editor(page).fill("export const userEdit = true;");

  await page.getByLabel("Handsontable version", { exact: true }).selectOption(NEXT_VERSION);

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

  await page.getByLabel("Handsontable version", { exact: true }).selectOption("18.0.0");

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

  await page.getByLabel("Handsontable version", { exact: true }).selectOption("17.1.0");

  await expect(page.getByText(/No documentation examples are available for Handsontable 17\.1\.0/).first()).toBeVisible();
  await expect(page.locator("section[aria-label='Preview'] iframe")).toHaveAttribute("src", "about:blank");
  await page.getByRole("button", { name: /React/ }).first().click();
  await expect(page.getByText("Starter templates", { exact: true })).toBeVisible();
  await page.getByText("Starter templates", { exact: true }).click();
  const reactStarter = page.locator(".hot-casc-row").filter({ hasText: "React (Vite, TS)" });
  await expect(reactStarter).not.toContainText("✓");
});

// Live render — needs the external Sandpack bundler; opt-in via E2E_LIVE=1.
test("live: a JavaScript example renders a Handsontable grid", async ({ page }) => {
  test.skip(process.env.E2E_LIVE !== "1", "set E2E_LIVE=1 to run live-render checks");
  test.setTimeout(120_000);
  // (column-adding was removed from the docs; accessibility example1 is a
  // data-rich vanilla example that exists in every bucket.)
  await page.goto("/?docs=guides/accessibility/accessibility/javascript/example1.js");
  // Sandpack renders the preview into a nested iframe; find the grid inside it.
  const preview = page.frameLocator("iframe").first();
  await expect(preview.getByText("Hodkiewicz - Hintz").first()).toBeVisible({ timeout: 90_000 });
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
