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

  // The editor side is gone: no splitter, no editor pane, no file sidebar.
  await expect(page.locator(SPLITTER)).toHaveCount(0);
  await expect(page.locator("[data-pane-active]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /sidebar/i })).toHaveCount(0);

  // `FullBar` replaces `PreviewBar`: minimize in, version pill out.
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

test("a pasted ?mode=full link boots straight into full mode", async ({ page }) => {
  await openPlayground(page, "?example=react&mode=full");

  await expect(page.getByRole("button", { name: MINIMIZE })).toBeVisible();
  await expect(page.locator(SPLITTER)).toHaveCount(0);

  // And it is still the live workspace, so minimize has an editor to return to.
  await page.getByRole("button", { name: MINIMIZE }).click();
  await expect(page.locator(SPLITTER)).toBeVisible();
});
