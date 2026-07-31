import { test, expect, type Page } from "@playwright/test";

// The editor/preview splitter (DEV-2160 / T6). Deterministic — no `E2E_LIVE=1`:
// `PreviewPane` renders its <iframe> unconditionally, and an empty frame swallows
// pointer events exactly as a live one does, so the drag-over-iframe case is real
// here. The Sandpack bundler is aborted so nothing external is needed.

const SPLITTER = "[data-splitter]";

async function openPlayground(page: Page) {
  await page.route("**/api/versions", (route) =>
    route.fulfill({ json: { latest: "18.0.0", next: "19.0.0-next.1", versions: ["18.0.0", "17.1.0"] } }),
  );
  await page.route("https://sandpack.codesandbox.io/**", (route) => route.abort());
  await page.route("https://sandpack-bundler.codesandbox.io/**", (route) => route.abort());
  // No storage reset needed — each test gets a fresh context, so `hot-split` is
  // absent and the seam starts at the designed 50%. (An `addInitScript` reset
  // would also run on `page.reload()` and silently defeat the persistence test.)
  await page.goto("/?example=react");
  await expect(page.locator(SPLITTER)).toBeVisible();
  // The frame the drag has to survive.
  await expect(page.frameLocator("iframe[title='Demo preview']").owner()).toBeVisible();
}

/** Left edge of the 1px splitter track. */
async function seamX(page: Page): Promise<number> {
  const box = await page.locator(SPLITTER).boundingBox();
  if (!box) throw new Error("splitter has no box");
  return box.x;
}

/** Drag the seam by `dx`. `steps` matters: a single jump can emit no intermediate
 *  pointermove at all, and the handler only acts on moves. */
async function dragSeam(page: Page, dx: number) {
  const box = await page.locator(SPLITTER).boundingBox();
  if (!box) throw new Error("splitter has no box");
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x, y);
  await page.mouse.down();
  await page.mouse.move(box.x + dx, y, { steps: 10 });
  await page.mouse.up();
}

test("dragging the seam over the preview iframe resizes the panes", async ({ page }) => {
  await openPlayground(page);
  const before = await seamX(page);

  // Rightwards: every intermediate position is over the preview iframe.
  await dragSeam(page, 200);

  expect(await seamX(page)).toBeCloseTo(before + 200, -1);
});

test("the ratio survives a reload", async ({ page }) => {
  await openPlayground(page);
  const before = await seamX(page);
  await dragSeam(page, -150);
  const moved = await seamX(page);
  expect(moved).toBeLessThan(before);

  await page.reload();
  await expect(page.locator(SPLITTER)).toBeVisible();
  expect(await seamX(page)).toBeCloseTo(moved, -1);
});

test("the seam holds still when the sidebar is toggled", async ({ page }) => {
  await openPlayground(page);
  const before = await seamX(page);
  await page.getByRole("button", { name: /sidebar/i }).click();
  expect(await seamX(page)).toBeCloseTo(before, -1);
});

test("double-click restores the designed split", async ({ page }) => {
  await openPlayground(page);
  const designed = await seamX(page);
  await dragSeam(page, 180);
  expect(await seamX(page)).toBeGreaterThan(designed);

  await page.locator(SPLITTER).dblclick();
  expect(await seamX(page)).toBeCloseTo(designed, -1);
});
