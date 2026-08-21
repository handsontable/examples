import { test, expect, type Locator, type Page } from "@playwright/test";

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

/** Composite `fg` (which may be translucent, or fully transparent) over `bg`,
 *  giving the colour a glyph on top of `fg` is actually read against. Alpha on
 *  the *text* is out of scope — nothing here paints any. */
function over(fg: string, bg: string) {
  const parts = (s: string) => (s.match(/[\d.]+/g) ?? []).map(Number);
  const f = parts(fg);
  const b = parts(bg);
  const a = f.length > 3 ? f[3]! : 1;
  if (a === 0) return bg;
  const mix = (i: number) => Math.round(a * f[i]! + (1 - a) * b[i]!);
  return `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`;
}

/** WCAG contrast between two colours already in hand.
 *
 *  Distinct from `contrast(page, selector)` below, which finds the background by
 *  walking up to the first fill with a non-zero alpha. That is right for an
 *  opaque control on a drawer and wrong for a translucent chip: it would stop at
 *  the chip's own `rgba(255, 255, 255, 0.16)` and measure white text against
 *  white rather than against the accent showing through it. Pair this with
 *  `over()` instead, which composites the two. */
function contrastPair(a: string, b: string) {
  const chan = (s: string) => s.match(/\d+/g)!.slice(0, 3).map(Number);
  const lum = (c: number[]) =>
    0.2126 * srgb(c[0]!) + 0.7152 * srgb(c[1]!) + 0.0722 * srgb(c[2]!);
  const [hi, lo] = [lum(chan(a)), lum(chan(b))].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}
function srgb(v: number) {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** `backgroundColor`, `color` and the four border colours of one element, plus
 *  the fill actually behind it — the pairing both defects are visible in.
 *
 *  "Actually behind" means the nearest ancestor that paints something, not the
 *  immediate parent. Most parents here are layout wrappers with no background
 *  of their own, and comparing a border against `rgba(0, 0, 0, 0)` can never
 *  fail — which made the check it exists for pass on the very colour it was
 *  written to catch. */
async function paint(page: Page, target: string | Locator) {
  const locator = typeof target === "string" ? page.locator(target) : target;
  return locator.first().evaluate((el) => {
    const c = getComputedStyle(el);
    let behind: string | null = null;
    for (let n = el.parentElement; n; n = n.parentElement) {
      const fill = getComputedStyle(n).backgroundColor;
      if (fill && fill !== "rgba(0, 0, 0, 0)" && fill !== "transparent") { behind = fill; break; }
    }
    return {
      background: c.backgroundColor,
      color: c.color,
      borderColor: c.borderTopColor,
      parentBackground: behind,
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
    // Transparent by design since the docs-assistant restyle (`.da-input`): the
    // composer is flush with the panel, so what must not be white is the fill
    // actually behind it — the drawer's own `surfaceRaised`.
    expect(textarea.background).toBe("rgba(0, 0, 0, 0)");
    expect(textarea.parentBackground).toBe("rgb(34, 34, 34)");
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

    // The edit box's path chip: `controlBorder`, or it dissolves into the
    // `surfaceMuted` panel it sits on. Selected by its text — the transcript's
    // inline `colWidths` span also matches `${CHAT} code` and renders first in
    // DOM order, so an unscoped `.first()` re-measures the span the loop above
    // already covered and lets the chip's border vanish unnoticed.
    const chipLocator = page.locator(`${CHAT} code`, { hasText: "src/index.tsx" });
    const chip = await paint(page, chipLocator);
    expect(chip.borderColor).toBe("rgb(53, 53, 53)");
    // And the edit box around it — the card the chip sits in — is the other half
    // of the same hairline: same token, same failure mode. By class since the
    // panel moved off inline styles (panels.css).
    const editBox = await paint(page, chipLocator.locator('xpath=ancestor::div[contains(@class, "hot-chat-edit-box")][1]'));
    expect(editBox.borderColor).toBe("rgb(53, 53, 53)");
    expect(editBox.borderColor).not.toBe(editBox.parentBackground);

    // A section divider is one hairline, and a divider the same colour as the
    // surface behind it is the ADR-0026 §5 defect in its purest form — there is
    // nothing else to the element to give it away. Its own parent paints
    // nothing, so this has to measure against the drawer's fill underneath.
    await expect(page.locator(`${CHAT} hr`)).toHaveCount(1);
    const drawn = await paint(page, `${CHAT} hr`);
    expect(drawn.parentBackground, "nothing behind the rule paints").not.toBeNull();
    expect(drawn.borderColor).not.toBe(drawn.parentBackground);
  });

  // The user's own turn, which the answer-surface test above never reaches: it is
  // an accent-filled bubble, and the two inline styles that carry their own colour
  // were still written for the muted surface the bubble replaced. Inline `code`
  // set no `color`, so it inherited `accentContrast` (#ffffff) onto its own
  // `surfaceMuted` chip — white on #f7f7f9 in light; a link was `accentText`,
  // which in light *is* `accent`, so it was the bubble. A question with an option
  // in backticks is the common case, and it came out blank (Bugbot #248).
  //
  // Measured as contrast rather than inequality: the light code defect was
  // #ffffff on #f7f7f9, two colours that are not equal and still unreadable.
  for (const mode of ["light", "dark"] as const) {
    test(`the user bubble keeps inline code and links readable in ${mode}`, async ({ page }) => {
      await openPlayground(page, mode);
      await stubOneAnswer(page);

      await page.getByRole("button", { name: "Ask AI", exact: true }).click();
      await page.locator(`${CHAT} textarea`)
        .fill("what does `colHeaders` do? see [docs](https://handsontable.com)");
      await page.locator(CHAT).getByRole("button", { name: "Send" }).click();

      const bubble = page.locator(`${CHAT} .hot-chat-bubble`).first();
      await expect(bubble).toBeVisible();
      const fill = await bubble.evaluate((el) => getComputedStyle(el).backgroundColor);

      for (const [what, locator] of [
        ["inline code", bubble.locator("code")],
        ["link", bubble.locator("a")],
      ] as const) {
        const paint = await locator.first().evaluate((el) => {
          const cs = getComputedStyle(el);
          return { ink: cs.color, own: cs.backgroundColor };
        });
        // Composited, not measured against the bubble directly. The chip carries
        // its own fill, so what the glyphs sit on is that fill over the accent —
        // and the two states differ only there. The regression paints an *opaque*
        // `surfaceMuted` chip while still inheriting white; its `color` is white
        // either way, so a ratio taken against the bubble clears 4.5 and the
        // defect ships green (Bugbot on db5b9ff6, which is how this read before).
        const behind = over(paint.own, fill);
        expect(contrastPair(paint.ink, behind), `${what} on the bubble`).toBeGreaterThan(4.5);
      }

      // Colour alone cannot mark a link whose only legible colour is the one the
      // surrounding text already uses.
      await expect(bubble.locator("a")).toHaveCSS("text-decoration-line", "underline");
    });
  }

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

    // The whole document of the visible pane — `/src/index.tsx`, the entry and only
    // open tab — read through CodeMirror's own view rather than `.cm-content` text:
    // the view renders the viewport only, so text-based reads of a long file are
    // partial by design. `Chat.apply()`'s label flip and its `applyEdit` call are
    // independent statements, so the labels alone stay green with the write deleted;
    // the doc is the file, and it is what Apply and Undo are supposed to move.
    // TODO(#185): read this through `workspaceFiles()` (`window.__HOT_FILES__`)
    // once that hook lands, instead of CodeMirror internals.
    const doc = () =>
      page
        .locator('[data-pane-active="true"] .cm-content')
        .evaluate((el) => {
          const tile = (el as HTMLElement & { cmTile?: { view: { state: { doc: { toString(): string } } } } }).cmTile;
          if (!tile) throw new Error("CodeMirror's cmTile hook is gone — the doc cannot be read");
          return tile.view.state.doc.toString();
        });

    await page.getByRole("button", { name: "Ask AI", exact: true }).click();
    await page.locator(`${CHAT} textarea`).fill("How do I set column widths?");
    await page.locator(CHAT).getByRole("button", { name: "Send" }).click();
    await expect(page.locator(CHAT).getByRole("button", { name: "Apply" })).toBeVisible();

    // The before-shot Undo must restore, captured only once the answer is in —
    // and provably not already the assistant's version.
    const original = await doc();
    expect(original).not.toBe("// changed\n");

    await page.locator(CHAT).getByRole("button", { name: "Apply" }).click();
    await expect(page.locator(CHAT).getByText("Applied to")).toBeVisible();
    // The file itself took the edit — the label above renders off `turn.undo`
    // and would say "Applied" whether or not anything was written.
    await expect.poll(doc).toBe("// changed\n");

    await page.locator(CHAT).getByRole("button", { name: "Undo" }).click();
    await expect(page.locator(CHAT).getByText("Proposed changes to")).toBeVisible();
    // Byte-identical, not merely different: Undo restores what was there.
    await expect.poll(doc).toBe(original);
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

    // The footer Reset, not a per-row one: the panel body grew its own in DEV-2560.
    const reset = page.locator(STYLE).locator("footer").getByRole("button", { name: "Reset", exact: true });
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

  test("controls prefilled with the preset's values still count as unset", async ({ page }) => {
    // The panel shows resolved preset values instead of empty boxes (DEV-2560),
    // and the trap is storing them: overridden-ness is "is the key present", so a
    // display value that leaked into state would un-pristine every demo and emit
    // the whole catalogue into the generated module. Node cannot render the
    // panel, so this is the assertion that actually covers it.
    await openPlayground(page, "light");
    await page.getByRole("button", { name: "Style", exact: true }).click();

    const panel = page.locator(STYLE);

    // One group at a time — the Foundation sections are an accordion — so the
    // ramp is checked before the density rows, not alongside them.
    await panel.getByRole("button", { name: /^Palette/ }).click();
    // Populated: the brand ramp paints the preset's own blue rather than white.
    await expect(panel.getByLabel("primary.500")).toHaveValue("#1a42e8");

    await panel.getByRole("button", { name: /^Density sizes/ }).click();
    // And a density row reads a measurement, not "theme default".
    await expect(panel.locator('[data-token="cellVertical"]')).toContainText("px");

    // Yet nothing is overridden. The group headers carry a count only once
    // something is, so an exact name is the badge-free assertion — and the
    // footer Reset is dead.
    await expect(panel.getByRole("button", { name: "Palette", exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Density sizes", exact: true })).toBeVisible();
    await expect(panel.locator("footer").getByRole("button", { name: "Reset", exact: true })).toBeDisabled();
  });
});
