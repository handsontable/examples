import { test, expect } from "@playwright/test";

// The preview must be able to come back. A runtime error in edited code puts the
// pane into `error` (the "The preview could not start" card); fixing the code has
// to clear it again. It did not: `SandpackRuntime.emitReady()` fired at most once
// per mount, so the bundler's next clean `done` — the honest "your fix compiled
// and ran" signal — was swallowed, and the error card outlived the error. The only
// way out was an example switch or a version change, both of which remount.
//
// Live — needs the external Sandpack bundler; opt-in via E2E_LIVE=1, like the
// other render checks.

/** The visible editor. Hidden panes stay mounted (T12), so an unscoped
 *  `.cm-content` would match every open file and resolve in DOM order. */
const activeEditor = (page: import("@playwright/test").Page) =>
  page.locator('[data-pane-active="true"] .cm-content');

const previewStatus = (page: import("@playwright/test").Page) =>
  page.locator('[aria-label="Preview"]');

// Deterministic — no `E2E_LIVE=1`: the session POST is stubbed to a refusal, so the
// error card appears whether or not a real API worker (and container pool) happens to be
// reachable from wherever the suite runs. Without the stub this test passes only when
// nothing answers `/api` — which is true in CI and false on a developer's machine with
// the local worker up.
//
// Tier 2 has no self-healing equivalent of the Tier-1 fix below. A boot failure means
// the container's boot script exited, so its dev server is gone: the fixed file streams
// into a container with nothing left to serve it, and `reload()` (row-2 refresh) bails
// early because the iframe was never pointed. A remount is the only way back, and this
// button is the only thing that asks for one.
test("a failed preview offers a restart that remounts the runtime", async ({ page }) => {
  const sessionPosts: string[] = [];
  await page.route("**/api/session", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    sessionPosts.push(route.request().url());
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "no container slots" }),
    });
  });

  // `react-js` is a container starter; `vue`, despite the name, is Tier 1 (see
  // catalog.json) and boots in-browser with no session at all.
  await page.goto("/?example=react-js");
  await expect(previewStatus(page)).toHaveAttribute("data-preview-status", "error", {
    timeout: 60_000,
  });
  const restart = page.getByRole("button", { name: "Restart preview" });
  await expect(restart).toBeVisible();

  const before = sessionPosts.length;
  expect(before, "the first mount attempted a session").toBeGreaterThan(0);
  await restart.click();
  // A fresh session POST is the observable proof the runtime remounted; asserting on the
  // status attribute alone would pass on a button that did nothing, since the retry ends
  // in the same error here (there is still no worker).
  await expect(async () => {
    expect(sessionPosts.length).toBeGreaterThan(before);
  }).toPass({ timeout: 30_000 });
  await expect(previewStatus(page)).toHaveAttribute("data-preview-status", "error", {
    timeout: 60_000,
  });
});

test("live: fixing a runtime error clears the preview error card", async ({ page }) => {
  test.skip(process.env.E2E_LIVE !== "1", "set E2E_LIVE=1 to run live-render checks");
  test.setTimeout(180_000);

  await page.goto("/?example=react");
  await expect(previewStatus(page)).toHaveAttribute("data-preview-status", "ready", {
    timeout: 120_000,
  });
  await expect(page.frameLocator("iframe").first().locator(".handsontable td").first()).toBeVisible({
    timeout: 90_000,
  });

  // Break it the way a user does: a reference to something that doesn't exist.
  // Compiles clean, throws when the module is evaluated.
  const editor = activeEditor(page);
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("\nconsole.log(alignHeadersTypo);");

  await expect(previewStatus(page)).toHaveAttribute("data-preview-status", "error", {
    timeout: 60_000,
  });
  await expect(page.getByText("The preview could not start")).toBeVisible();

  // Undo the edit — the fix. Select the broken line and remove it, newline and all.
  await page.keyboard.press("Shift+Home");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");

  await expect(previewStatus(page)).toHaveAttribute("data-preview-status", "ready", {
    timeout: 60_000,
  });
  await expect(page.getByText("The preview could not start")).toHaveCount(0);
  // Attribute alone would pass on a blanked pane; the grid has to be back.
  await expect(page.frameLocator("iframe").first().locator(".handsontable td").first()).toBeVisible({
    timeout: 60_000,
  });
});

// The counterpart to the test above: an unsupported version is refused before any runtime
// is built, so a remount would re-run the same refusal. The card has no action, and the
// version picker (still live behind it) is where the fix actually is.
test("a version the runner refuses gets no restart button", async ({ page }) => {
  await page.goto("/?example=react&v=99.99.99");
  await expect(previewStatus(page)).toHaveAttribute("data-preview-status", "error", {
    timeout: 30_000,
  });
  await expect(page.getByText("The preview could not start")).toBeVisible();
  await expect(page.getByRole("button", { name: "Restart preview" })).toHaveCount(0);
});

// The reported Vue case (`VueCompilerError` with a template code frame). It reads like a
// second engine but is not: `vue` is a sandpack starter, so this is the same swallowed-
// `done` bug — through a *compile* error rather than a runtime one. Worth its own test
// because the two arrive differently: a compile failure never evaluates the module, so
// only the `done{compilatonError:true}` + `show-error` pair is seen.
test("live: fixing a Vue template error clears the preview error card", async ({ page }) => {
  test.skip(process.env.E2E_LIVE !== "1", "set E2E_LIVE=1 to run live-render checks");
  test.setTimeout(180_000);

  await page.goto("/?example=vue");
  await expect(previewStatus(page)).toHaveAttribute("data-preview-status", "ready", {
    timeout: 120_000,
  });
  await expect(page.frameLocator("iframe").first().locator(".handsontable td").first()).toBeVisible({
    timeout: 90_000,
  });

  // A second root `<template>` — an SFC compile error, not a runtime one.
  await activeEditor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("\n<template><div /></template>");
  await expect(previewStatus(page)).toHaveAttribute("data-preview-status", "error", {
    timeout: 60_000,
  });

  await page.keyboard.press("Shift+Home");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await expect(previewStatus(page)).toHaveAttribute("data-preview-status", "ready", {
    timeout: 60_000,
  });
  await expect(page.frameLocator("iframe").first().locator(".handsontable td").first()).toBeVisible({
    timeout: 60_000,
  });
});
