import { test, expect, type Page } from "@playwright/test";

// The API tokens page (DEV-2583, ADR-0037) — mint, reveal once, revoke.
//
// Deterministic — no `E2E_LIVE=1`: the page renders no example, so nothing here
// needs the bundler. The API is stubbed in the browser-side route handler and
// holds its state there, so a revoke is read back the way the server would
// answer it rather than asserted against the response the page already has.
//
// Sign-in is faked at the *token* layer, for the reason `settings.spec.ts` sets
// out: a build-layer `VITE_DEV_USER` bypass leaks into production builds through
// `.env.local`, which would make the anonymous case below pass while proving
// nothing.

const EMAIL = "dev@handsontable.com";
const OTHER = "someone.else@handsontable.com";

type TokenRow = {
  id: string;
  name: string;
  created_by: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
};

const row = (over: Partial<TokenRow> = {}): TokenRow => ({
  id: "0123456789abcdef",
  name: "nightly e2e",
  created_by: EMAIL,
  created_at: "2026-08-01T09:00:00.000Z",
  last_used_at: null,
  revoked_at: null,
  revoked_by: null,
  ...over,
});

/** The plaintext the stub mints. Shaped like the real thing (`hot_pat_` + 16 hex
 *  + `_` + 43 base64url chars) so an assertion about "the secret" is about a
 *  string the Worker would actually have produced. */
const MINTED_ID = "fedcba9876543210";
const MINTED_SECRET = "A".repeat(43);
const MINTED = `hot_pat_${MINTED_ID}_${MINTED_SECRET}`;

async function signIn(page: Page) {
  await page.addInitScript(() => sessionStorage.setItem("hot_token", "e2e-token"));
  await page.route("**/broker/userinfo", (route) => route.fulfill({ json: { email: EMAIL } }));
  await page.route("**/broker/login**", (route) => route.abort());
}

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
    }));
}

/** A tokens server living in the route handler. Returns the calls it saw, so a
 *  test can assert the page actually asked rather than rendered from its own
 *  optimism. */
async function stubTokensApi(page: Page, seed: TokenRow[] = []) {
  const state = [...seed];
  const calls: string[] = [];

  await page.route("**/api/tokens", async (route) => {
    const method = route.request().method();
    calls.push(`${method} /api/tokens`);
    if (method === "GET") return route.fulfill({ json: { tokens: state } });
    if (method === "POST") {
      const { name } = JSON.parse(route.request().postData() ?? "{}") as { name: string };
      const created = row({ id: MINTED_ID, name, created_at: "2026-08-21T10:00:00.000Z" });
      state.unshift(created);
      // The mint response is the row plus the one and only sight of the token.
      return route.fulfill({ status: 201, json: { ...created, token: MINTED } });
    }
    return route.fallback();
  });

  await page.route("**/api/tokens/*", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop()!;
    calls.push(`${route.request().method()} /api/tokens/${id}`);
    const target = state.find((t) => t.id === id);
    if (!target) return route.fulfill({ status: 404, json: { error: "not found" } });
    target.revoked_at = "2026-08-21T11:00:00.000Z";
    target.revoked_by = EMAIL;
    return route.fulfill({ status: 204, body: "" });
  });

  return { calls, state };
}

const nameField = (page: Page) => page.getByLabel("Name");
const createButton = (page: Page) => page.getByRole("button", { name: "Create token" });

test.describe("/api-tokens", () => {
  test("the page frames itself like the other account pages", async ({ page }) => {
    await signIn(page);
    await stubProfile(page);
    await stubTokensApi(page);
    await page.goto("/api-tokens");

    await expect(page.getByRole("heading", { name: "API tokens" })).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Account" });
    await expect(nav.getByRole("link", { name: "My demos" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "API tokens" })).toHaveAttribute("aria-current", "page");
    await expect(nameField(page)).toBeVisible();
  });

  test("the account menu and the left nav both reach the page", async ({ page }) => {
    await signIn(page);
    await stubProfile(page);
    await stubTokensApi(page);
    await page.route("**/api/demos?scope=*", (route) => route.fulfill({ json: { demos: [] } }));
    await page.goto("/my-demos");

    const nav = page.getByRole("navigation", { name: "Account" });
    const link = nav.getByRole("link", { name: "API tokens" });
    await expect(link).not.toHaveAttribute("aria-current", "page");
    await link.click();
    await expect(page).toHaveURL(/\/api-tokens$/);
    await expect(page.getByRole("heading", { name: "API tokens" })).toBeVisible();

    await page.getByRole("button", { name: `Account: ${EMAIL}` }).click();
    await expect(page.getByRole("menuitem", { name: "API tokens" })).toBeVisible();
  });

  test("minting shows the token once, and the list only ever shows the masked form", async ({ page }) => {
    await signIn(page);
    await stubProfile(page);
    const api = await stubTokensApi(page);
    await page.goto("/api-tokens");

    await nameField(page).fill("nightly e2e");
    await createButton(page).click();

    // The reveal: the whole plaintext, exactly once, with the warning that says so.
    const reveal = page.getByRole("textbox", { name: "Your new API token" });
    await expect(reveal).toHaveValue(MINTED);
    await expect(page.getByText(/only time it is shown/i)).toBeVisible();

    // The row is in the list, masked — the secret is not on the page twice.
    await expect(page.getByText(`hot_pat_${MINTED_ID}_••••••••`)).toBeVisible();
    expect(api.calls).toContain("POST /api/tokens");

    // A reload is meant to lose it: nothing persisted the plaintext, and the
    // server cannot answer with it again.
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Your new API token" })).toHaveCount(0);
    await expect(page.getByText(`hot_pat_${MINTED_ID}_••••••••`)).toBeVisible();
    expect(await page.content()).not.toContain(MINTED_SECRET);
  });

  test("Create is inert until the token has a name", async ({ page }) => {
    await signIn(page);
    await stubProfile(page);
    await stubTokensApi(page);
    await page.goto("/api-tokens");

    await expect(createButton(page)).toBeDisabled();
    await nameField(page).fill("   ");
    await expect(createButton(page), "whitespace is not a name").toBeDisabled();
    await nameField(page).fill("nightly e2e");
    await expect(createButton(page)).toBeEnabled();
  });

  test("revoking asks first, then says who killed it", async ({ page }) => {
    await signIn(page);
    await stubProfile(page);
    const api = await stubTokensApi(page, [row()]);
    await page.goto("/api-tokens");

    await page.getByRole("button", { name: "Revoke" }).click();
    const dialog = page.getByRole("dialog", { name: "Revoke this token?" });
    await expect(dialog).toBeVisible();

    // Cancel leaves it alone — the confirmation is a real gate, not decoration.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    expect(api.calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);

    await page.getByRole("button", { name: "Revoke" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Revoke" }).click();

    await expect(page.getByText(`revoked by ${EMAIL}`)).toBeVisible();
    // The row stays: it is the audit trail, so revoking must not hide it.
    await expect(page.getByText("nightly e2e")).toBeVisible();
    // And there is nothing left to revoke on it.
    await expect(page.getByRole("button", { name: "Revoke" })).toHaveCount(0);
    expect(api.calls).toContain("DELETE /api/tokens/0123456789abcdef");
  });

  test("the revoke confirmation opens on Cancel, so Enter cannot revoke unanswered", async ({ page }) => {
    // `Dialog` focuses the content's first focusable unless something is marked
    // `data-autofocus`, and the first control here is the destructive one. Without
    // the marker, opening the dialog and pressing Enter revokes a live credential
    // without the question ever being answered.
    await signIn(page);
    await stubProfile(page);
    const api = await stubTokensApi(page, [row()]);
    await page.goto("/api-tokens");

    await page.getByRole("button", { name: "Revoke" }).click();
    await expect(page.getByRole("dialog", { name: "Revoke this token?" })).toBeVisible();

    await expect(
      page.getByRole("dialog").getByRole("button", { name: "Cancel" }),
      "focus lands on Cancel, not on Revoke",
    ).toBeFocused();

    await page.keyboard.press("Enter");
    expect(api.calls.filter((c) => c.startsWith("DELETE")), "Enter did not revoke").toEqual([]);
    await expect(page.getByRole("dialog")).toBeHidden();
  });

  test("a listing that fails says so instead of claiming there are no tokens", async ({ page }) => {
    // The page's whole job is enumerating live credentials. Telling a reader
    // "No tokens yet" when the request failed asserts the one thing it cannot know.
    await signIn(page);
    await stubProfile(page);
    await page.route("**/api/tokens", (route) =>
      route.fulfill({ status: 500, json: { error: "boom" } }));

    await page.goto("/api-tokens");
    await expect(page.getByText(/could not be loaded/i)).toBeVisible();
    await expect(page.getByText("No tokens yet.")).toHaveCount(0);
  });

  test("a token minted after a failed listing is still shown, so it can be revoked", async ({ page }) => {
    // Create is deliberately live after a load failure, so the row it produces
    // has to be reachable: a credential that exists and cannot be revoked from
    // the page is the worst state this feature can be in. The failure notice
    // stays too — the list is still not known to be complete.
    await signIn(page);
    await stubProfile(page);
    const calls: string[] = [];
    await page.route("**/api/tokens", (route) => {
      const method = route.request().method();
      calls.push(method);
      if (method === "GET") return route.fulfill({ status: 500, json: { error: "boom" } });
      const created = row({ id: MINTED_ID, name: "after failure" });
      return route.fulfill({ status: 201, json: { ...created, token: MINTED } });
    });

    await page.goto("/api-tokens");
    await expect(page.getByText(/could not be loaded/i)).toBeVisible();

    await nameField(page).fill("after failure");
    await createButton(page).click();

    await expect(page.getByRole("textbox", { name: "Your new API token" })).toHaveValue(MINTED);
    await expect(page.getByText("after failure")).toBeVisible();
    await expect(page.getByText(`hot_pat_${MINTED_ID}_••••••••`)).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Revoke" }),
      "the token just minted can be revoked",
    ).toBeEnabled();
    await expect(
      page.getByText(/could not be loaded/i),
      "and the page still admits the list is incomplete",
    ).toBeVisible();
  });

  test("somebody else's token is listed, and revocable, because revocation is team-wide", async ({ page }) => {
    // The deliberate departure recorded in ADR-0037: a permanent credential only
    // its author can kill is worse than one anybody on the team can.
    await signIn(page);
    await stubProfile(page);
    await stubTokensApi(page, [row({ id: "aaaabbbbccccdddd", name: "their script", created_by: OTHER })]);
    await page.goto("/api-tokens");

    await expect(page.getByText("their script")).toBeVisible();
    await expect(page.getByText(OTHER)).toBeVisible();
    await expect(page.getByRole("button", { name: "Revoke" })).toBeEnabled();
  });

  test("a token session is not offered the AI features", async ({ page }) => {
    // The Worker fences a token off /api/chat and /api/theme, so the controls
    // would only ever open a panel whose first request comes back 403.
    await page.addInitScript((token) => sessionStorage.setItem("hot_token", token), MINTED);
    await page.route("**/api/profile", (route) => route.fulfill({ json: { email: EMAIL, display_name: "Dev", saved_name: null, description: null, avatar_url: null, initial: "D" } }));
    // The broker must never be asked about this credential — that is the whole
    // point of resolving a token's identity against our own API.
    let brokerCalls = 0;
    await page.route("**/broker/userinfo", (route) => { brokerCalls += 1; return route.fulfill({ status: 401, json: {} }); });

    await page.goto("/");
    await expect(page.getByRole("button", { name: `Account: ${EMAIL}` })).toBeVisible();
    expect(brokerCalls, "a token's identity comes from /api/profile, not the broker").toBe(0);
    // `exact` on both: role-name matching is substring by default, and the file
    // tree's `styles.css` button matches a bare "Style".
    await expect(page.getByRole("button", { name: "Ask AI", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Style", exact: true })).toHaveCount(0);
  });

  test("a token session gets an explanation here, not controls that would 403", async ({ page }) => {
    // A token is fenced off token management entirely (ADR-0037), so the page
    // must not offer a form and a list whose every request comes back 403.
    await page.addInitScript((token) => sessionStorage.setItem("hot_token", token), MINTED);
    await stubProfile(page);
    await page.route("**/broker/userinfo", (route) => route.fulfill({ status: 401, json: {} }));
    // A tripwire, not a stub: the page must not ask at all.
    let listCalls = 0;
    await page.route("**/api/tokens", (route) => {
      listCalls += 1;
      return route.fulfill({ status: 403, json: { error: "token_forbidden", detail: "An API token cannot read the token list." } });
    });

    await page.goto("/api-tokens");
    await expect(page.getByRole("heading", { name: "API tokens" })).toBeVisible();
    await expect(page.getByText(/not available to a session signed in with an API token/i)).toBeVisible();
    await expect(createButton(page)).toHaveCount(0);
    await expect(nameField(page)).toHaveCount(0);
    expect(listCalls, "the page does not ask for a listing it may not have").toBe(0);
  });

  test("Create waits for the listing, so a mint cannot be overwritten by it", async ({ page }) => {
    // Minting before the mount GET resolves would prepend the new row and then
    // have the older response replace state with the pre-mint snapshot.
    await signIn(page);
    await stubProfile(page);
    let release = () => {};
    const held = new Promise<void>((r) => { release = r; });
    await page.route("**/api/tokens", async (route) => {
      if (route.request().method() === "GET") {
        await held;
        return route.fulfill({ json: { tokens: [] } });
      }
      return route.fallback();
    });

    await page.goto("/api-tokens");
    await nameField(page).fill("nightly e2e");
    await expect(createButton(page), "inert while the listing is in flight").toBeDisabled();
    release();
    await expect(createButton(page)).toBeEnabled();
  });

  test("a login session still gets the AI features", async ({ page }) => {
    // The control for the test above: without it, a bug that hid Ask AI from
    // everybody would read as the fence working.
    await signIn(page);
    await stubProfile(page);
    await page.goto("/");

    await expect(page.getByRole("button", { name: `Account: ${EMAIL}` })).toBeVisible();
    await expect(page.getByRole("button", { name: "Ask AI", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Style", exact: true })).toBeVisible();
  });

  test("an anonymous visitor is sent to the broker with /api-tokens preserved", async ({ page }) => {
    await page.route("**/broker/userinfo", (route) => route.fulfill({ status: 401, json: {} }));
    const brokerUrls: string[] = [];
    await page.route("**/broker/login**", (route) => {
      brokerUrls.push(route.request().url());
      return route.abort();
    });

    await page.goto("/api-tokens");
    await expect.poll(() => brokerUrls.length, { timeout: 5_000 }).toBeGreaterThan(0);
    expect(decodeURIComponent(brokerUrls[0]!)).toContain("/api-tokens");
  });

  test("a hard load of /api-tokens resolves to the page, not the playground", async ({ page }) => {
    // The `parseRoute()` ordering hazard: the SPA fallback serves index.html for
    // every path, so a missing regex renders the editor instead of 404ing.
    await signIn(page);
    await stubProfile(page);
    await stubTokensApi(page);
    await page.goto("/api-tokens");

    await expect(page.getByRole("heading", { name: "API tokens" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Share this demo" })).toHaveCount(0);
  });
});
