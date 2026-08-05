import { test, expect, type Page } from "@playwright/test";

// Sidebar file CRUD gating (DEV-2168 / T11, ADR-0025). The header `+` /
// `folder-plus` and the per-row ✎ / ✕ follow **being signed in**, not the mode —
// with `share` excluded, since the design never models ownership.
//
// Deterministic — no `E2E_LIVE=1`: nothing here renders the example, so the
// Sandpack bundler is aborted and every API call is stubbed.
//
// Sign-in is faked at the *token* layer (a seeded `hot_token` plus a stubbed
// `/broker/userinfo`), not the build layer, so these tests work against the same
// production build CI serves. The build-layer bypass would not: a local
// `pnpm build` embeds `.env.local`'s `VITE_DEV_USER`, because Vite loads
// `.env.local` for production builds too and `.env.production` does not override
// it. That would make every *anonymous* case here pass for the wrong reason —
// hence the `Sign in` / account-avatar preconditions asserted before each
// absence. Locally, build with `VITE_DEV_USER= pnpm --filter
// @handsontable/demo-authoring build`.

const EMAIL = "dev@handsontable.com";
const DEMO_ID = "e2ecrud01";

/** A minimal saved demo for `/edit/:id` and `/share/:id`. `/package.json` is
 *  `FileTree`'s one PROTECTED path, so the rename/delete probes use `/src/App.tsx`. */
const DEMO_FILES = {
  "/src/App.tsx": "export default function App() { return null; }\n",
  "/index.html": '<div id="root"></div>',
  "/package.json": JSON.stringify({ dependencies: { handsontable: "18.0.0" } }, null, 2),
};

async function stubShell(page: Page) {
  await page.route("**/api/versions", (route) =>
    route.fulfill({ json: { latest: "18.0.0", next: "19.0.0-next.1", versions: ["18.0.0", "17.1.0"] } }),
  );
  await page.route("https://sandpack.codesandbox.io/**", (route) => route.abort());
  await page.route("https://sandpack-bundler.codesandbox.io/**", (route) => route.abort());
  // A broken sign-in stub would let `/edit/:id` call `login()` and navigate to the
  // real external broker. Fail here instead.
  await page.route("**/broker/login**", (route) => route.abort());
}

/** Seeded token + stubbed userinfo: what `auth.ts`'s `currentUser()` reads. Both
 *  must be installed before `goto` — the app resolves the identity on mount. */
async function signIn(page: Page) {
  await page.addInitScript(() => sessionStorage.setItem("hot_token", "e2e-token"));
  await page.route("**/broker/userinfo", (route) => route.fulfill({ json: { email: EMAIL } }));
}

/** `/edit/:id` and `/share/:id` load source *and* metadata. One handler branching on
 *  the path, rather than two globs — two would depend on which of them Playwright
 *  matches first for `…/:id/source`, and the wrong answer serves the metadata payload
 *  as the source. */
async function stubSavedDemo(page: Page) {
  await page.route("**/api/demos/**", (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith("/source")
        ? { framework: "react", files: DEMO_FILES }
        : { title: "Shared demo", description: null, ht_version: "18.0.0", created_at: null },
    }),
  );
}

const addFileButton = (page: Page) => page.getByRole("button", { name: "New file", exact: true });
const addFolderButton = (page: Page) => page.getByRole("button", { name: "New file in a new folder" });
const renameButtons = (page: Page) => page.getByRole("button", { name: "Rename" });
const deleteButtons = (page: Page) => page.getByRole("button", { name: "Delete" });
/** `<section aria-label="Files">`. Scoping matters twice over: the editor tab strip
 *  reuses the same `title={path}` markup, and the section's two name inputs (add,
 *  rename) are the only textboxes inside it. They never coexist — `startAdd` clears
 *  `renaming` and starting a rename clears `adding`. */
const filesPanel = (page: Page) => page.getByRole("region", { name: "Files" });
const nameInput = (page: Page) => filesPanel(page).getByRole("textbox");
/** Tree rows carry the full path in `title` and the bare file name as their label.
 *  Matched on the title attribute, not the accessible name: the visible label wins
 *  the name computation, and two directories can hold the same file name. */
const fileRow = (page: Page, path: string) => filesPanel(page).locator(`button[title="${path}"]`);
/** The row *wrapper*, which is what carries the hover the ✎ / ✕ pair fades in on.
 *  `:has()` rather than the `has:` option — an option's inner locator is queried
 *  against the outer element, so a region-rooted one can never match inside a row. */
const rowOf = (page: Page, path: string) =>
  filesPanel(page).locator(`.hot-file-row:has(> button[title="${path}"])`);

/** `FileTree`'s delete confirmation. Its confirm control is labelled "Delete file"
 *  rather than "Delete" so it does not duplicate a row's trash control — but these
 *  locators still go through the dialog, because Playwright matches accessible names
 *  by substring: an unscoped `{ name: "Delete" }` would see both while it is open. */
const confirmDialog = (page: Page) => page.getByRole("dialog", { name: "Delete this file?" });
const confirmDeleteButton = (page: Page) =>
  confirmDialog(page).getByRole("button", { name: "Delete file" });

/** The only top-bar control that proves the app resolved a *null* user. */
const signInButton = (page: Page) => page.getByRole("button", { name: "Sign in" });
/** …and the one that proves it resolved a real one (`AccountMenu`'s avatar). */
const accountAvatar = (page: Page) => page.getByRole("button", { name: `Account: ${EMAIL}` });

async function expectNoFileCrud(page: Page) {
  await expect(addFileButton(page)).toHaveCount(0);
  await expect(addFolderButton(page)).toHaveCount(0);
  await expect(renameButtons(page)).toHaveCount(0);
  await expect(deleteButtons(page)).toHaveCount(0);
}

test("anonymous play has no file CRUD", async ({ page }) => {
  await stubShell(page);
  await page.goto("/?example=react");

  // Precondition, not decoration: `Sign in` renders only for a resolved null user,
  // so it rules out both a not-yet-resolved identity and a build with the
  // `VITE_DEV_USER` bypass baked in — either of which would make the absence below
  // pass without proving anything.
  await expect(signInButton(page)).toBeVisible();
  await expect(fileRow(page, "/src/index.tsx")).toBeVisible();

  await expectNoFileCrud(page);
});

test("signed-in play can add, rename and delete files", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await page.goto("/?example=react");

  await expect(accountAvatar(page)).toBeVisible();
  await expect(addFolderButton(page)).toBeVisible();

  // The newly-enabled case. Assert the *file*, not the icon — the icon only proves
  // `editable` flipped, while the row proves the handler is wired through to the
  // workspace.
  await addFileButton(page).click();
  await nameInput(page).fill("scratch.ts");
  await page.keyboard.press("Enter");
  await expect(fileRow(page, "/scratch.ts")).toBeVisible();

  // Rename and delete are gated on the same `editable` switch, one row down. The
  // rename field replaces the row it edits, so it is reached through the section,
  // not through the row.
  const row = rowOf(page, "/scratch.ts");
  await row.hover();
  await row.getByRole("button", { name: "Rename" }).click();
  await nameInput(page).fill("renamed.ts");
  await page.keyboard.press("Enter");
  await expect(fileRow(page, "/renamed.ts")).toBeVisible();
  await expect(fileRow(page, "/scratch.ts")).toHaveCount(0);

  const renamedRow = rowOf(page, "/renamed.ts");
  await renamedRow.hover();
  await renamedRow.getByRole("button", { name: "Delete" }).click();
  // The trash control only asks: the row has to survive until the dialog is confirmed,
  // or the confirmation is decorative.
  await expect(fileRow(page, "/renamed.ts")).toBeVisible();
  await confirmDeleteButton(page).click();
  await expect(fileRow(page, "/renamed.ts")).toHaveCount(0);
  await expect(confirmDialog(page)).toHaveCount(0);

  // `/package.json` is PROTECTED — the gate opening must not open that row.
  const protectedRow = rowOf(page, "/package.json");
  await protectedRow.hover();
  await expect(protectedRow.getByRole("button", { name: "Delete" })).toHaveCount(0);
});

test("the delete confirmation can be dismissed without losing the file", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await page.goto("/?example=react");

  const row = rowOf(page, "/src/index.tsx");
  await row.hover();
  await row.getByRole("button", { name: "Delete" }).click();

  // Focus has to land on Cancel, not on the confirm control: the destructive button is
  // first in the DOM, so without `data-autofocus` the Space below would delete the file
  // the dialog exists to ask about. Pressing it proves both halves at once.
  const cancel = confirmDialog(page).getByRole("button", { name: "Cancel" });
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Space");
  await expect(confirmDialog(page)).toHaveCount(0);
  await expect(fileRow(page, "/src/index.tsx")).toBeVisible();

  // Escape is `Dialog`'s other dismissal, and it must not delete either.
  await row.hover();
  await row.getByRole("button", { name: "Delete" }).click();
  await expect(confirmDialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(confirmDialog(page)).toHaveCount(0);
  await expect(fileRow(page, "/src/index.tsx")).toBeVisible();
});

test("signed-in edit keeps its file CRUD", async ({ page }) => {
  await stubShell(page);
  await stubSavedDemo(page);
  await signIn(page);
  await page.goto(`/edit/${DEMO_ID}`);

  await expect(accountAvatar(page)).toBeVisible();
  await expect(fileRow(page, "/src/App.tsx")).toBeVisible();
  await expect(addFileButton(page)).toBeVisible();
  await expect(addFolderButton(page)).toBeVisible();

  const row = rowOf(page, "/src/App.tsx");
  await row.hover();
  await expect(row.getByRole("button", { name: "Rename" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Delete" })).toBeVisible();
});

test("a signed-in visitor gets no file CRUD on someone else's share", async ({ page }) => {
  await stubShell(page);
  await stubSavedDemo(page);
  await signIn(page);
  await page.goto(`/share/${DEMO_ID}`);

  // `ShareRoute` renders the workspace anonymous but hands the identity to the top
  // bar alone, and *that* resolve is not gated by a splash — so wait on the avatar
  // before asserting absence, or this passes at t=0 whatever the gate does.
  await expect(accountAvatar(page)).toBeVisible();
  await expect(fileRow(page, "/src/App.tsx")).toBeVisible();

  await expectNoFileCrud(page);
});
