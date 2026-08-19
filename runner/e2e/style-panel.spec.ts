import { test, expect, type Page } from "@playwright/test";
import { stubShell, workspaceFiles } from "./helpers";

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

/** A TokenControl row, addressed by the one stable handle it has: the label
 *  span's `title`, which carries the token key (labels repeat — six rows are
 *  called "Background Color"). */
function tokenRow(page: Page, key: string) {
  return page.locator(`${STYLE} div`).filter({
    has: page.locator(`> div > span[title="${key}"]`),
  }).last();
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
    label: "docs react @ 18.0.0",
    url: "/?docs=guides/styling/theme-customization/react/example1.tsx&v=18.0.0",
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
  const drawer = await openPanel(page, "/?docs=guides/styling/themes/javascript/exampleTheme.js&v=18.0.0");

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
