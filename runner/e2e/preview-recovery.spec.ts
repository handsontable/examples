import { test, expect } from "@playwright/test";

// The preview must be able to come back. A runtime error in edited code puts the
// pane into `error` (the "The preview could not start" card); fixing the code has
// to clear it again. It did not: `SandpackRuntime.emitReady()` fired at most once
// per mount, so the bundler's next clean `done` — the honest "your fix compiled
// and ran" signal — was swallowed, and the error card outlived the error. The only
// way out was an example switch or a version change, both of which remount.
//
// Live — needs the external Sandpack bundler; opt-in via E2E_LIVE=1, like the
// other render checks.

/** The visible editor. Hidden panes stay mounted (T12), so an unscoped
 *  `.cm-content` would match every open file and resolve in DOM order. */
const activeEditor = (page: import("@playwright/test").Page) =>
  page.locator('[data-pane-active="true"] .cm-content');

const previewStatus = (page: import("@playwright/test").Page) =>
  page.locator('[aria-label="Preview"]');

// The browser-side Sentry gate rests on one premise (DEV-2540): the app stops
// reporting when `navigator.webdriver` is true, which is what keeps a suite pointed
// at production out of the production Sentry project. DEMOS-P is what that looked
// like before the gate existed — three real issues filed by an ad-hoc
// `E2E_BASE_URL=https://demos.handsontable.com` run, tagged
// `context: tier2-session-start`, from the same 503 session refusal the test below
// stubs. If this assertion ever goes false the gate is silently open again, and
// nothing else in the suite would notice.
//
// `playwright.config.ts` declares a single `chromium` project. Adding a firefox or
// webkit project means re-verifying this there rather than assuming it carries over.
test("the harness identifies itself as automation", async ({ page }) => {
  await page.goto("/");
  expect(await page.evaluate(() => navigator.webdriver)).toBe(true);
});

// Deterministic — no `E2E_LIVE=1`: the session POST is stubbed to a refusal, so the
// error card appears whether or not a real API worker (and container pool) happens to be
// reachable from wherever the suite runs. Without the stub this test passes only when
// nothing answers `/api` — which is true in CI and false on a developer's machine with
// the local worker up.
//
// Tier 2 has no self-healing equivalent of the Tier-1 fix below. A boot failure means
// the container's boot script exited, so its dev server is gone: the fixed file streams
// into a container with nothing left to serve it, and `reload()` (row-2 refresh) bails
// early because the iframe was never pointed. A remount is the only way back, and this
// button is the only thing that asks for one.
test("a failed preview offers a restart that remounts the runtime", async ({ page }) => {
  const sessionPosts: string[] = [];
  await page.route("**/api/session", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    sessionPosts.push(route.request().url());
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "no container slots" }),
    });
  });

  // `react-js` is a container starter; `vue`, despite the name, is Tier 1 (see
  // catalog.json) and boots in-browser with no session at all.
  await page.goto("/?example=react-js");
  await expect(previewStatus(page)).toHaveAttribute("data-preview-status", "error", {
    timeout: 60_000,
  });
  const restart = page.getByRole("button", { name: "Restart preview" });
  await expect(restart).toBeVisible();

  const before = sessionPosts.length;
  expect(before, "the first mount attempted a session").toBeGreaterThan(0);
  await restart.click();
  // A fresh session POST is the observable proof the runtime remounted; asserting on the
  // status attribute alone would pass on a button that did nothing, since the retry ends
  // in the same error here (there is still no worker).
  await expect(async () => {
    expect(sessionPosts.length).toBeGreaterThan(before);
  }).toPass({ timeout: 30_000 });
  await expect(previewStatus(page)).toHaveAttribute("data-preview-status", "error", {
    timeout: 60_000,
  });
});

// DEV-2554. A full container pool is temporary, so the card says so and asks again
// on its own instead of leaving a dead frame.
//
// THIS TEST IS THE ONLY THING PINNING THE HEURISTIC BYPASS. `describeRuntimeError`
// in apps/authoring/src/App.tsx rewrites any container-engine message matching
// /…|session start failed|fetch/i into "run the local API worker (requires Docker)".
// The server's capacity refusal is a 503 whose message the runtime wraps as
// "session start failed (503): …", so it WOULD match — the escape is an early return
// keyed on `code === "at_capacity"`, placed above the regex. The unit test in
// `pipeline/session-start-failure.test.mjs` can only pin the code and the status; it
// cannot see App.tsx at all. Delete assertion (a) and DEV-2538 comes back on this
// status with nothing else noticing.
//
// The stub's message is obviously synthetic on purpose, following the "e2e: refused
// on purpose" convention above: a realistic-looking capacity sentence in a
// `route.fulfill` is exactly what made the DEMOS-P issues unreadable for a week.
test("a pool at capacity retries itself and never mentions Docker", async ({ page }) => {
  const sessionPosts: string[] = [];
  await page.route("**/api/session", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    sessionPosts.push(route.request().url());
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      headers: { "retry-after": "1" },
      body: JSON.stringify({
        error: "at_capacity",
        message: "e2e: at capacity on purpose",
        retryAfterSeconds: 1,
      }),
    });
  });

  await page.goto("/?example=react-js");
  await expect(previewStatus(page)).toHaveAttribute("data-preview-status", "error", {
    timeout: 60_000,
  });

  // (a) THE CONTRACT. The visitor is told the slots are busy, not to install Docker.
  await expect(page.getByText(/All live-demo slots are busy/)).toBeVisible();
  await expect(page.getByText(/requires Docker/)).toHaveCount(0);
  // The wrapped runtime jargon must not reach the card either.
  await expect(page.getByText(/session start failed/)).toHaveCount(0);

  // (b) The retry is automatic: a second POST with nothing clicked.
  const before = sessionPosts.length;
  expect(before, "the first mount attempted a session").toBeGreaterThan(0);
  await expect(async () => {
    expect(sessionPosts.length).toBeGreaterThan(before);
  }).toPass({ timeout: 30_000 });

  // (c) The budget is bounded at exactly three creates, and then retrying STOPS.
  // This is what catches the reset-on-`retryGen` mistake, which retries for ever
  // against a pool that is already full.
  await expect(async () => {
    expect(sessionPosts.length).toBe(3);
  }).toPass({ timeout: 60_000 });

  // The countdown text is the difference between "spent" and "merely mid-wait". The
  // pane deliberately stays `data-preview-status="error"` *during* each wait — the
  // message explains the delay instead of a silent spinner — so the error card and
  // its "Restart preview" button are on screen throughout, and sampling the POST
  // count on the button alone would read a number from between two attempts.
  await expect(page.getByText(/Retrying in/)).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByText(/All live-demo slots are busy/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Restart preview" })).toBeVisible();

  await page.waitForTimeout(8000);
  expect(sessionPosts.length, "retrying must stop once the budget is spent").toBe(3);

  // (d) The bound is three creates PER DELIBERATE ATTEMPT, not three for ever.
  // "Restart preview" refills the budget — a person who chose to try again gets a
  // real try, and by then the pool may well have freed a slot. Stated here because
  // it is a design decision, not a side effect: only the button refills it (the
  // automatic retry inlines the same state updates precisely so it cannot), and
  // without this assertion that distinction is invisible.
  await page.getByRole("button", { name: "Restart preview" }).click();
  await expect(async () => {
    expect(sessionPosts.length).toBe(6);
  }).toPass({ timeout: 60_000 });
});

test("live: fixing a runtime error clears the preview error card", async ({ page }) => {
  test.skip(process.env.E2E_LIVE !== "1", "set E2E_LIVE=1 to run live-render checks");
  test.setTimeout(180_000);

  await page.goto("/?example=react");
  await expect(previewStatus(page)).toHaveAttribute("data-preview-status", "ready", {
    timeout: 120_000,
  });
  await expect(page.frameLocator("iframe").first().locator(".handsontable td").first()).toBeVisible({
    timeout: 90_000,
  });

  // Break it the way a user does: a reference to something that doesn't exist.
  // Compiles clean, throws when the module is evaluated.
  const editor = activeEditor(page);
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("\nconsole.log(alignHeadersTypo);");

  await expect(previewStatus(page)).toHaveAttribute("data-preview-status", "error", {
    timeout: 60_000,
  });
  await expect(page.getByText("The preview could not start")).toBeVisible();

  // Undo the edit — the fix. Select the broken line and remove it, newline and all.
  await page.keyboard.press("Shift+Home");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");

  await expect(previewStatus(page)).toHaveAttribute("data-preview-status", "ready", {
    timeout: 60_000,
  });
  await expect(page.getByText("The preview could not start")).toHaveCount(0);
  // Attribute alone would pass on a blanked pane; the grid has to be back.
  await expect(page.frameLocator("iframe").first().locator(".handsontable td").first()).toBeVisible({
    timeout: 60_000,
  });
});

// The counterpart to the test above: an unsupported version is refused before any runtime
// is built, so a remount would re-run the same refusal. The card has no action, and the
// version picker (still live behind it) is where the fix actually is.
test("a version the runner refuses gets no restart button", async ({ page }) => {
  await page.goto("/?example=react&v=99.99.99");
  await expect(previewStatus(page)).toHaveAttribute("data-preview-status", "error", {
    timeout: 30_000,
  });
  await expect(page.getByText("The preview could not start")).toBeVisible();
  await expect(page.getByRole("button", { name: "Restart preview" })).toHaveCount(0);
});

// A compile the bundler sees as "no module changed" resets the preview document without
// re-evaluating anything: a blank frame, `done` with no error, nothing in the console.
// Two paths hit it. This is the one reachable by typing: break a line (the transpile
// throws, so nothing is pushed and the good render stays), then undo the break — the
// recomputed sandbox is byte-identical to what the bundler already has, and pushing it
// blanked a preview that was correct. Not pushing is the fix.
test("live: breaking and un-breaking a line leaves the grid alone", async ({ page }) => {
  test.skip(process.env.E2E_LIVE !== "1", "set E2E_LIVE=1 to run live-render checks");
  test.setTimeout(180_000);

  const grid = page.frameLocator("iframe").first().locator(".handsontable td").first();
  await page.goto("/?example=react");
  await expect(previewStatus(page)).toHaveAttribute("data-preview-status", "ready", {
    timeout: 120_000,
  });
  await expect(grid).toBeVisible({ timeout: 90_000 });

  // Drop the comma after a `colHeaders` entry: a syntax error, so the transpile fails and
  // the bundler is never told. The grid on screen is the last good render.
  const commaAt = await page.evaluate(`(() => {
    const view = document.querySelector('.cm-content').cmTile.view;
    const at = view.state.doc.toString().indexOf("'Company name',") + "'Company name'".length;
    view.dispatch({ changes: { from: at, to: at + 1, insert: "" } });
    return at;
  })()`);
  await page.waitForTimeout(4000);
  await expect(grid).toBeVisible();

  // Put it back. The file is now byte-identical to the one that rendered.
  await page.evaluate(
    `document.querySelector('.cm-content').cmTile.view.dispatch({ changes: { from: ${commaAt}, insert: "," } })`,
  );
  await page.waitForTimeout(8000);
  await expect(grid).toBeVisible();
  await expect(previewStatus(page)).toHaveAttribute("data-preview-status", "ready");
});

// The other path to the same no-change compile: the row-2 refresh button pushes the
// current sources unchanged, which blanked the preview outright. `reload()` now stamps the
// entry *and* the example module so the bundler has a real diff to act on — stamping the
// HTML shell alone was measured to leave it blank, since a parcel sandbox boots from HTML
// but the module is what has to re-evaluate.
test("live: the refresh button re-runs the sandbox instead of blanking it", async ({ page }) => {
  test.skip(process.env.E2E_LIVE !== "1", "set E2E_LIVE=1 to run live-render checks");
  test.setTimeout(180_000);

  const preview = page.frameLocator("iframe").first();
  await page.goto("/?example=react");
  await expect(previewStatus(page)).toHaveAttribute("data-preview-status", "ready", {
    timeout: 120_000,
  });
  await expect(preview.locator(".handsontable td").first()).toBeVisible({ timeout: 90_000 });

  await page.getByRole("button", { name: "Reload the preview" }).click();
  await expect(preview.locator(".handsontable td").first()).toBeVisible({ timeout: 60_000 });
  // Re-evaluating the entry must not stack a second grid on the page (the DEV-2129 class),
  // and the plugin registry has to survive it — `getPlugin()` returning undefined after a
  // refresh is exactly how that bug presented, with a grid still on screen.
  await expect(preview.locator(".ht-root-wrapper")).toHaveCount(1);
  await preview.locator(".handsontable td").first().click({ button: "right" });
  await expect(preview.locator(".htContextMenu").first()).toBeVisible({ timeout: 15_000 });
});

// The reported Vue case (`VueCompilerError` with a template code frame). It reads like a
// second engine but is not: `vue` is a sandpack starter, so this is the same swallowed-
// `done` bug — through a *compile* error rather than a runtime one. Worth its own test
// because the two arrive differently: a compile failure never evaluates the module, so
// only the `done{compilatonError:true}` + `show-error` pair is seen.
test("live: fixing a Vue template error clears the preview error card", async ({ page }) => {
  test.skip(process.env.E2E_LIVE !== "1", "set E2E_LIVE=1 to run live-render checks");
  test.setTimeout(180_000);

  await page.goto("/?example=vue");
  await expect(previewStatus(page)).toHaveAttribute("data-preview-status", "ready", {
    timeout: 120_000,
  });
  await expect(page.frameLocator("iframe").first().locator(".handsontable td").first()).toBeVisible({
    timeout: 90_000,
  });

  // A second root `<template>` — an SFC compile error, not a runtime one.
  await activeEditor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("\n<template><div /></template>");
  await expect(previewStatus(page)).toHaveAttribute("data-preview-status", "error", {
    timeout: 60_000,
  });

  await page.keyboard.press("Shift+Home");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await expect(previewStatus(page)).toHaveAttribute("data-preview-status", "ready", {
    timeout: 60_000,
  });
  await expect(page.frameLocator("iframe").first().locator(".handsontable td").first()).toBeVisible({
    timeout: 60_000,
  });
});
