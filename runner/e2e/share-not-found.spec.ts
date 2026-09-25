import { test, expect, type Page } from "@playwright/test";

// `/share/<bad>` used to show "entry file /index.html not found in example
// files" for a demo id that doesn't resolve — confusing, and not even about
// the actual problem (there's no demo, not a bad entry file). Root cause: on a
// failed `GET /api/demos/:id/source`, the loader (App.tsx) set a friendly
// `errorMessage` and flipped `sourceLoaded` true, but never called
// `loadWorkspace` — so `files`/`entry` stayed at their placeholder value
// (`entry.entry` set, `files: {}`, from `toPlaceholderEntry`). `sourceLoaded`
// flipping true is what un-gates rendering EditorShell, whose preview-mount
// effect then ran against that still-empty, inconsistent placeholder and threw
// its OWN "entry file … not found" error, overwriting the friendly message
// with nothing ever having rendered it.
//
// The fix short-circuits the render on a 404/410 (same pattern `docsNotFound`
// already uses for the docs-example loader) before EditorShell — and hence its
// mount effect — is ever reached.
//
// Deterministic: both `/api/demos/:id/source` and `/api/demos/:id` are
// stubbed, so this needs no real API worker — same approach as
// saved-demo-version.spec.ts, runs against the local `vite preview`.

const DEMO_ID = "e2ezzznope1";

async function stubMissingDemo(page: Page, { metaStatus }: { metaStatus: 404 | 410 }) {
  await page.route("**/api/versions", (route) =>
    route.fulfill({ json: { latest: "18.0.0", next: "19.0.0-next.1", versions: ["18.0.0", "17.1.0"] } }),
  );
  await page.route("**/api/demos/**", (route) => {
    const isSource = new URL(route.request().url()).pathname.endsWith("/source");
    if (isSource) {
      // getDemoSource collapses "never existed" and "revoked" to the same 404
      // (index.ts's own comment: "revoked demos return 404") — this route
      // never answers 410, matching production.
      return route.fulfill({ status: 404, json: { error: "not found" } });
    }
    return route.fulfill({
      status: metaStatus,
      json: metaStatus === 410 ? { error: "revoked" } : { error: "not found" },
    });
  });
  await page.route("https://sandpack.codesandbox.io/**", (route) => route.abort());
  await page.route("https://sandpack-bundler.codesandbox.io/**", (route) => route.abort());
  await page.route("**/broker/login**", (route) => route.abort());
}

test("a share link to a demo id that never existed says so, not 'entry file not found'", async ({ page }) => {
  await stubMissingDemo(page, { metaStatus: 404 });
  await page.goto(`/share/${DEMO_ID}`);

  await expect(page.getByText("Demo not found")).toBeVisible();
  await expect(page.getByText(/entry file/i)).toHaveCount(0);
  await expect(page.getByText(/not found in example files/i)).toHaveCount(0);
});

test("a share link to a revoked demo says it was removed, not 'entry file not found'", async ({ page }) => {
  await stubMissingDemo(page, { metaStatus: 410 });
  await page.goto(`/share/${DEMO_ID}`);

  await expect(page.getByText("This demo was removed")).toBeVisible();
  await expect(page.getByText(/entry file/i)).toHaveCount(0);
  await expect(page.getByText(/not found in example files/i)).toHaveCount(0);
});
