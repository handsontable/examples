import { test, expect } from "@playwright/test";

// The share viewer, read from the outside (DEV-2203).
//
// `/d/:id` is what a client actually receives when someone shares a demo: a
// prebuilt static page served from R2 by the API worker, framed by `/share`
// and `/embed`. Everything the app-side specs prove happens *before* this
// point — `authed-actions.spec.ts` stubs `/api/demos` and never leaves the
// SPA. Nothing exercised the deployed contract: the redirect, the frame
// policies that make `/embed` docs-only, and the promise that a share never
// leaks its source snapshot.
//
// Read-only on purpose. These tests hit a permanent fixture demo, so they run
// against production with zero containers, zero writes and zero flake budget —
// cheap enough for the post-deploy smoke. The authed write path (create →
// build → view → revoke) is `share-create-live.spec.ts`, which needs a real
// broker token and is gated separately.
//
//   E2E_BASE_URL=https://demos.handsontable.com pnpm e2e e2e/share-view.spec.ts
//
// FIXTURE_ID names a demo that must keep existing. `r-react-18-0-0` is the
// IT-540 launch-verification share; if it is ever revoked, mint a replacement
// titled "E2E fixture — do not revoke" from any signed-in session and update
// the constant (see AGENTS.md § E2E).

const FIXTURE_ID = "r-react-18-0-0";

test.describe("share viewer — /d and /embed", () => {
  test.skip(!process.env.E2E_BASE_URL, "needs a deployed API origin — vite preview has no /api or /d routes");

  test("the built demo renders for an anonymous viewer", { tag: "@smoke" }, async ({ page }) => {
    // The static page is the demo itself — no editor shell, no preview iframe.
    await page.goto(`/d/${FIXTURE_ID}/`);
    await expect
      .poll(async () => page.locator(".handsontable .htCore td").count(), { timeout: 30_000 })
      .toBeGreaterThan(0);
  });

  test("the slashless URL redirects permanently instead of serving a copy", async ({ request, baseURL }) => {
    const res = await request.get(`${baseURL}/d/${FIXTURE_ID}`, { maxRedirects: 0 });
    expect(res.status()).toBe(308);
    expect(res.headers()["location"]).toContain(`/d/${FIXTURE_ID}/`);
  });

  test("the viewer is frame-locked to itself", async ({ request, baseURL }) => {
    const res = await request.get(`${baseURL}/d/${FIXTURE_ID}/`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-security-policy"]).toContain("frame-ancestors 'self'");
    expect(res.headers()["x-frame-options"]).toBe("SAMEORIGIN");
    // HTML must revalidate so a re-shared id can never serve a stale build.
    expect(res.headers()["cache-control"]).toContain("must-revalidate");
  });

  test("the embed is docs-only: handsontable.com may frame it, nobody may fetch it cross-origin", async ({
    request,
    baseURL,
  }) => {
    const res = await request.get(`${baseURL}/embed/${FIXTURE_ID}/`);
    expect(res.status()).toBe(200);
    const csp = res.headers()["content-security-policy"] ?? "";
    expect(csp).toContain("frame-ancestors");
    expect(csp).toContain("https://handsontable.com");
    expect(csp).toContain("https://*.handsontable.com");
    // `frame-ancestors` with an allowlist is incompatible with X-Frame-Options —
    // the worker must not send both, or the stricter header wins in old engines.
    expect(res.headers()["x-frame-options"]).toBeUndefined();
    // /embed is deliberately outside the cors() wrap: framing is allowed,
    // fetching from another origin is not.
    expect(res.headers()["access-control-allow-origin"]).toBeUndefined();
  });

  test("the source snapshot behind a share is never served", async ({ request, baseURL }) => {
    // __source.json sits in R2 next to the built assets; the worker refuses
    // any `__`-prefixed segment so the un-built files cannot leak.
    const res = await request.get(`${baseURL}/d/${FIXTURE_ID}/__source.json`);
    expect(res.status()).toBe(404);
  });

  test("an unknown id is a 404, not an error page with a 200 on it", async ({ request, baseURL }) => {
    const res = await request.get(`${baseURL}/d/zzzznope00/`);
    expect(res.status()).toBe(404);
  });
});
