import { test, expect, type Page } from "@playwright/test";

// Drag & drop onto the FILES section (DEV-2500).
//
// Deterministic — no `E2E_LIVE=1`: nothing here renders the example, so the
// Sandpack bundler is aborted and every API call is stubbed.
//
// Sign-in is faked at the *token* layer, as in sidebar-crud.spec.ts: dropping is
// gated on the same `editable` switch as the rest of the file CRUD, so a
// build-layer bypass would make the read-only cases pass for the wrong reason.
//
// What a synthetic DataTransfer can and cannot reach: `webkitGetAsEntry()`
// returns null for a scripted drop (filesystem entries exist only for a real OS
// drag), so these specs drive the plain-`files` fallback. The directory
// traversal is covered by pipeline/drop-files.test.mjs against fakes.

const EMAIL = "dev@handsontable.com";
const DEMO_ID = "e2edrop01";

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
  await page.route("**/broker/login**", (route) => route.abort());
}

async function signIn(page: Page) {
  await page.addInitScript(() => sessionStorage.setItem("hot_token", "e2e-token"));
  await page.route("**/broker/userinfo", (route) => route.fulfill({ json: { email: EMAIL } }));
}

async function stubSavedDemo(page: Page) {
  await page.route("**/api/demos/**", (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith("/source")
        ? { framework: "react", files: DEMO_FILES }
        : { title: "Shared demo", description: null, ht_version: "18.0.0", created_at: null },
    }),
  );
}

const filesPanel = (page: Page) => page.getByRole("region", { name: "Files" });
const fileRow = (page: Page, path: string) => filesPanel(page).locator(`button[title="${path}"]`);
const rowOf = (page: Page, path: string) =>
  filesPanel(page).locator(`.hot-file-row:has(> button[title="${path}"])`);
const dropHint = (page: Page) => filesPanel(page).getByTestId("files-drop-hint");
const accountAvatar = (page: Page) => page.getByRole("button", { name: `Account: ${EMAIL}` });
const collisionDialog = (page: Page) =>
  page.getByRole("dialog", { name: "Some of these files already exist" });

interface DropFile {
  name: string;
  contents: string;
  type?: string;
}

/** Build a DataTransfer in the page and hand it to the drag events. */
async function dataTransferOf(page: Page, files: DropFile[]) {
  return page.evaluateHandle((items) => {
    const dt = new DataTransfer();
    for (const item of items) {
      dt.items.add(new File([item.contents], item.name, { type: item.type ?? "text/plain" }));
    }
    return dt;
  }, files);
}

/** A full drag over the FILES section and a drop on it. */
async function dropOnto(page: Page, target: ReturnType<typeof filesPanel>, files: DropFile[]) {
  const dataTransfer = await dataTransferOf(page, files);
  await target.dispatchEvent("dragenter", { dataTransfer });
  await target.dispatchEvent("dragover", { dataTransfer });
  await target.dispatchEvent("drop", { dataTransfer });
}

test("dropping one file adds it and opens it", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await page.goto("/?example=react");
  await expect(accountAvatar(page)).toBeVisible();
  await expect(fileRow(page, "/src/index.tsx")).toBeVisible();

  await dropOnto(page, filesPanel(page), [{ name: "notes.md", contents: "# hello\n" }]);

  await expect(fileRow(page, "/notes.md")).toBeVisible();
  // Opened, not merely added: the tree calls `onSelect` for the last file, which
  // is what puts it in the editor.
  await expect(rowOf(page, "/notes.md")).toHaveAttribute("data-active", "true");
});

test("dropping several files adds all of them in one go", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await page.goto("/?example=react");
  await expect(accountAvatar(page)).toBeVisible();
  // Wait for the starter artifact, not just for the identity: `loadWorkspace`
  // replaces the file map wholesale when the fetch lands, so a drop that beats it
  // is overwritten (a keystroke would be too — a test precondition, not a
  // product guard).
  await expect(fileRow(page, "/src/index.tsx")).toBeVisible();

  await dropOnto(page, filesPanel(page), [
    { name: "a.ts", contents: "export const a = 1;\n" },
    { name: "b.css", contents: ".b {}\n" },
    { name: "c.json", contents: "{}\n" },
  ]);

  await expect(fileRow(page, "/a.ts")).toBeVisible();
  await expect(fileRow(page, "/b.css")).toBeVisible();
  await expect(fileRow(page, "/c.json")).toBeVisible();
});

test("the drop target is live while a file drag is over the section", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await page.goto("/?example=react");
  await expect(accountAvatar(page)).toBeVisible();
  // Wait for the starter artifact, not just for the identity: `loadWorkspace`
  // replaces the file map wholesale when the fetch lands, so a drop that beats it
  // is overwritten (a keystroke would be too — a test precondition, not a
  // product guard).
  await expect(fileRow(page, "/src/index.tsx")).toBeVisible();

  const panel = filesPanel(page);
  await expect(dropHint(page)).toHaveCount(0);

  const dataTransfer = await dataTransferOf(page, [{ name: "a.ts", contents: "x" }]);
  await panel.dispatchEvent("dragenter", { dataTransfer });

  await expect(dropHint(page)).toBeVisible();
  // The dashed frame comes from the app stylesheet keyed off `data-dropping`
  // (ADR-0026 — it cannot be inline or it would outrank the row rules). Read it
  // back computed: a hint element proves the React state flipped, not that the
  // rule matched.
  await expect(panel).toHaveAttribute("data-dropping", "true");
  await expect
    .poll(() => panel.evaluate((el) => getComputedStyle(el).outlineStyle))
    .toBe("dashed");

  await panel.dispatchEvent("dragleave", { dataTransfer });
  await expect(dropHint(page)).toHaveCount(0);
  await expect(panel).not.toHaveAttribute("data-dropping", "true");
});

test("the drop target follows the pointer off a row", async ({ page }) => {
  // Bugbot: the target was set by per-row `dragenter` and only cleared when the
  // drag ended, so moving from a row back onto the header left that row as the
  // target — the hint named a directory the pointer had left, and the drop landed
  // there instead of the root.
  await stubShell(page);
  await signIn(page);
  await page.goto("/?example=react");
  await expect(accountAvatar(page)).toBeVisible();
  await expect(fileRow(page, "/src/index.tsx")).toBeVisible();

  const panel = filesPanel(page);
  const dataTransfer = await dataTransferOf(page, [{ name: "notes.md", contents: "x" }]);
  await panel.dispatchEvent("dragenter", { dataTransfer });

  // Over a file inside src/ → that directory.
  await fileRow(page, "/src/index.tsx").dispatchEvent("dragover", { dataTransfer });
  await expect(dropHint(page)).toHaveText("Drop into src");

  // Back over the section header → the root, not the stale row.
  await panel.getByText("Files", { exact: true }).dispatchEvent("dragover", { dataTransfer });
  await expect(dropHint(page)).toHaveText("Drop into the project root");

  // And the drop follows the hint.
  await panel.dispatchEvent("drop", { dataTransfer });
  await expect(fileRow(page, "/notes.md")).toBeVisible();
  await expect(fileRow(page, "/src/notes.md")).toHaveCount(0);
});

test("the drop hint does not move the file rows", async ({ page }) => {
  // The hint used to sit in the flow at the top of the list, so it pushed every
  // row down by its own height the moment a drag entered — under a stationary
  // pointer that silently retargeted the drop.
  await stubShell(page);
  await signIn(page);
  await page.goto("/?example=react");
  await expect(accountAvatar(page)).toBeVisible();
  const row = fileRow(page, "/src/index.tsx");
  await expect(row).toBeVisible();

  const before = await row.boundingBox();
  const dataTransfer = await dataTransferOf(page, [{ name: "notes.md", contents: "x" }]);
  await filesPanel(page).dispatchEvent("dragenter", { dataTransfer });
  await expect(dropHint(page)).toBeVisible();
  const after = await row.boundingBox();

  expect(before && after).toBeTruthy();
  expect(after!.y).toBeCloseTo(before!.y, 0);
});

test("a dropped binary is refused by name, with a reason", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await page.goto("/?example=react");
  await expect(accountAvatar(page)).toBeVisible();
  // Wait for the starter artifact, not just for the identity: `loadWorkspace`
  // replaces the file map wholesale when the fetch lands, so a drop that beats it
  // is overwritten (a keystroke would be too — a test precondition, not a
  // product guard).
  await expect(fileRow(page, "/src/index.tsx")).toBeVisible();

  await dropOnto(page, filesPanel(page), [
    { name: "logo.png", contents: "PNG", type: "image/png" },
    { name: "keep.ts", contents: "export {};\n" },
  ]);

  // The text half still lands; only the image is refused, and it says so rather
  // than vanishing.
  await expect(fileRow(page, "/keep.ts")).toBeVisible();
  await expect(fileRow(page, "/logo.png")).toHaveCount(0);
  await expect(filesPanel(page).getByRole("status")).toContainText("logo.png");
  await expect(filesPanel(page).getByRole("status")).toContainText("not a text file");
});

test("a colliding drop asks, and Keep both leaves the original alone", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await page.goto("/?example=react");
  await expect(accountAvatar(page)).toBeVisible();
  await expect(fileRow(page, "/src/index.tsx")).toBeVisible();

  await dropOnto(page, filesPanel(page), [{ name: "notes.md", contents: "first\n" }]);
  await expect(fileRow(page, "/notes.md")).toBeVisible();

  await dropOnto(page, filesPanel(page), [{ name: "notes.md", contents: "second\n" }]);

  // Nothing is applied until the question is answered.
  await expect(collisionDialog(page)).toBeVisible();
  await expect(fileRow(page, "/notes-1.md")).toHaveCount(0);

  // Focus is on the non-destructive option, as in the delete confirm.
  const keepBoth = collisionDialog(page).getByRole("button", { name: "Keep both" });
  await expect(keepBoth).toBeFocused();
  await keepBoth.click();

  await expect(collisionDialog(page)).toHaveCount(0);
  await expect(fileRow(page, "/notes.md")).toBeVisible();
  await expect(fileRow(page, "/notes-1.md")).toBeVisible();
});

test("Cancel on a colliding drop adds nothing", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await page.goto("/?example=react");
  await expect(accountAvatar(page)).toBeVisible();
  // Wait for the starter artifact, not just for the identity: `loadWorkspace`
  // replaces the file map wholesale when the fetch lands, so a drop that beats it
  // is overwritten (a keystroke would be too — a test precondition, not a
  // product guard).
  await expect(fileRow(page, "/src/index.tsx")).toBeVisible();

  await dropOnto(page, filesPanel(page), [{ name: "notes.md", contents: "first\n" }]);
  await expect(fileRow(page, "/notes.md")).toBeVisible();
  await dropOnto(page, filesPanel(page), [{ name: "notes.md", contents: "second\n" }]);

  await collisionDialog(page).getByRole("button", { name: "Cancel" }).click();
  await expect(collisionDialog(page)).toHaveCount(0);
  await expect(fileRow(page, "/notes-1.md")).toHaveCount(0);
  await expect(fileRow(page, "/notes.md")).toBeVisible();
});

test("anonymous play has no drop target", async ({ page }) => {
  await stubShell(page);
  await page.goto("/?example=react");

  // Precondition: `Sign in` proves a resolved null user, so the absence below is
  // the gate and not an unresolved identity.
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect(fileRow(page, "/src/index.tsx")).toBeVisible();

  await dropOnto(page, filesPanel(page), [{ name: "notes.md", contents: "x" }]);
  await expect(dropHint(page)).toHaveCount(0);
  await expect(fileRow(page, "/notes.md")).toHaveCount(0);
});

test("a signed-in visitor cannot drop onto someone else's share", async ({ page }) => {
  await stubShell(page);
  await stubSavedDemo(page);
  await signIn(page);
  await page.goto(`/share/${DEMO_ID}`);

  await expect(accountAvatar(page)).toBeVisible();
  await expect(fileRow(page, "/src/App.tsx")).toBeVisible();

  await dropOnto(page, filesPanel(page), [{ name: "notes.md", contents: "x" }]);
  await expect(dropHint(page)).toHaveCount(0);
  await expect(fileRow(page, "/notes.md")).toHaveCount(0);
});
