import { test, expect, type Page } from "@playwright/test";

// The Ask AI and Style drawers (DEV-2209). Deterministic — no `E2E_LIVE=1`: both
// panels are chrome, so the Sandpack bundler is aborted and `/api/versions` is
// stubbed. Nothing here talks to `/api/chat` or `/api/theme`; the assertions are
// about how the panels are painted, not what the assistant answers.
//
// Why computed style rather than screenshots: this is the bug class ADR-0026 §5
// records. A dark-mode `#ffffff` control and a dead `:hover` both look plausible
// in a picture — the first one shipped for a whole release cycle. Read the values.

const CHAT = 'aside[aria-label="Ask about this example"]';
const STYLE = 'aside[aria-label="Style this demo"]';

async function openPlayground(page: Page, mode: "light" | "dark") {
  await page.addInitScript((m) => localStorage.setItem("hot-theme", m), mode);
  await page.route("**/api/versions", (route) =>
    route.fulfill({ json: { latest: "18.0.0", next: "19.0.0-next.1", versions: ["18.0.0", "17.1.0"] } }),
  );
  await page.route("https://sandpack.codesandbox.io/**", (route) => route.abort());
  await page.route("https://sandpack-bundler.codesandbox.io/**", (route) => route.abort());
  await page.goto("/?example=react");
  await expect(page.getByRole("button", { name: "Style", exact: true })).toBeVisible();
  // The pre-paint script reads storage, so the attribute is already right; assert
  // it rather than setting it, or every colour below is measured in the wrong mode.
  await expect(page.locator("html")).toHaveAttribute("data-hot-theme", mode);
}

/** `backgroundColor`, `color` and the four border colours of one element, plus
 *  its parent's fill — the pairing both defects are visible in. */
async function paint(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((el) => {
    const c = getComputedStyle(el);
    const parent = el.parentElement ? getComputedStyle(el.parentElement).backgroundColor : null;
    return {
      background: c.backgroundColor,
      color: c.color,
      borderColor: c.borderTopColor,
      parentBackground: parent,
    };
  });
}

test.describe("drawer chrome", () => {
  test("both drawers share one width and one surface", async ({ page }) => {
    await openPlayground(page, "light");

    await page.getByRole("button", { name: "Ask AI", exact: true }).click();
    const chat = await page.locator(CHAT).boundingBox();
    await page.locator(CHAT).getByRole("button", { name: /^Close/ }).click();

    await page.getByRole("button", { name: "Style", exact: true }).click();
    const style = await page.locator(STYLE).boundingBox();

    expect(chat?.width).toBe(style?.width);
    // `DRAWER_WIDTH`. Hard-coded rather than imported: the point is that neither
    // panel can drift back to its own number (400 and 380 before DEV-2209).
    expect(style?.width).toBe(400);
  });

  test("only one drawer is open at a time", async ({ page }) => {
    await openPlayground(page, "light");
    await page.getByRole("button", { name: "Ask AI", exact: true }).click();
    await expect(page.locator(CHAT)).toBeVisible();

    await page.getByRole("button", { name: "Style", exact: true }).click();
    await expect(page.locator(STYLE)).toBeVisible();
    await expect(page.locator(CHAT)).toHaveCount(0);
  });

  test("swapping drawers leaves focus on the trigger that was clicked", async ({ page }) => {
    await openPlayground(page, "light");
    const askAi = page.getByRole("button", { name: "Ask AI", exact: true });
    const style = page.getByRole("button", { name: "Style", exact: true });

    await askAi.click();
    await style.click();
    await expect(page.locator(STYLE)).toBeVisible();

    // The closing drawer used to focus *its* trigger on unmount — which happens
    // before the opening drawer records where focus was — so focus landed on
    // `Ask AI`, its `onFocus` fired, and the closed panel's tooltip appeared over
    // the open one.
    await expect(style).toBeFocused();
    await expect(page.locator("#ask-ai-hint")).toHaveCount(0);

    // And the drawer that is open now must return focus to its own trigger.
    await page.keyboard.press("Escape");
    await expect(page.locator(STYLE)).toHaveCount(0);
    await expect(style).toBeFocused();
  });

  test("Escape closes the drawer and hands focus back to its trigger", async ({ page }) => {
    await openPlayground(page, "light");
    const trigger = page.getByRole("button", { name: "Ask AI", exact: true });
    await trigger.click();
    await expect(page.locator(CHAT)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.locator(CHAT)).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("an Escape a Dialog has already consumed does not also close the drawer", async ({ page }) => {
    await openPlayground(page, "light");
    await page.getByRole("button", { name: "Ask AI", exact: true }).click();
    await expect(page.locator(CHAT)).toBeVisible();

    // `Dialog` listens on `document` in the capture phase and calls
    // `stopPropagation`. Installed here rather than opening a real dialog: the one
    // that can sit above a drawer is Share, and minting a share link needs the API.
    // The mechanism under test is the phase, and this reproduces it exactly.
    await page.evaluate(() => {
      const swallow = (e: KeyboardEvent) => { if (e.key === "Escape") e.stopPropagation(); };
      document.addEventListener("keydown", swallow, true);
    });
    await page.keyboard.press("Escape");
    await expect(page.locator(CHAT)).toBeVisible();
  });
});

/** WCAG 2.1 contrast ratio of one element's text against its own background,
 *  walking up for the first non-transparent ancestor fill — which is what a
 *  transparent button on a drawer actually renders against. */
async function contrast(page: Page, selector: string): Promise<number> {
  return page.locator(selector).first().evaluate((el) => {
    const parse = (v: string) => (v.match(/[\d.]+/g) ?? []).map(Number);
    const lum = ([r, g, b]: number[]) => {
      const ch = [r, g, b].map((c) => {
        const s = (c ?? 0) / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
    };
    let node: HTMLElement | null = el as HTMLElement;
    let background = "rgba(0, 0, 0, 0)";
    while (node) {
      const bg = getComputedStyle(node).backgroundColor;
      const parts = parse(bg);
      if (parts.length < 4 || parts[3] !== 0) { background = bg; break; }
      node = node.parentElement;
    }
    const a = lum(parse(getComputedStyle(el).color));
    const b = lum(parse(background));
    const [hi, lo] = a > b ? [a, b] : [b, a];
    return (hi + 0.05) / (lo + 0.05);
  });
}

test.describe("dark mode legibility", () => {
  test("accent text clears AA on the drawer's surface", async ({ page }) => {
    await openPlayground(page, "dark");
    await page.getByRole("button", { name: "Ask AI", exact: true }).click();

    // Plain `accent` (#1A42E8) is 2.3:1 on `surfaceRaised` — these four buttons are
    // the first thing an empty chat panel offers and they read as disabled.
    // `accentText` is the lifted pair.
    const suggestion = await contrast(page, `${CHAT} .hot-panel-suggestion`);
    expect(suggestion).toBeGreaterThanOrEqual(4.5);

    await page.locator(CHAT).getByRole("button", { name: /^Close/ }).click();
    await page.getByRole("button", { name: "Style", exact: true }).click();
    // Same token, as a selected tab label and a link inside body copy.
    expect(await contrast(page, `${STYLE} [role=tab][aria-selected=true]`)).toBeGreaterThanOrEqual(4.5);
    expect(await contrast(page, `${STYLE} a`)).toBeGreaterThanOrEqual(4.5);
  });

  test("no control in either drawer is painted white", async ({ page }) => {
    await openPlayground(page, "dark");

    await page.getByRole("button", { name: "Style", exact: true }).click();
    await page.locator(STYLE).getByRole("tab", { name: "Common" }).click();
    // The control every one of the 272 tokens is edited through. It rendered
    // `#ffffff` behind `#d1d1d4` text before DEV-2209 — about 1.4:1.
    const trigger = await paint(page, `${STYLE} button[aria-expanded]`);
    expect(trigger.background).not.toBe("rgb(255, 255, 255)");
    // `surface`, the shell's dark ground for a control on a raised surface.
    expect(trigger.background).toBe("rgb(7, 6, 4)");

    await page.locator(`${STYLE} button[aria-expanded]`).first().click();
    const popover = await paint(page, `${STYLE} button[aria-expanded="true"] + div, ${STYLE} div:has(> .hot-panel-list-item)`);
    expect(popover.background).not.toBe("rgb(255, 255, 255)");

    await page.locator(STYLE).getByRole("button", { name: /^Close/ }).click();
    await page.getByRole("button", { name: "Ask AI", exact: true }).click();
    const textarea = await paint(page, `${CHAT} textarea`);
    expect(textarea.background).not.toBe("rgb(255, 255, 255)");
    expect(textarea.background).toBe("rgb(7, 6, 4)");
  });

  test("control outlines are visible against the surface they sit on", async ({ page }) => {
    await openPlayground(page, "dark");
    await page.getByRole("button", { name: "Style", exact: true }).click();

    // The colour inputs live inside the Palette group, which starts collapsed.
    await page.locator(STYLE).getByRole("button", { name: /Palette/ }).click();
    await expect(page.locator(`${STYLE} input[type=color]`).first()).toBeVisible();

    // Dark `border` *is* `surfaceRaised`, so a control outlined with it vanishes on
    // a drawer. `controlBorder` (#353535) is the one that reads.
    for (const selector of [`${STYLE} select`, `${STYLE} input[type=color]`]) {
      const el = await paint(page, selector);
      expect(el.borderColor, selector).toBe("rgb(53, 53, 53)");
      expect(el.borderColor, selector).not.toBe(el.parentBackground);
    }
  });
});

test.describe("chat transcript", () => {
  /** One canned answer carrying every surface the transcript can paint: a table,
   *  an inline code span, a fenced block, a proposed edit and a doc link. Live
   *  browsing cannot reach any of them — they exist only after a turn — which is
   *  exactly why they went unmeasured until now. */
  async function stubOneAnswer(page: Page) {
    await page.route("**/api/search", (route) => route.fulfill({ json: { results: [] } }));
    await page.route("**/api/chat/event", (route) => route.fulfill({ json: {} }));
    await page.route("**/api/chat", (route) =>
      route.fulfill({
        json: {
          message: [
            "## Column widths",
            "",
            "Set `colWidths` on the grid.",
            "",
            "| Option | Type |",
            "| --- | --- |",
            "| `colWidths` | number |",
            "",
            // A section divider, which models put between every part of a long
            // answer. It used to render as literal dashes (DEV-2197).
            "---",
            "",
            "```js",
            "colWidths: [100, 200]",
            "```",
          ].join("\n"),
          edits: [{ path: "src/index.tsx", contents: "// changed\n", why: "sets the widths" }],
          references: ["https://handsontable.com/docs/column-width/"],
          pages: [],
        },
      }),
    );
  }

  test("every surface an answer paints is legible in dark", async ({ page }) => {
    await openPlayground(page, "dark");
    await stubOneAnswer(page);

    await page.getByRole("button", { name: "Ask AI", exact: true }).click();
    await page.locator(`${CHAT} textarea`).fill("How do I set column widths?");
    await page.locator(CHAT).getByRole("button", { name: "Send" }).click();
    await expect(page.locator(CHAT).getByText("Proposed changes to")).toBeVisible();

    for (const selector of [
      `${CHAT} table`,          // markdown.tsx tableStyle
      `${CHAT} th`,             // thStyle
      `${CHAT} pre`,            // preStyle
      `${CHAT} p code`,         // codeStyle — the inline span
    ]) {
      const el = await paint(page, selector);
      expect(el.background, selector).not.toBe("rgb(255, 255, 255)");
      expect(el.borderColor, selector).not.toBe(el.parentBackground);
    }

    // The edit box and its path chip: `controlBorder`, or they dissolve into the
    // `surfaceMuted` panel they sit on.
    const chip = await paint(page, `${CHAT} code`);
    expect(chip.borderColor).toBe("rgb(53, 53, 53)");

    // A section divider is one hairline, and a divider the same colour as the
    // surface behind it is the ADR-0026 §5 defect in its purest form — there is
    // nothing else to the element to give it away.
    const rule = page.locator(`${CHAT} hr`);
    await expect(rule).toHaveCount(1);
    const drawn = await paint(page, `${CHAT} hr`);
    expect(drawn.borderColor).not.toBe(drawn.parentBackground);
  });

  test("a --- between sections draws a rule, not literal dashes", async ({ page }) => {
    await openPlayground(page, "light");
    await stubOneAnswer(page);

    await page.getByRole("button", { name: "Ask AI", exact: true }).click();
    await page.locator(`${CHAT} textarea`).fill("How do I set column widths?");
    await page.locator(CHAT).getByRole("button", { name: "Send" }).click();
    await expect(page.locator(CHAT).getByText("Proposed changes to")).toBeVisible();

    await expect(page.locator(`${CHAT} hr`)).toHaveCount(1);
    // The old behaviour, and the one a reader actually notices: the divider
    // arriving as three dashes on a line of its own.
    const transcript = await page.locator(CHAT).innerText();
    expect(transcript).not.toMatch(/^\s*---\s*$/m);
  });

  test("Apply writes the file and Undo puts it back", async ({ page }) => {
    await openPlayground(page, "dark");
    await stubOneAnswer(page);

    await page.getByRole("button", { name: "Ask AI", exact: true }).click();
    await page.locator(`${CHAT} textarea`).fill("How do I set column widths?");
    await page.locator(CHAT).getByRole("button", { name: "Send" }).click();

    await page.locator(CHAT).getByRole("button", { name: "Apply" }).click();
    await expect(page.locator(CHAT).getByText("Applied to")).toBeVisible();
    await page.locator(CHAT).getByRole("button", { name: "Undo" }).click();
    await expect(page.locator(CHAT).getByText("Proposed changes to")).toBeVisible();
  });
});

test.describe("interaction states", () => {
  // ADR-0026 §5: a synthetic event does not trigger `:hover`, and these carry a
  // 120ms `background-color` transition — read too early and a live rollover
  // reports its resting colour. Hence a real pointer and the settle.
  const SETTLE = 250;

  test("panel rows have a live rollover", async ({ page }) => {
    await openPlayground(page, "dark");
    await page.getByRole("button", { name: "Style", exact: true }).click();
    await page.locator(STYLE).getByRole("tab", { name: "Component" }).click();

    const rows = page.locator(`${STYLE} .hot-panel-row`);
    await expect(rows.first()).toBeVisible();
    const rest = await paint(page, `${STYLE} .hot-panel-row`);

    await rows.first().hover();
    await page.waitForTimeout(SETTLE);
    const hovered = await paint(page, `${STYLE} .hot-panel-row`);

    expect(hovered.background).not.toBe(rest.background);
    expect(hovered.background).toBe("rgba(255, 255, 255, 0.08)"); // dark `hover`
  });

  test("preset tiles keep their frame at rest and take the accent on hover", async ({ page }) => {
    await openPlayground(page, "light");
    await page.getByRole("button", { name: "Style", exact: true }).click();

    const idle = page.locator(`${STYLE} .hot-panel-tile[data-active="false"]`).first();
    await expect(idle).toBeVisible();
    const rest = await idle.evaluate((el) => getComputedStyle(el).borderTopColor);
    // A framed thumbnail without its frame reads as a floating image, so unlike a
    // colour chip this one is not transparent at rest.
    expect(rest).toBe("rgb(231, 231, 233)"); // light `controlBorder`

    await idle.hover();
    await page.waitForTimeout(SETTLE);
    const hovered = await idle.evaluate((el) => getComputedStyle(el).borderTopColor);
    expect(hovered).not.toBe(rest);

    // And the selected tile carries the accent — with no second ring behind it.
    const selected = page.locator(`${STYLE} .hot-panel-tile[data-active="true"]`).first();
    await expect(selected).toHaveCSS("border-top-color", "rgb(26, 66, 232)");
    await expect(selected).toHaveCSS("box-shadow", "none");
  });
});

test.describe("behaviour survives the restyle", () => {
  test("picking a preset still writes the theme module, and Reset still removes it", async ({ page }) => {
    await openPlayground(page, "light");
    await page.getByRole("button", { name: "Style", exact: true }).click();

    const reset = page.locator(STYLE).getByRole("button", { name: "Reset" });
    await expect(reset).toBeDisabled();

    await page.locator(`${STYLE} .hot-panel-tile`, { hasText: "horizon" }).first().click();
    // The theme lands in the demo as a real file, through the editor's own write
    // path — that is the feature, and it is what a restyle must not disturb.
    await expect(page.locator(".hot-file-row", { hasText: "handsontable-theme" })).toBeVisible();
    await expect(page.locator(STYLE).getByText("Applied to the preview")).toBeVisible();
    await expect(reset).toBeEnabled();

    await reset.click();
    await expect(reset).toBeDisabled();
    await expect(page.locator(`${STYLE} .hot-panel-tile[data-active="true"]`).first()).toContainText("main");
  });
});
