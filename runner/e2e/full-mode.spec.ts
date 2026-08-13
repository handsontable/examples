import { test, expect, type Page } from "@playwright/test";

// Full mode in `play` (ADR-0027 §13). Deterministic — no `E2E_LIVE=1`: every
// assertion here is about chrome and the URL, and `PreviewPane` renders its
// <iframe> unconditionally, so the "did the runtime survive the toggle" check
// works with the Sandpack bundler aborted.
//
// The button was gated on `savedId` until DEV-2027 follow-up work, which meant it
// never appeared in `play` at all. Nothing in `e2e/` covered it, which is why that
// shipped unnoticed — hence this file.

const SPLITTER = "[data-splitter]";
const MAXIMIZE = "Open the preview full-window";
const MINIMIZE = "Leave full-window view";

async function openPlayground(page: Page, query = "?example=react") {
  await page.route("**/api/versions", (route) =>
    route.fulfill({ json: { latest: "18.0.0", next: "19.0.0-next.1", versions: ["18.0.0", "17.1.0"] } }),
  );
  await page.route("https://sandpack.codesandbox.io/**", (route) => route.abort());
  await page.route("https://sandpack-bundler.codesandbox.io/**", (route) => route.abort());
  await page.goto(`/${query}`);
  await expect(page.frameLocator("iframe[title='Demo preview']").owner()).toBeVisible();
}

/** Marks the live preview iframe so a re-mount — or a page load — is detectable.
 *  A DOM attribute rather than a JS handle: React re-creating the element drops it,
 *  and so does a navigation, which is exactly what this must not do. */
async function stampPreview(page: Page) {
  await page.locator("iframe[title='Demo preview']").evaluate((el) => {
    el.setAttribute("data-e2e-stamp", "1");
  });
}

async function previewIsSameElement(page: Page): Promise<boolean> {
  return page.locator("iframe[title='Demo preview']").evaluate((el) => el.getAttribute("data-e2e-stamp") === "1");
}

// `play` is one rule, not two: `onMaximize` keys off `route.mode`, which a docs
// example and a starter share. Covered with a starter, which needs no docs-manifest
// mock to reach the same code.
test("a workspace in play offers full-window", async ({ page }) => {
  await openPlayground(page);
  await expect(page.getByRole("button", { name: MAXIMIZE })).toBeVisible();
});

test("full mode drops the editor and keeps the running preview", async ({ page }) => {
  await openPlayground(page);
  await stampPreview(page);

  await page.getByRole("button", { name: MAXIMIZE }).click();

  // The editor side is put away: splitter, editor pane and sidebar toggle all gone from
  // the page. `not.toBeVisible`, not `toHaveCount(0)` — the editor side is hidden rather
  // than unmounted, deliberately, so that undo and scroll survive (see the trip test
  // below). Asserting absence here would forbid the fix.
  await expect(page.locator(SPLITTER)).not.toBeVisible();
  await expect(page.locator("[data-pane-active]")).not.toBeVisible();
  await expect(page.getByRole("button", { name: /sidebar/i })).not.toBeVisible();

  // `FullBar` replaces `PreviewBar` — that one *is* a swap, so the pill is really gone.
  await expect(page.getByRole("button", { name: MINIMIZE })).toBeVisible();
  await expect(page.getByRole("button", { name: "Handsontable version" })).toHaveCount(0);

  // Shareable, and reached without a navigation — the stamp survives only if the
  // iframe element does, which is the whole point of toggling in place.
  expect(new URL(page.url()).searchParams.get("mode")).toBe("full");
  expect(await previewIsSameElement(page)).toBe(true);
});

test("minimize restores the editor and drops the param", async ({ page }) => {
  await openPlayground(page);
  await page.getByRole("button", { name: MAXIMIZE }).click();
  await expect(page.getByRole("button", { name: MINIMIZE })).toBeVisible();
  await stampPreview(page);

  await page.getByRole("button", { name: MINIMIZE }).click();

  await expect(page.locator(SPLITTER)).toBeVisible();
  await expect(page.getByRole("button", { name: MAXIMIZE })).toBeVisible();
  expect(new URL(page.url()).searchParams.has("mode")).toBe(false);
  expect(await previewIsSameElement(page)).toBe(true);
});

// Bugbot on #117 reported the symptom — `EditorStatusBar` keeping its pre-toggle
// `Ln, Col` — but the cause is that the panes were unmounted and came back fresh,
// which also throws away the per-tab undo history DEV-2169 exists to keep. Undo is
// what this asserts: a stale readout is invisible to a test (the stale value and the
// correct one are the same number), an empty history is not.
test("the editor survives a trip through full mode", async ({ page }) => {
  await openPlayground(page);
  const content = () => page.locator("[data-pane-active] .cm-content");
  await content().click();
  await page.keyboard.type("zzmarkerzz");
  await expect(content()).toContainText("zzmarkerzz");

  await page.getByRole("button", { name: MAXIMIZE }).click();
  await expect(page.getByRole("button", { name: MINIMIZE })).toBeVisible();
  await page.getByRole("button", { name: MINIMIZE }).click();
  await expect(page.locator(SPLITTER)).toBeVisible();

  // Undo needs focus, which leaving the editor put away costs either way. Clicking
  // back in moves the caret but does not touch the history — that is the difference
  // between a hidden pane and a re-mounted one.
  await content().click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(content()).not.toContainText("zzmarkerzz");
});

// ---- full mode over a *saved* demo (`/share/:id?mode=full`) -----------------
// A different component from everything above: `App` dispatches a saved demo's
// `?mode=full` to `FullMode`, which wraps the built `/d/:id/` output and boots no
// runtime at all. DEV-2495 — it fetched the demo's metadata and rendered only the
// title, dropping the description the API had already sent.

const SAVED_ID = "e2efull001";

async function stubSavedFull(page: Page, description: string | null) {
  await page.route(`**/api/demos/${SAVED_ID}`, (route) =>
    route.fulfill({ json: { id: SAVED_ID, title: "A saved demo", description, ht_version: "18.0.0" } }),
  );
  await page.route(`**/api/demos/${SAVED_ID}/source`, (route) =>
    route.fulfill({ json: { framework: "react", files: { "/package.json": "{}" } } }),
  );
  // The built demo the view frames, and the probe behind the status dot.
  await page.route(`**/d/${SAVED_ID}/**`, (route) => route.fulfill({ body: "<p>demo</p>", contentType: "text/html" }));
}

test("full mode on a saved demo shows its title and description", async ({ page }) => {
  await stubSavedFull(page, "Row striping across a frozen column");
  await page.goto(`/share/${SAVED_ID}?mode=full`);

  await expect(page.getByText("A saved demo")).toBeVisible();
  await expect(page.locator("[data-demo-description]")).toHaveText("Row striping across a frozen column");
});

test("full mode draws no caption for a demo without a description", async ({ page }) => {
  await stubSavedFull(page, null);
  await page.goto(`/share/${SAVED_ID}?mode=full`);

  // The title is the precondition: it proves the metadata landed, so an absent
  // caption is a choice rather than a fetch that never resolved.
  await expect(page.getByText("A saved demo")).toBeVisible();
  await expect(page.getByRole("button", { name: MINIMIZE })).toBeVisible();
  await expect(page.locator("[data-demo-description]")).toHaveCount(0);
});

test("a pasted ?mode=full link boots straight into full mode", async ({ page }) => {
  await openPlayground(page, "?example=react&mode=full");

  await expect(page.getByRole("button", { name: MINIMIZE })).toBeVisible();
  await expect(page.locator(SPLITTER)).not.toBeVisible();

  // And it is still the live workspace, so minimize has an editor to return to.
  await page.getByRole("button", { name: MINIMIZE }).click();
  await expect(page.locator(SPLITTER)).toBeVisible();
});
