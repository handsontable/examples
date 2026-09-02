import { test, expect, type FrameLocator, type Page } from "@playwright/test";
import { previewReady } from "./helpers";

// Does a demo whose `index.html` carries no `<script>` still build its grid? (DEV-2741)
//
// Reported as a `/share/:id` regression after the DEV-2724 deploy; it was neither. Two
// production demos — `/share/6n1lu5k2s3` (published the same morning) and
// `/share/6ri5be5l28` (published the day *before* the deploy) — rendered a bare
// `<div id="grid">` and nothing else, and their `/d/:id/` artifacts were markup with no
// bundle in them. Both had been stored by `create_demo` with `/index.html` =
// `<div id="grid" …></div>` alone.
//
// Nothing has a fallback for that. `resolveSandboxEntry` makes the HTML file the sandbox
// entry for every parcel example, and the bundler's HTML transpiler derives the module
// graph from its `<script src>` tags; `vite build` reads the same document on the `/d`
// path. Measured inside the live preview frame: `window.__hotRunnerMonitor` and
// `window.__hotRunnerScheme` were both undefined and `document.styleSheets.length` was
// `0` — proof that the module entry, where `withInjections` also writes both receivers,
// never executed at all.
//
// The write gate refuses that payload now (`validateHtmlEntry`) and stored demos are
// repaired when their source is read (`repairEntryScript`). This spec is the oracle for
// the visitor: given the reported document, the grid builds.
//
// Live — needs the real Sandpack bundler, so it is opt-in like the other render checks,
// and `stubShell` is deliberately not used (it aborts the bundler hosts, which leaves no
// preview to read):
//
//   E2E_LIVE=1 pnpm e2e e2e/preview-entry-script.spec.ts
//
// Note what is NOT asserted: `data-preview-status`. It read `ready` over every one of
// the blank previews measured above — the status attribute is not an oracle for this.

const PAYLOAD_ID = "q4m7v2x811";

const TITLE = "Entry script repair";

/** The reported shape, verbatim: no document scaffolding and no `<script>` at all. */
const FRAGMENT_HTML = `<h3>${TITLE}</h3>\n<div id="grid" style="height: 300px; width: 500px;"></div>\n`;

const DEMO_JS = `import Handsontable from 'handsontable';
import 'handsontable/styles/handsontable.css';
import 'handsontable/styles/ht-theme-main.css';

new Handsontable(document.getElementById('grid'), {
  data: [['Tesla', 2017], ['Nissan', 2018], ['Volvo', 2020]],
  colHeaders: ['Car', 'Year'],
  rowHeaders: true,
  height: 300,
  licenseKey: 'non-commercial-and-evaluation',
});
`;

const PAYLOAD = {
  framework: "javascript",
  title: "Entry script demo",
  files: {
    "/index.html": FRAGMENT_HTML,
    "/index.js": DEMO_JS,
    "/package.json": JSON.stringify({ dependencies: { handsontable: "18.0.0" } }, null, 2),
  },
};

const preview = (page: Page): FrameLocator => page.frameLocator("iframe").first();

test.describe("a demo whose index.html loads no module still renders", () => {
  test.skip(process.env.E2E_LIVE !== "1", "set E2E_LIVE=1 to run live-render checks");
  // Same budget as the sibling live specs: a cold bundler spends more than the 60s
  // config default inside `previewReady` alone, and a generic "Test timeout exceeded"
  // would replace whatever this spec measured.
  test.describe.configure({ timeout: 300_000 });

  test("the grid builds from a script-less index.html", async ({ page }) => {
    await page.route("**/api/versions", (route) =>
      route.fulfill({ json: { latest: "18.0.0", next: "19.0.0-next.1", versions: ["18.0.0"] } }),
    );
    await page.route("**/broker/userinfo", (route) => route.fulfill({ status: 401, json: {} }));
    await page.route(`**/api/payload/${PAYLOAD_ID}`, (route) => route.fulfill({ json: PAYLOAD }));

    await page.goto(`/?payload=${PAYLOAD_ID}`);
    await previewReady(page);

    // The demo's own markup reaching the page proves only that the document was
    // rendered — which it always was. The grid is the assertion.
    await expect(preview(page).getByRole("heading", { name: TITLE })).toBeVisible({
      timeout: 120_000,
    });
    await expect(preview(page).locator(".handsontable").first()).toBeVisible({
      timeout: 120_000,
    });

    // The second oracle, and the one that fails unambiguously: both receivers are
    // injected into the *module* entry, so either global being undefined means the
    // module never ran — the exact measurement taken on the two broken production
    // demos.
    const ranTheModule = await preview(page)
      .locator("#grid")
      .evaluate(() => Boolean((window as unknown as { __hotRunnerScheme?: boolean }).__hotRunnerScheme));
    expect(ranTheModule, "the entry module never executed").toBe(true);
  });
});
