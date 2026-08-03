import { test, expect, type Page } from "@playwright/test";

// Multi-file editor tabs (DEV-2169 / T12, ADR-0025 §3). The strip shipped styled
// but single-file in T4; here it opens many, closes them, and dots the ones with
// unsaved edits.
//
// **The load-bearing test in this file is "closing a tab keeps its edits".** ADR-0025
// argues from the code that a tab is a view and not a buffer — contents live in the
// app's `files` map, `EditorShell` holds only view pointers — and therefore that no
// confirmation dialog is needed. That argument is only as good as a test that shows
// the edits surviving, which is what `reopening a closed tab keeps its edits` is.
//
// Deterministic — no `E2E_LIVE=1`: nothing here renders the example, so the Sandpack
// bundler is aborted and every API call is stubbed. Most cases run anonymous in
// `play`, because tabs are not auth-gated; only the dirty-dot-clears-on-save case
// needs a signed-in `/edit/:id`, and it fakes sign-in at the *token* layer for the
// reasons `sidebar-crud.spec.ts` sets out at length.

const EMAIL = "dev@handsontable.com";
const DEMO_ID = "e2etabs001";

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
  await page.route("**/api/demos/**", (route) => {
    if (route.request().method() === "PATCH") return route.fulfill({ json: { ok: true } });
    return route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith("/source")
        ? { framework: "react", files: DEMO_FILES }
        : { title: "Saved demo", description: null, ht_version: "18.0.0", created_at: null },
    });
  });
}

// ---- locators --------------------------------------------------------------
// Tabs and tree rows both carry `title={path}`, so every locator is scoped: the
// strip is `role="tablist"`, the tree is `<section aria-label="Files">`.
const strip = (page: Page) => page.getByRole("tablist", { name: "Open files" });
const tab = (page: Page, path: string) => strip(page).locator(`[role="tab"][data-path="${path}"]`);
const tabs = (page: Page) => strip(page).getByRole("tab");
const closeButton = (page: Page, path: string, name: string) =>
  tab(page, path).getByRole("button", { name: `Close ${name}` });

const filesPanel = (page: Page) => page.getByRole("region", { name: "Files" });
const fileRow = (page: Page, path: string) => filesPanel(page).locator(`button[title="${path}"]`);
const rowOf = (page: Page, path: string) =>
  filesPanel(page).locator(`.hot-file-row:has(> button[title="${path}"])`);
const nameInput = (page: Page) => filesPanel(page).getByRole("textbox");

const saveButton = (page: Page) => page.getByRole("button", { name: /^Save/ });

/** The visible editor. Hidden panes stay mounted — that is the point of T12 — so an
 *  unscoped `.cm-content` would match every open file and resolve in DOM order. */
const activeEditor = (page: Page) =>
  page.locator('[data-pane-active="true"] .cm-content');

/** Which glyph the tab is showing. Both are always in the DOM; the stylesheet decides,
 *  so this has to be a computed-style read rather than a presence check. */
async function glyph(page: Page, path: string): Promise<"dot" | "x"> {
  const dot = await tab(page, path).locator(".hot-tab-dot").evaluate((el) => getComputedStyle(el).display);
  return dot === "none" ? "x" : "dot";
}

async function openReact(page: Page) {
  await stubShell(page);
  await page.goto("/?example=react");
  await expect(tab(page, "/src/index.tsx")).toBeVisible();
}

// ---- opening and focusing --------------------------------------------------

test("the tree opens a second tab, and re-selecting focuses rather than duplicating", async ({ page }) => {
  await openReact(page);
  await expect(tabs(page)).toHaveCount(1);

  await fileRow(page, "/src/constants.ts").click();
  await expect(tabs(page)).toHaveCount(2);
  await expect(tab(page, "/src/constants.ts")).toHaveAttribute("aria-selected", "true");
  await expect(tab(page, "/src/index.tsx")).toHaveAttribute("aria-selected", "false");

  // Back to the first: it is already open, so this must move the selection, not
  // append a third tab.
  await fileRow(page, "/src/index.tsx").click();
  await expect(tabs(page)).toHaveCount(2);
  await expect(tab(page, "/src/index.tsx")).toHaveAttribute("aria-selected", "true");

  // And clicking the tab itself selects it too.
  await tab(page, "/src/constants.ts").click();
  await expect(tab(page, "/src/constants.ts")).toHaveAttribute("aria-selected", "true");
});

// ---- the no-lost-edits guarantee (ADR-0025 §3) -----------------------------

test("switching tabs keeps each file's edits", async ({ page }) => {
  await openReact(page);

  await activeEditor(page).click();
  await page.keyboard.type("// edit in index");

  await fileRow(page, "/src/constants.ts").click();
  await expect(activeEditor(page)).not.toContainText("// edit in index");

  await tab(page, "/src/index.tsx").click();
  await expect(activeEditor(page)).toContainText("// edit in index");
});

test("reopening a closed tab keeps its edits", async ({ page }) => {
  await openReact(page);

  await activeEditor(page).click();
  await page.keyboard.type("// survives the close");

  // Open a second file first: closing the only tab would leave nothing to prove the
  // point against, and this is also the case a user hits.
  await fileRow(page, "/src/constants.ts").click();
  await closeButton(page, "/src/index.tsx", "index.tsx").click();
  await expect(tab(page, "/src/index.tsx")).toHaveCount(0);

  // The edits were never in the tab. Reopening from the tree must show them.
  await fileRow(page, "/src/index.tsx").click();
  await expect(activeEditor(page)).toContainText("// survives the close");
});

test("undo history survives a tab switch", async ({ page }) => {
  // The reason every open tab stays mounted instead of being re-keyed (T12's main
  // quality decision). With a remount this passes only by accident of the undo stack
  // being empty.
  await openReact(page);

  await activeEditor(page).click();
  await page.keyboard.type("// undo me");
  await expect(activeEditor(page)).toContainText("// undo me");

  await fileRow(page, "/src/constants.ts").click();
  await tab(page, "/src/index.tsx").click();

  await activeEditor(page).click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(activeEditor(page)).not.toContainText("// undo me");
});

// ---- closing ---------------------------------------------------------------

test("closing the active tab activates a neighbour, and the last close empties the pane", async ({ page }) => {
  await openReact(page);
  await fileRow(page, "/src/constants.ts").click();
  await fileRow(page, "/src/styles.css").click();
  await expect(tabs(page)).toHaveCount(3);

  // Close the middle one while it is *not* active — the selection must not move.
  await tab(page, "/src/constants.ts").hover();
  await closeButton(page, "/src/constants.ts", "constants.ts").click();
  await expect(tabs(page)).toHaveCount(2);
  await expect(tab(page, "/src/styles.css")).toHaveAttribute("aria-selected", "true");

  // Close the active one: the right-hand neighbour has gone, so the left takes over.
  await closeButton(page, "/src/styles.css", "styles.css").click();
  await expect(tab(page, "/src/index.tsx")).toHaveAttribute("aria-selected", "true");

  // Undesigned, decided in T12: the last tab closes rather than refusing.
  await closeButton(page, "/src/index.tsx", "index.tsx").click();
  await expect(tabs(page)).toHaveCount(0);
  await expect(page.getByText("No file open. Pick one from the files sidebar.")).toBeVisible();

  // And the tree still opens one again.
  await fileRow(page, "/src/index.tsx").click();
  await expect(tabs(page)).toHaveCount(1);
});

// ---- the unsaved-changes dot (finding A6, open item 43) --------------------

test("the dot marks only the edited file, and reverts to the close ✕ on hover", async ({ page }) => {
  await openReact(page);
  await fileRow(page, "/src/constants.ts").click();

  // A clean tab shows the ✕ — the glyph slot is never empty, so the tab keeps its
  // width whichever is showing.
  expect(await glyph(page, "/src/index.tsx")).toBe("x");
  expect(await glyph(page, "/src/constants.ts")).toBe("x");

  await activeEditor(page).click();
  await page.keyboard.type("// dirty");

  // Per-file, which is the whole reason `dirtyPaths` exists: the workspace-level
  // boolean would dot both tabs here.
  expect(await glyph(page, "/src/constants.ts")).toBe("dot");
  expect(await glyph(page, "/src/index.tsx")).toBe("x");

  // Hover restores the ✕, so closing a dirty tab is still reachable. `hover()` drives
  // real CDP mouse input, so this exercises CSS `:hover` — a synthetic `mouseover`
  // would not (open items 16 / 36).
  await tab(page, "/src/constants.ts").hover();
  expect(await glyph(page, "/src/constants.ts")).toBe("x");

  // The dot belongs to the *file*, not to the selection: switching away must leave it
  // on the tab that carries the edit, and must not move it to the newly active one.
  await tab(page, "/src/index.tsx").click();
  await page.mouse.move(0, 400); // off the strip, or the hover ✕ masks the dot
  expect(await glyph(page, "/src/constants.ts")).toBe("dot");
  expect(await glyph(page, "/src/index.tsx")).toBe("x");
});

test("saving clears the dot without disturbing the workspace Save state", async ({ page }) => {
  await stubShell(page);
  await stubSavedDemo(page);
  await signIn(page);
  await page.goto(`/edit/${DEMO_ID}`);
  await expect(tab(page, "/src/App.tsx")).toBeVisible();

  await activeEditor(page).click();
  await page.keyboard.type("// unsaved");
  expect(await glyph(page, "/src/App.tsx")).toBe("dot");
  // T10's workspace-level indicator must light up from the same edit.
  await expect(saveButton(page)).toHaveText("Save •");

  await page.keyboard.press("ControlOrMeta+s");
  await expect(saveButton(page)).toHaveText("Save");
  expect(await glyph(page, "/src/App.tsx")).toBe("x");
});

// ---- reconciliation with the file set --------------------------------------

test("switching example discards the previous workspace's tabs", async ({ page }) => {
  // The trap T3 hit with directory expansion, and the reason `workspaceKey` exists:
  // both starters contain `/package.json`, so reconciling by "does this path still
  // exist" would leave that tab open across the switch.
  await openReact(page);
  await fileRow(page, "/package.json").click();
  await expect(tabs(page)).toHaveCount(2);

  await page.goto("/?example=angular");
  await expect(filesPanel(page)).toBeVisible();
  await expect(tabs(page)).toHaveCount(1);
  await expect(tab(page, "/src/index.tsx")).toHaveCount(0);
  await expect(tab(page, "/package.json")).toHaveCount(0);
});

test("renaming an open file moves its tab; deleting one closes it", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await page.goto("/?example=react");
  await expect(tab(page, "/src/index.tsx")).toBeVisible();

  await fileRow(page, "/src/constants.ts").click();
  await expect(tab(page, "/src/constants.ts")).toHaveAttribute("aria-selected", "true");

  // Rename: the tab follows rather than closing. Without `EditorShell`'s wrapper the
  // reconcile can only drop it, which is what `active` alone did before T12.
  const row = rowOf(page, "/src/constants.ts");
  await row.hover();
  await row.getByRole("button", { name: "Rename" }).click();
  await nameInput(page).fill("src/renamed.ts");
  await page.keyboard.press("Enter");

  await expect(tab(page, "/src/renamed.ts")).toHaveAttribute("aria-selected", "true");
  await expect(tab(page, "/src/constants.ts")).toHaveCount(0);
  await expect(tabs(page)).toHaveCount(2);

  // Delete: the tab goes with the file.
  const renamed = rowOf(page, "/src/renamed.ts");
  await renamed.hover();
  await renamed.getByRole("button", { name: "Delete" }).click();
  await expect(tab(page, "/src/renamed.ts")).toHaveCount(0);
  await expect(tab(page, "/src/index.tsx")).toHaveAttribute("aria-selected", "true");
});

test("adding a file opens it", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await page.goto("/?example=react");
  await expect(tab(page, "/src/index.tsx")).toBeVisible();

  await page.getByRole("button", { name: "New file", exact: true }).click();
  await nameInput(page).fill("scratch.ts");
  await page.keyboard.press("Enter");

  await expect(tab(page, "/scratch.ts")).toHaveAttribute("aria-selected", "true");
});

// ---- keyboard --------------------------------------------------------------

test("the strip is one tab stop with arrow-key roving and Delete-to-close", async ({ page }) => {
  await openReact(page);
  await fileRow(page, "/src/constants.ts").click();
  await fileRow(page, "/src/styles.css").click();

  // Roving tabindex: only the selected tab is reachable by Tab.
  await expect(tab(page, "/src/styles.css")).toHaveAttribute("tabindex", "0");
  await expect(tab(page, "/src/index.tsx")).toHaveAttribute("tabindex", "-1");

  await tab(page, "/src/styles.css").focus();
  // Arrows move focus, not selection, so a keyboard user can reach a tab's ✕ without
  // switching files on the way past.
  await page.keyboard.press("ArrowLeft");
  await expect(tab(page, "/src/constants.ts")).toBeFocused();
  await expect(tab(page, "/src/styles.css")).toHaveAttribute("aria-selected", "true");

  // Enter is what commits the move.
  await page.keyboard.press("Enter");
  await expect(tab(page, "/src/constants.ts")).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("Home");
  await expect(tab(page, "/src/index.tsx")).toBeFocused();
  await page.keyboard.press("End");
  await expect(tab(page, "/src/styles.css")).toBeFocused();

  await page.keyboard.press("Delete");
  await expect(tab(page, "/src/styles.css")).toHaveCount(0);
  await expect(tabs(page)).toHaveCount(2);
});

test("the whole strip is one Tab stop however many files are open", async ({ page }) => {
  // A native `<button>` is focusable by default, so the close ✕ silently added one Tab
  // stop *per open file* — the roving model says the strip is one stop, plus the active
  // tab's own ✕. Counted rather than asserted on attributes, because the failure is
  // about how many times a keyboard user presses Tab.
  await openReact(page);
  for (const p of ["/src/constants.ts", "/src/styles.css", "/index.html"]) {
    await fileRow(page, p).click();
  }
  await expect(tabs(page)).toHaveCount(4);

  const inStrip = await strip(page).evaluate(
    (el) => [...el.querySelectorAll("*")].filter((n) => (n as HTMLElement).tabIndex === 0).length,
  );
  expect(inStrip).toBe(2); // the active tab and its close button, and nothing else
});

test("closing keeps focus in the strip instead of dropping it on the body", async ({ page }) => {
  await openReact(page);
  await fileRow(page, "/src/constants.ts").click();
  await fileRow(page, "/src/styles.css").click();

  // Closing unmounts the focused element; without a handoff, focus falls to <body> and
  // the next close needs a full tab-in from the top of the page.
  await tab(page, "/src/styles.css").focus();
  await page.keyboard.press("Delete");
  await expect(tab(page, "/src/constants.ts")).toBeFocused();

  // …and a second Delete works straight away, which is the point.
  await page.keyboard.press("Delete");
  await expect(tab(page, "/src/index.tsx")).toBeFocused();

  // Last tab: nothing to hand focus to, so the strip itself takes it — the user keeps
  // their place in the page rather than being sent back to the top.
  await page.keyboard.press("Delete");
  await expect(tabs(page)).toHaveCount(0);
  await expect(strip(page)).toBeFocused();
});
