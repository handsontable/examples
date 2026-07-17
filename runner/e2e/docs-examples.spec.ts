import { test, expect } from "@playwright/test";

// End-to-end tests for the docs-example playground UI. Deterministic tests do
// not depend on the external Sandpack bundler; the live-render test does and is
// gated behind E2E_LIVE=1 (run against prod in the post-deploy smoke).

const REACT_EXAMPLE = "/?docs=guides/columns/column-adding/react/example2.tsx";

test("opens a docs example: breadcrumb, framework picker, docs link", async ({ page }) => {
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
  await page.goto(REACT_EXAMPLE);
  await page.getByRole("button", { name: /Adding and removing columns/ }).click();

  // Search box + top-level groups present.
  await expect(page.getByPlaceholder("Search examples…")).toBeVisible();
  await expect(page.getByText("Starter templates", { exact: true })).toBeVisible();

  // The currently-open example is highlighted (✓) and expanded to (the leaf
  // label is an exact match; the trigger/banner show a longer truncated string).
  await expect(page.getByText("Add and remove columns from the context menu", { exact: true })).toBeVisible();

  // Search narrows results.
  await page.getByPlaceholder("Search examples…").fill("dropdown array of values");
  await expect(page.getByText(/Dropdown cell type ▸ Array of values/).first()).toBeVisible();
});

test("switching framework updates the URL", async ({ page }) => {
  await page.goto(REACT_EXAMPLE);
  await page.getByRole("button", { name: "Vue", exact: true }).click();
  await expect(page).toHaveURL(/docs=guides%2Fcolumns%2Fcolumn-adding%2Fvue%2Fexample2\.vue/);
});

test("selecting an example from the cascader loads it", async ({ page }) => {
  await page.goto("/?example=react"); // start on a starter
  await page.getByRole("button", { name: /React/ }).first().click(); // open picker
  await page.getByText("Columns", { exact: true }).click();
  await page.getByText("Adding and removing columns", { exact: true }).click();
  await page.getByText("Standard example", { exact: true }).click();
  await expect(page).toHaveURL(/docs=guides%2Fcolumns%2Fcolumn-adding%2F.+example1/);
});

test("unresolved docs path shows a not-found screen, not the default starter", async ({ page }) => {
  await page.goto("/?docs=guides/does/not/exist.tsx");

  await expect(page.getByText("Example not found")).toBeVisible();
  await expect(page.getByText("guides/does/not/exist.tsx")).toBeVisible();

  // The real regression guard: no starter/preview iframe ever mounts behind the
  // not-found screen. Asserting only the message would also pass a version that
  // shows it while the default starter still boots underneath (today's bug).
  await expect(page.locator("iframe")).toHaveCount(0);
});

// Live render — needs the external Sandpack bundler; opt-in via E2E_LIVE=1.
test("live: a JavaScript example renders a Handsontable grid", async ({ page }) => {
  test.skip(process.env.E2E_LIVE !== "1", "set E2E_LIVE=1 to run live-render checks");
  test.setTimeout(120_000);
  await page.goto("/?docs=guides/columns/column-adding/javascript/example1.js");
  // Sandpack renders the preview into a nested iframe; find the grid inside it.
  const preview = page.frameLocator("iframe").first();
  await expect(preview.getByText("Ana García").first()).toBeVisible({ timeout: 90_000 });
});
