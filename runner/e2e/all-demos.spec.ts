import { test, expect, type Page } from "@playwright/test";

// Browsing the team's demos, read-only (`/all-demos`, DEV-2506).
//
// The API's ownership rules were already there — PATCH and DELETE answer 403 to a
// non-owner. What these specs cover is the UI half: a card you do not own offers
// no Rename or Delete, opens the read-only playground, and `/edit/:id` for
// someone else's demo does not sit there offering a Save that would 403.

const EMAIL = "dev@handsontable.com";
const OTHER = "someone.else@handsontable.com";
const MINE = "mine0001";
const THEIRS = "their001";

function demo(id: string, title: string, createdBy: string) {
  return {
    id,
    title,
    description: null,
    framework: "react",
    tier: 1,
    ht_version: "18.0.0",
    forked_from: null,
    visibility: "unlisted",
    revoked: 0,
    created_at: "2026-08-01T10:00:00.000Z",
    updated_at: "2026-08-01T10:00:00.000Z",
    created_by: createdBy,
  };
}

const DEMO_FILES = {
  "/src/App.tsx": "export default function App() { return null; }\n",
  "/index.html": '<div id="root"></div>',
  "/package.json": JSON.stringify({ dependencies: { handsontable: "18.0.0" } }, null, 2),
};

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

/** The listing, honouring `?scope=`, plus the per-demo source/metadata/access. */
async function stubDemos(page: Page) {
  await page.route("**/api/demos?scope=*", (route) => {
    const scope = new URL(route.request().url()).searchParams.get("scope");
    const demos = scope === "all"
      ? [
          demo(MINE, "My grid", EMAIL),
          demo(THEIRS, "Their grid", OTHER),
          demo("their002", "Their second grid", OTHER),
        ]
      : [demo(MINE, "My grid", EMAIL)];
    return route.fulfill({ json: { demos, scope } });
  });
  await page.route("**/api/demos/*/access", (route) => {
    const owned = new URL(route.request().url()).pathname.includes(MINE);
    return route.fulfill({ json: { owned, revoked: false } });
  });
  await page.route("**/api/demos/*/source", (route) =>
    route.fulfill({ json: { framework: "react", files: DEMO_FILES } }),
  );
  await page.route("**/api/demos/*", (route) =>
    route.fulfill({
      json: { title: "Their grid", description: null, ht_version: "18.0.0", created_at: null },
    }),
  );
}

const card = (page: Page, title: string) => page.locator("article").filter({ hasText: title });
const kebab = (page: Page, title: string) => card(page, title).getByRole("button", { name: /Actions for/ });
const menuItem = (page: Page, name: string) => page.getByRole("menuitem", { name, exact: true });

test("All demos lists the team's, My demos lists only yours", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await stubDemos(page);

  await page.goto("/my-demos");
  await expect(card(page, "My grid")).toBeVisible();
  await expect(card(page, "Their grid")).toHaveCount(0);

  await page.getByRole("link", { name: "All demos" }).click();
  await expect(page).toHaveURL(/\/all-demos$/);
  await expect(card(page, "My grid")).toBeVisible();
  await expect(card(page, "Their grid")).toBeVisible();
  // Whose it is, on the card itself.
  await expect(card(page, "Their grid")).toContainText("Someone Else");
});

test("someone else's card is read-only, and opens the share view", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await stubDemos(page);
  await page.goto("/all-demos");

  await kebab(page, "Their grid").click();
  // Look and fork, yes…
  await expect(menuItem(page, "Open")).toHaveAttribute("href", `/share/${THEIRS}`);
  await expect(menuItem(page, "Copy link")).toBeVisible();
  await expect(menuItem(page, "Fork")).toBeVisible();
  // …change and destroy, no.
  await expect(menuItem(page, "Rename")).toHaveCount(0);
  await expect(menuItem(page, "Delete")).toHaveCount(0);
});

test("your own card keeps every action, on either list", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await stubDemos(page);
  await page.goto("/all-demos");

  await kebab(page, "My grid").click();
  await expect(menuItem(page, "Open")).toHaveAttribute("href", `/edit/${MINE}`);
  await expect(menuItem(page, "Rename")).toBeVisible();
  await expect(menuItem(page, "Delete")).toBeVisible();
});

test("the owner filter shows one person's demos, and the view is a link", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await stubDemos(page);
  await page.goto("/all-demos");
  await expect(card(page, "My grid")).toBeVisible();

  // Options are the owners actually in the list, counted.
  const picker = page.getByRole("button", { name: "Filter demos by owner" });
  await expect(picker).toContainText("Everyone (3)");
  await picker.click();
  await expect(page.getByRole("option", { name: "Someone Else (2)" })).toBeVisible();
  await expect(page.getByRole("option", { name: "Dev (1)" })).toBeVisible();

  await page.getByRole("option", { name: "Someone Else (2)" }).click();

  // Their two, not yours…
  await expect(card(page, "Their grid")).toBeVisible();
  await expect(card(page, "Their second grid")).toBeVisible();
  await expect(card(page, "My grid")).toHaveCount(0);
  // …and the URL carries it, by local part rather than the whole address.
  await expect(page).toHaveURL(/\/all-demos\?owner=someone\.else$/);
  expect(page.url()).not.toContain("@");

  // A reload keeps the filter, which is the point of putting it in the URL.
  await page.reload();
  await expect(card(page, "Their grid")).toBeVisible();
  await expect(card(page, "My grid")).toHaveCount(0);

  // Everyone puts the grid back and drops the parameter.
  await page.getByRole("button", { name: "Filter demos by owner" }).click();
  await page.getByRole("option", { name: "Everyone (3)" }).click();
  await expect(card(page, "My grid")).toBeVisible();
  await expect(page).not.toHaveURL(/owner=/);
});

test("a filter that matches nobody says whose it was", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await stubDemos(page);
  // The URL is user-editable, so an unknown owner is a normal input.
  await page.goto("/all-demos?owner=nobody.here");

  await expect(page.getByText("No demos from Nobody Here.")).toBeVisible();
  // Not the generic empty state, which would read as "nobody has saved anything".
  await expect(page.getByText("Nobody has saved a demo yet.")).toHaveCount(0);
  await expect(card(page, "My grid")).toHaveCount(0);
});

test("My demos has no owner filter — it has one owner", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await stubDemos(page);
  await page.goto("/my-demos");

  await expect(card(page, "My grid")).toBeVisible();
  await expect(page.getByRole("button", { name: "Filter demos by owner" })).toHaveCount(0);
});

test("/edit/:id for someone else's demo lands on the read-only playground", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await stubDemos(page);

  await page.goto(`/edit/${THEIRS}`);

  // The address bar tells the truth…
  await expect(page).toHaveURL(new RegExp(`/share/${THEIRS}$`));
  // …the demo is readable…
  await expect(page.getByRole("region", { name: "Files" }).locator('button[title="/src/App.tsx"]')).toBeVisible();
  // …and nothing offers to save over it.
  await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save •" })).toHaveCount(0);
});

test("/edit/:id for your own demo still opens the editor", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await stubDemos(page);

  await page.goto(`/edit/${MINE}`);

  await expect(page).toHaveURL(new RegExp(`/edit/${MINE}$`));
  await expect(page.getByRole("button", { name: /^Save/ })).toBeVisible();
});

test("an access check that fails does not lock the owner out", async ({ page }) => {
  // Fail open, deliberately: the API still refuses a stranger's save, so the worst
  // case is the behaviour that shipped before the check. Failing closed would send
  // an owner to a read-only page over one flaky request.
  await stubShell(page);
  await signIn(page);
  await stubDemos(page);
  await page.unroute("**/api/demos/*/access");
  await page.route("**/api/demos/*/access", (route) => route.abort());

  await page.goto(`/edit/${MINE}`);

  await expect(page).toHaveURL(new RegExp(`/edit/${MINE}$`));
  await expect(page.getByRole("button", { name: /^Save/ })).toBeVisible();
});

// DEV-2534 / DEV-2544. Delete is only drawn on a card this page believes is
// yours, so a 403 here is a genuine disagreement between the UI and the server —
// which is why the message names ownership instead of echoing the wire string,
// why the session is left alone, and why (unlike a 401) this one still reports.
test("a revoke the server refuses on ownership says whose demo it is", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await stubDemos(page);
  // The top bar's background profile refresh. Unstubbed it reaches the real
  // `VITE_API_BASE` from `.env.production`, is answered 401 for the faked token,
  // and since DEV-2534 a 401 clears the session — so `hot_token` would already
  // be gone by the time this case looks at it.
  await page.route("**/api/profile", (route) =>
    route.fulfill({
      json: {
        email: EMAIL,
        display_name: "Dev",
        saved_name: null,
        description: null,
        avatar_url: null,
        initial: "D",
      },
    }),
  );
  // Registered after `stubDemos`, so it wins for the DELETE and defers the rest.
  await page.route("**/api/demos/*", async (route) => {
    if (route.request().method() === "DELETE") {
      return route.fulfill({ status: 403, json: { error: "forbidden" } });
    }
    return route.fallback();
  });

  await page.goto("/my-demos");
  await kebab(page, "My grid").click();
  await menuItem(page, "Delete").click();
  await page.getByRole("dialog", { name: "Delete this demo?" })
    .getByRole("button", { name: "Delete" })
    .click();

  const alert = page.getByRole("alert");
  await expect(alert).toContainText("belongs to someone else");
  await expect(alert).not.toContainText("forbidden");
  // A live session, refused one row: the token stays.
  expect(await page.evaluate(() => sessionStorage.getItem("hot_token"))).toBe("e2e-token");
  // And the card is not shown as revoked, because it was not.
  await expect(card(page, "My grid")).toBeVisible();
});
