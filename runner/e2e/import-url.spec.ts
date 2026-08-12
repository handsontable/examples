import { test, expect, type Page } from "@playwright/test";

// Importing a JSFiddle / StackBlitz project (DEV-2504).
//
// `/api/import` is stubbed: the parsers are covered against recorded fixtures in
// pipeline/import-url.test.mjs, and what is worth testing here is the wiring —
// the dialog navigates, `?import=` loads a workspace instead of the starter, the
// param is consumed, and a refusal is shown rather than swallowed.
//
// Deterministic — no `E2E_LIVE=1`: the Sandpack bundler is aborted.

const EMAIL = "dev@handsontable.com";

const IMPORTED = {
  provider: "stackblitz",
  title: "ToolBar Demo",
  framework: "typescript",
  files: {
    "/index.html": '<div id="example"></div>',
    "/src/main.ts": "import Handsontable from 'handsontable';\n",
    "/package.json": JSON.stringify({ dependencies: { handsontable: "^18.0.0" } }, null, 2),
  },
  skipped: [{ path: "/logo.png", reason: "not a text file" }],
};

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
const accountAvatar = (page: Page) => page.getByRole("button", { name: `Account: ${EMAIL}` });
const importDialog = (page: Page) => page.getByRole("dialog", { name: "Import a project" });

test("the My demos Import tile hands the URL to the playground", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await page.route("**/api/demos**", (route) => route.fulfill({ json: { demos: [] } }));
  await page.goto("/my-demos");

  await page.getByRole("button", { name: "Import" }).click();
  await expect(importDialog(page)).toBeVisible();

  const field = importDialog(page).getByLabel("JSFiddle or StackBlitz URL");
  await expect(field).toBeFocused();
  // The Import control stays disabled until the URL looks like a supported host —
  // a client-side courtesy only; the Worker's allowlist is the real gate.
  const submit = importDialog(page).getByRole("button", { name: "Import", exact: true });
  await expect(submit).toBeDisabled();
  await field.fill("https://example.com/nope");
  await expect(submit).toBeDisabled();

  await field.fill("https://jsfiddle.net/1bw9tphk/1/");
  await expect(submit).toBeEnabled();
  await submit.click();

  // The dialog does not import — it navigates, so one fetch happens in one place.
  await expect(page).toHaveURL(/\/\?import=https%3A%2F%2Fjsfiddle\.net%2F1bw9tphk%2F1%2F$/);
});

test("a CodeSandbox URL is answered in the dialog, before any request", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await page.route("**/api/demos**", (route) => route.fulfill({ json: { demos: [] } }));
  await page.goto("/my-demos");

  await page.getByRole("button", { name: "Import" }).click();
  await importDialog(page)
    .getByLabel("JSFiddle or StackBlitz URL")
    .fill("https://codesandbox.io/p/devbox/nj3gp2?file=%2Fpackage.json");

  await expect(importDialog(page)).toContainText("Export the sandbox to a .zip");
  await expect(importDialog(page).getByRole("button", { name: "Import", exact: true })).toBeDisabled();
});

test("?import= opens the imported workspace, not the starter", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  let importCalls = 0;
  await page.route("**/api/import", (route) => {
    importCalls += 1;
    return route.fulfill({ json: IMPORTED });
  });
  await page.goto("/?import=https%3A%2F%2Fstackblitz.com%2Fedit%2Fvitejs-vite-de8qy2bm");
  await expect(accountAvatar(page)).toBeVisible();

  // The imported files, and *not* the react starter the playground defaults to:
  // the starter fetch has to stay out of the way or it replaces them.
  await expect(fileRow(page, "/src/main.ts")).toBeVisible();
  await expect(fileRow(page, "/index.html")).toBeVisible();
  await expect(fileRow(page, "/src/index.tsx")).toHaveCount(0);

  // What could not come across is reported, not dropped silently.
  await expect(page.getByText(/Not imported: \/logo\.png \(not a text file\)/)).toBeVisible();

  // The param is consumed, so a reload does not re-import over the author's edits.
  await expect(page).not.toHaveURL(/import=/);
  expect(importCalls).toBe(1);
});

test("a refused import says why instead of hanging on a spinner", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await page.route("**/api/import", (route) =>
    route.fulfill({
      status: 400,
      json: {
        error:
          "That project does not use Handsontable, and this playground only hosts Handsontable demos.",
      },
    }),
  );
  await page.goto("/?import=https%3A%2F%2Fstackblitz.com%2Fedit%2Fsomeone-elses-app");
  await expect(accountAvatar(page)).toBeVisible();

  await expect(page.getByText(/only hosts Handsontable demos/)).toBeVisible();
});
