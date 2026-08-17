import { test, expect, type Page } from "@playwright/test";

// The blank starter, and whether anyone can actually reach it (DEV-2499).
//
// Deterministic — no `E2E_LIVE=1`: nothing here renders the example, so the
// Sandpack bundler is aborted and the shell's API calls are stubbed. The
// starter artifacts themselves (`/starter-examples/18/blank*.json`) are the
// app's own static files, served by the same vite preview as the shell — no
// route stub needed, and no network left to be flaky.

const EMAIL = "dev@handsontable.com";

async function stubShell(page: Page) {
  await page.route("**/api/versions", (route) =>
    route.fulfill({ json: { latest: "18.0.0", next: "19.0.0-next.1", versions: ["18.0.0", "17.1.0"] } }),
  );
  await page.route("https://sandpack.codesandbox.io/**", (route) => route.abort());
  await page.route("https://sandpack-bundler.codesandbox.io/**", (route) => route.abort());
  await page.route("**/broker/login**", (route) => route.abort());
}

async function signIn(page: Page) {
  await page.addInitScript(() => sessionStorage.setItem("hot_token", "e2e-token"));
  await page.route("**/broker/userinfo", (route) => route.fulfill({ json: { email: EMAIL } }));
}

const filesPanel = (page: Page) => page.getByRole("region", { name: "Files" });
const fileRow = (page: Page, path: string) => filesPanel(page).locator(`button[title="${path}"]`);
/** The *visible* editor — scoped to the shown pane, as in docs-examples.spec.ts:
 *  every open tab keeps its own CodeMirror mounted, so a bare `.cm-content`
 *  trips strict mode the moment a second file opens. */
const editor = (page: Page) => page.locator('[data-pane-active="true"] .cm-content');

test("the Create tile opens the blank starter, not the showcase", async ({ page }) => {
  // "Create" means starting from nothing (DEV-2499): the playground's default is
  // the React *showcase* — sample data, ten plugins — which is the wrong answer
  // to "give me an empty grid". The tile must point at `?example=blank`, and the
  // page it lands on must be the blank starter's file set, not the showcase's.
  await stubShell(page);
  await signIn(page);
  // My demos renders its grid (and the Create tile) for any resolved list, so an
  // empty one is the smallest rig that puts the tile on screen.
  await page.route("**/api/demos?scope=*", (route) =>
    route.fulfill({ json: { demos: [], scope: "mine" } }),
  );
  await page.goto("/my-demos");

  const create = page.getByRole("link", { name: "Create" });
  await expect(create).toHaveAttribute("href", "/?example=blank");
  await create.click();

  // The blank starter's entry file — and none of the react showcase, whose
  // entry would be /src/index.tsx.
  await expect(fileRow(page, "/index.js")).toBeVisible();
  await expect(fileRow(page, "/src/index.tsx")).toHaveCount(0);
});

test("a blank starter opens with nothing but the grid", async ({ page }) => {
  await stubShell(page);
  await page.goto("/?example=blank");

  await expect(fileRow(page, "/index.js")).toBeVisible();

  // The entry file opens on boot. It is ~15 lines, so the whole document is in
  // the DOM and `.cm-content` is safe to read — a long file would have to be
  // read another way, because CodeMirror virtualises and `.cm-content` would
  // only hold the rendered window.
  await expect(editor(page)).toContainText("startRows");
  // Nothing but the grid: no showcase module registration, no plugins switched
  // on, no sample data.
  await expect(editor(page)).not.toContainText("registerAllModules");
  await expect(editor(page)).not.toContainText("contextMenu");
  await expect(editor(page)).not.toContainText("data:");
});

test("the picker lists all three blank templates first", async ({ page }) => {
  await stubShell(page);
  await page.goto("/?example=blank");
  await expect(fileRow(page, "/index.js")).toBeVisible();

  // The picker trigger is named for the current example (see
  // docs-examples.spec.ts); opening it reveals the current selection's category,
  // but the click keeps the test honest if that default ever changes.
  await page.getByRole("button", { name: /Blank \(JavaScript\)/ }).first().click();
  await page.getByText("Starter templates", { exact: true }).click();

  // Blank leads: the starters follow `catalog.examples` order, and the three
  // empty grids sit ahead of every showcase — "Create" semantics, not
  // alphabetical accident. The first-row assertion is what catches a reorder.
  const items = page.getByRole("treeitem");
  await expect(items.first()).toHaveText("Blank (JavaScript)");
  await expect(page.getByRole("treeitem", { name: "Blank (TypeScript)" })).toBeVisible();
  await expect(page.getByRole("treeitem", { name: "Blank (React)" })).toBeVisible();
});
