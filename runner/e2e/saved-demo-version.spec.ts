// What the editor does with a saved demo's Handsontable version (DEV-2565).
//
// Demos created over the MCP before that fix hold the literal string "latest" in
// `demos.ht_version`, which `validateHandsontableVersion` rejects — and the editor
// adopts whatever version it is handed *and* suppresses its own latest-fallback,
// so the sentinel used to render the boot refusal `handsontable-version must be
// semver-valid or a pkg.pr.new id/URL` (Sentry DEMOS-1X).
//
// The API repairs it on the source route (`editorVersionRef`), so these two tests
// pin the client half of that contract: the field's *presence* is the answer.
// `htVersion: null` means "nothing to say, resolve latest yourself" — reading it
// as falsy and falling back to `meta.ht_version` puts the sentinel straight back.

import { test, expect, type Page } from "@playwright/test";

const SAVED_ID = "e2ever0001";
const DEMO_FILES = {
  "/package.json": JSON.stringify({ dependencies: { handsontable: "^18.0.0" } }),
  "/src/App.jsx": "export default () => null;\n",
};

/** A read-only share locks the version, so the bar prints it as text instead of
 *  rendering the picker button. */
/*  `.first()`: the preview bar and the status bar both print it. */
const versionLabel = (page: Page, version: string) =>
  page.getByText(`Handsontable ${version}`).first();

/**
 * A saved demo whose row still carries the sentinel, and whose snapshot answers
 * `htVersion` the way the repaired API does.
 */
async function stubSavedDemo(page: Page, htVersion: string | null) {
  await page.route("**/api/versions", (route) =>
    route.fulfill({ json: { latest: "18.0.0", next: "19.0.0-next.1", versions: ["18.0.0", "17.1.0"] } }),
  );
  await page.route("**/api/demos/**", (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith("/source")
        ? { framework: "react", files: DEMO_FILES, htVersion }
        : { title: "Saved demo", description: null, ht_version: "latest", created_at: null },
    }),
  );
  // No live bundler in CI, and the boot is not what these tests are about.
  await page.route("https://sandpack.codesandbox.io/**", (route) => route.abort());
  await page.route("https://sandpack-bundler.codesandbox.io/**", (route) => route.abort());
  await page.route("**/broker/login**", (route) => route.abort());
}

const refusal = (page: Page) => page.getByText(/semver-valid or a pkg\.pr\.new id\/URL/);

test("a snapshot with nothing to pin resolves the latest version instead of refusing to boot", async ({ page }) => {
  await stubSavedDemo(page, null);
  await page.goto(`/share/${SAVED_ID}`);

  await expect(versionLabel(page, "18.0.0")).toBeVisible();
  await expect(refusal(page)).toHaveCount(0);
});

test("the repaired ref from the snapshot wins over the sentinel in the row", async ({ page }) => {
  await stubSavedDemo(page, "13106");
  await page.goto(`/share/${SAVED_ID}`);

  await expect(versionLabel(page, "13106")).toBeVisible();
  await expect(refusal(page)).toHaveCount(0);
});
