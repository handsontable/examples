import { test, expect, type FrameLocator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { previewReady, workspaceFiles } from "./helpers";

// Does the demo's own `<head>` reach the live preview? (DEV-2576)
//
// The classic bundler renders the demo's `<body>` inside its own document shell and
// discards the authored `<head>`. Measured on `master`, inside the preview document:
// `document.title` is "Sandbox - CodeSandbox", there are no stylesheet links, and a
// grid that gets its theme from a CDN `<link>` renders core-only — `--ht-*`
// undefined, cell padding `0px`. The static `/d/:id` build, which serves the real
// HTML, is correct. So this is bundler behaviour, and no unit test can see it: the
// oracle has to be a real mount.
//
// Live — needs the Sandpack bundler; opt-in via E2E_LIVE=1 like the other render
// checks. `stubShell` is deliberately NOT used: it aborts both bundler hosts, which
// leaves no preview document to measure, so a deterministic variant of this spec
// cannot exist.
//
//   E2E_LIVE=1 pnpm e2e e2e/preview-head-assets.spec.ts
//
// The fixture is the same file `pipeline/head-assets.test.mjs` extracts from, so the
// unit test and this one cannot drift apart on what a head contains. Its theme CSS
// arrives *only* through the head — the stock starters all import their CSS from JS,
// which is why `?example=javascript` would be a hollow test here.

const PAYLOAD_ID = "hd7k2q9x41";

const here = path.dirname(fileURLToPath(import.meta.url));
const HEAD_FIXTURE = fs.readFileSync(path.join(here, "../pipeline/fixtures/head-assets-demo.html"), "utf8");

const CDN_THEME = "https://cdn.jsdelivr.net/npm/handsontable@18/styles/ht-theme-main.min.css";

const DEMO_JS = `import Handsontable from 'handsontable';

// What a styled demo actually does, and the DEV-2581 regression in one line: this
// runs *before* the injected head assets are re-created, and it overrides the theme
// on the same selector the theme itself uses. Equal specificity, so whichever lands
// later wins — appending the re-created stylesheet erased this.
const override = document.createElement('style');
override.textContent = '.ht-theme-main { --ht-cell-vertical-padding: 11px }';
document.head.appendChild(override);

new Handsontable(document.getElementById('grid'), {
  data: [['a', 1], ['b', 2], ['c', 3]],
  colHeaders: true,
  rowHeaders: true,
  themeName: 'ht-theme-main',
  licenseKey: 'non-commercial-and-evaluation',
});
`;

const PAYLOAD = {
  framework: "javascript",
  title: "Head assets demo",
  files: {
    "/index.html": HEAD_FIXTURE,
    "/index.js": DEMO_JS,
    "/styles.css": "#grid { outline: 3px solid rgb(1, 2, 3) }\n",
    "/package.json": JSON.stringify({ dependencies: { handsontable: "18.0.0" } }, null, 2),
  },
};

const preview = (page: Page): FrameLocator => page.frameLocator("iframe").first();
const grid = (page: Page) => preview(page).locator(".handsontable").first();

/** Everything the preview document says about the head, read in one hop. */
function readHead(page: Page) {
  return grid(page).evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const wrapper = document.querySelector("[class*='ht-theme-']");
    const cell = document.querySelector(".handsontable td");
    return {
      title: document.title,
      stylesheets: [...document.querySelectorAll("link[rel=stylesheet]")].map((l) => (l as HTMLLinkElement).href),
      inlineSentinel: root.getPropertyValue("--e2e-head-sentinel").trim(),
      dataSentinel: root.getPropertyValue("--e2e-data-sentinel").trim(),
      localRule: (() => {
        const box = document.getElementById("grid");
        return box ? getComputedStyle(box).outlineColor : "";
      })(),
      themeVar: wrapper ? getComputedStyle(wrapper).getPropertyValue("--ht-cell-vertical-padding").trim() : "",
      cellPadding: cell ? getComputedStyle(cell).padding : "",
      // Every viewport meta, not the first: the bundler's own shell already ships one
      // ("width=device-width,initial-scale=1"), so the authored one is necessarily a
      // second node. What this change owns is that it reaches the document at all.
      viewports: [...document.querySelectorAll('meta[name="viewport"]')].map((m) => ({
        content: m.getAttribute("content"),
        ours: m.hasAttribute("data-hot-runner-head"),
      })),
      preloads: [...document.querySelectorAll('link[rel=preload][as=style]')].map((l) => (l as HTMLLinkElement).href),
      localIcons: [...document.querySelectorAll("link[rel=icon]")]
        .map((l) => l.getAttribute("href"))
        .filter((href) => href === "/favicon.svg"),
    };
  });
}

/**
 * Wait until the re-created head has finished loading before reading it.
 *
 * The stylesheets are cross-origin `<link>`s, so they land some time after the grid
 * becomes visible — reading immediately made this spec flake (measured: one run in
 * three saw `links=0`). Polling the observable end state is the fix; a fixed sleep
 * would either flake again or slow every run to the worst case.
 */
async function headSettled(page: Page) {
  await expect
    .poll(
      async () => {
        const head = await readHead(page);
        // Non-zero cell padding is the honest "the theme stylesheet applied" signal.
        // `themeVar !== ""` is not: the demo's own override sets that variable
        // synchronously, so it is already non-empty while the cross-origin sheet is
        // still in flight — a readiness check that passes before the thing under test
        // has happened, which then fails a later assertion for the wrong reason.
        const themed = head.stylesheets.length > 0 && !head.cellPadding.startsWith("0px");
        return themed
          ? "ready"
          : `pending: links=${head.stylesheets.length} padding=${head.cellPadding}`;
      },
      { timeout: 30_000, message: "the re-created head never finished loading" },
    )
    .toBe("ready");
}

test.describe("head assets reach the live preview", () => {
  test.skip(process.env.E2E_LIVE !== "1", "set E2E_LIVE=1 to run live-render checks");
  // The config default is 60s, and the waits inside one test already allow more than
  // that on a cold bundler: `previewReady` 120s, the grid 120s, `headSettled` 30s. At
  // 60s the test aborts with Playwright's generic "Test timeout exceeded" *before*
  // those waits can report what they measured — the least informative failure wins.
  // Same budget as `preview-scheme.spec.ts`, the closest sibling.
  test.describe.configure({ timeout: 300_000 });

  test("a demo styled only from its <head> renders themed", async ({ page }) => {
    await page.route("**/api/versions", (route) =>
      route.fulfill({ json: { latest: "18.0.0", next: "19.0.0-next.1", versions: ["18.0.0"] } }),
    );
    await page.route("**/broker/userinfo", (route) => route.fulfill({ status: 401, json: {} }));
    await page.route(`**/api/payload/${PAYLOAD_ID}`, (route) => route.fulfill({ json: PAYLOAD }));

    // The CDN stylesheet is deliberately NOT stubbed: the bundler serves the sandbox
    // through a service worker, which Playwright does not intercept by default, so a
    // swallowed route would fail this spec for a reason that is not the feature. The
    // `data:` stylesheet and the inline <style> in the same head are the
    // network-independent companions — on `master` all three are missing alike.
    await page.goto(`/?payload=${PAYLOAD_ID}`);
    await previewReady(page);
    await expect(grid(page)).toBeVisible({ timeout: 120_000 });

    await headSettled(page);
    const head = await readHead(page);

    // Each of these is zero/empty on `master`; the message carries the measurement so
    // a red run says what it saw.
    expect(head.title, `measured title: ${JSON.stringify(head.title)}`).toBe("Head assets demo");
    expect(head.stylesheets, `measured stylesheets: ${head.stylesheets.length}`).toContain(CDN_THEME);
    expect(head.inlineSentinel, "the authored inline <style> reached the document").toBe("7px");
    expect(head.dataSentinel, "a data: stylesheet reached the document").toBe("9px");
    expect(
      head.viewports.filter((m) => m.ours).map((m) => m.content),
      `measured viewport metas: ${JSON.stringify(head.viewports)}`,
    ).toEqual(["width=device-width, initial-scale=1.0"]);
    expect(head.preloads.length, "the absolute preload link is carried").toBe(1);

    // The theme is the point: assert it resolved at all, and that cells got the
    // padding a theme brings, rather than pinning literals the deployed theme is free
    // to change. `""` and `0px` are exactly the broken state, so they must not pass.
    expect(head.themeVar, `measured --ht-cell-vertical-padding: ${JSON.stringify(head.themeVar)}`).not.toBe("");
    expect(head.cellPadding, `measured td padding: ${head.cellPadding}`).not.toBe("0px");
    expect(head.cellPadding).toMatch(/^[1-9]/);

    // DEV-2581: the demo's own override, applied at runtime before the head was
    // re-created, still wins. `4px` here means the re-created theme stylesheet landed
    // after it and took the cascade — the state measured on prod for 6z5k1q2bd4,
    // where the demo's blue/white palette was replaced by the theme's defaults.
    expect(head.themeVar, "the demo's own theme override survives the re-created head").toBe("11px");
  });

  test("what the bundler already handles is not touched, and the workspace stays clean", async ({ page }) => {
    await page.route("**/api/versions", (route) =>
      route.fulfill({ json: { latest: "18.0.0", next: "19.0.0-next.1", versions: ["18.0.0"] } }),
    );
    await page.route("**/broker/userinfo", (route) => route.fulfill({ status: 401, json: {} }));
    await page.route(`**/api/payload/${PAYLOAD_ID}`, (route) => route.fulfill({ json: PAYLOAD }));

    await page.goto(`/?payload=${PAYLOAD_ID}`);
    await previewReady(page);
    await expect(grid(page)).toBeVisible({ timeout: 120_000 });

    await headSettled(page);
    const head = await readHead(page);

    // A local stylesheet already applies today — the bundler resolves the local URL
    // through the module graph — which is why the injector leaves it alone. If this
    // ever regresses to `rgb(0, 0, 0)`, the "leave it to the bundler" decision is what
    // has to change.
    expect(head.localRule, "the local ./styles.css rule still applies").toBe("rgb(1, 2, 3)");

    // Exactly one link per authored href: the payload skips a stylesheet the document
    // already has, so nothing double-loads on a template that keeps the head.
    const themeLinks = head.stylesheets.filter((href) => href === CDN_THEME);
    expect(themeLinks.length, "no duplicate theme stylesheet").toBe(1);

    // A local <link rel=icon> is dropped on purpose: every local URL answers with the
    // bundler's own SPA shell, so re-creating it would render an HTML document.
    expect(head.localIcons.length, "no re-created local icon").toBe(0);

    // The authored map is what Download-zip, fork and the exports read, and what the
    // static `/d/:id` build serves. The injection must not be in it.
    const files = await workspaceFiles(page);
    expect(files["/index.js"], "the workspace copy carries no runner plumbing").not.toContain("hot-runner-head");
  });
});
