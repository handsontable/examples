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

/** The listing, honouring `?scope=`, plus the per-demo source/metadata/access.
 *
 *  `extraMine` joins the mine scope only: the owner-filter test counts heads on
 *  the `all` list ("Everyone (3)"), and a rig-wide extra row would silently move
 *  those numbers for every test sharing this stub. */
async function stubDemos(page: Page, extraMine: ReturnType<typeof demo>[] = []) {
  await page.route("**/api/demos?scope=*", (route) => {
    const scope = new URL(route.request().url()).searchParams.get("scope");
    const demos = scope === "all"
      ? [
          demo(MINE, "My grid", EMAIL),
          demo(THEIRS, "Their grid", OTHER),
          demo("their002", "Their second grid", OTHER),
        ]
      : [demo(MINE, "My grid", EMAIL), ...extraMine];
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

test("a demo the MCP created shows up on your own list", async ({ page }) => {
  // The MCP push (DEV-2501) writes through the same worker endpoint the Save
  // button does, stamping `created_by` from the caller's token and recording its
  // origin in `forked_from` ("mcp:<framework>"). To this list that row must be
  // indistinguishable from a demo saved in the browser: on *your* list, with the
  // full owner's menu — not the read-only card a teammate's demo gets, which is
  // what a `created_by` mismatch between the two writers would produce.
  //
  // The mismatch has to be real or the test proves nothing (audit, DEV-2203):
  // the MCP writer normalises case differently than the browser session, so
  // `created_by` here deliberately differs in case from the signed-in email —
  // the owner's menu below appears only if `isOwnedBy`'s case-folding is wired
  // into the card path, which is the exact two-writer seam this test guards.
  await stubShell(page);
  await signIn(page);
  await stubDemos(page, [
    { ...demo("mcpdemo1", "Pushed from my machine", "Dev@Handsontable.com"), forked_from: "mcp:react" },
  ]);
  await page.goto("/my-demos");

  await expect(card(page, "Pushed from my machine")).toBeVisible();

  // First-class owned demo: Open goes to the editor, and Rename and Delete are
  // offered — the two actions the read-only menu withholds.
  await kebab(page, "Pushed from my machine").click();
  await expect(menuItem(page, "Open")).toHaveAttribute("href", "/edit/mcpdemo1");
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

test("a pasted filter link filters regardless of its case", async ({ page }) => {
  // The URL is the shareable artefact, and pasted links arrive hand-edited or
  // autocapitalised. The slug has to match case-insensitively end to end: the
  // grid filters AND the picker names the person — a filtered grid under an
  // "Everyone" label would read as the whole team having two demos.
  await stubShell(page);
  await signIn(page);
  await stubDemos(page);
  await page.goto("/all-demos?owner=SOMEONE.ELSE");

  await expect(card(page, "Their grid")).toBeVisible();
  await expect(card(page, "Their second grid")).toBeVisible();
  await expect(card(page, "My grid")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Filter demos by owner" })).toContainText("Someone Else (2)");
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

/** The top bar's background profile refresh, kept alive. Unstubbed it reaches
 *  the real `VITE_API_BASE`, 401s for the faked token, and since DEV-2534 a 401
 *  clears the session — so any later assertion that leans on "still signed in"
 *  would be testing a signed-out page without saying so. Same stub as the
 *  revoke test below, hoisted for the DEV-2530 pair. */
async function stubProfile(page: Page) {
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
}

// DEV-2530. The guide sells one safety property for a share link: a shared demo
// cannot change its version — the recipient sees exactly the build the author
// pinned. `EditorShell` implements it as `versionLocked` on the share route and
// `PreviewBar` renders the version as inert muted text instead of the picker,
// but until now nothing asserted it, so the lock could be dropped without a
// single test going red.

/** The locked version pill: the bar's static "Handsontable <v>" text, where the
 *  picker sits on every other route. The preview *status* bar prints the same
 *  string (`aria-label="Preview status"`), so a bare `getByText` resolves to
 *  two elements — the pill is the span that is not inside the status bar. */
function lockedVersionPill(page: Page, version: string) {
  return page.locator('span:not([aria-label="Preview status"] span)', {
    hasText: new RegExp(`^Handsontable ${version.replaceAll(".", "\\.")}$`),
  });
}

/** Pin one demo's saved metadata to a version other than `DEFAULT_VERSION`
 *  ("18.0.0", which `stubDemos` serves): with the default, "the pill shows the
 *  author's pin" and "the pill fell back to the app default" are the same
 *  green. Registered after `stubDemos`, so it wins the meta GET for this id
 *  and defers everything else (`/access`, `/source`, other ids) to the rig. */
async function pinDemoMeta(page: Page, id: string, version: string) {
  await page.route("**/api/demos/*", (route) => {
    if (!new URL(route.request().url()).pathname.endsWith(`/api/demos/${id}`)) return route.fallback();
    return route.fulfill({
      json: { title: "Their grid", description: null, ht_version: version, created_at: null },
    });
  });
}
test("the share page locks the version: text to read, not a menu to open", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await stubDemos(page);
  await stubProfile(page);
  // Two versions instead of stubShell's one: interactivity is only proven by a
  // pick that lands, and a one-option menu has nowhere to move. Registered
  // after stubShell, so this route wins (Playwright matches newest-first).
  await page.route("**/api/versions", (route) =>
    route.fulfill({ json: { latest: "18.0.0", next: "19.0.0-next.1", versions: ["18.0.0", "17.1.0"] } }),
  );
  // Three distinct versions in play — the app default (18.0.0), this visitor's
  // playground pick (17.1.0), and the author's pin (16.1.0) — so the value on
  // the share pill can only be the author's.
  await pinDemoMeta(page, THEIRS, "16.1.0");

  // First, the contrast that makes the lock falsifiable: on the playground the
  // same control is a live picker under exactly these accessible names. Without
  // this half, renaming the trigger (or the pencil) would turn every "absent on
  // the share page" assertion below into a vacuous pass.
  await page.goto("/?example=react");
  const trigger = page.getByRole("button", { name: "Handsontable version", exact: true });
  await expect(trigger).toContainText("18.0.0");
  await trigger.click();
  await expect(page.getByRole("listbox", { name: "Handsontable version" })).toBeVisible();
  await page.getByRole("option", { name: "17.1.0", exact: true }).click();
  await expect(trigger).toContainText("17.1.0");
  // Signed in and off the share route, the custom-version pencil is offered
  // too — seeing it here is what gives its absence on the share page teeth.
  await expect(page.getByRole("button", { name: "Set a custom Handsontable version" })).toBeVisible();

  // Now the share page, same signed-in visitor. The version is readable, and
  // it is the author's pin — not the default this run booted with, and not the
  // 17.1.0 this visitor just picked one navigation ago…
  await page.goto(`/share/${THEIRS}`);
  await expect(lockedVersionPill(page, "16.1.0")).toBeVisible();
  // …but it is nobody's control: no picker trigger, no pencil, no free-text field.
  await expect(page.getByRole("button", { name: "Handsontable version", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Set a custom Handsontable version" })).toHaveCount(0);
  await expect(page.getByLabel("Custom Handsontable version")).toHaveCount(0);

  // What the lock means for a user, not just for the DOM: clicking where the
  // picker sits on every other route opens nothing. MenuButton renders its
  // popover synchronously on the trigger's click, so if this text were still a
  // live trigger the listbox would exist by the time the click resolves.
  await lockedVersionPill(page, "16.1.0").click();
  await expect(page.getByRole("listbox", { name: "Handsontable version" })).toHaveCount(0);
  await expect(page.getByRole("option")).toHaveCount(0);

  // And none of those absences were the signed-out fallback: the session is intact.
  expect(await page.evaluate(() => sessionStorage.getItem("hot_token"))).toBe("e2e-token");
});

test("the lock belongs to the route, not the visitor: your own share page is pinned too", async ({ page }) => {
  // The dangerous regression here is keying the lock off ownership (`/access`)
  // instead of the route: the owner would get a live picker on the very page
  // their recipients have open, and one switch there rewrites what everyone
  // else is looking at. The signed-in owner on their own `/share/:id` is the
  // only visitor who can catch that — the previous test's stranger cannot.
  await stubShell(page);
  await signIn(page);
  await stubDemos(page);
  await stubProfile(page);
  await pinDemoMeta(page, MINE, "16.1.0");

  await page.goto(`/share/${MINE}`);

  // Still the share playground — owning the demo redirects nowhere…
  await expect(page).toHaveURL(new RegExp(`/share/${MINE}$`));
  // …and still pinned: the author's version, as text, with no picker and no pencil.
  await expect(lockedVersionPill(page, "16.1.0")).toBeVisible();
  await expect(page.getByRole("button", { name: "Handsontable version", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Set a custom Handsontable version" })).toHaveCount(0);
  // Signed in throughout, so the absences above are the lock, not a lost session.
  expect(await page.evaluate(() => sessionStorage.getItem("hot_token"))).toBe("e2e-token");
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
