import { test, expect, type Page } from "@playwright/test";

// Authed action surfaces (DEV-2167 / T10, ADR-0025). The unframed action bar is
// gone: `Fork` and `Save` share one top-bar slot left of the theme toggle, `Share`
// heads the preview bar's right icon group, and the custom-version input hides
// behind a pencil on the version pill. `Embed` has no button — the share icon is
// mode-aware and mints the demo itself in `play`.
//
// Deterministic — no `E2E_LIVE=1`: nothing here renders the example, so the
// Sandpack bundler is aborted and every API call is stubbed.
//
// Sign-in is faked at the *token* layer, for the reasons `sidebar-crud.spec.ts`
// sets out at length: a build-layer `VITE_DEV_USER` bypass leaks into production
// builds through `.env.local`, which would make every anonymous case below pass
// without proving anything. Hence the `Sign in` / avatar preconditions.

const EMAIL = "dev@handsontable.com";
const DEMO_ID = "e2eacts01";
const MINTED_ID = "e2eminted1";

const DEMO_FILES = {
  "/src/App.tsx": "export default function App() { return null; }\n",
  "/index.html": '<div id="root"></div>',
  "/package.json": JSON.stringify({ dependencies: { handsontable: "18.0.0" } }, null, 2),
};

async function stubShell(page: Page) {
  await page.route("**/api/versions", (route) =>
    route.fulfill({ json: { latest: "18.0.0", next: "19.0.0-next.1", versions: ["18.0.0", "17.1.0"] } }),
  );
  await page.route("https://sandpack.codesandbox.io/**", (route) => route.abort());
  await page.route("https://sandpack-bundler.codesandbox.io/**", (route) => route.abort());
  await page.route("**/broker/login**", (route) => route.abort());
}

async function signIn(page: Page) {
  await page.addInitScript(() => sessionStorage.setItem("hot_token", "e2e-token"));
  await page.route("**/broker/userinfo", (route) => route.fulfill({ json: { email: EMAIL } }));
}

async function stubSavedDemo(page: Page) {
  await page.route("**/api/demos/**", (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith("/source")
        ? { framework: "react", files: DEMO_FILES }
        : { title: "Saved demo", description: null, ht_version: "18.0.0", created_at: null },
    }),
  );
}

/**
 * Records the collection-level calls the two mint paths make. `**` + `/api/demos`
 * with no trailing segment on purpose: `**​/api/demos/**` (what `stubSavedDemo`
 * registers) requires a literal `/` after `demos` and so never matches the POST.
 * The two handlers cannot shadow each other.
 */
async function stubMint(page: Page, holdMs = 0) {
  const posts: string[] = [];
  await page.route("**/api/demos", async (route) => {
    posts.push(route.request().postData() ?? "");
    // A deliberate hold when asked, so the in-flight treatment is observable.
    if (holdMs) await new Promise((r) => setTimeout(r, holdMs));
    await route.fulfill({ json: { id: MINTED_ID } });
  });
  return posts;
}

const forkButton = (page: Page) => page.getByRole("button", { name: "Fork", exact: true });
const saveButton = (page: Page) => page.getByRole("button", { name: /^Save/ });
const shareIcon = (page: Page) => page.getByRole("button", { name: "Share this demo" });
/** The *visible* editor. Scoped to the shown pane since T12 (DEV-2169): every open
 *  tab keeps its own mounted CodeMirror, so a bare `.cm-content` matches one element
 *  per open tab. Only one file is open in these tests today, but the scoping is what
 *  keeps that from being load-bearing. */
const editor = (page: Page) => page.locator('[data-pane-active="true"] .cm-content');
/** `exact`, or it also matches the pencil's "Set a custom Handsontable version". */
const versionPill = (page: Page) =>
  page.getByRole("button", { name: "Handsontable version", exact: true });
const versionPencil = (page: Page) =>
  page.getByRole("button", { name: "Set a custom Handsontable version" });
const versionInput = (page: Page) => page.getByRole("textbox", { name: "Custom Handsontable version" });
const shareDialog = (page: Page) => page.getByRole("dialog", { name: "Share this demo" });

/** The retired bar. Not a landmark, so it is matched on the attribute itself —
 *  its absence is the headline assertion of this whole file. */
const actionBar = (page: Page) => page.locator('[aria-label="Demo actions"]');

const signInButton = (page: Page) => page.getByRole("button", { name: "Sign in" });
const accountAvatar = (page: Page) => page.getByRole("button", { name: `Account: ${EMAIL}` });

async function expectNoAuthedActions(page: Page) {
  await expect(actionBar(page)).toHaveCount(0);
  await expect(forkButton(page)).toHaveCount(0);
  await expect(saveButton(page)).toHaveCount(0);
  await expect(shareIcon(page)).toHaveCount(0);
  await expect(versionPencil(page)).toHaveCount(0);
}

test("anonymous play has no authed action surfaces", async ({ page }) => {
  await stubShell(page);
  await page.goto("/?example=react");

  await expect(signInButton(page)).toBeVisible();
  await expect(versionPill(page)).toBeVisible();

  await expectNoAuthedActions(page);
});

test("signed-in play puts Fork in the top bar and Share in the preview bar", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await page.goto("/?example=react");

  await expect(accountAvatar(page)).toBeVisible();

  await expect(forkButton(page)).toBeVisible();
  await expect(shareIcon(page)).toBeVisible();
  await expect(versionPencil(page)).toBeVisible();
  // `play` is not a saved demo, so the slot holds Fork and nothing else.
  await expect(saveButton(page)).toHaveCount(0);
  // The point of the ticket.
  await expect(actionBar(page)).toHaveCount(0);
});

test("the play share icon mints a demo, then opens the same dialog Embed did", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  const posts = await stubMint(page);
  await page.goto("/?example=react");

  await expect(accountAvatar(page)).toBeVisible();
  await shareIcon(page).click();

  await expect(shareDialog(page)).toBeVisible();
  expect(posts).toHaveLength(1);

  // The third row is why `Embed` needs no button of its own.
  await expect(shareDialog(page).getByText("Docs embed URL (handsontable.com only)")).toBeVisible();
  await expect(shareDialog(page).getByRole("textbox").nth(2)).toHaveValue(
    new RegExp(`/embed/${MINTED_ID}`),
  );
});

// The prerequisite ADR-0025 called out: a 36px icon and a 49px button cannot
// render "Preparing…" or "Creating…", so both had to grow an icon-form pending
// treatment before Fork and Share could move here. Nothing in the type system
// guards this — `forking` and `sharing` are both optional booleans, so wiring
// the wrong one at the call site still compiles.
test("the share icon and Fork show their in-flight state", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await stubMint(page, 1500);
  await page.goto("/?example=react");

  await expect(accountAvatar(page)).toBeVisible();

  await shareIcon(page).click();
  const preparing = page.getByRole("button", { name: "Preparing…" });
  await expect(preparing).toBeVisible();
  await expect(preparing).toBeDisabled();
  await expect(preparing).toHaveCSS("cursor", "default");
  // …and it resolves back rather than sticking.
  await expect(shareDialog(page)).toBeVisible();
  await expect(shareIcon(page)).toBeEnabled();
});

test("Fork shows its in-flight state and is driven by `forking`, not `sharing`", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await stubMint(page, 1500);
  await page.goto("/?example=react");

  await expect(accountAvatar(page)).toBeVisible();

  await forkButton(page).click();
  const creating = page.getByRole("button", { name: "Creating…" });
  await expect(creating).toBeVisible();
  await expect(creating).toBeDisabled();
  // A disabled button keeps its base `cursor` unless something clears it.
  await expect(creating).toHaveCSS("cursor", "default");
  // The regression this guards: while Fork is in flight the *share* icon must
  // stay live. Before T10 one flag drove both under two different names.
  await expect(shareIcon(page)).toBeEnabled();
});

test("signed-in edit swaps Fork for Save and shares without minting", async ({ page }) => {
  await stubShell(page);
  await stubSavedDemo(page);
  await signIn(page);
  const posts = await stubMint(page);
  await page.goto(`/edit/${DEMO_ID}`);

  await expect(accountAvatar(page)).toBeVisible();
  await expect(saveButton(page)).toBeVisible();
  await expect(forkButton(page)).toHaveCount(0);

  // `edit` already has an id, so the dialog opens off `savedId` with no request.
  await shareIcon(page).click();
  await expect(shareDialog(page)).toBeVisible();
  expect(posts).toHaveLength(0);
  await expect(shareDialog(page).getByRole("textbox").first()).toHaveValue(
    new RegExp(`/share/${DEMO_ID}$`),
  );
});

test("Ctrl+S saves in edit mode", async ({ page }) => {
  await stubShell(page);
  await stubSavedDemo(page);
  await signIn(page);

  const patches: string[] = [];
  await page.route(`**/api/demos/${DEMO_ID}`, async (route) => {
    if (route.request().method() === "PATCH") {
      patches.push(route.request().method());
      return route.fulfill({ json: { ok: true } });
    }
    return route.fallback();
  });

  await page.goto(`/edit/${DEMO_ID}`);
  await expect(saveButton(page)).toBeVisible();

  // Focus inside CodeMirror before pressing, because that is where a user's
  // focus actually is when they reach for Save. CodeMirror installs its own
  // keydown handling on `.cm-content`, so a shortcut proven only against
  // `<body>` proves nothing about the case the shortcut exists for.
  await editor(page).click();
  await page.keyboard.type("// edit");
  await expect(saveButton(page)).toHaveText("Save •");

  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => patches.length).toBe(1);
  // The dot clears on a successful save — the workspace-level `dirty` boolean
  // T10 keeps consuming, and the one T12 must not break when it adds per-file.
  await expect(saveButton(page)).toHaveText("Save");

  // Caps Lock sends `key: "S"` with `shiftKey` false. Dispatched rather than
  // pressed because Playwright cannot latch Caps Lock, and the handler is on
  // `document` — the guard is what is under test here, and a case-sensitive one
  // would both skip the save and let the browser's own dialog through.
  await editor(page).click();
  await page.keyboard.type("// more");
  await expect(saveButton(page)).toHaveText("Save •");

  const defaultPrevented = await page.evaluate(() => {
    const e = new KeyboardEvent("keydown", {
      key: "S",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(e);
    return e.defaultPrevented;
  });
  expect(defaultPrevented).toBe(true);
  await expect.poll(() => patches.length).toBe(2);
});

test("Ctrl+S does not save the workspace from under an open dialog", async ({ page }) => {
  await stubShell(page);
  await stubSavedDemo(page);
  await signIn(page);

  const patches: string[] = [];
  await page.route(`**/api/demos/${DEMO_ID}`, async (route) => {
    if (route.request().method() === "PATCH") {
      patches.push(route.request().method());
      return route.fulfill({ json: { ok: true } });
    }
    return route.fallback();
  });

  // `?edit=info` opens the Edit info dialog at mount (`App.tsx:516`).
  await page.goto(`/edit/${DEMO_ID}?edit=info`);
  const dialog = page.getByRole("dialog", { name: "Edit info" });
  await expect(dialog).toBeVisible();

  // Type a draft title. It lives in the dialog's local state until *its* Save,
  // so a workspace save here would persist the old one behind the new.
  await dialog.getByLabel("Title").fill("A draft nobody committed");
  await page.keyboard.press("ControlOrMeta+s");

  // Swallowed: no PATCH, and the dialog is still up with the draft intact.
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Title")).toHaveValue("A draft nobody committed");
  expect(patches).toHaveLength(0);
});

test("a signed-in visitor gets no authed actions on someone else's share", async ({ page }) => {
  await stubShell(page);
  await stubSavedDemo(page);
  await signIn(page);
  await page.goto(`/share/${DEMO_ID}`);

  // `ShareRoute` renders the workspace anonymous but still hands the identity to
  // the top bar, so the avatar is the only honest precondition here. Without it
  // this passes at t=0 whatever the gate does — and this route is exactly where
  // `accountEmail` and `authed` disagree.
  await expect(accountAvatar(page)).toBeVisible();

  await expectNoAuthedActions(page);
  // The version is pinned on a share, so the pill is inert text rather than a picker.
  await expect(versionPill(page)).toHaveCount(0);
});

test("the version pencil commits a custom version on Enter and reverts on Escape", async ({ page }) => {
  await stubShell(page);
  await signIn(page);
  await page.goto("/?example=react");

  await expect(accountAvatar(page)).toBeVisible();
  await expect(versionPill(page)).toContainText("18.0.0");

  // Escape first: it must leave the picker exactly as it found it.
  await versionPencil(page).click();
  await versionInput(page).fill("0.0.0-next-07941cf-20260101");
  await page.keyboard.press("Escape");
  await expect(versionInput(page)).toHaveCount(0);
  await expect(versionPill(page)).toContainText("18.0.0");

  await versionPencil(page).click();
  await versionInput(page).fill("0.0.0-next-07941cf-20260101");
  await page.keyboard.press("Enter");
  await expect(versionInput(page)).toHaveCount(0);
  await expect(versionPill(page)).toContainText("0.0.0-next-07941cf-20260101");
});

// DEV-2505: `Sign in` is an internal, @handsontable.com-only affordance, so it
// lives in the preview status bar rather than the top bar. Asserted by *place*,
// not just by presence — the next redesign would otherwise put it back beside
// Download without anything failing.
test("Sign in sits in the status bar, not the top bar", async ({ page }) => {
  await stubShell(page);
  await page.goto("/?example=react");

  const signIn = page.getByRole("button", { name: "Sign in" });
  await expect(signIn).toBeVisible();

  // Inside the preview status bar…
  await expect(page.getByLabel("Preview status").getByRole("button", { name: "Sign in" })).toBeVisible();
  // …and nowhere in the header.
  await expect(page.locator("header").getByRole("button", { name: "Sign in" })).toHaveCount(0);
});
