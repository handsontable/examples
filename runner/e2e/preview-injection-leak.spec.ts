import { test, expect, type FrameLocator, type Page } from "@playwright/test";
import { previewReady } from "./helpers";

// Does anything the runner injects reach the preview as visible page text? (DEV-2724)
//
// Reported on `/share/:id`: the preview panel rendered the whole monitor reporter —
// source, comments, `window.__hotRunnerMonitor`, the DEV ticket numbers in its
// comments — as a wall of plain unstyled text above the demo's own output.
//
// The cause was the injection *point*, not the reporter. The classic bundler renders
// the demo's `<body>` inside its own document shell and slices that body out with
// `/<body.*>([\s\S]*)<\/body>/m` before assigning it as markup. `.` stops at a
// newline but `.*` is greedy, so the match ran to the last `>` on the `<body>` line —
// which, once a receiver was inserted right after `<body>`, was our own `<script>`'s.
// The open tag was eaten by the match and the source became the body's first text
// node. `insertInjectedTag` now goes *before* `<body>` when a document has no
// `<head>`, which is the only shape that reached that branch — and the shape
// `create_demo` writes.
//
// Live — needs the real Sandpack bundler, so it is opt-in like the other render
// checks, and `stubShell` is deliberately not used (it aborts the bundler hosts,
// which leaves no preview document to read):
//
//   E2E_LIVE=1 pnpm e2e e2e/preview-injection-leak.spec.ts
//
// No deterministic variant can exist: the mangling happens inside the bundler's own
// document shell. The unit-level guard is `pipeline/inject-html.test.mjs`, which runs
// the bundler's regex verbatim over the injected document; this spec is the oracle
// for what the visitor actually sees.

const PAYLOAD_ID = "lk9x3d7q22";

const TITLE = "beforeKeyDown returning false";

/** The reported shape: no `<head>`, and `<body>` alone on its line. A starter's
 *  `index.html` has a `<head>`, which is why every starter looked fine while a published
 *  demo did not. One of two shapes `create_demo` emitted — the other is a bare fragment
 *  with no `<script>` at all, which rendered nothing anywhere (DEV-2741,
 *  `preview-entry-script.spec.ts`). */
const HEADLESS_HTML = `<!doctype html>
<html>
  <body>
    <h3>${TITLE}</h3>
    <p id="status">Press Enter on a selected cell.</p>
    <div id="grid" style="height: 300px; width: 500px;"></div>
    <script type="module" src="/index.js"></script>
  </body>
</html>
`;

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
  title: "Injection leak demo",
  files: {
    "/index.html": HEADLESS_HTML,
    "/index.js": DEMO_JS,
    "/package.json": JSON.stringify({ dependencies: { handsontable: "18.0.0" } }, null, 2),
  },
};

const preview = (page: Page): FrameLocator => page.frameLocator("iframe").first();

/** Fragments that only ever appear in code the *runner* injects — the prelude, both
 *  receivers' globals, and their shared marker. None of them belongs in the demo's
 *  own sources above, so any of them showing up as rendered text is the bug. */
const INJECTED_FRAGMENTS = [
  "document.currentScript",
  "__hotRunnerMonitor",
  "__hotRunnerScheme",
  "hot-runner-monitor",
  "hot-runner-scheme",
];

test.describe("the runner's injected scripts never render as page text", () => {
  test.skip(process.env.E2E_LIVE !== "1", "set E2E_LIVE=1 to run live-render checks");
  // Same budget as the sibling live specs: a cold bundler spends more than the 60s
  // config default inside `previewReady` alone, and a generic "Test timeout exceeded"
  // would replace whatever this spec measured.
  test.describe.configure({ timeout: 300_000 });

  test("a demo whose index.html has no <head> shows only its own output", async ({ page }) => {
    await page.route("**/api/versions", (route) =>
      route.fulfill({ json: { latest: "18.0.0", next: "19.0.0-next.1", versions: ["18.0.0"] } }),
    );
    await page.route("**/broker/userinfo", (route) => route.fulfill({ status: 401, json: {} }));
    await page.route(`**/api/payload/${PAYLOAD_ID}`, (route) => route.fulfill({ json: PAYLOAD }));

    await page.goto(`/?payload=${PAYLOAD_ID}`);
    await previewReady(page);

    const heading = preview(page).getByRole("heading", { name: TITLE });
    await expect(heading).toBeVisible({ timeout: 120_000 });

    const text: string = await heading.evaluate(() => document.body.innerText);

    for (const fragment of INJECTED_FRAGMENTS) {
      expect(
        text.includes(fragment),
        `"${fragment}" is rendered as page text — the injected script was mangled into a text node`,
      ).toBe(false);
    }
    // The demo's own output is the other half of the assertion: a preview that renders
    // nothing at all would pass every check above.
    expect(text).toContain(TITLE);
    await expect(preview(page).locator(".handsontable").first()).toBeVisible({ timeout: 120_000 });
  });
});
