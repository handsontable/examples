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

test("picking a starter after an import still loads it", async ({ page }) => {
  // Bugbot: the starter-load effect was gated on `importPhase` staying "loaded",
  // so an import disabled it for the rest of the session — `selectExample` cleared
  // `sourceLoaded` and bumped `starterGen`, and nothing ever fetched again.
  await stubShell(page);
  await signIn(page);
  await page.route("**/api/import", (route) => route.fulfill({ json: IMPORTED }));
  await page.goto("/?import=https%3A%2F%2Fstackblitz.com%2Fedit%2Fvitejs-vite-de8qy2bm");
  await expect(fileRow(page, "/src/main.ts")).toBeVisible();

  // Switch to a catalog starter through the picker's own path.
  await page.getByRole("button", { name: /ToolBar Demo|TypeScript|typescript/ }).first().click();
  await page.getByRole("option", { name: "Starter templates" }).click();
  await page.getByRole("treeitem", { name: "JavaScript (Vite)" }).click();

  // The starter's files arrive, and the imported ones are gone.
  await expect(fileRow(page, "/index.js")).toBeVisible();
  await expect(fileRow(page, "/src/main.ts")).toHaveCount(0);
});

test("an import survives a version change, re-pinned in place", async ({ page }) => {
  // The starter effect is gated off while an import is open (it would otherwise
  // fetch a catalog snapshot over the imported files), so the version picker only
  // keeps working because of the dedicated re-pin effect.
  await stubShell(page);
  await signIn(page);
  await page.route("**/api/import", (route) => route.fulfill({ json: IMPORTED }));
  await page.goto("/?import=https%3A%2F%2Fstackblitz.com%2Fedit%2Fvitejs-vite-de8qy2bm");
  await expect(fileRow(page, "/src/main.ts")).toBeVisible();

  // Same two-step the docs specs use: the pill is named "Handsontable version"
  // (exact — the pencil beside it is "Set a custom Handsontable version").
  await page.getByRole("button", { name: "Handsontable version", exact: true }).click();
  await page.getByRole("option", { name: "17.1.0", exact: true }).click();

  // Still the imported workspace, now pinned to the chosen version.
  await expect(fileRow(page, "/src/main.ts")).toBeVisible();
  await expect(fileRow(page, "/src/index.tsx")).toHaveCount(0);
  await fileRow(page, "/package.json").click();
  await expect(page.locator('[data-pane-active="true"] .cm-content')).toContainText("17.1.0");
});

test("a failed docs switch leaves the import — and its protection — in place", async ({ page }) => {
  // Bugbot: clearing the import state inside the pickers dropped the starter-load
  // gate before the new workspace existed, so a docs example that failed to load
  // left the imported files open and unprotected — and a later version change
  // fetched a catalog starter over them.
  await stubShell(page);
  await signIn(page);
  await page.route("**/api/import", (route) => route.fulfill({ json: IMPORTED }));
  // Every docs manifest 404s: the picker's docs half cannot resolve anything.
  await page.route("**/docs-examples/**", (route) => route.fulfill({ status: 404, body: "" }));
  await page.goto("/?import=https%3A%2F%2Fstackblitz.com%2Fedit%2Fvitejs-vite-de8qy2bm");
  await expect(fileRow(page, "/src/main.ts")).toBeVisible();

  // A version change is what used to overwrite the workspace afterwards.
  await page.getByRole("button", { name: "Handsontable version", exact: true }).click();
  await page.getByRole("option", { name: "17.1.0", exact: true }).click();

  await expect(fileRow(page, "/src/main.ts")).toBeVisible();
  await expect(fileRow(page, "/src/index.tsx")).toHaveCount(0);
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
  // …and it stays up. The starter effect is gated on a failed boot as well as a
  // loaded one (DEV-2517): the default starter used to land on top and
  // `loadWorkspace` cleared `errorMessage` with it, so the refusal was visible for
  // about a second. Shared with `?payload=` — see payload-boot.spec.ts.
  await expect(fileRow(page, "/src/index.tsx")).toHaveCount(0);
  await expect(page.getByText(/only hosts Handsontable demos/)).toBeVisible();
});

// DEV-2534. `/api/import` answers an unauthenticated or expired request with
// `{"error":"unauthorized"}`, and the import branch consulted `body.error`
// first — so its own 401 copy never ran and the wire string was what a person
// read. The status is what decides now.
test("an import refused for want of a session says to sign in, not 'unauthorized'", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await page.route("**/api/import", (route) =>
    route.fulfill({ status: 401, json: { error: "unauthorized" } }),
  );
  await page.goto("/?import=https%3A%2F%2Fstackblitz.com%2Fedit%2Fvitejs-vite-de8qy2bm");
  await expect(accountAvatar(page)).toBeVisible();

  await expect(page.getByText("Sign in to import a project.")).toBeVisible();
  await expect(page.getByText(/unauthorized/i)).toHaveCount(0);
});
