import { test, expect, type Page } from "@playwright/test";

// A demo that exports a file has to be able to hand it over (DEV-2203, reported by
// Aleksandra).
//
// The preview runs in a sandboxed iframe. Chrome blocks downloads started inside one
// unless the sandbox lists `allow-downloads`, and it blocks them *silently*: the demo
// builds the `.xlsx`, the anchor click does nothing, and the only trace is a console
// line. So an `ExportFile` demo looked like a Handsontable bug rather than a frame
// policy — which is the expensive kind of wrong.
//
// Asserted on the attribute rather than on a real download: the frames are ours and
// the policy is the whole fix, so this fails the moment somebody rewrites the sandbox
// list without thinking about it. A live download check would need the external
// bundler and a demo with an export button, and would tell us the same thing.

const EMAIL = "dev@handsontable.com";
const REQUIRED = [
  "allow-scripts",
  "allow-same-origin",
  "allow-forms",
  "allow-popups",
  "allow-modals",
  "allow-downloads",
];

async function stubShell(page: Page) {
  await page.route("**/api/versions", (route) =>
    route.fulfill({ json: { latest: "18.0.0", next: "19.0.0-next.1", versions: ["18.0.0"] } }),
  );
  // The bundler is not needed: the frame exists before anything is bundled into it.
  await page.route("https://sandpack.codesandbox.io/**", (route) => route.abort());
  await page.route("https://sandpack-bundler.codesandbox.io/**", (route) => route.abort());
  await page.route("**/broker/login**", (route) => route.abort());
}

test("the playground preview can hand over a downloaded file", async ({ page }) => {
  await stubShell(page);
  await page.goto("/?example=javascript");

  const frame = page.locator('iframe[title="Demo preview"]');
  await expect(frame).toBeAttached();
  const sandbox = (await frame.getAttribute("sandbox")) ?? "";
  for (const token of REQUIRED) {
    expect(sandbox.split(/\s+/), `preview sandbox is missing ${token}`).toContain(token);
  }
});

test("the full-window view can too", async ({ page }) => {
  await stubShell(page);
  await page.addInitScript(() => sessionStorage.setItem("hot_token", "e2e-token"));
  await page.route("**/broker/userinfo", (route) => route.fulfill({ json: { email: EMAIL } }));
  await page.route("**/api/demos/ab12cd34", (route) =>
    route.fulfill({
      json: {
        id: "ab12cd34",
        title: "Export to Excel",
        description: null,
        framework: "javascript",
        ht_version: "18.0.0",
        created_at: "2026-08-14T09:00:00.000Z",
        created_by: EMAIL,
        revoked: 0,
      },
    }),
  );
  await page.route("**/api/demos/ab12cd34/access", (route) =>
    route.fulfill({ json: { owned: true, revoked: false } }),
  );
  // The built page the frame points at; its content does not matter here.
  await page.route("**/d/ab12cd34/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>demo</title>" }),
  );

  await page.goto("/share/ab12cd34?mode=full");

  const frame = page.locator('iframe[title="Handsontable demo"]');
  await expect(frame).toBeAttached();
  const sandbox = (await frame.getAttribute("sandbox")) ?? "";
  for (const token of REQUIRED) {
    expect(sandbox.split(/\s+/), `full-window sandbox is missing ${token}`).toContain(token);
  }
});
