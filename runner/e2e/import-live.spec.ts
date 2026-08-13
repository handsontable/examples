import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { parseJsFiddle } from "../workers/api/src/import-url.js";

// Does a converted fiddle actually *run*? (DEV-2509)
//
// The unit tests pin what the conversion produces; this pins that the produced
// thing boots, which is the failure that was reported: the import looked fine and
// the preview died with `ReferenceError: Handsontable is not defined`.
//
// It runs the real parser over the recorded fixture and feeds the result to a
// stubbed `/api/import`, so it covers conversion *and* execution without needing
// the Worker. Live render — needs the external Sandpack bundler; opt-in via
// E2E_LIVE=1, like the docs-example render checks.
test.describe("live import render", () => {
  test.skip(process.env.E2E_LIVE !== "1", "set E2E_LIVE=1 to run live-render checks");

  test("a fiddle whose libraries came from a CDN boots after conversion", async ({ page }) => {
    // `import.meta.url`, not `__dirname`: the specs are ESM.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const fixture = fs.readFileSync(
      path.join(here, "../pipeline/fixtures/jsfiddle-cdn-globals.html"),
      "utf8",
    );
    const parsed = parseJsFiddle(fixture, "https://jsfiddle.net/1bw9tphk/1/");

    // Sanity, before spending two minutes on a bundler: the conversion happened.
    expect(parsed.files["/script.js"]).toContain("import Handsontable from 'handsontable';");
    expect(parsed.files["/index.html"]).not.toContain("handsontable.full.min.js");

    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await page.route("**/api/versions", (route) =>
      route.fulfill({ json: { latest: "18.0.0", next: "19.0.0-next.1", versions: ["18.0.0"] } }),
    );
    await page.addInitScript(() => sessionStorage.setItem("hot_token", "e2e-token"));
    await page.route("**/broker/userinfo", (route) =>
      route.fulfill({ json: { email: "dev@handsontable.com" } }),
    );
    await page.route("**/api/import", (route) =>
      route.fulfill({
        json: { provider: "jsfiddle", framework: "javascript", ...parsed },
      }),
    );

    await page.goto("/?import=https%3A%2F%2Fjsfiddle.net%2F1bw9tphk%2F1%2F");
    await expect(
      page.getByRole("region", { name: "Files" }).locator('button[title="/script.js"]'),
    ).toBeVisible();

    // The preview is cross-origin, so its own status attribute is the only
    // readable signal — the same one the starter matrix polls. `error` here is
    // what the bug looked like.
    const pane = page.locator("[data-preview-status]");
    await expect
      .poll(() => pane.getAttribute("data-preview-status"), {
        timeout: 180_000,
        intervals: [2000],
      })
      .toBe("ready");

    // Nothing threw in the host page either (the sandbox's own errors surface as
    // console noise from its origin, not as page errors here).
    expect(errors, errors.join("\n")).toHaveLength(0);
  });
});
