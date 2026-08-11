import { test, expect, type Page } from "@playwright/test";

// The Settings page (DEV-2166, frame `114:26833`) — the profile page behind the
// row T9 drew greyed out.
//
// Deterministic — no `E2E_LIVE=1`: the page renders no example, so nothing here
// needs the bundler.
//
// Sign-in is faked at the *token* layer for the reason `sidebar-crud.spec.ts`
// sets out at length: a build-layer `VITE_DEV_USER` bypass leaks into production
// builds through `.env.local`, which would make the anonymous case below pass
// while proving nothing.

const EMAIL = "dev@handsontable.com";

/** The server's shape for `GET /api/profile` — always a full view, defaults
 *  included, so the client never derives anything the server wouldn't. */
type ProfileView = {
  email: string;
  display_name: string;
  saved_name: string | null;
  description: string | null;
  avatar_url: string | null;
  initial: string;
};

/** What the server returns for a user with no row: the name derived from the
 *  address (ADR-0007 — `dev@` has no `name.surname` to read, so it capitalises),
 *  no stored name, and no avatar. */
const emptyProfile: ProfileView = {
  email: EMAIL,
  display_name: "Dev",
  saved_name: null,
  description: null,
  avatar_url: null,
  initial: "D",
};

async function signIn(page: Page) {
  await page.addInitScript(() => sessionStorage.setItem("hot_token", "e2e-token"));
  await page.route("**/broker/userinfo", (route) => route.fulfill({ json: { email: EMAIL } }));
  await page.route("**/broker/login**", (route) => route.abort());
}

/**
 * A profile server held in the browser-side route handler, so a save is actually
 * read back on the next load rather than asserted against the response the page
 * already has in hand. That distinction is the whole of "survives a reload".
 */
async function stubProfileApi(page: Page, initial: ProfileView = emptyProfile) {
  const state = { ...initial };
  const calls: string[] = [];

  // The avatar image itself: a 1×1 PNG, so a rendered <img> has something to load
  // and does not sit broken.
  await page.route("**/api/profile/avatar/*", (route) =>
    route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      ),
    }),
  );

  await page.route("**/api/profile/avatar", async (route) => {
    const method = route.request().method();
    calls.push(`${method} avatar`);
    if (method === "POST") {
      state.avatar_url = "/api/profile/avatar/e2e-avatar-key";
    } else if (method === "DELETE") {
      state.avatar_url = null;
    }
    await route.fulfill({ json: state });
  });

  await page.route("**/api/profile", async (route) => {
    const method = route.request().method();
    calls.push(`${method} profile`);
    if (method === "PUT") {
      const body = JSON.parse(route.request().postData() ?? "{}") as {
        display_name: string | null;
        description: string | null;
      };
      state.saved_name = body.display_name;
      state.description = body.description;
      // Cleared -> back to the derived default, which is what the real server does.
      state.display_name = body.display_name ?? initial.display_name;
      state.initial = (state.display_name[0] ?? "?").toUpperCase();
    }
    await route.fulfill({ json: state });
  });

  return { state, calls };
}

const nameField = (page: Page) => page.getByLabel("Name");
const descriptionField = (page: Page) => page.getByLabel("Description");
const saveButton = (page: Page) => page.getByRole("button", { name: "Save", exact: true });
const cancelButton = (page: Page) => page.getByRole("button", { name: "Cancel", exact: true });
const uploadButton = (page: Page) => page.getByRole("button", { name: "Upload", exact: true });
const removeButton = (page: Page) => page.getByRole("button", { name: "Remove", exact: true });

const PNG_1x1 = {
  name: "avatar.png",
  mimeType: "image/png",
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
};

test.describe("/settings", () => {
  test("renders the frame's chrome, nav and card", async ({ page }) => {
    await signIn(page);
    await stubProfileApi(page);
    await page.goto("/settings");

    // The static pill (`114:26884`, the chevron, is hidden in the frame — this is
    // a label, not a trigger).
    await expect(page.getByText("Settings", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

    // The same left nav as My Demos, with Settings the current page.
    const nav = page.getByRole("navigation", { name: "Account" });
    await expect(nav.getByRole("link", { name: "My demos" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");

    await expect(nameField(page)).toBeVisible();
    await expect(descriptionField(page)).toBeVisible();
    await expect(uploadButton(page)).toBeVisible();
    await expect(removeButton(page)).toBeVisible();
  });

  test("an empty profile shows the address-derived default as a placeholder, not a value", async ({ page }) => {
    await signIn(page);
    await stubProfileApi(page);
    await page.goto("/settings");

    // Pre-filling the derived name would make an unsaved default look stored.
    await expect(nameField(page)).toHaveValue("");
    await expect(nameField(page)).toHaveAttribute("placeholder", "Dev");
  });

  test("the derived name is the address's name.surname, capitalised", async ({ page }) => {
    // The rule the whole team's addresses go through (ADR-0007). Asserted
    // through the *client's* copy of the derivation — the placeholder is drawn
    // before `GET /api/profile` answers — so this is what catches the client and
    // the worker drifting apart in the browser rather than in a unit test.
    const person = "anna-maria.kowalska@handsontable.com";
    await page.addInitScript(() => sessionStorage.setItem("hot_token", "e2e-token"));
    await page.route("**/broker/userinfo", (route) => route.fulfill({ json: { email: person } }));
    await page.route("**/broker/login**", (route) => route.abort());
    await stubProfileApi(page, {
      ...emptyProfile,
      email: person,
      display_name: "Anna-Maria Kowalska",
      initial: "A",
    });

    await page.goto("/settings");
    await expect(nameField(page)).toHaveAttribute("placeholder", "Anna-Maria Kowalska");
  });

  test("a save round-trips and survives a reload", async ({ page }) => {
    await signIn(page);
    await stubProfileApi(page);
    await page.goto("/settings");

    // Save is inert until something actually changed.
    await expect(saveButton(page)).toBeDisabled();

    await nameField(page).fill("Ada Lovelace");
    await descriptionField(page).fill("Builds spreadsheets.");
    await expect(saveButton(page)).toBeEnabled();
    await saveButton(page).click();

    await expect(page.getByRole("status")).toHaveText("Saved.");
    await expect(saveButton(page)).toBeDisabled();

    // Drop the sessionStorage cache first, or the reload would re-read the value
    // this page just put there and the assertion would hold with a broken GET.
    await page.evaluate(() => sessionStorage.removeItem("hot_profile"));
    await page.reload();
    await expect(nameField(page)).toHaveValue("Ada Lovelace");
    await expect(descriptionField(page)).toHaveValue("Builds spreadsheets.");
  });

  test("a stale cache is corrected by the server, not shown instead of it", async ({ page }) => {
    // The cache exists so the avatar paints on the first frame; it must never
    // become the value the page settles on. Seed one, serve a different profile,
    // and the server's has to win.
    await signIn(page);
    await page.addInitScript(() => {
      sessionStorage.setItem(
        "hot_profile",
        JSON.stringify({
          email: "dev@handsontable.com",
          display_name: "Stale Name",
          saved_name: "Stale Name",
          description: "Stale description",
          avatar_url: null,
          initial: "S",
        }),
      );
    });
    await stubProfileApi(page, {
      ...emptyProfile,
      display_name: "Fresh Name",
      saved_name: "Fresh Name",
      description: "Fresh description",
      initial: "F",
    });

    await page.goto("/settings");
    await expect(nameField(page)).toHaveValue("Fresh Name");
    await expect(descriptionField(page)).toHaveValue("Fresh description");
  });

  test("a cache belonging to someone else is never painted", async ({ page }) => {
    // A token swap does not have to go through `logout()` — the broker redirect
    // sets one directly — so the owner check, not just the logout path, is what
    // keeps one user's name off another's screen.
    await signIn(page);
    await page.addInitScript(() => {
      sessionStorage.setItem(
        "hot_profile",
        JSON.stringify({
          email: "someone.else@handsontable.com",
          display_name: "Someone Else",
          saved_name: "Someone Else",
          description: null,
          avatar_url: "/api/profile/avatar/not-yours",
          initial: "S",
        }),
      );
    });
    await stubProfileApi(page);

    await page.goto("/settings");
    await expect(page.getByText("Someone Else")).toHaveCount(0);
    await expect(nameField(page)).toHaveValue("");
  });

  test("logging out drops the cached profile with the token", async ({ page }) => {
    await signIn(page);
    await stubProfileApi(page, { ...emptyProfile, saved_name: "Ada Lovelace", display_name: "Ada Lovelace" });
    await page.goto("/settings");
    await expect(nameField(page)).toHaveValue("Ada Lovelace");
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("hot_profile"))).not.toBeNull();

    // `logout("/")` navigates to a public page, so read the storage there.
    await page.getByRole("navigation", { name: "Account" }).getByRole("button", { name: "Log out" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/settings"));
    // Only the profile key is asserted: `signIn`'s init script re-seeds
    // `hot_token` on every navigation, so checking it here would be checking the
    // harness. That the token is dropped is `auth.ts`'s long-standing behaviour;
    // what is new is that the profile goes with it.
    expect(await page.evaluate(() => sessionStorage.getItem("hot_profile"))).toBeNull();
  });

  test("typing before the profile loads does not wipe the field left untouched", async ({ page }) => {
    // The form renders immediately while `GET /api/profile` is still in flight —
    // it costs the Worker a broker round trip — so someone can start typing
    // against empty fields. A draft that snapshotted *both* fields would freeze
    // the untouched one at "" and Save would then clear the stored value.
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    await signIn(page);
    const { calls, state } = await stubProfileApi(page, {
      ...emptyProfile,
      saved_name: "Ada Lovelace",
      display_name: "Ada Lovelace",
      description: "Builds spreadsheets.",
      initial: "A",
    });
    await page.route("**/api/profile", async (route) => {
      // Hold only the initial GET; the PUT must go straight through.
      if (route.request().method() === "GET") await held;
      await route.fallback();
    });

    await page.goto("/settings");
    await nameField(page).fill("Ada L.");
    release();

    // The description arrives late and must win, because nothing was typed into it.
    await expect(descriptionField(page)).toHaveValue("Builds spreadsheets.");
    // And the late fetch must not clobber what was typed, either.
    await expect(nameField(page)).toHaveValue("Ada L.");

    await saveButton(page).click();
    await expect(page.getByRole("status")).toHaveText("Saved.");
    expect(calls).toContain("PUT profile");
    expect(state.description).toBe("Builds spreadsheets.");
    expect(state.saved_name).toBe("Ada L.");
  });

  test("changing the avatar keeps an in-progress text edit", async ({ page }) => {
    // Upload and Remove are documented as independent of the Save/Cancel form.
    // Independent has to mean both ways: they must not discard a half-typed name.
    await signIn(page);
    await stubProfileApi(page);
    await page.goto("/settings");

    await nameField(page).fill("Half typed");
    await page.setInputFiles('input[type="file"]', PNG_1x1);
    await expect(page.getByRole("status")).toHaveText("Avatar updated.");

    await expect(nameField(page)).toHaveValue("Half typed");
    await expect(saveButton(page)).toBeEnabled();
  });

  test("form controls stay visible in dark mode", async ({ page }) => {
    // `border` and `surfaceRaised` are the same colour in dark (#222222), so an
    // outline-only control drawn with `border` vanishes — the DEV-2209 failure.
    // Asserted as "the outline differs from what is behind it" rather than
    // against a literal, so it survives a palette change.
    await signIn(page);
    await stubProfileApi(page);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/settings");

    // Or the whole assertion below passes vacuously against the light palette,
    // where `border` and the surfaces do differ.
    await expect(page.locator("html")).toHaveAttribute("data-hot-theme", "dark");

    const contrasts = await page.evaluate(() => {
      const results: Array<{ label: string; border: string; behind: string }> = [];
      const behindOf = (el: Element) => {
        let node: Element | null = el.parentElement;
        while (node) {
          const bg = getComputedStyle(node).backgroundColor;
          if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;
          node = node.parentElement;
        }
        return "";
      };
      for (const el of document.querySelectorAll("main input, main textarea, main button")) {
        const style = getComputedStyle(el);
        if (style.borderTopStyle === "none") continue;
        results.push({
          label: el.textContent?.trim() || (el as HTMLElement).id || el.tagName,
          border: style.borderTopColor,
          behind: behindOf(el),
        });
      }
      return results;
    });

    expect(contrasts.length).toBeGreaterThan(0);
    for (const control of contrasts) {
      expect(control.border, `${control.label} outline is invisible against its surface`)
        .not.toBe(control.behind);
    }
  });

  test("Cancel discards the draft without writing", async ({ page }) => {
    await signIn(page);
    const { calls } = await stubProfileApi(page);
    await page.goto("/settings");

    await nameField(page).fill("Discarded");
    await cancelButton(page).click();

    await expect(nameField(page)).toHaveValue("");
    expect(calls.filter((c) => c === "PUT profile")).toHaveLength(0);
  });

  test("upload then remove restores the monogram", async ({ page }) => {
    await signIn(page);
    await stubProfileApi(page);
    await page.goto("/settings");

    // Nothing to remove yet.
    await expect(removeButton(page)).toBeDisabled();
    const avatar = page.locator("main img").first();
    await expect(avatar).toHaveCount(0);

    await page.setInputFiles('input[type="file"]', PNG_1x1);
    await expect(avatar).toBeVisible();
    await expect(removeButton(page)).toBeEnabled();

    await removeButton(page).click();
    await expect(page.locator("main img")).toHaveCount(0);
    // The monogram is back — the initial of the derived name.
    await expect(page.getByRole("main").getByText("D", { exact: true })).toBeVisible();
  });

  test("a rejected upload surfaces the server's reason", async ({ page }) => {
    await signIn(page);
    await stubProfileApi(page);
    // Whatever the client thinks it is sending, the server sniffs the bytes.
    await page.unroute("**/api/profile/avatar");
    await page.route("**/api/profile/avatar", (route) =>
      route.fulfill({ status: 415, json: { error: "avatar must be a PNG, JPEG or WebP image" } }),
    );
    await page.goto("/settings");

    await page.setInputFiles('input[type="file"]', PNG_1x1);
    await expect(page.getByRole("alert")).toContainText("PNG, JPEG or WebP");
  });

  test("the saved name and avatar reach the top bar", async ({ page }) => {
    await signIn(page);
    await stubProfileApi(page, {
      ...emptyProfile,
      display_name: "Ada Lovelace",
      saved_name: "Ada Lovelace",
      initial: "A",
      avatar_url: "/api/profile/avatar/e2e-avatar-key",
    });
    await page.goto("/settings");

    const account = page.getByRole("button", { name: `Account: ${EMAIL}` });
    await expect(account.locator("img")).toBeVisible();
  });

  test("the account menu's Settings row is live and navigates", async ({ page }) => {
    await signIn(page);
    await stubProfileApi(page);
    await page.route("**/api/demos", (route) => route.fulfill({ json: { demos: [] } }));
    await page.goto("/my-demos");

    await page.getByRole("button", { name: `Account: ${EMAIL}` }).click();
    const row = page.getByRole("menuitem", { name: "Settings" });
    await expect(row).toBeEnabled();
    await row.click();

    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  });

  test("the My Demos left-nav Settings row is live and navigates", async ({ page }) => {
    // The other half of AC1, and the row that was a `<button disabled>` before
    // this change. On `/settings` it is the current page, so it has to be
    // asserted from `/my-demos` to prove it is a working link at all.
    await signIn(page);
    await stubProfileApi(page);
    await page.route("**/api/demos", (route) => route.fulfill({ json: { demos: [] } }));
    await page.goto("/my-demos");

    const nav = page.getByRole("navigation", { name: "Account" });
    const row = nav.getByRole("link", { name: "Settings" });
    await expect(row).toBeVisible();
    await expect(row).not.toHaveAttribute("aria-current", "page");
    await row.click();

    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  });

  test("an anonymous visitor is sent to the broker with /settings preserved", async ({ page }) => {
    // No `signIn` — no token, and the broker answers 401 as it would for a stranger.
    await page.route("**/broker/userinfo", (route) => route.fulfill({ status: 401, json: {} }));
    const brokerUrls: string[] = [];
    await page.route("**/broker/login**", (route) => {
      brokerUrls.push(route.request().url());
      return route.abort();
    });

    await page.goto("/settings");

    await expect.poll(() => brokerUrls.length).toBeGreaterThan(0);
    expect(decodeURIComponent(brokerUrls[0]!)).toContain("return_to=");
    expect(decodeURIComponent(brokerUrls[0]!)).toContain("/settings");
  });

  test("a hard load of /settings resolves to the settings page, not the playground", async ({ page }) => {
    // The static Worker has always served index.html here
    // (`not_found_handling: "single-page-application"`), so this never 404'd —
    // it silently rendered the playground until `parseRoute()` learned the path.
    await signIn(page);
    await stubProfileApi(page);
    const response = await page.goto("/settings");

    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    // The playground's pill would be the example cascader.
    await expect(page.getByRole("button", { name: /Choose an example/i })).toHaveCount(0);
  });
});
