import { test, expect, type FrameLocator, type Page } from "@playwright/test";

// Does a generated theme module actually reach the grid? (DEV-2197)
//
// Everything about the Style panel had been checked by running the code
// generator and reading its output — never by loading the result into a
// browser. `pipeline/theme-*.test.mjs` assert on the generated *text*, and
// `e2e/panels.spec.ts` aborts the Sandpack bundler on purpose, so no grid ever
// renders there. Both suites were green while the Vue wiring emitted JSX into
// an SFC and the Astro wiring put an import where Astro reads it as markup:
// perfectly plausible source that no framework could load.
//
// So: one case per wiring shape in `theme/codegen.ts`, each driving the real
// panel and reading the real grid.
//
// Live — needs the Sandpack bundler (Tier 1) or a container session (Tier 2);
// opt-in via E2E_LIVE=1, like the other render checks.
//
//   E2E_LIVE=1 pnpm e2e e2e/style-apply.spec.ts --workers=1
//   E2E_LIVE=1 E2E_BASE_URL=https://demos.handsontable.com pnpm e2e e2e/style-apply.spec.ts --workers=1
//
// `--workers=1` whenever `astro` or `angular` is in the selection: they are the
// Tier-2 cases, the container pool holds 5 slots (`Sandbox max_instances`), and
// sessions are not torn down between tests. At `--workers=2` the second Tier-2
// case fails with the preview stuck on `booting` — which reads as a product
// failure and is not one. Consecutive runs can exhaust the pool on their own.
//
// The Tier-1 cases (react, vue, javascript) need no container and no API worker;
// a plain `vite preview` serves them. Tier 2 needs the API worker reachable on
// the *same origin* — `vite dev` with `VITE_API_BASE` pointed at its own port.

const STYLE = 'aside[aria-label="Style this demo"]';

/** The four shapes `wireTheme` recognises, one example each. `astro` and
 *  `angular` are Tier 2: they boot a real container and are correspondingly
 *  slower, which is why the timeouts below are generous. */
const SHAPES = [
  { example: "react", shape: "<HotTable …>" },
  { example: "vue", shape: "<HotTable …> in an SFC" },
  { example: "javascript", shape: "new Handsontable(el, {…})" },
  { example: "astro", shape: "new Handsontable(el, {…}) in a client script" },
  // Angular's wiring is correct — `pipeline/theme-wiring.test.mjs` runs the real
  // codegen over its `gridSettings` shape — but it cannot be observed here, and
  // the reason is not the theme: **no** edit reaches the Angular preview. A bare
  // `<p>` typed into `data-grid.component.html` was still absent after 90s,
  // while the same probe on `react-js` and `astro` (both Tier 2, both container
  // starters) shows up in about ten seconds. Until the Angular container
  // rebuilds on a file write, every panel that edits files — the editor, the AI
  // assistant, this one — is invisible there. DEV-2216; un-`fixme` this case
  // when it lands, and it should pass unchanged.
  { example: "angular", shape: "gridSettings = {…}", blocked: "the Angular container never rebuilds on a file write" },
] as const;

const preview = (page: Page): FrameLocator => page.frameLocator("iframe").first();
const cell = (page: Page) => preview(page).locator(".handsontable td").first();

/**
 * The theme class Handsontable put on the grid's root wrapper.
 *
 * This, not colour, is the signal that a theme took. Cell colours are a trap:
 * several starters ship their own stylesheet (`table.htCore tr.odd td {
 * background: #fafbff }`), which outranks the theme's tokens — a themed React
 * grid and an unthemed one both read `rgb(250, 251, 255)` on the first cell.
 * An assertion on that passes or fails on which row happens to come first.
 */
async function themeClass(page: Page): Promise<string> {
  return preview(page).locator(".handsontable").first().evaluate((el) => {
    const wrapper = el.closest("[class*='ht-theme-']");
    return [...(wrapper?.classList ?? [])].find((c) => c.startsWith("ht-theme-")) ?? "";
  });
}

/** The rendered height of the first data cell — the density signal. */
async function cellHeight(page: Page): Promise<number> {
  return cell(page).evaluate((el) => Math.round(el.getBoundingClientRect().height));
}

async function openExample(page: Page, example: string) {
  await page.goto(`/?example=${example}`);
  await expect(page.locator('[aria-label="Preview"]')).toHaveAttribute("data-preview-status", "ready", {
    timeout: 180_000,
  });
  await expect(cell(page)).toBeVisible({ timeout: 120_000 });
}

async function openStylePanel(page: Page) {
  await page.getByRole("button", { name: "Style", exact: true }).click();
  await expect(page.locator(STYLE)).toBeVisible();
}

/** The panel writes the theme through the editor's own file-write path, so the
 *  module landing in the tree is the signal that an apply completed. */
async function expectThemeModuleWritten(page: Page) {
  await expect(page.locator(".hot-file-row", { hasText: "handsontable-theme" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator(STYLE).getByText("Applied to the preview")).toBeVisible();
}

for (const { example, shape, blocked } of SHAPES.map((s) => ({ blocked: undefined, ...s }))) {
  test.describe(`${example} — ${shape}`, () => {
    test.skip(process.env.E2E_LIVE !== "1", "set E2E_LIVE=1 to run live-render checks");
    // `fixme`, not deletion: these assertions are right and the product is not.
    // Removing them would lose the only executable record of what is broken.
    if (blocked) test.fixme(true, blocked);
    test.describe.configure({ timeout: 300_000 });

    test("a theme applies to the grid, and Reset takes it back off", async ({ page }) => {
      // Every warning the demo logs, so the alias check below sees the whole run.
      const console_: string[] = [];
      page.on("console", (message) => console_.push(message.text()));

      await openExample(page, example);
      const before = await themeClass(page);
      await openStylePanel(page);

      const drawer = page.locator(STYLE);

      // 1. The generated theme reaches the grid. Handsontable names the root
      //    wrapper after the theme it actually resolved, so this distinguishes
      //    "our module applied" from "the demo's original theme is still on",
      //    which is exactly the state the container-class bug left behind.
      await drawer.getByLabel("Colour scheme").selectOption("dark");
      await expectThemeModuleWritten(page);
      await expect(async () => {
        expect(await themeClass(page), "the grid is not on the generated theme")
          .toEqual("ht-theme-custom-theme");
      }).toPass({ timeout: 60_000 });

      // 2. The panel found where this framework builds its grid. Falling back
      //    to "add the import by hand" is a legitimate outcome in general, but
      //    not for the five shapes this suite covers.
      await expect(drawer.getByText("shape the panel does not recognise")).toHaveCount(0);

      // 3. `theme` and `themeName` are aliases: Handsontable warns and drops one
      //    when both are set. The theme still applies, so this is invisible
      //    without reading the console — and it fires per wiring shape.
      expect(
        console_.filter((line) => /Both theme and themeName are defined/i.test(line)),
        "wiring must replace the themeName it displaces, not sit beside it",
      ).toEqual([]);

      // 4. Reset returns the grid to the theme it arrived on — including the
      //    `ht-theme-*` class on the container that apply had to take off.
      await drawer.getByRole("button", { name: "Reset", exact: true }).click();
      await expect(async () => {
        expect(await themeClass(page), "Reset left the demo on someone else's theme").toEqual(before);
      }).toPass({ timeout: 60_000 });
    });

    test("a density size override reaches the grid", async ({ page }) => {
      // The item this suite exists to settle. `density.sizes` is keyed by
      // density variant — `{ comfortable: { cellVertical: … } }` — and emitting
      // it a level higher was silently ignored by Handsontable rather than
      // rejected, so reading the generated module could never tell the two
      // readings apart. Row height can.
      await openExample(page, example);
      const before = await cellHeight(page);
      await openStylePanel(page);

      const drawer = page.locator(STYLE);
      await drawer.getByRole("button", { name: /Density sizes/ }).click();

      // The variant editor opens on the variant the grid is set to, so this
      // override lands where the preview will show it.
      const row = drawer.locator("label").filter({ has: page.locator('span[title="cellVertical"]') });
      await row.locator('input[type="text"]').fill("28px");

      await expectThemeModuleWritten(page);
      await expect(async () => {
        expect(await cellHeight(page), "cell padding did not change the row height")
          .toBeGreaterThan(before);
      }).toPass({ timeout: 60_000 });
    });
  });
}

test("switching examples does not carry one demo's theme into the next", async ({ page }) => {
  test.skip(process.env.E2E_LIVE !== "1", "set E2E_LIVE=1 to run live-render checks");
  test.setTimeout(300_000);

  // The third thing the ticket asks about, alongside "applies" and "restores":
  // the panel's state outlives a switch, and the demo it was written into does
  // not follow. Whatever the reconciliation is, the next example must not open
  // showing a theme it has not been given.
  await openExample(page, "react");
  await openStylePanel(page);
  await page.locator(STYLE).getByLabel("Colour scheme").selectOption("dark");
  await expectThemeModuleWritten(page);

  await openExample(page, "javascript");
  await openStylePanel(page);

  // This pins *consistency*, not policy: either the theme followed — in which
  // case the module is in this demo's tree too — or it did not, and the panel is
  // back to pristine. Both are defensible; what must not happen is the panel
  // claiming one and the files holding the other. If a policy is ever decided,
  // this test should assert that instead.
  //
  // Polled, not sampled: the second demo's file tree renders as its session
  // comes up, and reading the count once right after the switch measures the
  // race rather than the behaviour.
  const reset = page.locator(STYLE).getByRole("button", { name: "Reset", exact: true });
  const module_ = page.locator(".hot-file-row", { hasText: "handsontable-theme" });

  await expect(async () => {
    const enabled = await reset.isEnabled();
    const count = await module_.count();
    expect(
      count > 0,
      enabled
        ? "the panel offers Reset, so the theme module must be in this demo"
        : "the panel is pristine, so no theme module should have been written",
    ).toEqual(enabled);
  }).toPass({ timeout: 60_000 });
});
