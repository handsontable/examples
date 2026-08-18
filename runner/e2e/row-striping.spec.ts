import { test, expect, type FrameLocator, type Page } from "@playwright/test";

// Does the starters' own row striping survive a dark colour scheme? (DEV-2197)
//
// Five starters mark every other row with `odd` from their own `beforeRenderer`
// and stripe it from their own stylesheet. That rule used to pin
// `background: #fafbff`, which outranks the theme's `:where()`-wrapped tokens —
// so a demo switched to dark kept near-white rows carrying the theme's *light*
// foreground: grey text on white, alternating with correctly dark rows. Nothing
// caught it. `style-apply.spec.ts` reads the `ht-theme-*` class and row height
// and deliberately refuses to look at colour; every other suite reads generated
// text. A stylesheet literal is invisible to all of them.
//
// So this is the one place colour is read — and only ever as a *relationship*
// between two rows. The rule now mixes its tint out of `--ht-foreground-color`
// and `--ht-background-color`, so the value is whatever the active theme makes
// it. Any fixed expectation would be wrong by construction: these demos are
// themeable, and the tint is supposed to move.
//
// Live — needs the Sandpack bundler; opt-in via E2E_LIVE=1 like the other
// render checks.
//
//   E2E_LIVE=1 pnpm e2e e2e/row-striping.spec.ts
//   E2E_LIVE=1 E2E_BASE_URL=https://demos.handsontable.com pnpm e2e e2e/row-striping.spec.ts
//
// Only the Sandpack starters are covered, which is why no `--workers=1` is
// needed here: a plain `vite preview` serves them. `react-js`, `base-web` and
// `angular` carry the same rule but are `engine: "container"`, so including them
// would force the 5-slot `Sandbox` pool and a same-origin API worker onto every
// run. Check those by hand against a `vite dev` with `VITE_API_BASE` pointed at
// its own port. `angular` is a full case in `style-apply.spec.ts` (DEV-2216): what
// once read as "no edit reaches its preview" was a silent type-check failure in the
// generated theme module, so edits there are observable now.

/** Every starter that stripes its own rows and boots in Sandpack. */
const EXAMPLES = ["react", "javascript", "typescript", "vue"] as const;

type Row = { bg: [number, number, number]; color: [number, number, number] };
type Reading = { odd: Row; even: Row };

const preview = (page: Page): FrameLocator => page.frameLocator("iframe").first();
const cell = (page: Page) => preview(page).locator(".handsontable td").first();

/**
 * Both rows' background and text colour, as sRGB 0-255 triples.
 *
 * Read through `color()` as well as `rgb()`: a `color-mix()` result computes to
 * `color(srgb 0.965 …)`, so a naive `rgb(…)` parse silently yields nothing and
 * every comparison below would trivially pass.
 */
async function readRows(page: Page): Promise<Reading> {
  return preview(page)
    .locator(".handsontable")
    .first()
    .evaluate(() => {
      const parse = (value: string): [number, number, number] => {
        // `color(srgb …)` carries 0-1 components; `rgb(…)` carries 0-255.
        const scale = value.startsWith("color(") ? 255 : 1;
        const nums = (value.match(/-?[\d.]+/g) ?? []).slice(0, 3).map((n) => Number(n) * scale);
        if (nums.length < 3 || nums.some((n) => Number.isNaN(n))) {
          // A transparent or unparsed background is the failure this suite is
          // looking for, so refuse to guess a value for it.
          throw new Error(`cannot read a colour out of ${JSON.stringify(value)}`);
        }
        return [nums[0]!, nums[1]!, nums[2]!];
      };
      const read = (selector: string) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`no cell matched ${selector}`);
        const styles = getComputedStyle(el);
        return { bg: parse(styles.backgroundColor), color: parse(styles.color) };
      };
      return {
        odd: read("table.htCore tr.odd td"),
        even: read("table.htCore tr.ht__row_even:not(.odd) td"),
      };
    });
}

/** The theme class Handsontable resolved, as `style-apply.spec.ts` reads it. */
async function themeClass(page: Page): Promise<string> {
  return preview(page)
    .locator(".handsontable")
    .first()
    .evaluate((el) => {
      const wrapper = el.closest("[class*='ht-theme-']");
      return [...(wrapper?.classList ?? [])].find((c) => c.startsWith("ht-theme-")) ?? "";
    });
}

/**
 * The scheme the grid is actually resolving colours against.
 *
 * Handsontable's `ThemeManager` writes `color-scheme` into its injected
 * `<style>`, and that declaration is what makes every `light-dark()` token pick
 * a side. It is the only per-apply signal available on the *second* apply: by
 * then the theme module is already in the file tree and the wrapper already
 * carries `ht-theme-custom-theme`, so both of the usual apply signals are
 * satisfied before the new scheme has reached the grid — and a read taken there
 * silently returns the previous scheme's colours.
 */
async function resolvedScheme(page: Page): Promise<string> {
  return preview(page)
    .locator(".handsontable")
    .first()
    .evaluate((el) => {
      const wrapper = el.closest("[class*='ht-theme-']");
      return wrapper ? getComputedStyle(wrapper).colorScheme : "";
    });
}

/** Relative luminance, WCAG's definition — the basis of both checks below. */
function luminance([r, g, b]: [number, number, number]): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * The three-part condition. Two of them are not enough, and the missing one is
 * the interesting one:
 *
 * An invalid `var()` makes `background` fall back to `transparent`, at which
 * point the odd row renders *identically* to the even row. "Close to the even
 * row" and "text is legible" both hold — and the striping the demo exists to
 * show is gone. So the tint has to be near, legible, **and** present.
 */
function expectLegibleStripe(reading: Reading, scheme: string) {
  const { odd, even } = reading;

  // 1. A tint, not an inversion. Anything beyond a hair's contrast between the
  //    two row backgrounds means one of them is ignoring the theme — which is
  //    exactly the reported bug: near-white rows against a near-black grid read
  //    about 19:1 here.
  expect(contrast(odd.bg, even.bg), `[${scheme}] odd row is not a tint of the even row`)
    .toBeLessThan(1.5);

  // 2. Present. Never assert the value — only that the two differ.
  const delta = Math.max(...odd.bg.map((c, i) => Math.abs(c - (even.bg[i] ?? 0))));
  expect(delta, `[${scheme}] odd and even rows are the same colour — the striping is gone`)
    .toBeGreaterThan(1);

  // 3. Legible. The theme sets one foreground for the whole grid, so it is the
  //    odd row's *background* that decides whether that text can be read.
  expect(contrast(odd.color, odd.bg), `[${scheme}] odd row text is unreadable on its background`)
    .toBeGreaterThan(4.5);
}

/**
 * Proof that the scheme actually flipped before anything is read from it.
 *
 * Without this the whole suite passes vacuously: every assertion above is a
 * *relationship* between two rows, and that relationship holds perfectly well in
 * light mode. A dark switch that silently did nothing would look identical to a
 * dark switch that worked. The even row is the honest witness — no starter rule
 * touches it, so its background is the theme's own answer.
 */
function expectSchemeFlipped(light: Reading, dark: Reading) {
  expect(
    contrast(light.even.bg, dark.even.bg),
    "the colour scheme never changed — this run proves nothing about dark mode",
  ).toBeGreaterThan(4);
  expect(luminance(dark.even.bg), "the 'dark' reading is not dark").toBeLessThan(
    luminance(light.even.bg),
  );
}

for (const example of EXAMPLES) {
  test.describe(`${example} — row striping follows the theme`, () => {
    test.skip(process.env.E2E_LIVE !== "1", "set E2E_LIVE=1 to run live-render checks");
    test.describe.configure({ timeout: 300_000 });

    test("stripes stay legible in light and in dark", async ({ page }) => {
      await page.goto(`/?example=${example}`);
      await expect(page.locator('[aria-label="Preview"]')).toHaveAttribute(
        "data-preview-status",
        "ready",
        { timeout: 180_000 },
      );
      await expect(cell(page)).toBeVisible({ timeout: 120_000 });

      // 1 & 2. The theme the demo ships with, in both of its schemes. This is
      //    what a visitor sees before touching anything, and what someone
      //    copying the starter into their own app gets. The shipped
      //    `ht-theme-main.min.css` delivers its light/dark pairs as a
      //    lightningcss `var()` switch keyed off the class name, so swapping the
      //    class is what flips it — there is no media query to emulate.
      let shippedLight: Reading | undefined;
      await expect(async () => {
        shippedLight = await readRows(page);
        expectLegibleStripe(shippedLight, "default theme, light");
      }).toPass({ timeout: 60_000 });

      await preview(page)
        .locator(".handsontable")
        .first()
        .evaluate(() => {
          document.querySelectorAll(".ht-theme-main").forEach((el) => {
            el.classList.replace("ht-theme-main", "ht-theme-main-dark");
          });
        });
      expect(await themeClass(page), "the dark theme class did not land").toEqual(
        "ht-theme-main-dark",
      );
      await expect(async () => {
        const shippedDark = await readRows(page);
        expectSchemeFlipped(shippedLight!, shippedDark);
        expectLegibleStripe(shippedDark, "default theme, dark");
      }).toPass({ timeout: 60_000 });

      // 3 & 4. A theme from the Style panel. Structurally different, and the
      //    reason both halves are worth running: the panel's theme is injected
      //    by Handsontable at runtime with real `light-dark()` values, which the
      //    tint then has to nest inside `color-mix()`. The static stylesheet
      //    above never exercises that parse.
      await page.reload();
      await expect(page.locator('[aria-label="Preview"]')).toHaveAttribute(
        "data-preview-status",
        "ready",
        { timeout: 180_000 },
      );
      await expect(cell(page)).toBeVisible({ timeout: 120_000 });

      const drawer = page.locator('aside[aria-label="Style this demo"]');
      await page.getByRole("button", { name: "Style", exact: true }).click();
      await expect(drawer).toBeVisible();

      const panel: Partial<Record<"dark" | "light", Reading>> = {};
      for (const scheme of ["dark", "light"] as const) {
        await drawer.getByLabel("Colour scheme").selectOption(scheme);
        // The written module is the apply signal — not a timeout.
        await expect(page.locator(".hot-file-row", { hasText: "handsontable-theme" })).toBeVisible({
          timeout: 120_000,
        });
        await expect(page.locator('[aria-label="Preview"]')).toHaveAttribute(
          "data-preview-status",
          "ready",
          { timeout: 180_000 },
        );
        await expect(cell(page)).toBeVisible({ timeout: 120_000 });

        // Until the grid is on the generated theme, its tokens are not the ones
        // being read and the `light-dark()` nesting has not been exercised at
        // all. Same reason `style-apply.spec.ts` keys on this class.
        await expect(async () => {
          expect(await themeClass(page), "the grid is not on the generated theme").toEqual(
            "ht-theme-custom-theme",
          );
        }).toPass({ timeout: 60_000 });

        await expect(async () => {
          expect(await resolvedScheme(page), `the grid has not switched to ${scheme} yet`).toEqual(
            scheme,
          );
        }).toPass({ timeout: 60_000 });

        await expect(async () => {
          panel[scheme] = await readRows(page);
          expectLegibleStripe(panel[scheme]!, `panel theme, ${scheme}`);
        }).toPass({ timeout: 60_000 });
      }
      expectSchemeFlipped(panel.light!, panel.dark!);
    });
  });
}
