import { test, expect } from "@playwright/test";
import { workspaceFiles } from "./helpers";

// The authed share round-trip, for real (DEV-2203): create → build → view →
// revoke, against a deployed worker. Everything else about sharing is proved
// with stubs (authed-actions.spec.ts) or read-only against a fixture
// (share-view.spec.ts); this is the one test that exercises the builder, R2
// and D1 end to end.
//
// It needs a real credential — there is no test bypass in the deployed worker,
// by design (auth.ts requires @handsontable.com on both of its paths). Since
// DEV-2583 that credential is a persistent API token, which does not expire and
// can be minted from the app, so this spec finally runs unattended:
//
//   1. Sign in on the deployed app, go to /api-tokens, mint one, copy it
//   2. E2E_API_TOKEN=<that> E2E_BASE_URL=https://demos.handsontable.com \
//        pnpm e2e e2e/share-create-live.spec.ts --workers=1
//
// The token goes into `sessionStorage.hot_token` exactly as a login token would
// — the client resolves identity for it against our own API rather than the
// broker (ADR-0037), which is what keeps this spec driving the real Share
// button instead of being rewritten into an API script. It is also why the
// workflow's trace scrubbing matters more than it used to: this credential has
// no expiry to limit the damage of a leaked artifact.
//
// Cost and hygiene: one BuilderSandbox boot (pool of 3, shared) and one D1
// row per run. The revoke lives in an afterEach, not the test body — see the
// note at `demoId` below.

const TOKEN = process.env.E2E_API_TOKEN;

// Written by the test, read by the afterEach below. Module scope on purpose:
// the revoke must not live in the test body's `finally` — a body that hits its
// own timeout is killed mid-flight, and the minted production share would
// outlive the run (Bugbot, #186). afterEach gets its own timeout slice and
// runs even when the body dies.
let demoId: string | null = null;

test.afterEach(async ({ request, baseURL }) => {
  if (!demoId) return;
  test.setTimeout(60_000);
  // Revoke is the cleanup *and* the final assertion: rows are soft-deleted,
  // so the worst-case leak is one revoked row, and the 410 proves the kill.
  const del = await request.delete(`${baseURL}/api/demos/${demoId}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  expect(del.status(), "the owner can revoke their own demo").toBe(204);
  const after = await request.get(`${baseURL}/d/${demoId}/`);
  expect(after.status(), "a revoked share answers 410, not a stale page").toBe(410);
  demoId = null;
});

test("a demo shared today is a page a client can open — until it is revoked", async ({ page }) => {
  test.skip(!process.env.E2E_BASE_URL, "needs a deployed API origin");
  test.skip(!TOKEN, "set E2E_API_TOKEN to a token minted on /api-tokens");
  // Headroom above the sum of the wait ceilings (30+30+300+60s) — the previous
  // 420s equalled it exactly, so a build that used its whole dialog budget
  // timed the body out before the view assertions ran (Bugbot, #186). All
  // waits below are condition-bound with ceilings, never sleeps.
  test.setTimeout(480_000);

  // The real token, the real broker, no stubs.
  await page.addInitScript((token) => sessionStorage.setItem("hot_token", token), TOKEN!);

  // The id is captured off the network, not the dialog: a locator throwing
  // between the mint and the id read would leave a live production share with
  // nothing to revoke it (Bugbot, #186 — getByLabel(/client link/i) also
  // matched the "Copy Public client link" button and strict mode threw).
  page.on("response", async (res) => {
    if (res.request().method() === "POST" && /\/api\/demos$/.test(res.url()) && res.ok()) {
      const body = (await res.json().catch(() => null)) as { id?: string } | null;
      if (body?.id) demoId = body.id;
    }
  });

  await page.goto("/?example=react");
  // Fork appearing in the top bar is the signed-in signal — assert it before
  // acting, so an expired token reads as "token expired", not a dead button.
  await expect(
    page.getByRole("button", { name: "Fork", exact: true }),
    "no authed top bar — has E2E_API_TOKEN been revoked?",
  ).toBeVisible({ timeout: 30_000 });

  // Auth is not the only precondition: the workspace starts as an empty
  // placeholder and fills asynchronously (and can refill when /api/versions
  // swaps in `latest`). Minting in that window posts empty files and burns
  // the whole dialog budget on a doomed build (Bugbot, #186) — so wait for
  // the starter to actually be here before sharing.
  await expect(async () => {
    const files = await workspaceFiles(page);
    expect(files["/package.json"], "the starter workspace has loaded").toBeTruthy();
  }).toPass({ timeout: 30_000 });

  // Share mints a demo: POST /api/demos runs a real container build and
  // only then hands back links, so the dialog opening means "built".
  await page.getByRole("button", { name: "Share this demo" }).click();
  const dialog = page.getByRole("dialog", { name: "Share this demo" });
  await expect(dialog).toBeVisible({ timeout: 300_000 });

  // The textbox role, not getByLabel: the field's copy button is named
  // "Copy Public client link" and would collide under strict mode.
  const clientLink = await dialog.getByRole("textbox", { name: /client link/i }).inputValue();

  // The wire capture is un-awaited and its json read is best-effort — if it
  // lost the race, a demo would exist (the dialog is showing its link) while
  // afterEach saw null and skipped the revoke (Bugbot, #186). The link is the
  // recovery path: whichever source answers, afterEach ends up owning the id
  // of any demo that now exists.
  const linkId = new URL(clientLink).pathname.split("/").filter(Boolean).pop() ?? null;
  demoId ??= linkId;
  expect(demoId, "a demo id, from the mint response or the dialog's link").toBeTruthy();
  expect(linkId, "the dialog's client link names the minted demo").toBe(demoId);

  // The built page renders for an anonymous client (fresh context state not
  // needed — /d is public and static, cookies play no part).
  await page.goto(`/d/${demoId}/`);
  await expect
    .poll(async () => page.locator(".handsontable .htCore td").count(), { timeout: 60_000 })
    .toBeGreaterThan(0);
});
