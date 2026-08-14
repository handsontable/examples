import { test, expect, type Page } from "@playwright/test";

// The in-app guide (`/guide`, DEV-2503; role-based tracks, DEV-2522).
//
// The content is `runner/docs/guide/*.md`, imported raw and rendered by the app's
// markdown renderer. What is worth asserting is that it is gated, that it *renders*
// (rather than showing literal markdown), that each audience can find its own track,
// and that a section deeplink lands on that section — the guide's whole point is that
// you can paste one at someone.

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

test("the overview offers one track per audience", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await page.goto("/guide");

  await expect(page.getByRole("heading", { name: "Using demos.handsontable.com" })).toBeVisible();

  // The four cards, by the audience each one names — that division is the feature.
  for (const audience of ["Everyone · non-technical", "Support", "DevRel", "Developers"]) {
    await expect(page.getByText(audience, { exact: true })).toBeVisible();
  }

  // The overview's own prose renders (headings parsed, not literal `##`), including
  // the URL table every track refers back to.
  await expect(page.getByRole("heading", { name: "Useful URLs" })).toBeVisible();
  await expect(page.locator("table").first()).toBeVisible();
  await expect(page.locator("main")).toContainText("/embed/<id>/");

  const body = await page.locator("main").innerText();
  expect(body).not.toContain("|-----|");
  expect(body).not.toMatch(/\*\*[A-Za-z]/);
  expect(body).not.toMatch(/^#{1,4} /m);
});

test("each track renders its own document, and only its own", async ({ page }) => {
  await stubShell(page);
  await signIn(page);

  await page.goto("/guide/everyone");
  await expect(page.getByRole("heading", { name: "Ask Claude for a demo", level: 1 })).toBeVisible();
  await expect(page.locator("main")).toContainText("Handsontable MCP");
  // The two subjects that must not bleed across tracks.
  await expect(page.locator("main")).not.toContainText("pkg.pr.new");

  await page.goto("/guide/support");
  await expect(
    page.getByRole("heading", { name: "Build a demo in the browser", level: 1 }),
  ).toBeVisible();
  await expect(page.locator("main")).toContainText("CodeSandbox cannot be imported");
  await expect(page.locator("main")).not.toContainText("pkg.pr.new");

  await page.goto("/guide/devrel");
  await expect(
    page.getByRole("heading", { name: "Demos in the documentation and on the blog", level: 1 }),
  ).toBeVisible();
  await expect(page.locator("main")).toContainText("<iframe");

  await page.goto("/guide/developers");
  await expect(page.locator("main")).toContainText("pkg.pr.new");
  await expect(page.getByRole("heading", { name: "Demo an unreleased fix: the PR number as the version" })).toBeVisible();
});

test("a section deeplink scrolls to that section", async ({ page }) => {
  await stubShell(page);
  await signIn(page);

  // The anchor a reader would have copied out of the contents list.
  await page.goto("/guide/support#7-title-and-description");
  const heading = page.locator("#\\37 -title-and-description");
  await expect(heading).toHaveText("7. Title and description");
  // In the viewport, which is what "the link works" means — the ids exist for
  // scrolling, not for the DOM's benefit.
  await expect(heading).toBeInViewport();

  // And the contents list is the surface those links come from.
  const contents = page.getByRole("complementary", { name: /Contents of/ });
  await expect(contents.getByRole("link", { name: "7. Title and description" })).toBeVisible();
});

test("the tracks are reachable from each other, and from the overview", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await page.goto("/guide");

  await page.getByRole("link", { name: /Docs & blog/ }).click();
  await expect(page).toHaveURL(/\/guide\/devrel$/);

  // The switcher on a track page, which is how someone lands on the wrong one and
  // recovers without going back to the overview.
  await page.getByRole("navigation", { name: "Guide tracks" })
    .getByRole("link", { name: "PR builds & tooling" })
    .click();
  await expect(page).toHaveURL(/\/guide\/developers$/);
  await expect(page.getByRole("navigation", { name: "Guide tracks" })
    .getByRole("link", { name: "PR builds & tooling" })).toHaveAttribute("aria-current", "page");
});

test("a cross-track link is a same-tab link, and the cards take a hover border", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await page.goto("/guide/support");

  // The tracks refer to each other in prose. Two things have to hold: the markdown
  // link became a link at all (the parser only admits absolute URLs and paths), and
  // it does not open a tab — a reader following three cross-references would
  // otherwise end up with three windows.
  const cross = page.locator("main").getByRole("link", { name: "Developers track" });
  await expect(cross).toHaveAttribute("href", "/guide/developers");
  await expect(cross).not.toHaveAttribute("target", /.+/);
  await cross.click();
  await expect(page).toHaveURL(/\/guide\/developers$/);

  // The overview's cards keep their resting border in the stylesheet, so the hover
  // rule can change it (ADR-0026: an inline `border` shorthand would win instead).
  await page.goto("/guide");
  const card = page.getByRole("link", { name: /Ask Claude/ }).first();
  const resting = await card.evaluate((el) => getComputedStyle(el).borderTopColor);
  await card.hover();
  await expect
    .poll(() => card.evaluate((el) => getComputedStyle(el).borderTopColor))
    .not.toBe(resting);
});

test("a stale track link lands on the overview and says so", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await page.goto("/guide/marketing");

  await expect(page.getByRole("status")).toContainText("does not exist");
  await expect(page.getByRole("heading", { name: "Using demos.handsontable.com" })).toBeVisible();
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

test("an anonymous visitor is sent to the broker with the track path preserved", async ({ page }) => {
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

  await page.goto("/guide/developers");

  await expect.poll(() => brokerUrls.length).toBeGreaterThan(0);
  // The *track*, not just `/guide`: a link into one section is the thing people
  // click, and losing it on sign-in dumps them on the overview.
  expect(decodeURIComponent(brokerUrls[0]!)).toContain("return_to=");
  expect(decodeURIComponent(brokerUrls[0]!)).toContain("/guide/developers");
  // …and the document itself never rendered for the stranger.
  await expect(page.locator("main")).toHaveCount(0);
});
