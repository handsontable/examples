import { test, expect } from "@playwright/test";
import {
  currentDocsRelease,
  expectGridRendered,
  isKnownNoise,
  previewReady,
  trackSessions,
} from "./helpers";

// The docs-example paths that need a container (DEV-2203).
//
// docs-examples.spec.ts renders JavaScript, TypeScript and React guide
// examples live — all Sandpack. But a docs *Vue* or *Angular* example runs in
// a real container (config/frameworks.json gives both engine: "container" for
// docs imports), so until now the two wrappers most likely to break on a
// container image change had no live docs coverage at all.
//
// Two boots, no more. The pool holds five global slots shared with real
// traffic, so this spec must run with --workers=1 and never grows a
// per-example walk — the bucket's ~1500 entries belong to the manifest tests
// and the import pipeline. Fixture: the context-menu guide (react + vue
// variants in every bucket) and the accessibility guide's Angular example.
//
// The version is resolved from the newest imported release bucket, not restated
// here (DEV-2736). A literal `v=18.0.0` survived the 18.1 import silently: these
// tests assert nothing about the bucket, so instead of going red the way #283's
// did, they kept passing while the only container-engine coverage the Vue and
// Angular docs wrappers have drifted onto the previous release line.
const { version: DOCS_VERSION } = currentDocsRelease();

const REACT_DOCS = `/?docs=guides/accessories-and-menus/context-menu/react/example1.tsx&v=${DOCS_VERSION}`;
const ANGULAR_DOCS = `/?docs=guides/accessibility/accessibility/angular/example1.ts&v=${DOCS_VERSION}`;

test.describe("docs examples on the container engine", () => {
  test.skip(process.env.E2E_LIVE !== "1", "set E2E_LIVE=1 to run live-render checks");
  test.skip(!process.env.E2E_BASE_URL, "containers need a deployed API origin — vite preview has no /api proxy");
  test.describe.configure({ timeout: 300_000 });

  test("switching a docs example to Vue renders the Vue variant in a container", async ({ page, request }) => {
    // Two engines in sequence: a Sandpack ready (up to 120s) *and then* a
    // container ready (240s) plus the grid poll — the shared 300s describe
    // budget fits a single boot, not both (Bugbot, #184).
    test.setTimeout(480_000);
    const tracked = trackSessions(page);
    try {
      await page.goto(REACT_DOCS);
      await previewReady(page, "sandpack");

      // The Framework menu labels options with the docs display name — match
      // by prefix so "Vue 3" does not couple this test to the exact wording.
      await page.getByRole("button", { name: "Framework", exact: true }).click();
      await page.getByRole("option", { name: /^Vue/ }).click();
      await expect(page).toHaveURL(/docs=guides%2Faccessories-and-menus%2Fcontext-menu%2Fvue%2F/);

      await previewReady(page, "container");
      await expectGridRendered(page);
    } finally {
      await tracked.cleanup(request);
    }
  });

  test("an Angular docs example renders, and its HMR websocket connects", async ({ page, request }) => {
    const consoleLines: string[] = [];
    page.on("console", (m) => consoleLines.push(`${m.type()}: ${m.text()}`));

    const tracked = trackSessions(page);
    try {
      await page.goto(ANGULAR_DOCS);
      await previewReady(page, "container");
      await expectGridRendered(page);

      // The HMR socket must be *connected*, not merely quiet: this spec's
      // first prod run found the proxy refusing the `vite-hmr` upgrade with a
      // 400 (vite gates it on `server.allowedHosts`; fixed by DEV-2541), and
      // the defect stayed invisible for three days precisely because the page
      // rendered and only the console knew. A boot that never reaches the HMR
      // client at all would silently pass an errors-only check the same way.
      await expect(async () => {
        expect(
          consoleLines.some((l) => /\[vite\] connected/.test(l)),
          "the dev server's HMR client reported [vite] connected",
        ).toBe(true);
      }).toPass({ timeout: 60_000 });

      // Angular's dev server is the only one that type-checks, so a broken
      // generated file fails *silently* by serving the last good bundle
      // (DEV-2216) — a clean console is part of "it rendered".
      const real = consoleLines.filter((l) => l.startsWith("error:")).filter((e) => !isKnownNoise(e));
      expect(real, `console errors:\n${real.join("\n")}`).toEqual([]);
    } finally {
      await tracked.cleanup(request);
    }
  });
});
