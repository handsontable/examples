import { test, expect, type Page } from "@playwright/test";

// Markdown demo descriptions and their editor (DEV-2507).
//
// The toolbar's transforms are unit-tested in pipeline/markdown-actions.test.mjs;
// what matters here is the wiring: the buttons act on the real textarea, the
// preview renders through the app's renderer, and a saved description shows up in
// the sidebar as *formatted output* rather than literal syntax.

const EMAIL = "dev@handsontable.com";
const DEMO_ID = "e2edesc01";

const DEMO_FILES = {
  "/src/App.tsx": "export default function App() { return null; }\n",
  "/index.html": '<div id="root"></div>',
  "/package.json": JSON.stringify({ dependencies: { handsontable: "18.0.0" } }, null, 2),
};

const DESCRIPTION = "What this shows:\n\n- **filters** on the top row\n- a [link](https://handsontable.com)";

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

/** A saved demo whose description is markdown. */
async function stubSavedDemo(page: Page, description: string | null = DESCRIPTION) {
  await page.route("**/api/demos/**", (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith("/source")
        ? { framework: "react", files: DEMO_FILES }
        : { title: "Sales grid", description, ht_version: "18.0.0", created_at: "2026-08-01T10:00:00.000Z" },
    }),
  );
}

const boxInfo = (page: Page) => page.getByRole("region", { name: "Box info" });
const dialog = (page: Page) => page.getByRole("dialog", { name: "Edit info" });
const descriptionArea = (page: Page) => dialog(page).getByLabel("Description");

test("a markdown description renders as formatted text in the sidebar", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await stubSavedDemo(page);
  await page.goto(`/edit/${DEMO_ID}`);

  const info = boxInfo(page);
  await expect(info).toContainText("What this shows:");
  // Rendered, not literal: a real <strong>, a real list item, a real link.
  await expect(info.locator("strong", { hasText: "filters" })).toBeVisible();
  await expect(info.locator("li").first()).toContainText("filters");
  // `safeHref` re-serializes through `new URL()`, which normalizes the origin to a
  // trailing slash — the assertion follows the parser rather than the source text.
  await expect(info.getByRole("link", { name: "link" })).toHaveAttribute(
    "href",
    "https://handsontable.com/",
  );
  // …and no syntax leaked through.
  await expect(info).not.toContainText("**filters**");
  await expect(info).not.toContainText("- a [link]");
});

test("a shared demo's description renders as markdown for its reader", async ({ page }) => {
  // Every markdown assertion above runs on /edit/:id — the owner's surface. The
  // person the description is *for* reads it on /share/:id, which reaches BoxInfo
  // by a different route (ShareRoute, whose user is always null — so no sign-in
  // here, deliberately: the reader is anonymous). The stub already covers it:
  // share mode hits the same /api/demos/:id + /source pair the editor does.
  await stubShell(page);
  await stubSavedDemo(page);
  await page.goto(`/share/${DEMO_ID}`);

  const info = boxInfo(page);
  // Rendered for the reader, not echoed: a real <strong>, and no literal syntax.
  await expect(info.locator("strong", { hasText: "filters" })).toBeVisible();
  await expect(info).not.toContainText("**filters**");
});

test("the toolbar writes markdown into the field without typing it", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await stubSavedDemo(page, null);
  await page.goto(`/edit/${DEMO_ID}`);

  await page.getByRole("button", { name: "Edit info" }).click();
  const area = descriptionArea(page);
  await area.fill("make this bold");
  // Select "bold" (the last word) and hit the toolbar.
  await area.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(10, 14));
  await dialog(page).getByRole("button", { name: "Bold (⌘B)" }).click();
  await expect(area).toHaveValue("make this **bold**");

  // The list button works on the line the caret is in.
  await area.fill("first\nsecond");
  await area.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, 12));
  await dialog(page).getByRole("button", { name: "Bullet list" }).click();
  await expect(area).toHaveValue("- first\n- second");
});

test("the preview shows the rendered result, not the source", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await stubSavedDemo(page, null);
  await page.goto(`/edit/${DEMO_ID}`);

  await page.getByRole("button", { name: "Edit info" }).click();
  await descriptionArea(page).fill("## Heading\n\n- one\n- two");
  await dialog(page).getByRole("button", { name: "Preview" }).click();

  const preview = page.getByTestId("description-preview");
  // The preview uses the *description* renderer, not the guide's document mode: a
  // heading in a 320px sidebar is one emphasized line, not an <h2>. So assert the
  // structure the sidebar will actually show — the marker is gone, the list is a
  // list — rather than a tag the demo pages never render.
  await expect(preview).toContainText("Heading");
  await expect(preview).not.toContainText("## Heading");
  await expect(preview.locator("li")).toHaveCount(2);
  // Back to writing, with the source intact.
  await dialog(page).getByRole("button", { name: "Write" }).click();
  await expect(descriptionArea(page)).toHaveValue("## Heading\n\n- one\n- two");
});

test("a description over the cap cannot be saved", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await stubSavedDemo(page, null);
  await page.goto(`/edit/${DEMO_ID}`);

  await page.getByRole("button", { name: "Edit info" }).click();
  const save = dialog(page).getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeEnabled();

  await descriptionArea(page).fill("x".repeat(4001));
  // The field says why, and Save refuses — the Worker would answer 400.
  await expect(dialog(page)).toContainText("4000 is the limit");
  await expect(save).toBeDisabled();

  await descriptionArea(page).fill("x".repeat(4000));
  await expect(save).toBeEnabled();
});

test("a multi-paragraph description cannot stretch a demo card", async ({ page }) => {
  // Review finding: the card clamped with `-webkit-line-clamp`, which counts line
  // boxes in an inline context — rendered markdown gives it block children, so the
  // clamp did nothing and a long description stretched the whole grid row.
  await stubShell(page);
  await signIn(page);
  const long = Array.from({ length: 8 }, (_, i) => `Paragraph ${i + 1} of the description.`).join("\n\n");
  // `**/api/demos*` matches with or without a query: the `?scope=` parameter
  // arrives with #163, and this branch is off master.
  await page.route("**/api/demos*", (route) =>
    route.fulfill({
      json: {
        demos: [
          {
            id: DEMO_ID, title: "Sales grid", description: long, framework: "react", tier: 1,
            ht_version: "18.0.0", forked_from: null, visibility: "unlisted", revoked: 0,
            created_at: "2026-08-01T10:00:00.000Z", updated_at: "2026-08-01T10:00:00.000Z",
            created_by: EMAIL,
          },
        ],
      },
    }),
  );
  await page.goto("/my-demos");

  const card = page.locator("article").filter({ hasText: "Sales grid" });
  await expect(card).toBeVisible();
  // The clamp box itself, by testid: the rendered markdown nests its own divs, and
  // measuring one of those measures the content rather than the box holding it.
  const box = card.getByTestId("card-description");
  const sizes = await box.evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight }));
  // Clipped to the frame's three lines, and genuinely overflowing — which is what
  // proves the clamp is doing something rather than the text being short.
  expect(sizes.client).toBeLessThanOrEqual(60);
  expect(sizes.scroll).toBeGreaterThan(sizes.client);
  // …and the card itself stays the design's size rather than growing to fit.
  const cardBox = await card.boundingBox();
  expect(cardBox!.height).toBeLessThan(260);
});

test("a long description is clamped in the sidebar, with a way to read it", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  // Ten paragraphs: unclamped, this would push FILES off a 320px sidebar.
  await stubSavedDemo(page, Array.from({ length: 10 }, (_, i) => `Paragraph ${i + 1}.`).join("\n\n"));
  await page.goto(`/edit/${DEMO_ID}`);

  const info = boxInfo(page);
  const more = info.getByRole("button", { name: "Show more" });
  await expect(more).toBeVisible();

  // Clamped: the rendered block is taller than the box showing it.
  const clamped = info.locator("[data-expanded], div").first();
  await more.click();
  await expect(info.getByRole("button", { name: "Show less" })).toBeVisible();
  await expect(info).toContainText("Paragraph 10.");
  expect(clamped).toBeTruthy();
});
