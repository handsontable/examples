import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";
import { activeEditor, expectGridRendered, previewReady, stubShell } from "./helpers";

// The two editor promises nothing was proving (DEV-2203):
//
// 1. Download hands over the workspace *as edited*. In play and share modes the
//    zip is the only way out with your changes — the button even highlights to
//    say so — yet no test ever opened one. The zip is built client-side with
//    fflate (App.tsx downloadWorkspaceZip), so this is deterministic: no
//    bundler, no API, runs in PR CI.
//
// 2. A plain content edit reaches the rendered grid. preview-recovery.spec.ts
//    proves error → recovery round-trips and style-apply.spec.ts proves theme
//    modules land, but "type a thing, see the thing" — the whole point of the
//    editor — was only ever implied. Needs the live bundler, so E2E_LIVE.

const MARKER = "// e2e-download-marker";

/** Insert text at the top of the visible editor through CodeMirror's own
 *  dispatch — `.cm-content` is contenteditable but virtualised, so typing via
 *  the keyboard depends on scroll position while a dispatch does not. */
async function insertAtTop(page: Page, text: string) {
  await activeEditor(page).waitFor();
  await page.evaluate(`(() => {
    const view = document.querySelector('[data-pane-active="true"] .cm-content').cmTile.view;
    view.dispatch({ changes: { from: 0, insert: ${JSON.stringify(text + "\n")} } });
  })()`);
}

test("Download zips the workspace including an unsaved edit", async ({ page }) => {
  await stubShell(page);
  await page.goto("/?example=react");
  await insertAtTop(page, MARKER);

  // The edit marks the workspace dirty, so the button gains its "•" nudge —
  // waiting for it doubles as "the edit reached the files state".
  const download1 = page.waitForEvent("download");
  await page.getByRole("button", { name: /^Download( •)?$/ }).click();
  const download = await download1;

  expect(download.suggestedFilename()).toBe("react-vite-ts.zip");

  const zipPath = await download.path();
  const entries = unzipSync(readFileSync(zipPath!));

  // Paths in the zip lose their leading slash — `/src/index.tsx` unzips to a
  // real relative path, not a root-anchored one.
  const paths = Object.keys(entries);
  expect(paths).toContain("src/index.tsx");
  expect(paths).toContain("package.json");
  expect(paths.some((p) => p.startsWith("/"))).toBe(false);

  expect(strFromU8(entries["src/index.tsx"])).toContain(MARKER);
});

test("an edit to the example reaches the rendered grid", async ({ page }) => {
  test.skip(process.env.E2E_LIVE !== "1", "set E2E_LIVE=1 to run live-render checks");
  test.setTimeout(240_000);

  await page.goto("/?example=react");
  await previewReady(page, "sandpack");
  await expectGridRendered(page);

  // Rename the first column header. A header is asserted by its text, so the
  // check cannot pass by accident the way a data cell's value could.
  await activeEditor(page).waitFor();
  await page.evaluate(`(() => {
    const view = document.querySelector('[data-pane-active="true"] .cm-content').cmTile.view;
    const doc = view.state.doc.toString();
    const at = doc.indexOf("'Company name'");
    if (at < 0) throw new Error("fixture changed: 'Company name' not found in the react starter");
    view.dispatch({ changes: { from: at, to: at + "'Company name'".length, insert: "'E2E header'" } });
  })()`);

  const renamed = page.frameLocator('iframe[title="Demo preview"]').locator("th", { hasText: "E2E header" });
  await expect(async () => {
    expect(await renamed.count()).toBeGreaterThan(0);
  }).toPass({ timeout: 90_000 });
});
