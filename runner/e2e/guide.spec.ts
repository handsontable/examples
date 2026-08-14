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

test("prose wraps to the window, not to the markdown's line endings", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await page.goto("/guide/support");
  // Wait for the document, not the shell: the count below is a one-shot assertion, and
  // the page is a splash until the identity resolves.
  await expect(
    page.getByRole("heading", { name: "Build a demo in the browser", level: 1 }),
  ).toBeVisible();

  // The docs are hard-wrapped at ~88 columns so their diffs are reviewable. That is a
  // file-format detail: rendered with `pre-wrap` (which the chat panel needs) every
  // one of those wraps became a line break on screen, and the prose broke mid-sentence
  // at a width nobody's window happens to be.
  //
  // Paragraphs holding a figure are skipped: the image is a block element inside the
  // paragraph, so `innerText` reports a newline around it no matter how text wraps.
  const paragraphs = page.locator("main article p:not(:has(img))");
  const count = await paragraphs.count();
  expect(count).toBeGreaterThan(10);
  for (let i = 0; i < count; i += 1) {
    const text = await paragraphs.nth(i).innerText();
    expect(text, `paragraph ${i} kept the source's line endings`).not.toContain("\n");
  }
});

test("each track renders its own document, and only its own", async ({ page }) => {
  await stubShell(page);
  await signIn(page);

  await page.goto("/guide/everyone");
  await expect(page.getByRole("heading", { name: "Ask Claude for a demo", level: 1 })).toBeVisible();
  await expect(page.locator("main")).toContainText("Handsontable MCP");
  // The one instruction on this track that cannot be dropped: a demo that builds is
  // not a demo that works, and this reader never sees the code.
  await expect(page.getByRole("heading", { name: "Open the link before you send it" })).toBeVisible();
  await expect(page.locator("main")).toContainText("builds is not the same as a demo that works");
  // Both tools, both named in the prompts a reader will copy.
  await expect(page.locator("main")).toContainText("Load create_demo, then create a demo");
  await expect(page.getByRole("heading", { name: "Changing a demo, also by asking" })).toBeVisible();
  await expect(page.locator("main")).toContainText("Load update_demo, then make the Overdue rows red");
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

test("prompt blocks read as something you type, and never overflow", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await page.goto("/guide/everyone");
  await expect(page.getByRole("heading", { name: "Ask Claude for a demo", level: 1 })).toBeVisible();

  const prompt = page.locator("main article pre").first();
  await expect(prompt).toContainText("Load create_demo");

  const box = await prompt.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      radius: parseFloat(s.borderTopLeftRadius),
      padding: parseFloat(s.paddingLeft),
      wrap: s.whiteSpace,
      scrollable: el.scrollWidth - el.clientWidth,
      bg: s.backgroundColor,
      bodyBg: getComputedStyle(document.body).backgroundColor,
    };
  });
  // A card, not a terminal line: rounded, padded, its own fill, and wrapping rather
  // than a horizontal scrollbar — a prompt that runs off the edge is one nobody copies
  // whole.
  expect(box.radius).toBeGreaterThanOrEqual(4);
  expect(box.padding).toBeGreaterThanOrEqual(10);
  expect(box.wrap).toBe("pre-wrap");
  expect(box.scrollable).toBe(0);
  expect(box.bg).not.toBe(box.bodyBg);
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

test("the left panel carries the tracks as a submenu under Guide", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await page.goto("/guide");

  // From the overview's cards…
  await page.locator("main").getByRole("link", { name: /Docs & blog/ }).click();
  await expect(page).toHaveURL(/\/guide\/devrel$/);

  // …and from then on, from the sidebar: four rows nested under Guide, the current
  // one marked. This is how someone who landed on the wrong track recovers without
  // going back to the overview.
  const tracks = page.getByRole("navigation", { name: "Guide tracks" });
  for (const label of ["Ask Claude", "In the browser", "Docs & blog", "PR builds & tooling"]) {
    await expect(tracks.getByRole("link", { name: label })).toBeVisible();
  }
  await expect(tracks.getByRole("link", { name: "Docs & blog" })).toHaveAttribute("aria-current", "page");

  await tracks.getByRole("link", { name: "PR builds & tooling" }).click();
  await expect(page).toHaveURL(/\/guide\/developers$/);
  await expect(tracks.getByRole("link", { name: "PR builds & tooling" })).toHaveAttribute("aria-current", "page");

  // The submenu belongs to the page you are on: My demos does not carry the guide's
  // sections.
  await page.goto("/my-demos");
  await expect(page.getByRole("navigation", { name: "Guide tracks" })).toHaveCount(0);
});

test("the tracks carry figures, loaded lazily and only where they belong", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await page.goto("/guide/support");

  const shots = page.locator("main img");
  expect(await shots.count()).toBeGreaterThanOrEqual(6);
  // Lazy, because the screencast alone is a couple of megabytes and the reader may
  // never scroll to it.
  await expect(shots.first()).toHaveAttribute("loading", "lazy");
  // Real alt text, not a filename: this page is read by people who need it read out.
  for (const img of await shots.all()) {
    expect((await img.getAttribute("alt"))?.length ?? 0).toBeGreaterThan(12);
  }
  // The one that has to actually be there: the file drop, which is impossible to
  // describe in words alone.
  await expect(page.locator('main img[src="/guide/files-drop.jpg"]')).toBeVisible();
  // And it resolves — a 404 here renders as a broken frame in the middle of the prose.
  const status = await page.evaluate(async () =>
    (await fetch("/guide/files-drop.jpg", { method: "HEAD" })).status,
  );
  expect(status).toBe(200);

  // DevRel's track is prose and code, and stays that way — the figures follow the
  // subject, they are not decoration sprinkled on every page.
  await page.goto("/guide/devrel");
  await expect(page.locator("main img")).toHaveCount(0);
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
  const card = page.locator("main").getByRole("link", { name: /Ask Claude/ });
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
