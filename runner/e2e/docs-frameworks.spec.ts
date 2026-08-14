import { test, expect } from "@playwright/test";
import { expectGridRendered, isKnownNoise, previewReady, trackSessions } from "./helpers";

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
// per-example walk — the 1261-entry bucket belongs to the manifest tests and
// the import pipeline. Fixture: the context-menu guide (react + vue variants
// in every bucket) and the accessibility guide's Angular example.

const REACT_DOCS = "/?docs=guides/accessories-and-menus/context-menu/react/example1.tsx&v=18.0.0";
const ANGULAR_DOCS = "/?docs=guides/accessibility/accessibility/angular/example1.ts&v=18.0.0";

test.describe("docs examples on the container engine", () => {
  test.skip(process.env.E2E_LIVE !== "1", "set E2E_LIVE=1 to run live-render checks");
  test.skip(!process.env.E2E_BASE_URL, "containers need a deployed API origin — vite preview has no /api proxy");
  test.describe.configure({ timeout: 300_000 });

  test("switching a docs example to Vue renders the Vue variant in a container", async ({ page, request }) => {
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

  // KNOWN DEFECT, found by this spec's first prod run (2026-08-14): the Angular
  // docs container renders, but its HMR websocket never connects — the proxy
  // answers the `wss://4200-angular-….demos.handsontable.com` handshake with a
  // 400, Vite falls back to `wss://localhost:4200` (refused) and gives up. The
  // Vue docs container on the same proxy connects fine. User-visible as "an
  // edit to an Angular docs example only shows after a manual reload" — the
  // DEV-2216 symptom class. Filtered here so the render coverage stays live;
  // the fixme below is the assertion that should hold once the proxy is fixed.
  const ANGULAR_HMR_DEFECT = [
    /WebSocket connection to 'wss:\/\/.*' failed/,
    /\[vite\] failed to connect to websocket/,
  ];

  test("an Angular docs example renders", async ({ page, request }) => {
    const consoleErrors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });

    const tracked = trackSessions(page);
    try {
      await page.goto(ANGULAR_DOCS);
      await previewReady(page, "container");
      await expectGridRendered(page);

      // Angular's dev server is the only one that type-checks, so a broken
      // generated file fails *silently* by serving the last good bundle
      // (DEV-2216) — a clean console is part of "it rendered".
      const real = consoleErrors.filter(
        (e) => !isKnownNoise(e) && !ANGULAR_HMR_DEFECT.some((re) => re.test(e)),
      );
      expect(real, `console errors:\n${real.join("\n")}`).toEqual([]);
    } finally {
      await tracked.cleanup(request);
    }
  });

  test.fixme(
    "the Angular docs container's HMR websocket connects",
    async () => {
      // Un-fixme together with removing ANGULAR_HMR_DEFECT above: open
      // ANGULAR_DOCS, wait for ready, and assert no console line matches
      // either defect pattern. Until the proxy accepts the Angular dev
      // server's websocket upgrade, that assertion fails on production.
    },
  );
});
