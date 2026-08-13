import { test, expect, type Page } from "@playwright/test";

// The in-app guide (`/guide`, DEV-2503).
//
// The content is `runner/docs/create-and-share-a-demo.md`, imported raw and
// rendered by the app's markdown renderer. What is worth asserting is that it is
// gated, that it *renders* (rather than showing literal markdown), and that it is
// reachable from the account menu — a page nobody can find is not a guide.

const EMAIL = "dev@handsontable.com";

async function stubShell(page: Page) {
  await page.route("**/api/versions", (route) =>
    route.fulfill({ json: { latest: "18.0.0", next: "19.0.0-next.1", versions: ["18.0.0"] } }),
  );
  await page.route("https://sandpack.codesandbox.io/**", (route) => route.abort());
  await page.route("https://sandpack-bundler.codesandbox.io/**", (route) => route.abort());
  await page.route("**/broker/login**", (route) => route.abort());
}

async function signIn(page: Page) {
  await page.addInitScript(() => sessionStorage.setItem("hot_token", "e2e-token"));
  await page.route("**/broker/userinfo", (route) => route.fulfill({ json: { email: EMAIL } }));
}

test("the guide renders the doc as formatted text", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await page.goto("/guide");

  // The document's own headings, which only appear if the markdown was parsed.
  await expect(page.getByText("Using demos.handsontable.com", { exact: true })).toBeVisible();
  for (const section of [
    "1. Pick a starting point",
    "4. Import a demo from somewhere else",
    "5. Publish a demo from your own machine",
    "8. Save, fork, share, embed",
    "10. Useful URLs",
  ]) {
    await expect(page.getByText(section, { exact: true })).toBeVisible();
  }

  // A table of URLs, not a wall of pipes: the renderer builds a real table.
  await expect(page.locator("table")).toBeVisible();
  await expect(page.locator("table")).toContainText("/embed/ab12cd34/");

  // And no leaked syntax anywhere on the page.
  const body = await page.locator("main").innerText();
  expect(body).not.toContain("|-----|");
  expect(body).not.toMatch(/\*\*[A-Za-z]/);
  expect(body).not.toMatch(/^## /m);
});

test("the guide is reachable from the account menu", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await page.goto("/?example=react");
  // Wait for the starter to land before opening the menu: the top bar re-renders
  // when the workspace loads, which remounts the account menu and closes it —
  // clicking during the load looks like a missing row.
  await expect(page.getByRole("region", { name: "Files" }).locator('button[title="/src/index.tsx"]')).toBeVisible();

  await page.getByRole("button", { name: `Account: ${EMAIL}` }).click();
  // `menuitem`, not `button`: `AccountMenu` overrides the implicit role on every
  // row, so a role=button locator matches nothing however the label reads.
  const guide = page.getByRole("menuitem", { name: "Guide" });
  await expect(guide).toBeVisible();
  await guide.click();
  await expect(page).toHaveURL(/\/guide$/);
});

test("an anonymous visitor is sent to the broker with /guide preserved", async ({ page }) => {
  // Asserted the way settings.spec.ts does it: the observable behaviour of a gated
  // route is the broker call it makes, not the splash it shows on the way — the
  // splash is a frame the redirect is already leaving.
  await stubShell(page);
  await page.route("**/broker/userinfo", (route) => route.fulfill({ status: 401, json: {} }));
  const brokerUrls: string[] = [];
  await page.unroute("**/broker/login**");
  await page.route("**/broker/login**", (route) => {
    brokerUrls.push(route.request().url());
    return route.abort();
  });

  await page.goto("/guide");

  await expect.poll(() => brokerUrls.length).toBeGreaterThan(0);
  expect(decodeURIComponent(brokerUrls[0]!)).toContain("return_to=");
  expect(decodeURIComponent(brokerUrls[0]!)).toContain("/guide");
  // …and the document itself never rendered for the stranger.
  await expect(page.getByText("Using demos.handsontable.com", { exact: true })).toHaveCount(0);
});
