import { test, expect, type FrameLocator, type Page } from "@playwright/test";

// Does the shell's colour scheme reach the grid, and does a starter's own
// declaration survive being copied out of the playground? (DEV-2561, ADR-0035)
//
// Two claims, and they need different setups because one of them masks the other.
//
// The shell drives a stock demo, so in the playground the grid reads whatever the
// toggle says — whether or not the starter declared a scheme of its own. That is
// why `row-striping.spec.ts` cannot assert the pin and says so: with the override
// in place, a pinned starter and an `auto` one are indistinguishable.
//
// What the pin actually buys shows up only once the shell stands down, which is
// what a demo that has been downloaded, forked or exported *is*. So the second test
// stands it down deliberately, from inside the preview, and reads what the demo
// declares on its own. Measured while writing it, with the OS emulated dark:
//
//   bucket next (pinned)     stand down -> color-scheme: light,      light cells
//   bucket 18   (unpinned)   stand down -> color-scheme: light dark, dark cells
//
// which is the regression this exists to catch: a starter that loses its
// `colorScheme` renders the reader's preference instead of the theme it names, and
// nothing inside the playground looks any different.
//
// Live — needs the Sandpack bundler; opt-in via E2E_LIVE=1 like the other render
// checks.
//
//   E2E_LIVE=1 pnpm e2e e2e/preview-scheme.spec.ts
//   E2E_LIVE=1 E2E_BASE_URL=https://demos.handsontable.com pnpm e2e e2e/preview-scheme.spec.ts
//
// Tier 2 is not covered here. Its half of the bridge is the proxy rewrite, checked
// as a response transform in `pipeline/scheme-bridge.test.mjs`; exercising it in a
// browser would pull the 5-slot container pool and a same-origin API worker into
// every run, for the same reason `row-striping.spec.ts` stays on Sandpack.

const preview = (page: Page): FrameLocator => page.frameLocator("iframe").first();
const grid = (page: Page) => preview(page).locator(".handsontable").first();

/** What the grid resolves colours against, read off the theme wrapper — the same
 *  signal `row-striping.spec.ts` and `style-apply.spec.ts` read. */
async function resolvedScheme(page: Page): Promise<string> {
  return grid(page).evaluate((el) => {
    const wrapper = el.closest("[class*='ht-theme-']");
    return wrapper ? getComputedStyle(wrapper).colorScheme : "";
  });
}

/** A cell's background, as a string. Never compared to a literal — only light
 *  against dark, so a theme change cannot break this suite. */
async function cellBackground(page: Page): Promise<string> {
  return grid(page).evaluate(() => {
    const cell = document.querySelector("table.htCore td");
    if (!cell) throw new Error("no cell to read");
    return getComputedStyle(cell).backgroundColor;
  });
}

/** Roughly, is this colour dark? The two schemes differ by an order of magnitude
 *  here — near-white against `rgb(5, 5, 6)` — so a crude mean is enough and stays
 *  true across palette changes. */
function isDark(colour: string): boolean {
  const nums = (colour.match(/-?[\d.]+/g) ?? []).slice(0, 3).map(Number);
  if (nums.length < 3) throw new Error(`cannot read a colour out of ${JSON.stringify(colour)}`);
  const scale = colour.startsWith("color(") ? 255 : 1;
  return (nums[0]! + nums[1]! + nums[2]!) * scale / 3 < 128;
}

/** True when the runner's own override is present in the preview document. */
async function hasOverride(page: Page): Promise<boolean> {
  return grid(page).evaluate(() => !!document.getElementById("hot-runner-scheme"));
}

async function waitForGrid(page: Page) {
  await expect(page.locator('[aria-label="Preview"]')).toHaveAttribute(
    "data-preview-status",
    "ready",
    { timeout: 180_000 },
  );
  await expect(grid(page)).toBeVisible({ timeout: 120_000 });
}

/** Put the shell in `mode` and prove it landed. The button is labelled with its
 *  destination, so its name is also the current state. */
async function setShellTheme(page: Page, mode: "light" | "dark") {
  const current = await page.locator("html").getAttribute("data-hot-theme");
  if (current !== mode) {
    await page.getByRole("button", { name: `Switch to ${mode} theme` }).click();
  }
  await expect(page.locator("html")).toHaveAttribute("data-hot-theme", mode);
}

test.describe("the preview's colour scheme", () => {
  test.skip(process.env.E2E_LIVE !== "1", "set E2E_LIVE=1 to run live-render checks");
  test.describe.configure({ timeout: 300_000 });

  test("a stock demo follows the shell's toggle", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("hot-theme", "light"));
    await page.goto("/?example=react");
    await waitForGrid(page);

    await expect(async () => {
      expect(await resolvedScheme(page), "the shell's light never reached the grid").toEqual(
        "light",
      );
    }).toPass({ timeout: 60_000 });
    expect(isDark(await cellBackground(page)), "a light grid is not dark").toBe(false);

    await setShellTheme(page, "dark");
    await expect(async () => {
      expect(await resolvedScheme(page), "the shell's dark never reached the grid").toEqual("dark");
      expect(isDark(await cellBackground(page)), "a dark grid is dark").toBe(true);
    }).toPass({ timeout: 60_000 });

    // Back again, because a toggle that only works one way is a different bug and
    // the override has to be replaced in place rather than accumulating.
    await setShellTheme(page, "light");
    await expect(async () => {
      expect(await resolvedScheme(page), "the grid did not come back to light").toEqual("light");
      expect(isDark(await cellBackground(page)), "a light grid is not dark").toBe(false);
    }).toPass({ timeout: 60_000 });
  });

  test("a starter's own scheme is what survives the shell standing down", async ({
    page,
    request,
    baseURL,
  }) => {
    // The `next` bucket, because that is the one master's `examples/` feeds
    // (ADR-0029): 17 and 18 come from their frozen branches and are not pinned
    // until this is backported there. Its Handsontable version is read from the
    // manifest rather than written down — it is a nightly, and it moves weekly.
    const manifest = await request.get(`${baseURL}/starter-examples/next/manifest.json`);
    expect(manifest.ok(), "the next bucket has to be served for this to mean anything").toBe(true);
    const { hotVersion } = (await manifest.json()) as { hotVersion: string };

    await page.route("**/api/versions", (route) =>
      route.fulfill({ json: { latest: "18.0.0", next: hotVersion, versions: ["18.0.0"] } }),
    );
    await page.addInitScript(() => localStorage.setItem("hot-theme", "light"));
    // A dark machine, a light shell: the combination that tells the demo's own
    // declaration apart from the shell's opinion of it.
    await page.emulateMedia({ colorScheme: "dark" });

    await page.goto(`/?example=react&v=${encodeURIComponent(hotVersion)}`);
    await waitForGrid(page);

    await expect(async () => {
      expect(await hasOverride(page), "the shell should be driving this demo").toBe(true);
      expect(await resolvedScheme(page)).toEqual("light");
    }).toPass({ timeout: 60_000 });

    // Stand the shell down from inside the preview — the same message it sends for
    // a demo that owns its scheme, and the state a copied demo is permanently in.
    await grid(page).evaluate(() => {
      window.postMessage({ source: "hot-runner-scheme", mode: "auto" }, "*");
    });

    await expect(async () => {
      expect(await hasOverride(page), "`auto` must remove the override, not rewrite it").toBe(
        false,
      );
      // `light`, not `light dark`: the starter declares a scheme, so the dark
      // machine underneath it does not get a say. An unpinned starter reads
      // `light dark` here and renders dark cells.
      expect(
        await resolvedScheme(page),
        "the starter no longer declares a scheme — a copy of it will follow its reader's OS",
      ).toEqual("light");
      expect(isDark(await cellBackground(page)), "the grid went dark on a dark machine").toBe(
        false,
      );
    }).toPass({ timeout: 60_000 });
  });
});
