import { test, expect, type Page } from "@playwright/test";
import { activeEditor, workspaceFiles } from "./helpers";

// Typing in the code editor must never lose focus to the preview. Every Tier-1
// keystroke recompiles the sandbox and re-evaluates the demo module inside the
// cross-origin Sandpack iframe; a demo that focuses something as it boots —
// `hot.selectCells()`, `hot.listen()`, any `element.focus()` — then pulls browser
// focus out of CodeMirror mid-sentence, and the rest of the keystrokes land in a
// grid cell. The guard is `EditorShell`'s window-blur listener: a focus grab by a
// subframe within a keystroke of typing is theft, and focus goes straight back.
//
// Asserted through where the keystrokes *land*, never through `document.activeElement`:
// Chromium is not consistent about that value across a cross-origin grab (see the
// guard's comment) — on the builds where it goes stale, an activeElement assertion
// stays green while every keystroke is already routing into the frame.
//
// Live — the theft needs the real cross-origin bundler frame: a same-origin stub
// could never move browser focus the way the production preview does. Opt-in via
// E2E_LIVE=1, like the other render checks.

const previewStatus = (page: Page) => page.locator('[aria-label="Preview"]');

test("live: typing through a preview rebuild keeps focus in the editor", async ({ page }) => {
  test.skip(process.env.E2E_LIVE !== "1", "set E2E_LIVE=1 to run live-render checks");
  test.setTimeout(180_000);

  await page.goto("/?example=javascript");
  await expect(previewStatus(page)).toHaveAttribute("data-preview-status", "ready", {
    timeout: 120_000,
  });
  await expect(page.frameLocator("iframe").first().locator(".handsontable td").first()).toBeVisible({
    timeout: 90_000,
  });

  // Make the demo grab focus the way the reported one did (`selectCells()` on
  // boot): append a line that focuses an element on every module evaluation. A
  // plain <input> rather than a Handsontable API, so the trigger cannot drift
  // with grid behavior across versions.
  const editor = activeEditor(page);
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(
    "\nconst stealer = document.createElement('input'); document.body.append(stealer); stealer.focus();",
  );

  // Let that line's own rebuild (and its first grab) land before the part under
  // test, so the assertions below measure the typing phase alone.
  await page.waitForTimeout(4_000);
  await editor.click();

  // Type the way a user does — continuously, at a human cadence — so at least one
  // re-evaluation (and its focus grab) lands mid-sentence.
  const marker = "focus stays in the editor 0123456789";
  await page.keyboard.type(`\n// ${marker}`, { delay: 120 });

  // Give the last keystroke's rebuild time to run the stealer once more, then keep
  // typing WITHOUT re-clicking the editor. The tail proves the end state — focus was
  // back with the editor after the final grab, not merely never lost before it.
  await page.waitForTimeout(3_000);
  const tail = "and stays there";
  await page.keyboard.type(` ${tail}`, { delay: 120 });

  // The whole sentence, in the file, in one piece: no keystroke ever landed in the
  // preview on the way.
  const files = await workspaceFiles(page);
  expect(files["/index.js"]).toContain(`// ${marker} ${tail}`);
});
