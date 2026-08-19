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

/** Build a DataTransfer holding one binary file (base64 in, bytes out). */
async function binaryDataTransferOf(page: Page, name: string, base64: string) {
  return page.evaluateHandle(
    ({ name: fileName, data }) => {
      const bin = atob(data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], fileName, { type: "application/zip" }));
      return dt;
    },
    { name, data: base64 },
  );
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

test("a drop on a folder row lands inside that folder", async ({ page }) => {
  // The mirror image of "the drop target follows the pointer off a row" above:
  // there the pointer left the /src row and the drop had to fall back to the
  // root; here it stays on the folder row and the drop must land inside src/.
  // A folder row carries `data-drop-path` but no handler of its own — the
  // section's dragover resolves whatever row is under the pointer — so the same
  // event sequence drives both, and this one completes the drop instead of
  // moving off.
  await stubShell(page);
  await signIn(page);
  await page.goto("/?example=react");
  await expect(accountAvatar(page)).toBeVisible();
  await expect(fileRow(page, "/src/index.tsx")).toBeVisible();

  const panel = filesPanel(page);
  const dataTransfer = await dataTransferOf(page, [{ name: "notes.md", contents: "x" }]);
  await panel.dispatchEvent("dragenter", { dataTransfer });

  // Over the folder row itself (its button is titled "/src"), and the hint
  // names the directory — the promise the drop below has to keep.
  await fileRow(page, "/src").dispatchEvent("dragover", { dataTransfer });
  await expect(dropHint(page)).toHaveText("Drop into src");

  await fileRow(page, "/src").dispatchEvent("drop", { dataTransfer });

  // Inside the folder, and nowhere else — a root /notes.md would mean the drop
  // ignored the target the hint had named.
  await expect(fileRow(page, "/src/notes.md")).toBeVisible();
  await expect(fileRow(page, "/notes.md")).toHaveCount(0);
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

test("Replace on a colliding drop overwrites in place, and adds no copy", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await page.goto("/?example=react");
  await expect(accountAvatar(page)).toBeVisible();
  await expect(fileRow(page, "/src/index.tsx")).toBeVisible();

  await dropOnto(page, filesPanel(page), [{ name: "notes.md", contents: "first\n" }]);
  await expect(fileRow(page, "/notes.md")).toBeVisible();
  await dropOnto(page, filesPanel(page), [{ name: "notes.md", contents: "second\n" }]);

  await collisionDialog(page).getByRole("button", { name: "Replace" }).click();
  await expect(collisionDialog(page)).toHaveCount(0);

  // In place: the row survives and no `-1` copy appeared alongside it.
  await expect(fileRow(page, "/notes.md")).toBeVisible();
  await expect(fileRow(page, "/notes-1.md")).toHaveCount(0);

  // The crux is the content: Replace and Cancel both leave exactly one
  // /notes.md row, so row assertions alone cannot tell them apart. `commit`
  // re-selects the dropped file, which makes its pane the active one, and the
  // file is one line — the whole document is in the DOM, so `.cm-content` is
  // safe to read (CodeMirror virtualises long files; this one isn't).
  await expect(rowOf(page, "/notes.md")).toHaveAttribute("data-active", "true");
  const editor = page.locator('[data-pane-active="true"] .cm-content');
  await expect(editor).toContainText("second");
  await expect(editor).not.toContainText("first");
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

test("dropping a .zip unpacks it (DEV-2531)", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await page.goto("/?example=react");
  await expect(accountAvatar(page)).toBeVisible();
  await expect(fileRow(page, "/src/index.tsx")).toBeVisible();

  // A real archive, built with the same library the Download button writes with, and
  // shaped like one a forum user attaches: a wrapping directory, a file we take, a
  // file we refuse, and something that should never arrive at all.
  const { zipSync, strToU8 } = await import("fflate");
  const bytes = zipSync({
    "my-repro/index.js": strToU8("console.log('repro');\n"),
    "my-repro/data/rows.json": strToU8('[{ "a": 1 }]'),
    "my-repro/.env": strToU8("SECRET=1\n"),
    "my-repro/logo.png": strToU8("pretend"),
    "my-repro/node_modules/left-pad/index.js": strToU8("module.exports = 1\n"),
  });
  const base64 = Buffer.from(bytes).toString("base64");

  const panel = filesPanel(page);
  const dataTransfer = await binaryDataTransferOf(page, "my-repro.zip", base64);
  await panel.dispatchEvent("dragenter", { dataTransfer });
  await panel.dispatchEvent("dragover", { dataTransfer });
  await panel.dispatchEvent("drop", { dataTransfer });

  // Root stripped, so the project lands as a project.
  await expect(fileRow(page, "/index.js")).toBeVisible();
  await expect(fileRow(page, "/data/rows.json")).toBeVisible();
  // The archive itself is never stored, and neither is anything it should not carry.
  await expect(fileRow(page, "/my-repro.zip")).toHaveCount(0);
  await expect(fileRow(page, "/.env")).toHaveCount(0);
  await expect(fileRow(page, "/logo.png")).toHaveCount(0);
  await expect(fileRow(page, "/node_modules/left-pad/index.js")).toHaveCount(0);

  // And what it refused is said out loud, not swallowed.
  await expect(page.getByText(/Skipped/)).toContainText(/\.env|logo\.png/);
});
