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
//
// 3. (DEV-2530 item 4) The FILES-header download button (FileTree.tsx) hands
//    over the *same* zip as the top bar — same entries, same bytes, same
//    filename. Deterministic for the same reason as 1.

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

/** Click a download control and hand back the zip, unpacked. Factored from the
 *  inline pattern in the first test (waitForEvent → click → path → unzipSync)
 *  because the parity test below needs it twice in one run. */
async function downloadZipVia(page: Page, button: ReturnType<Page["getByRole"]>) {
  const event = page.waitForEvent("download");
  await button.click();
  const download = await event;
  const zipPath = await download.path();
  return { filename: download.suggestedFilename(), entries: unzipSync(readFileSync(zipPath!)) };
}

test("the FILES-header download hands over the same zip as the top bar", async ({ page }) => {
  // The promise: the little download icon on the FILES header (FileTree.tsx)
  // is the same exit as the big top-bar Download — one workspace, one zip,
  // whichever control you reach for. Today both wire to the one `downloadZip`
  // callback in App.tsx; this test is the tripwire for the day the sidebar
  // button grows its own zipper (say, one that reads the saved snapshot
  // instead of the live files) and the two exits quietly diverge.
  //
  // The oracle is entry names + per-entry decompressed bytes, NOT whole-zip
  // byte equality: fflate stamps each entry's header with an mtime that
  // defaults to "now" at zip time, so two zips of identical files built
  // milliseconds apart can legitimately differ as raw bytes. Decompressed
  // entry content carries no timestamp, so comparing it is exact and stable.
  await stubShell(page);
  await page.goto("/?example=react");
  await insertAtTop(page, MARKER);

  // Same anchored name as the first test — matches with or without the
  // unsaved-work "•", never the sidebar button's longer name.
  const topBar = await downloadZipVia(page, page.getByRole("button", { name: /^Download( •)?$/ }));

  // The FILES-header button is icon-only; its accessible name is its `title`
  // (the icon itself is aria-hidden — icons/ui.tsx labels live on the button).
  const filesHeader = await downloadZipVia(
    page,
    page.getByRole("button", { name: "Download this workspace (including your edits) as a .zip" }),
  );

  // Same suggested filename — a sidebar zip named differently would fail the
  // "same hand-over" promise even with identical contents.
  expect(filesHeader.filename).toBe(topBar.filename);

  // Identical entry *lists* first: a missing or extra file is a clearer
  // failure than a byte mismatch on whatever entry the loop reached first.
  const topPaths = Object.keys(topBar.entries).sort();
  expect(Object.keys(filesHeader.entries).sort()).toEqual(topPaths);

  // The marker must be in BOTH zips — without this, two zips that both lost
  // the unsaved edit would still compare equal and the test would pass vacuously.
  expect(strFromU8(topBar.entries["src/index.tsx"])).toContain(MARKER);
  expect(strFromU8(filesHeader.entries["src/index.tsx"])).toContain(MARKER);

  // Per-entry byte equality across the whole workspace (superset of the marker
  // file). Buffer.equals rather than toEqual keeps a failure to one named path
  // instead of a screenful of diffed typed arrays.
  for (const p of topPaths) {
    expect(
      Buffer.from(filesHeader.entries[p]).equals(Buffer.from(topBar.entries[p])),
      `zip entry "${p}" differs between the FILES-header and top-bar downloads`,
    ).toBe(true);
  }
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
