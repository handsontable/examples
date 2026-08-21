import { test, expect, type APIRequestContext, type FrameLocator, type Page } from "@playwright/test";
import { workspaceFiles } from "./helpers";

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
// Tier-2 cases and the container pool holds 5 slots (`Sandbox max_instances`).
// At `--workers=2` the second Tier-2 case fails with the preview stuck on
// `booting` — which reads as a product failure and is not one.
//
// Sessions ARE torn down now (DEV-2547): every session this file creates is
// deleted in `afterEach`, so a failed run no longer leaves containers squatting
// slots shared with real traffic until their idle window expires. Consecutive
// runs used to exhaust the pool on their own.
//
// The Tier-1 cases (react, vue, javascript) need no container and no API worker;
// a plain `vite preview` serves them. Tier 2 needs the API worker reachable on
// the *same origin* — `vite dev` with `VITE_API_BASE` pointed at its own port.

const STYLE = 'aside[aria-label="Style this demo"]';

/**
 * Tier-2 sessions this file created, so they can be deleted even when a test
 * fails (DEV-2547).
 *
 * The container pool is five global slots shared with production traffic, and a
 * leaked session holds one for its whole idle window — which is how a red run
 * poisoned the next one. Tier-1 tests create no session, so the hooks are a
 * no-op there.
 *
 * Local to this spec on purpose: `trackSessions` lands in `e2e/helpers.ts` with
 * the DEV-2203 suites, and duplicating it there for one release is cheaper than
 * conflicting with that file.
 */
const created = new WeakMap<Page, { id: string; apiBase: string }[]>();

test.beforeEach(({ page }) => {
  const sessions: { id: string; apiBase: string }[] = [];
  created.set(page, sessions);
  page.on("response", async (res) => {
    if (res.request().method() !== "POST" || !/\/api\/session$/.test(res.url()) || !res.ok()) return;
    const body = (await res.json().catch(() => null)) as { sessionId?: string } | null;
    if (body?.sessionId) sessions.push({ id: body.sessionId, apiBase: new URL(res.url()).origin });
  });
});

test.afterEach(async ({ page, request }: { page: Page; request: APIRequestContext }) => {
  for (const { id, apiBase } of created.get(page) ?? []) {
    // Best effort: the session may already be gone (the shell's own pagehide
    // teardown races this one), and a failed DELETE must not fail the test that
    // has already reported its real result.
    await request.delete(`${apiBase}/api/session/${id}`).catch(() => {});
  }
});

/** The four shapes `wireTheme` recognises, one example each. `astro` and
 *  `angular` are Tier 2: they boot a real container and are correspondingly
 *  slower, which is why the timeouts below are generous. */
const SHAPES = [
  { example: "react", shape: "<HotTable …>" },
  { example: "vue", shape: "<HotTable …> in an SFC" },
  { example: "javascript", shape: "new Handsontable(el, {…})" },
  { example: "astro", shape: "new Handsontable(el, {…}) in a client script" },
  // Angular is the case worth having: its dev server is the only one that
  // type-checks, so it is the only starter where a type error in the generated
  // module is fatal — and fatal *silently*, since a failed build just keeps
  // serving the last good bundle (DEV-2216). It read as "no edit ever reaches
  // the Angular preview" because the broken module stays on disk and swallows
  // every later edit too. `pipeline/theme-typecheck.test.mjs` now compiles the
  // generated module against Handsontable's types; this case is what proves the
  // compiled result also renders.
  { example: "angular", shape: "gridSettings = {…}" },
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

/**
 * The Worker's own preview documents, served in place of the demo when the
 * container's dev-server port refuses (`workers/api/src/preview-boot.ts`).
 *
 * They matter to this suite because they are indistinguishable from a slow demo
 * if all you wait for is a cell: DEV-2547 was reported as "reaches ready, then
 * `.handsontable td` never appears (120s)" for astro and angular, and the report
 * could not say which page the frame was holding — a boot page, a dead-server
 * page, or a demo that genuinely failed to render. Naming them turns that 120s
 * silence into one line.
 */
const RUNNER_PREVIEW_PAGE = /Reconnecting to the demo|The demo stopped responding/;

async function openExample(page: Page, example: string) {
  return openAt(page, `/?example=${example}`, example);
}

/** The waits `openExample` is made of, over any URL — a payload route needs the
 *  same "did the preview really come up, and is the frame holding the demo"
 *  reading, and it is the reading that costs 40 lines. */
async function openAt(page: Page, url: string, label: string) {
  await page.goto(url);
  const pane = page.locator('[aria-label="Preview"]');
  // Not `toHaveAttribute("ready")`: a preview that fails outright sits on `error`
  // for the full 180s and reports as a timeout. Poll off `booting` first, then say
  // which of the two terminal states it reached and why.
  await expect
    .poll(() => pane.getAttribute("data-preview-status"), { timeout: 180_000, intervals: [1_000] })
    .not.toEqual("booting");
  if ((await pane.getAttribute("data-preview-status")) === "error") {
    const detail = await pane.locator("pre").first().innerText().catch(() => "(no detail)");
    throw new Error(`the ${label} preview failed to start: ${detail}`);
  }
  await expect(pane).toHaveAttribute("data-preview-status", "ready");

  // Ready means the demo rendered — but if the frame is holding one of the
  // runner's own pages instead, fail on that fact rather than on a missing cell.
  const apology = preview(page).getByText(RUNNER_PREVIEW_PAGE).first();
  const outcome = await Promise.race([
    cell(page).waitFor({ state: "visible", timeout: 120_000 }).then(() => "grid" as const),
    apology
      .waitFor({ state: "visible", timeout: 120_000 })
      .then(() => "runner-page" as const)
      // Never settles: both waits share a deadline, so a resolved timeout here would
      // race the cell wait's rejection and could win it — returning "the grid is
      // there" for the very case (no cell, no apology either) this exists to report.
      // Only the cell branch may end the race.
      .catch(() => new Promise<never>(() => {})),
  ]);
  if (outcome === "runner-page") {
    throw new Error(
      `the ${label} preview frame is holding the runner's own page, not the demo: ${await apology.innerText()}`,
    );
  }
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

/**
 * Set one density measurement through the size control (DEV-2560).
 *
 * The row used to be a free-text `<input>` inside a `<label>`; it is the shared
 * size control now, which is a `<div>` with a disclosure — hence `data-token`
 * rather than a label filter. The sizing list is what this clicks, not the
 * `custom` text box: the list commits on click, while the text box commits on
 * blur, which `fill()` does not trigger.
 *
 * `size_10` is 40px, the top of the scale; `density.default.cellVertical` is
 * `sizing.size_1`, 4px. So a row-height assertion cannot pass or fail for want
 * of a big enough step.
 */
async function setDensitySize(page: Page, key: string, step: string) {
  const row = page.locator(STYLE).locator(`[data-token="${key}"]`);
  await row.getByRole("button", { expanded: false }).first().click();
  await row.getByRole("button", { name: new RegExp(`^${step}\\b`) }).click();
}

for (const { example, shape } of SHAPES) {
  test.describe(`${example} — ${shape}`, () => {
    test.skip(process.env.E2E_LIVE !== "1", "set E2E_LIVE=1 to run live-render checks");
    test.describe.configure({ timeout: 300_000 });

    // @smoke on react only: the post-deploy subset (DEV-2203) wants one Style
    // apply+reset round-trip, and react is the Tier-1 shape that needs no container.
    test("a theme applies to the grid, and Reset takes it back off", { tag: example === "react" ? ["@smoke"] : [] }, async ({ page }) => {
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
      // Scoped to the footer: the panel body carries per-row resets now, and an
      // unscoped exact-name match would be ambiguous with a group expanded.
      await drawer.locator("footer").getByRole("button", { name: "Reset", exact: true }).click();
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
      await setDensitySize(page, "cellVertical", "size_10");

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
  const reset = page.locator(STYLE).locator("footer").getByRole("button", { name: "Reset", exact: true });
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

/**
 * A theme edit must not rebuild the demo (DEV-2496).
 *
 * Reported as "picking any new value in the colour picker refreshes the whole table —
 * blink blink". Every theme edit went out as an ordinary file write, which on Tier 1 is
 * a full bundler compile (per drag frame) and on Tier 2 a dev-server reload. Both
 * re-run the demo from the top, so the grid was thrown away and built again.
 *
 * What this watches is the grid's own root element, stamped before the edit. A rebuild
 * cannot preserve it — the element is created by the demo's own code — so the stamp
 * surviving *is* "the table did not blink", on either tier and without depending on
 * bundler internals. That the edit also took effect is read from the row height, so a
 * live patch that quietly did nothing cannot pass either.
 *
 * One example per tier: react drives the in-browser bundler, astro a real container.
 */
for (const example of ["react", "astro"] as const) {
  test(`${example} — a theme edit patches the running grid instead of rebuilding it`, async ({ page }) => {
    test.skip(process.env.E2E_LIVE !== "1", "set E2E_LIVE=1 to run live-render checks");
    test.setTimeout(300_000);

    await openExample(page, example);
    await openStylePanel(page);
    const drawer = page.locator(STYLE);

    // The first apply is the one edit that *has* to rebuild: it wires the theme into
    // the demo, and the module it writes is what carries the live-patch bridge. So
    // wait for the grid to come back on the generated theme before measuring anything
    // — until then there is nothing in the preview to patch.
    await drawer.getByLabel("Colour scheme").selectOption("dark");
    await expectThemeModuleWritten(page);
    await expect(async () => {
      expect(await themeClass(page), "the grid is not on the generated theme yet")
        .toEqual("ht-theme-custom-theme");
    }).toPass({ timeout: 60_000 });

    const before = await cellHeight(page);
    await preview(page).locator(".handsontable").first()
      .evaluate((el) => el.setAttribute("data-live-probe", "1"));

    // A density size, for the same reason the suite already uses one: row height is a
    // signal no starter stylesheet can outrank.
    await drawer.getByRole("button", { name: /Density sizes/ }).click();
    await setDensitySize(page, "cellVertical", "size_10");

    await expect(async () => {
      expect(await cellHeight(page), "the edit never reached the grid").toBeGreaterThan(before);
    }).toPass({ timeout: 60_000 });

    // The assertion this test exists for. Before the fix the stamp is gone here: the
    // demo was re-evaluated and built a new grid.
    await expect(preview(page).locator(".handsontable").first())
      .toHaveAttribute("data-live-probe", "1");

    // And it stays gone-free while the edit settles — a rebuild scheduled a beat later
    // would be just as visible to the user as an immediate one.
    await page.waitForTimeout(2000);
    await expect(preview(page).locator(".handsontable").first())
      .toHaveAttribute("data-live-probe", "1");
  });
}

// ---- AI styling: what the panel claims it did (DEV-2497) ---------------------
//
// Reported as "the AI tab didn't produce a new palette for 'corporate green'".
// It had produced one. `POST /api/theme` answered 200 with a complete, correct
// green ramp and `tokens: {}`, the panel applied all six steps, and the grid
// rendered pixel-identical — because the brand ramp reaches only interaction
// states (selection, focus rings, the active header, checkbox and radio), none
// of which is on screen until you touch the grid. The panel then forwarded the
// model's own message, "Applied a corporate green palette", as confirmation.
//
// The AI tab had no coverage at all, which is how that shipped. These cases are
// deterministic — `/api/theme` is stubbed with the payloads actually observed in
// production, so no gateway, no spend, and no `E2E_LIVE` — because what is under
// test is what the panel *says* about an answer, not what a model returns.

/** The reproduced payload, verbatim off prod. */
const GREEN_RAMP = {
  "primary.100": "#e6f4ea",
  "primary.200": "#b9dfc4",
  "primary.300": "#7dbf90",
  "primary.400": "#3d9e58",
  "primary.500": "#1a7a38",
  "primary.600": "#0d5225",
} as const;

/** The panel, with `/api/theme` answering `answer` and no bundler running. */
async function openWithThemeApi(page: Page, answer: unknown) {
  await page.route("**/api/versions", (route) =>
    route.fulfill({ json: { latest: "18.0.0", next: "19.0.0-next.1", versions: ["18.0.0", "17.1.0"] } }),
  );
  // The panel is chrome here; aborting the bundler is what keeps these fast and
  // deterministic, the way e2e/panels.spec.ts does it.
  await page.route("https://sandpack.codesandbox.io/**", (route) => route.abort());
  await page.route("https://sandpack-bundler.codesandbox.io/**", (route) => route.abort());
  await page.route("**/api/theme", (route) => route.fulfill({ json: answer }));

  await page.goto("/?example=react");
  await expect(page.getByRole("button", { name: "Style", exact: true })).toBeVisible();
  await openStylePanel(page);

  const drawer = page.locator(STYLE);
  await drawer.getByRole("tab", { name: "AI" }).click();
  return drawer;
}

async function describeStyle(drawer: ReturnType<Page["locator"]>, prompt: string) {
  await drawer.getByLabel("Describe the style you want").fill(prompt);
  // "Send", not "Style": the composer's send button was renamed off the top-bar
  // trigger's name, which it collided with while this tab was open.
  await drawer.getByRole("button", { name: "Send", exact: true }).click();
}

test.describe("AI styling", () => {
  test("a brand ramp alone says where the colour actually shows", async ({ page }) => {
    const drawer = await openWithThemeApi(page, {
      message: "Applied a corporate green palette.",
      tokens: {},
      palette: GREEN_RAMP,
      config: {},
    });

    await describeStyle(drawer, "corporate green");

    // The claim still gets through — it is true, the ramp did apply.
    await expect(drawer.getByText("Applied a corporate green palette.")).toBeVisible();
    // …followed by the part that stops it reading as a broken feature.
    await expect(drawer.getByText(/shows on selection, focus and active headers/)).toBeVisible();

    // And the ramp really did land: the Foundation tab's swatch for the step the
    // model set holds the colour it set.
    await drawer.getByRole("tab", { name: "Foundation" }).click();
    await drawer.getByRole("button", { name: /Palette/ }).click();
    await expect(drawer.getByLabel("primary.500")).toHaveValue("#1a7a38");
  });

  test("an answer that changes nothing is not reported as success", async ({ page }) => {
    // The forced tool call lets the model refuse with `message` alone, and the
    // panel used to render that refusal in the same place, and the same voice, as
    // a successful restyle.
    const drawer = await openWithThemeApi(page, { message: "I only restyle grids." });

    await describeStyle(drawer, "write me a poem");

    await expect(drawer.getByText(/didn’t change the theme/)).toBeVisible();
    // The prompt is kept, because editing it is the next thing that happens.
    await expect(drawer.getByLabel("Describe the style you want")).toHaveValue("write me a poem");
    // Nothing was applied, so nothing claims to have been.
    await expect(drawer.getByText("Applied to the preview")).toHaveCount(0);
  });

  test("an answer that tints a resting surface is reported plainly", async ({ page }) => {
    const drawer = await openWithThemeApi(page, {
      message: "Applied a corporate green palette.",
      // What the fixed endpoint returns for the same prompt: the ramp, plus the
      // header pair tinted from its lightest step.
      tokens: { headerBackgroundColor: "#e6f4ea", headerRowBackgroundColor: "#e6f4ea" },
      palette: GREEN_RAMP,
      config: {},
    });

    await describeStyle(drawer, "corporate green");

    await expect(drawer.getByText("Applied a corporate green palette.")).toBeVisible();
    await expect(drawer.getByText(/shows on selection, focus and active headers/)).toHaveCount(0);
    await expect(drawer.getByLabel("Describe the style you want")).toHaveValue("");
  });
});

test("a recolour reaches the header the grid is painting right now", async ({ page }) => {
  test.skip(process.env.E2E_LIVE !== "1", "set E2E_LIVE=1 to run live-render checks");
  test.setTimeout(300_000);

  // The pixel proof, and the one assertion that would have caught the original
  // report: with the endpoint's floor in place, a brand recolour changes a colour
  // an untouched grid is already showing. Column-header background, not a cell —
  // starter stylesheets override `td`, never `th` (see `themeClass` above).
  // The endpoint's own shape: a `[light, dark]` pair of ramp references, not a
  // literal. So this also proves a real grid resolves the pair — the panel stores
  // pairs for manual colour picks, but nothing had checked one arriving from
  // /api/theme and surviving codegen into the running demo.
  const tint = ["colors.primary.100", "colors.primary.600"];
  await page.route("**/api/theme", (route) => route.fulfill({
    json: {
      message: "Applied a corporate green palette.",
      tokens: { headerBackgroundColor: tint, headerRowBackgroundColor: tint },
      palette: GREEN_RAMP,
      config: {},
    },
  }));

  await openExample(page, "react");
  // `th:visible`, and a named column at that. Handsontable paints its column
  // headers in the `ht_clone_top` overlay and leaves the master `thead` at
  // `visibility: hidden` — which still has a bounding box and still answers
  // `getComputedStyle`, so `locator("th").first()` reads a real colour off a cell
  // nobody can see. An assertion on that measures the wrong element and passes.
  const header = preview(page).locator("th:visible").filter({ hasText: "Company" }).first();
  await expect(header).toBeVisible({ timeout: 120_000 });
  const before = await header.evaluate((el) => getComputedStyle(el).backgroundColor);
  // The preset's header is neutral (`palette.50`), which is the whole defect: the
  // brand ramp this prompt sets does not appear in it.
  expect(before).toEqual("rgb(247, 247, 249)");

  await openStylePanel(page);
  const drawer = page.locator(STYLE);
  await drawer.getByRole("tab", { name: "AI" }).click();
  await describeStyle(drawer, "corporate green");

  await expectThemeModuleWritten(page);
  await expect(async () => {
    expect(
      await header.evaluate((el) => getComputedStyle(el).backgroundColor),
      "the recolour never reached anything the grid paints at rest",
    ).toEqual("rgb(230, 244, 234)"); // #e6f4ea, the ramp's lightest step
  }).toPass({ timeout: 60_000 });
});

// DEV-2571 / Sentry DEMOS-1P, and the one assertion no amount of generated text
// can make: after the module is taken back out, does the demo actually compile
// and render on a core that has no theme API?
//
// The fixture is a workspace that *arrives* themed on a 16 pin — a payload,
// which is also the only shape where the generated module is the sole importer
// of `handsontable/themes`. A 16 starter wires `themeName`, so nothing else in
// such a demo asks for that path, which is precisely why the reported event
// named `/handsontable-theme.js`. (A dirty 18 -> 16 switch is a different
// story: those starters import `handsontable/themes` themselves and ADR-0021 §6
// keeps the files it finds, which is what the version warning is for.)
const THEMED_AT_16_PAYLOAD = {
  framework: "javascript",
  title: "Themed on 16",
  files: {
    // A real Vite entry: the module script is what loads `/index.js` at all, and
    // 16 has no CSS auto-injection, so the stylesheet is imported by hand.
    "/index.html":
      '<!DOCTYPE html>\n<html>\n<head><meta charset="UTF-8" /></head>\n'
      + '<body>\n  <div id="example"></div>\n'
      + '  <script type="module" src="./index.js"></script>\n</body>\n</html>\n',
    "/index.js":
      "import { customTheme } from './handsontable-theme'; // handsontable-theme\n"
      + "import Handsontable from 'handsontable';\n"
      + "import 'handsontable/dist/handsontable.full.min.css';\n\n"
      + "new Handsontable(document.getElementById('example'), {\n"
      + "  data: [['Tesla', 'Model 3'], ['Nissan', 'Leaf']],\n"
      + "  theme: customTheme,\n"
      + "  rowHeaders: true,\n"
      + "  colHeaders: true,\n"
      + "  licenseKey: 'non-commercial-and-evaluation',\n"
      + "});\n",
    "/handsontable-theme.js":
      "import { getTheme, hasTheme, registerTheme, reinitTheme } from 'handsontable/themes';\n"
      + "import tokensPreset from 'handsontable/themes/static/variables/tokens/main';\n\n"
      + "const THEME_NAME = 'custom-theme';\n"
      + "if (hasTheme(THEME_NAME)) reinitTheme(THEME_NAME, { tokens: tokensPreset });\n"
      + "else registerTheme(THEME_NAME, { tokens: tokensPreset });\n"
      + "export const customTheme = getTheme(THEME_NAME);\n",
    "/package.json": JSON.stringify(
      { dependencies: { handsontable: "16.2.0" } },
      null,
      2,
    ),
  },
};

test("a demo that arrives themed on a pre-theme-API core still renders", async ({ page }) => {
  test.skip(process.env.E2E_LIVE !== "1", "set E2E_LIVE=1 to run live-render checks");
  test.setTimeout(240_000);

  await page.route("**/api/payload/thm16live1", (route) =>
    route.fulfill({ json: THEMED_AT_16_PAYLOAD }));

  // Unstripped, `handsontable/themes` does not exist in handsontable@16.2.0 and
  // the bundler answers `Could not find module in path: 'handsontable/themes'
  // relative to '/handsontable-theme.js'` — `openAt` turns that into the
  // preview-failed-to-start error with the message attached.
  await openAt(page, "/?payload=thm16live1&v=16.2.0", "themed-on-16 payload");

  await expect(page.locator(".hot-file-row", { hasText: "handsontable-theme" })).toBeVisible();
  const files = await workspaceFiles(page);
  expect(files["/handsontable-theme.js"]).toContain("Theme cleared.");
  expect(files["/index.js"]).not.toContain("customTheme");
  // The grid rendered above; it must be the demo's own, unthemed — no theme
  // class, because the module that would have registered one is inert.
  expect(await themeClass(page)).toBe("");
});
