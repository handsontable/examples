import { defineConfig, devices } from "@playwright/test";

// E2E for the authoring app. By default runs against a local `vite preview` of
// the built app; set E2E_BASE_URL to test a deployed URL (e.g. prod). The
// live-render tests (which need the external Sandpack bundler) only run when
// E2E_LIVE=1 — kept off by default so PR CI stays deterministic.
const baseURL = process.env.E2E_BASE_URL || "http://localhost:4173";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL, trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Start a local preview only when not pointing at an external URL.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "pnpm --filter @handsontable/demo-authoring preview -- --port 4173 --strictPort",
        url: "http://localhost:4173",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
