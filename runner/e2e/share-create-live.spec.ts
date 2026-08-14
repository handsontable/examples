import { test, expect } from "@playwright/test";

// The authed share round-trip, for real (DEV-2203): create → build → view →
// revoke, against a deployed worker. Everything else about sharing is proved
// with stubs (authed-actions.spec.ts) or read-only against a fixture
// (share-view.spec.ts); this is the one test that exercises the builder, R2
// and D1 end to end.
//
// It needs a real broker token — there is no test bypass in the deployed
// worker, by design (auth.ts re-validates every bearer against the broker and
// requires @handsontable.com). Broker tokens are per-user session JWTs with an
// expiry and no programmatic mint path, so the token arrives as a secret you
// refresh by hand when you want this to run:
//
//   1. Sign in on the deployed app, then in the console: sessionStorage.hot_token
//   2. E2E_BROKER_TOKEN=<that> E2E_BASE_URL=https://demos.handsontable.com \
//        pnpm e2e e2e/share-create-live.spec.ts --workers=1
//
// Cost and hygiene: one BuilderSandbox boot (pool of 3, shared) and one D1
// row per run. The revoke in `finally` is both the cleanup and the last
// assertion — a revoked share must answer 410, and rows are soft-deleted so
// the worst-case leak is one revoked row.

const TOKEN = process.env.E2E_BROKER_TOKEN;

test("a demo shared today is a page a client can open — until it is revoked", async ({ page, request, baseURL }) => {
  test.skip(!process.env.E2E_BASE_URL, "needs a deployed API origin");
  test.skip(!TOKEN, "set E2E_BROKER_TOKEN to a fresh sessionStorage.hot_token from a signed-in session");
  test.setTimeout(420_000);

  // The real token, the real broker, no stubs.
  await page.addInitScript((token) => sessionStorage.setItem("hot_token", token), TOKEN!);

  let demoId: string | null = null;
  try {
    await page.goto("/?example=react");
    // Fork appearing in the top bar is the signed-in signal — assert it before
    // acting, so an expired token reads as "token expired", not a dead button.
    await expect(
      page.getByRole("button", { name: "Fork", exact: true }),
      "no authed top bar — is E2E_BROKER_TOKEN expired?",
    ).toBeVisible({ timeout: 30_000 });

    // Share mints a demo: POST /api/demos runs a real container build and
    // only then hands back links, so the dialog opening means "built".
    await page.getByRole("button", { name: "Share this demo" }).click();
    const dialog = page.getByRole("dialog", { name: "Share this demo" });
    await expect(dialog).toBeVisible({ timeout: 300_000 });

    const clientLink = await dialog.getByLabel(/client link/i).inputValue();
    demoId = new URL(clientLink).pathname.split("/").filter(Boolean).pop() ?? null;
    expect(demoId, `a demo id in the dialog's client link (got: ${clientLink})`).toBeTruthy();

    // The built page renders for an anonymous client (fresh context state not
    // needed — /d is public and static, cookies play no part).
    await page.goto(`/d/${demoId}/`);
    await expect
      .poll(async () => page.locator(".handsontable .htCore td").count(), { timeout: 60_000 })
      .toBeGreaterThan(0);
  } finally {
    if (demoId) {
      // Revoke is the cleanup *and* the final assertion.
      const del = await request.delete(`${baseURL}/api/demos/${demoId}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(del.status(), "the owner can revoke their own demo").toBe(204);
      const after = await request.get(`${baseURL}/d/${demoId}/`);
      expect(after.status(), "a revoked share answers 410, not a stale page").toBe(410);
    }
  }
});
