import { test, expect, type Page } from "@playwright/test";
import { currentDocsRelease, pickFromMenu, stubShell, workspaceFiles } from "./helpers";

// The Style panel itself (DEV-2203) — the highest-value spec on the task,
// because this seam is where seven defects hid, four of them silently.
//
// style-apply.spec.ts proves a generated theme reaches the running grid, one
// case per wiring shape. This spec proves everything *before* the grid: the
// panel's controls, the state they write, and the module the codegen emits.
// All of it is deterministic — the bundler is aborted, panels.spec.ts-style —
// so the whole file runs in PR CI, and unchanged against production.
//
// Two hard-won rules from the first (discarded) draft of this spec:
//
// 1. Never assert file contents through `.cm-content`. CodeMirror virtualises
//    long documents, so the editor pane holds only the lines on screen and the
//    assertion passes or fails on scroll position. `window.__HOT_FILES__` (the
//    App.tsx test contract added with this spec) reads the real files map.
// 2. Panel state lives in `localStorage["hot-runner-theme"]` behind a 250 ms
//    trailing debounce, and quiet file writes ride the same delay — poll with
//    `expect(...).toPass()`, never sample once.

// The two docs deep links below fetch from the *real* committed buckets (this
// spec aborts the bundler but not the docs manifest), so a restated version
// goes stale on the next import — 18.0 outlived the 18.1 bucket here too
// (DEV-2736). Both fixtures are byte-identical across the two buckets apart
// from their package.json pins, and nothing installs, so this only moves which
// bucket is read.
const { version: DOCS_VERSION } = currentDocsRelease();

const STYLE = 'aside[aria-label="Style this demo"]';

const COMPONENTS = [
  "Cell", "Header", "Rows", "Buttons", "Links", "Inputs", "Checkboxes",
  "Radio Buttons", "Move", "Resize", "Hidden", "Menu", "Comments", "License",
  "Pagination", "Dialog", "MultiSelect", "Scrollbar",
];

async function openPanel(page: Page, url = "/?example=react") {
  await stubShell(page);
  await page.route("**/api/versions/exists**", (route) => route.fulfill({ json: { exists: true } }));
  await page.goto(url);
  await page.getByRole("button", { name: "Style", exact: true }).click();
  await expect(page.locator(STYLE)).toBeVisible();
  return page.locator(STYLE);
}

/** The persisted ThemeState, or null before the first debounced write. */
function state(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("hot-runner-theme") ?? "null"));
}

/** A TokenControl row, addressed by `data-token` — the documented test contract
 *  on the row (labels repeat — six rows are called "Background Color"). This
 *  used to walk the row's internal structure (`> div > span[title]`), which the
 *  Theme Builder relayout broke; the attribute is the hook that can't. */
function tokenRow(page: Page, key: string) {
  return page.locator(`${STYLE} [data-token="${key}"]`);
}

/** The module row landing in the file tree is the apply signal — the panel
 *  writes through the editor's own file-write path, so tree presence means
 *  the workspace really changed. */
async function expectApplied(page: Page) {
  await expect(page.locator(".hot-file-row", { hasText: "handsontable-theme" })).toBeVisible();
  await expect(page.locator(STYLE).getByText("Applied to the preview")).toBeVisible();
}

test("the panel opens on Foundation with all four tabs", async ({ page }) => {
  const drawer = await openPanel(page);

  for (const tab of ["Foundation", "Common", "Component", "AI"]) {
    await expect(drawer.getByRole("tab", { name: tab })).toBeVisible();
  }
  await expect(drawer.getByRole("tab", { name: "Foundation" })).toHaveAttribute("aria-selected", "true");

  // The Foundation preset selects, addressable by their labels.
  for (const label of ["Colors", "Colour scheme", "Density"]) {
    await expect(drawer.getByLabel(label)).toBeVisible();
  }
});

test("all 18 components are reachable, and each opens a sub-panel with token rows", async ({ page }) => {
  const drawer = await openPanel(page);
  await drawer.getByRole("tab", { name: "Component" }).click();

  // 18 exactly — a vendored-catalogue regression (a lost component is silent).
  await expect(drawer.locator("button.hot-panel-row")).toHaveCount(COMPONENTS.length);

  for (const name of COMPONENTS) {
    await drawer.getByRole("button", { name, exact: true }).click();
    await expect(
      drawer.locator("span[title]").first(),
      `the ${name} sub-panel renders at least one token row`,
    ).toBeVisible();
    await drawer.getByRole("button", { name: "All components" }).click();
  }
});

test("preset tiles carry real images, and switching one is recorded", async ({ page }) => {
  const drawer = await openPanel(page);

  // naturalWidth > 0 is the only signal that catches a renamed asset — a
  // broken <img> is invisible in the markup and to a role query.
  const tiles = drawer.locator(".hot-panel-tile img");
  await expect(tiles).toHaveCount(5); // 3 token mappings + 2 icon sets
  await expect(async () => {
    for (let i = 0; i < 5; i += 1) {
      expect(await tiles.nth(i).evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
    }
  }).toPass();

  const tokensSection = drawer.locator("section").filter({ hasText: "Token mapping" }).first();
  await tokensSection.getByRole("button", { name: "horizon" }).click();
  await expect(tokensSection.getByRole("button", { name: "horizon" })).toHaveAttribute("data-active", "true");
  await expectApplied(page);
  await expect(async () => {
    expect((await state(page))?.tokens).toBe("horizon");
  }).toPass();
});

test("a select token renders a dropdown and records the pick", async ({ page }) => {
  const drawer = await openPanel(page);
  await drawer.getByRole("tab", { name: "Common" }).click();

  const select = tokenRow(page, "fontWeight").locator("select");
  await expect(select.locator("option")).toHaveCount(9); // 100..900, from token.options
  await select.selectOption("700");

  await expect(async () => {
    expect((await state(page))?.params?.fontWeight).toBe("700");
  }).toPass();

  // The per-token Reset renders only once the token is overridden — its
  // presence is the "is overridden" signal, and clicking it clears the key.
  await drawer.getByTitle("Reset fontWeight").click();
  await expect(async () => {
    expect((await state(page))?.params?.fontWeight).toBeUndefined();
  }).toPass();
  await expect(drawer.getByTitle("Reset fontWeight")).toHaveCount(0);
});

test("a numeric token carries its unit and constraints, and clearing removes the override", async ({ page }) => {
  const drawer = await openPanel(page);
  await drawer.getByRole("tab", { name: "Common" }).click();

  const input = tokenRow(page, "shadowOpacity").locator('input[type="number"]');
  await expect(input).toHaveAttribute("min", "0");
  await expect(input).toHaveAttribute("max", "100");
  await expect(input).toHaveAttribute("step", "1");

  await input.fill("40");
  await expect(async () => {
    expect((await state(page))?.params?.shadowOpacity).toBe("40%");
  }).toPass();

  // The defect this pins: an emptied field must remove the override, not
  // store a bare "%" that reads as a zero-length CSS value.
  await input.fill("");
  await expect(async () => {
    const params = (await state(page))?.params ?? {};
    expect(params.shadowOpacity).toBeUndefined();
  }).toPass();
  await expect(drawer.getByTitle("Reset shadowOpacity")).toHaveCount(0);
});

test("a size token shows its resolved value, never the raw reference", async ({ page }) => {
  const drawer = await openPanel(page);
  await drawer.getByRole("tab", { name: "Common" }).click();

  // borderRadius is "sizing.size_1" in the catalogue; the trigger must show
  // what that resolves to on this build — the raw reference was the shipped
  // regression (a control full of "sizing.size_1" reads as broken).
  const trigger = tokenRow(page, "borderRadius").locator("button[aria-expanded]");
  await expect(trigger).toContainText("4px");
  await expect(trigger).not.toContainText("sizing.");

  await trigger.click();
  // A pristine token opens the popover on the "custom" segment (the mode is
  // derived from the override, and there is none yet) — the scale lives
  // behind the "sizing" segment.
  await drawer.getByRole("button", { name: "sizing", exact: true }).click();
  const size2 = drawer.locator(".hot-panel-list-item", { hasText: "size_2" }).first();
  await expect(size2).toBeVisible();
  await size2.click();
  await expect(async () => {
    expect((await state(page))?.params?.borderRadius).toBe("sizing.size_2");
  }).toPass();
});

test("linked header tokens move together, and reset together", async ({ page }) => {
  const drawer = await openPanel(page);
  await drawer.getByRole("tab", { name: "Component" }).click();
  await drawer.getByRole("button", { name: "Header", exact: true }).click();

  // Pick a ramp colour for the header background. headerBackgroundColor is
  // linked to headerRowBackgroundColor (a *Rows* token) — the defect was that
  // the linked half was never written, so column headers restyled while row
  // headers kept the stock colour.
  await tokenRow(page, "headerBackgroundColor").locator("button[aria-expanded]").click();
  await drawer.locator('.hot-swatch-btn[title="primary.500"]').first().click();

  await expect(async () => {
    const params = (await state(page))?.params ?? {};
    expect(params.headerBackgroundColor).toBeDefined();
    expect(JSON.stringify(params.headerRowBackgroundColor)).toBe(JSON.stringify(params.headerBackgroundColor));
  }).toPass();

  // The linked override is visible from the other side too: Rows carries an
  // override badge without ever having been opened.
  await drawer.getByRole("button", { name: "All components" }).click();
  await expect(drawer.getByRole("button", { name: "Rows", exact: true })).toContainText("1");

  // Reset from the Header side must clear both.
  await drawer.getByRole("button", { name: "Header", exact: true }).click();
  await drawer.getByTitle("Reset headerBackgroundColor").click();
  await expect(async () => {
    const params = (await state(page))?.params ?? {};
    expect(params.headerBackgroundColor).toBeUndefined();
    expect(params.headerRowBackgroundColor).toBeUndefined();
  }).toPass();
});

test("density sizes are written per variant, including one the grid is not on", async ({ page }) => {
  const drawer = await openPanel(page);
  await drawer.getByRole("button", { name: /Density sizes/ }).click();

  // The grid is on "default"; edit "comfortable". The editor says so rather
  // than pretending — and the write must land under the edited variant, not
  // the active one (the wrong-nesting defect was ignored in silence).
  await drawer.getByRole("button", { name: "comfortable", exact: true }).click();
  await expect(drawer.getByText("won't show in the preview yet")).toBeVisible();

  // DEV-2560 made density sizes scale pickers with a `data-token` hook — the
  // same interaction style-apply.spec.ts drives; pick a step off the sizing
  // scale rather than typing a literal.
  const row = drawer.locator('[data-token="cellVertical"]');
  await row.getByRole("button", { expanded: false }).first().click();
  await row.getByRole("button", { name: /^size_7\b/ }).click();

  await expect(async () => {
    const sizes = (await state(page))?.densitySizes ?? {};
    expect(sizes.comfortable?.cellVertical).toBe("sizing.size_7");
    expect(sizes.default).toBeUndefined();
  }).toPass();

  await expectApplied(page);
  await expect(async () => {
    const module = (await workspaceFiles(page))["/handsontable-theme.ts"] ?? "";
    expect(module).toContain('"comfortable": {');
    expect(module).toContain('"cellVertical": "sizing.size_7"');
    expect(module).toContain('type: "default"');
  }).toPass();
});

// The displaced-themeName round trip needs a fixture that *has* a themeName on
// a version the panel will theme: DEV-2222 disables Style below major 17
// (`themingSupported`), which retired the v16 starters as fixtures, and the
// v17+ starters wire `theme={mainTheme}` and carry none. The docs bucket still
// has the attribute shape at 18: the theme-customization React example ships a
// literal `themeName="ht-theme-main"`. The settings shape (`themeName: '…'`)
// has no natural fixture on a themable version — its round trip is pinned at
// codegen level by pipeline/theme-wiring.test.mjs instead. Assert the
// precondition first: if the docs artifact ever loses its themeName, this must
// read as "fixture changed", not "product broke".
for (const shape of [
  {
    label: `docs react @ ${DOCS_VERSION}`,
    url: `/?docs=guides/styling/theme-customization/react/example1.tsx&v=${DOCS_VERSION}`,
    file: "/src/App.tsx",
    original: 'themeName="ht-theme-main"',
    wired: "theme={customTheme}",
    module: "/handsontable-theme.ts",
  },
]) {
  test(`apply then Reset round-trips a displaced themeName (${shape.label})`, async ({ page }) => {
    const drawer = await openPanel(page, shape.url);

    let before: Record<string, string> = {};
    await expect(async () => {
      before = await workspaceFiles(page);
      expect(before[shape.file], `fixture precondition: ${shape.label} carries a themeName`)
        .toContain(shape.original);
    }).toPass();

    await drawer.getByLabel("Colour scheme").selectOption("dark");
    await expectApplied(page);

    await expect(async () => {
      const files = await workspaceFiles(page);
      const wiredFile = files[shape.file] ?? "";
      // Swapped in place — the grid element survives (the line-deletion defect
      // erased single-line <HotTable … /> elements wholesale) …
      expect(wiredFile).toContain(shape.wired);
      // … and the displaced themeName rides the marker comment: after wiring,
      // the only line still mentioning themeName is the marker that will
      // restore it. (Line-based, not a raw count: the fixture's stylesheet
      // also names ht-theme-main, in a rule, not an attribute.)
      expect(wiredFile).toContain("// handsontable-theme restore:");
      const themeNameLines = wiredFile.split("\n").filter((l) => l.includes("themeName"));
      expect(themeNameLines).toHaveLength(1);
      expect(themeNameLines[0]).toContain("handsontable-theme restore:");
    }).toPass();

    await drawer.getByRole("button", { name: "Reset", exact: true }).click();

    await expect(async () => {
      const after = await workspaceFiles(page);
      for (const [path, contents] of Object.entries(before)) {
        expect(after[path], `${path} returns to exactly how it arrived`).toBe(contents);
      }
      expect(after[shape.module]).toBe("// Theme cleared.\nexport const customTheme = undefined;\n");
    }).toPass();
  });
}

test("the theme survives a reload", async ({ page }) => {
  // No addInitScript storage manipulation here — it would run on reload() too
  // and defeat the very thing under test (AGENTS.md warns about exactly this).
  let drawer = await openPanel(page);

  const tokensSection = drawer.locator("section").filter({ hasText: "Token mapping" }).first();
  await tokensSection.getByRole("button", { name: "horizon" }).click();
  await drawer.getByRole("tab", { name: "Common" }).click();
  await tokenRow(page, "fontWeight").locator("select").selectOption("700");

  await expect(async () => {
    const saved = await state(page);
    expect(saved?.tokens).toBe("horizon");
    expect(saved?.params?.fontWeight).toBe("700");
  }).toPass();

  await page.reload();
  await page.getByRole("button", { name: "Style", exact: true }).click();
  drawer = page.locator(STYLE);

  // Restored, and re-applied: on mount a non-pristine theme rebuilds the
  // module into the current demo, so the file row reappears without a touch.
  await expect(
    drawer.locator("section").filter({ hasText: "Token mapping" }).first().getByRole("button", { name: "horizon" }),
  ).toHaveAttribute("data-active", "true");
  await expect(async () => {
    expect((await state(page))?.params?.fontWeight).toBe("700");
  }).toPass();
  await expect(page.locator(".hot-file-row", { hasText: "handsontable-theme" })).toBeVisible();
});

test("the generated module quotes every key", async ({ page }) => {
  const drawer = await openPanel(page);

  // One of each interpolated-key family: a token param, a palette ramp, a
  // density size. Keys look trustworthy but arrive from localStorage or a
  // shared link — every one must go through JSON.stringify (the injection
  // defect), which reads as "every key is quoted".
  await drawer.getByRole("tab", { name: "Common" }).click();
  await tokenRow(page, "fontWeight").locator("select").selectOption("700");

  await drawer.getByRole("tab", { name: "Foundation" }).click();
  await drawer.getByRole("button", { name: /Palette/ }).click();
  await drawer.getByLabel("Generate the brand ramp from this colour").fill("#1a7a38");

  await drawer.getByRole("button", { name: /Density sizes/ }).click();
  const row = drawer.locator('[data-token="cellVertical"]');
  await row.getByRole("button", { expanded: false }).first().click();
  await row.getByRole("button", { name: /^size_7\b/ }).click();

  await expect(async () => {
    const module = (await workspaceFiles(page))["/handsontable-theme.ts"] ?? "";
    expect(module).toContain('"fontWeight": "700"');
    expect(module).toContain('"primary"');
    expect(module).toContain('"500"');
    expect(module).toContain('"cellVertical": "sizing.size_7"');
    // The density variant key is dynamic too — a variant name from state must
    // come out quoted just like token and ramp keys. (Structural keys the
    // codegen owns — tokens:, density:, type: — are legitimately bare; the
    // exhaustive no-unquoted-interpolation guard is pipeline/theme-codegen.test.mjs,
    // which scans the codegen source itself.)
    expect(module).toContain('"default": {');
  }).toPass();
});

test("Copy for my app hands over the theme without the runner's bridge", async ({ page }) => {
  const drawer = await openPanel(page);
  await drawer.getByRole("tab", { name: "Common" }).click();
  await tokenRow(page, "fontWeight").locator("select").selectOption("700");
  await expectApplied(page);

  await drawer.getByRole("button", { name: "Copy for my app" }).click();
  const snippet = drawer.locator("pre code");
  await expect(snippet).toBeVisible();

  // The snippet is what users paste into their own app: the same theme, a
  // hand-off comment, and *none* of the live-patch bridge the in-demo module
  // carries — window.parent listeners belong to the runner, not the user.
  await expect(snippet).toContainText("registerTheme");
  await expect(snippet).toContainText("// then hand it to the grid");
  await expect(snippet).not.toContainText("hot-runner-theme");
  await expect(snippet).not.toContainText("addEventListener");
  await expect(snippet).not.toContainText("window.parent");
});

test("a grid shape the panel does not recognise gets the manual hint, not a mangled file", async ({ page }) => {
  // This docs example builds its grid with `theme: getTheme('…').setColorScheme(…)`
  // — a computed expression wireTheme deliberately refuses to touch.
  const drawer = await openPanel(
    page,
    `/?docs=guides/styling/themes/javascript/exampleTheme.js&v=${DOCS_VERSION}`,
  );

  // Wait for the docs workspace to actually arrive before applying: until the
  // fetch lands, the files map is empty, and wireTheme over an empty map shows
  // the very same hint — the test would pass without ever touching the fixture
  // (Bugbot, #185). The unrecognisable expression is the precondition.
  let before = "";
  let entryPath = "";
  await expect(async () => {
    const files = await workspaceFiles(page);
    entryPath = Object.keys(files).find((p) => files[p].includes("theme: getTheme(")) ?? "";
    expect(entryPath, "the docs example with the computed theme expression has loaded").not.toBe("");
    before = files[entryPath];
  }).toPass();

  const tokensSection = drawer.locator("section").filter({ hasText: "Token mapping" }).first();
  await tokensSection.getByRole("button", { name: "horizon" }).click();

  await expect(drawer.getByText("shape the panel does not recognise")).toBeVisible();
  await expect(drawer.locator("code", { hasText: "handsontable-theme" }).first()).toBeVisible();
  // The module is still written — only the wiring is left to the user…
  await expect(page.locator(".hot-file-row", { hasText: "handsontable-theme" })).toBeVisible();
  // …and the file the panel refused to wire is byte-identical to how it loaded.
  await expect(async () => {
    expect((await workspaceFiles(page))[entryPath]).toBe(before);
  }).toPass();
});

test("a Google Font pick injects the stylesheet link and says so", async ({ page }) => {
  const drawer = await openPanel(page);
  await drawer.getByRole("tab", { name: "Common" }).click();

  await tokenRow(page, "fontFamily").locator("select").selectOption("Roboto");

  await expect(drawer.getByText("from Google Fonts")).toBeVisible();
  await expect(async () => {
    const module = (await workspaceFiles(page))["/handsontable-theme.ts"] ?? "";
    expect(module).toContain("fonts.googleapis.com/css2?family=Roboto");
    expect(module).toContain("document.head.appendChild(fontLink)");
  }).toPass();
});

// DEV-2571 (Sentry DEMOS-1P): `DemoError: Could not find module in path:
// 'handsontable/themes' relative to '/handsontable-theme.js'`.
//
// The generated module is a real workspace file, and a version switch on a
// *dirty* workspace deliberately keeps the files it finds (ADR-0021 §6) —
// applying a theme is what dirties it, so a themed demo takes exactly that
// branch down to a core that has no `handsontable/themes` at all.

/** `stubShell` advertises 18.0.0 and 17.1.0 only, and the picker cannot offer a
 *  version the list does not hold — so a downgrade case has to widen it. The
 *  override is registered *after* `stubShell` on purpose: Playwright matches the
 *  most recently added handler first. */
async function openPanelAtVersions(page: Page, url: string, versions: string[]) {
  await stubShell(page);
  await page.route("**/api/versions", (route) =>
    route.fulfill({ json: { latest: "18.0.0", next: "19.0.0-next.1", versions } }));
  await page.route("**/api/versions/exists**", (route) => route.fulfill({ json: { exists: true } }));
  await page.goto(url);
  await page.getByRole("button", { name: "Style", exact: true }).click();
  await expect(page.locator(STYLE)).toBeVisible();
  return page.locator(STYLE);
}

const themeModule = (files: Record<string, string>) =>
  Object.entries(files).find(([path]) => path.includes("handsontable-theme"));

test("a downgrade below the theme API takes the theme module back out", async ({ page }) => {
  const drawer = await openPanelAtVersions(page, "/?example=react&v=18.0.0", ["18.0.0", "17.1.0", "16.2.0"]);

  await drawer.getByLabel("Colour scheme").selectOption("dark");
  await expectApplied(page);

  // Precondition: the module really does import the path a pre-17 core lacks,
  // and the entry really is wired to it. Without this the test could pass on a
  // demo that was never themed.
  let entry = "";
  await expect(async () => {
    const files = await workspaceFiles(page);
    const [, module] = themeModule(files) ?? [];
    expect(module, "fixture precondition: a theme module was written").toContain("handsontable/themes");
    entry = Object.keys(files).find((p) => files[p].includes("theme={customTheme}")) ?? "";
    expect(entry, "fixture precondition: the theme was wired into the grid").not.toBe("");
  }).toPass();

  // The drawer overlays the preview bar, so the version pill is only clickable
  // with the panel closed — which is also the honest flow: nobody switches core
  // versions from inside the Style panel. Closing it flushes the panel's pending
  // quiet writes, so the theme is fully landed before the downgrade.
  await page.getByRole("button", { name: "Style", exact: true }).click();
  await expect(page.locator(STYLE)).toBeHidden();
  // The drawer hands focus back to its trigger as it unmounts, and the trigger
  // shows its tooltip on focus — a wide one, which then covers the version pill.
  // Escape is what that button offers to dismiss it (`StyleButton`, onKeyDown).
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toBeHidden();

  await pickFromMenu(page, "Handsontable version", "16.2.0");

  await expect(async () => {
    const files = await workspaceFiles(page);
    // The switch itself happened — otherwise everything below is vacuous.
    expect(files["/package.json"]).toContain('"handsontable": "16.2.0"');
    // The module is inert, so nothing it used to import is asked for any more.
    const [, module] = themeModule(files) ?? [];
    expect(module).toContain("Theme cleared.");
    expect(module).not.toContain("handsontable/themes");
    // Unwired in place, not line-deleted: the grid element survives.
    expect(files[entry]).not.toContain("customTheme");
    expect(files[entry]).toContain("<HotTable");
    // Scope note, deliberately not asserted the other way round: the >=17
    // starters import `handsontable/themes` themselves (`isLegacyBucket` in
    // pipeline/blank-starters.mjs emits `theme:` above 16 and `themeName:`
    // below), and a dirty cross-bucket switch keeps the files it finds by
    // design (ADR-0021 §6). So this workspace can still hold a 17+ API on a
    // 16 core — that is what the second half of the composed notice is for,
    // and it is not DEV-2571's to remove.
  }).toPass();

  // The notice has to name the theme. The dirty-switch branch sets its own
  // "unsaved edits may not match the selected version API" string in the same
  // commit and into the same single slot, and left to win it would tell the user
  // nothing about the file that just changed under them.
  await expect(page.locator('span[title*="the custom theme was removed from this demo"]')).toBeVisible();

  // And the button says why it can no longer be opened.
  await expect(page.getByRole("button", { name: "Style", exact: true }))
    .toHaveAttribute("aria-disabled", "true");
});

test("a bare major deep link cannot open the Style panel", async ({ page }) => {
  // `16` is a version `validateHandsontableVersion` accepts (coerced to 16.0.0)
  // and both `?v=` and the version pencil pass through verbatim. Reading the
  // major off the raw string found no `\d+\.`, answered null, and null is the
  // pass-through meant for `next`/pkg.pr.new builds — so this booted a v16 core
  // with theming enabled, which is how a themed 16 workspace gets made at all.
  await stubShell(page);
  await page.goto("/?example=react&v=16");

  // `aria-disabled` rather than `disabled`: the button stays focusable so its
  // tooltip is reachable by keyboard. Playwright reads it as not enabled, which
  // is the assertion — a click cannot be dispatched at all.
  const style = page.getByRole("button", { name: "Style", exact: true });
  await expect(style).toHaveAttribute("aria-disabled", "true");
  await expect(style).toBeDisabled();
  await expect(page.locator(STYLE)).toBeHidden();
});

test("a version the validator refuses cannot open the Style panel either", async ({ page }) => {
  // `selectedReleaseMajor` answers null for a ref the validator rejects, and null
  // is the pass-through meant for `next`/pkg.pr.new builds — so a sub-floor deep
  // link used to get a live Style button over a preview the mount guard refuses
  // to boot, and theming it would have written a module into a workspace that
  // cannot run at all.
  await stubShell(page);
  await page.goto("/?example=react&v=14.0.0");

  const style = page.getByRole("button", { name: "Style", exact: true });
  await expect(style).toHaveAttribute("aria-disabled", "true");
  await expect(style).toBeDisabled();
  await expect(page.locator(STYLE)).toBeHidden();
});

// The hydration half of DEV-2571, and the shape the reported event most likely
// had: a workspace that *arrives* themed on a sub-17 pin, with no version change
// anywhere. Authored as a payload so the only `handsontable/themes` import in it
// is the generated module's — a 16 starter wires `themeName`, so nothing else in
// a themed-at-16 demo asks for that path, which is exactly why Sandpack blamed
// `/handsontable-theme.js` by name.
const THEMED_AT_16 = {
  framework: "javascript",
  title: "Themed on 16",
  files: {
    "/index.html": '<div id="example"></div>',
    "/index.js":
      "import { customTheme } from './handsontable-theme'; // handsontable-theme\n"
      + "import Handsontable from 'handsontable';\n"
      + "import { data } from './data.js';\n\n"
      + "new Handsontable(document.getElementById('example'), {\n"
      + "  data: data,\n"
      + "  theme: customTheme,\n"
      + "  rowHeaders: true,\n"
      + "});\n",
    "/data.js": "export const data = [['a']];\n",
    "/handsontable-theme.js":
      "import { getTheme, hasTheme, registerTheme, reinitTheme } from 'handsontable/themes';\n"
      + "import tokensPreset from 'handsontable/themes/static/variables/tokens/main';\n\n"
      + "const THEME_NAME = 'custom-theme';\n"
      + "if (hasTheme(THEME_NAME)) reinitTheme(THEME_NAME, { tokens: tokensPreset });\n"
      + "else registerTheme(THEME_NAME, { tokens: tokensPreset });\n"
      + "export const customTheme = getTheme(THEME_NAME);\n",
    "/package.json": JSON.stringify({ dependencies: { handsontable: "16.2.0" } }, null, 2),
  },
};

test("an unusable version leaves a wired theme alone", async ({ page }) => {
  // "Not themeable" and "on a core below the theme API" are two different
  // questions, and the strip may only key on the second (review, PR #241). A ref
  // the validator refuses — a half-typed version in the pencil, a legacy `latest`
  // sentinel on a saved row, a `?v=` typo — is not a pre-17 core. The preview
  // refuses to boot on all of them, and taking a theme out of the workspace over
  // any of them destroys files to fix nothing.
  await stubShell(page);
  await page.route("**/api/payload/thm16at0002", (route) => route.fulfill({ json: THEMED_AT_16 }));
  await page.goto("/?payload=thm16at0002&v=latest");

  // The Style button is still refused — that half is right.
  await expect(page.getByRole("button", { name: "Style", exact: true }))
    .toHaveAttribute("aria-disabled", "true");

  // The files are untouched. Polled, so this cannot pass by reading the workspace
  // before the strip effect would have had its chance.
  await expect(async () => {
    const files = await workspaceFiles(page);
    expect(Object.keys(files), "the payload opened").toContain("/handsontable-theme.js");
    expect(files["/handsontable-theme.js"]).toContain("handsontable/themes");
    expect(files["/index.js"]).toContain("customTheme");
  }).toPass();
  await expect(page.locator('span[title*="the custom theme was removed"]')).toBeHidden();
});

test("a workspace that arrives themed on a sub-17 pin is repaired on load", async ({ page }) => {
  await stubShell(page);
  await page.route("**/api/payload/thm16at0001", (route) => route.fulfill({ json: THEMED_AT_16 }));
  await page.goto("/?payload=thm16at0001&v=16.2.0");

  await expect(async () => {
    const files = await workspaceFiles(page);
    expect(Object.keys(files), "the payload opened").toContain("/handsontable-theme.js");
    // The import a 16 core cannot resolve — the DEMOS-1P message names this file
    // and this specifier — is gone, and so is the wiring that reached for it.
    expect(files["/handsontable-theme.js"]).not.toContain("handsontable/themes");
    expect(files["/handsontable-theme.js"]).toContain("Theme cleared.");
    expect(files["/index.js"]).not.toContain("customTheme");
    // Unwired in place: the settings object and the grid survive.
    expect(files["/index.js"]).toContain("rowHeaders: true,");
    expect(files["/index.js"]).toContain("new Handsontable(");
  }).toPass();

  await expect(page.locator('span[title*="the custom theme was removed from this demo"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Style", exact: true }))
    .toHaveAttribute("aria-disabled", "true");

  // The notice is about the workspace that just lost its theme, so it must not
  // outlive it: the next workspace never had one. (Nothing sets the flag back to
  // false on its own — the strip effect early-returns when there is no theme.)
  await page.getByRole("button", { name: /JavaScript/ }).first().click();
  await page.getByText("Starter templates", { exact: true }).click();
  await page.getByRole("treeitem", { name: "React (Vite, TS)" }).click();
  await expect(async () => {
    const files = await workspaceFiles(page);
    expect(Object.keys(files), "the starter replaced the payload").not.toContain("/handsontable-theme.js");
  }).toPass();
  await expect(page.locator('span[title*="the custom theme was removed"]')).toBeHidden();
});
