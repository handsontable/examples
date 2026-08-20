import { test, expect } from "@playwright/test";
import { expectGridRendered, stubShell } from "./helpers";

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

  const preview = page.frameLocator("iframe").first();
  const grid = preview.locator(".handsontable td").first();
  await page.goto("/?example=react");
  await expect(previewStatus(page)).toHaveAttribute("data-preview-status", "ready", {
    timeout: 120_000,
  });
  await expect(grid).toBeVisible({ timeout: 90_000 });

  // The bug leaves nothing the chrome can see: the no-change push resets the
  // preview *document* with a clean `done` — no error, `data-preview-status`
  // stays "ready" — so a fixed sleep here was a window the erroneous push could
  // simply arrive after, and the external bundler's latency is unbounded. What a
  // document reset cannot survive is state on the preview's own window: a real
  // (changed-file) compile re-evaluates modules in the same document and keeps
  // it, only a document reset drops it. So mark the window, close the hazard on
  // an event, and check the mark.
  const previewFrame = async () => {
    const frame = await (await page.locator("iframe").first().elementHandle())?.contentFrame();
    if (!frame) throw new Error("the preview frame is gone");
    return frame;
  };
  await (await previewFrame()).evaluate(() => {
    (window as Window & { __hotDocumentKept?: boolean }).__hotDocumentKept = true;
  });

  // Drop the comma after a `colHeaders` entry: a syntax error, so the transpile fails and
  // the bundler is never told. The grid on screen is the last good render. The pause is
  // not the oracle — a failed transpile pushes nothing, so there is no event to wait on;
  // it only spaces the two edits so they reach the recompute as two cycles rather than
  // coalescing in one debounce window.
  const commaAt = await page.evaluate(`(() => {
    const view = document.querySelector('.cm-content').cmTile.view;
    const at = view.state.doc.toString().indexOf("'Company name',") + "'Company name'".length;
    view.dispatch({ changes: { from: at, to: at + 1, insert: "" } });
    return at;
  })()`);
  await page.waitForTimeout(2000);
  await expect(grid).toBeVisible();

  // Put it back. The file is now byte-identical to the one that rendered — the push
  // the fix exists to suppress.
  await page.evaluate(
    `document.querySelector('.cm-content').cmTile.view.dispatch({ changes: { from: ${commaAt}, insert: "," } })`,
  );

  // Close the hazard window on an event rather than the clock: a *real* edit queued
  // behind the un-break. Pushes are FIFO through the one client, so by the time this
  // edit's output is on screen, whatever the un-break pushed (nothing, if the fix
  // holds) has already been through the bundler — however slow the round trip was.
  await page.evaluate(`(() => {
    const view = document.querySelector('.cm-content').cmTile.view;
    const doc = view.state.doc.toString();
    const at = doc.indexOf("'Company name'") + 1;
    view.dispatch({ changes: { from: at, to: at + "Company name".length, insert: "Sentinel column" } });
  })()`);
  // Handsontable renders a column header more than once — the master table
  // plus overlay clones, and at least one copy is a hidden internal render —
  // so a bare getByText is a strict-mode violation the moment the rename
  // actually lands, and a positional .first() can pin the hidden copy. Filter
  // to the visible instance (first live run of this rework, DEV-2203).
  await expect(
    preview.getByText("Sentinel column").filter({ visible: true }).first(),
  ).toBeVisible({ timeout: 60_000 });

  // The grid never left, the status never left ready — and, the discriminating bit,
  // the preview document was never reset behind our back.
  await expect(grid).toBeVisible();
  await expect(previewStatus(page)).toHaveAttribute("data-preview-status", "ready");
  expect(
    await (await previewFrame()).evaluate(
      () => (window as Window & { __hotDocumentKept?: boolean }).__hotDocumentKept,
    ),
    "the byte-identical push reset the preview document",
  ).toBe(true);
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

// DEV-2569 / Sentry DEMOS-15 — the compiler chunk, and the only place its failure is real.
//
// Tier 1 pre-transpiles sources for the classic `parcel` bundler, which needs
// @babel/standalone: ~2.3 MB, code-split, fetched on first compile. It fails for ordinary
// reasons (offline, a blocked request, an extension) and it used to fail permanently for
// one of ours — a deploy rotating the chunk out from under a tab, which Workers Assets
// answers with `200 text/html` rather than a 404. `assets/compiler-babel.js` is hash-free
// now so that population is gone (`scripts/check-compiler-chunk.mjs` pins the name), and
// what is left is the transient case these two tests drive.
//
// This spec is the *only* place the loader can be tested honestly. Its two import sites are
// byte-identical in source and are not identical in the bundle — Vite rewrites the bare
// specifier and inserts a CJS-interop hop the `@vite-ignore` retry does not get — so the
// retry used to resolve the chunk's raw module record and die on the next compile with
// `e.transform is not a function`. `pipeline/transpile-loader.test.mjs` imports
// `packages/runtime/dist`, where both paths really are equivalent, and was green over
// exactly that. Playwright runs against a real `vite build` (see playwright.config.ts), so
// here the divergence exists.
//
// Verified red: with the two `asBabel` calls in transpile.ts reverted, the recovery
// assertion below fails — the status stays `error` after Restart, which is what production
// did.

/** The compiler chunk plus any retry query. The trailing `*` is load-bearing: without it
 *  the `?hotRetry=n` requests slip past the block and the test passes for the wrong reason. */
const COMPILER_CHUNK = "**/assets/compiler-babel.js*";

test("a blocked compiler chunk cards, and Restart preview really recovers", async ({ page }) => {
  test.setTimeout(120_000);
  // Deterministic in the strict sense: `stubShell` alone is not enough here. A `parcel`
  // sandbox loads its bundler from a *versioned* host (measured: 2-19-8-sandpack.codesandbox.io)
  // plus jsdelivr and prod-packager-packages, none of which stubShell's two globs match — so
  // this case would have quietly depended on the external bundler. Everything off-localhost is
  // aborted instead, which costs the `ready` end-state (that one is the E2E_LIVE case below)
  // and keeps a sharper oracle: with the bundler unreachable, `booting` means our transpile
  // finished and handed the sandbox over, and `error` means it did not.
  await stubShell(page);
  await page.route((url) => url.hostname !== "localhost", (route) => route.abort());

  // The oracle. Handing the compiled sandbox to the bundler is the first thing that happens
  // *after* our transpile succeeds, and `buildSetup` throws ahead of it when the transpile
  // fails — so an attempted bundler request is a positive signal that the compiler produced
  // usable output. Measured both ways on this build: 2 attempts with the fix, 0 without.
  // The requests are aborted by the route above, so nothing leaves the machine.
  const bundlerAttempts: string[] = [];
  page.on("request", (r) => {
    const { hostname } = new URL(r.url());
    if (/sandpack/.test(hostname)) bundlerAttempts.push(hostname);
  });

  const asked: string[] = [];
  let blocked = true;
  await page.route(COMPILER_CHUNK, (route) => {
    asked.push(new URL(route.request().url()).search || "(bare)");
    return blocked ? route.abort() : route.fallback();
  });

  // `javascript` is Tier 1 on the `parcel` environment (catalog.json) — the one engine that
  // needs the compiler at all.
  await page.goto("/?example=javascript");
  await expect(previewStatus(page)).toHaveAttribute("data-preview-status", "error", {
    timeout: 60_000,
  });
  await expect(page.getByText("The preview could not start")).toBeVisible();
  await expect(page.locator("pre")).toContainText("The preview compiler could not be downloaded");
  const restart = page.getByRole("button", { name: "Restart preview" });
  await expect(restart, "the card has to offer the action its copy names").toBeVisible();
  expect(asked, "two bounded attempts, and the second must ask for a URL of its own").toEqual([
    "(bare)",
    "?hotRetry=1",
  ]);

  expect(bundlerAttempts, "a failed transpile never reaches the bundler").toEqual([]);

  blocked = false;
  await restart.click();

  // The whole fix. Before it the retry resolved the chunk's raw module record and the card
  // flipped to the exact string production showed — "Failed to transpile /index.js for the
  // parcel sandbox: e.transform is not a function" — with the status stuck on `error` and no
  // bundler request ever attempted. Note `data-preview-status` is deliberately *not* the
  // oracle here: `booting` is on the failure path too (it precedes `error`), so asserting it
  // passes with the fix reverted.
  await expect
    .poll(() => bundlerAttempts.length, { timeout: 60_000, intervals: [250] })
    .toBeGreaterThan(0);
  await expect(page.getByText("The preview could not start")).toHaveCount(0);
  // A browser caches a failed module fetch in the document's module map, so re-importing the
  // *same* specifier never touches the network again — which is why the remount's bare import
  // files no third request, and why `rearm` has to mint a fresh query to be honest.
  expect(asked).toEqual(["(bare)", "?hotRetry=1", "?hotRetry=2"]);
});

test("live: the grid renders after a compiler-chunk recovery", async ({ page }) => {
  test.skip(process.env.E2E_LIVE !== "1", "set E2E_LIVE=1 to run live-render checks");
  test.setTimeout(180_000);
  // The half that was never clicked through before shipping. `booting` above is our own
  // signal; a real bundler behind it is what proves the recovered compiler's output builds.

  let blocked = true;
  await page.route(COMPILER_CHUNK, (route) => (blocked ? route.abort() : route.fallback()));

  await page.goto("/?example=javascript");
  await expect(previewStatus(page)).toHaveAttribute("data-preview-status", "error", {
    timeout: 60_000,
  });

  blocked = false;
  await page.getByRole("button", { name: "Restart preview" }).click();
  await expect(previewStatus(page)).toHaveAttribute("data-preview-status", "ready", {
    timeout: 120_000,
  });
  await expectGridRendered(page);
});
