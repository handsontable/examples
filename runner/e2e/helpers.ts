import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
// `src`, not `dist`, the way docs-examples.spec.ts imports it: the `e2e` job
// downloads only the authoring build and `e2e-live` skips `pnpm build`, so a
// `dist` specifier fails at spec load. Playwright resolves the `.js` to the source.
import { highestReleaseBucket } from "../packages/runtime/src/docs-bucket.js";

// Shared helpers for the e2e suite (DEV-2203).
//
// Everything here existed first as copy-paste: `stubShell` and `signIn` were
// declared verbatim in nine specs, the session-cleanup pattern in two, the
// noise filter in one. New specs import from here; existing specs keep their
// local copies and migrate opportunistically — a mass rewrite would churn
// thousands of spec lines for zero behaviour change.
//
// The file is not matched by `*.spec.ts`, so Playwright never collects it.

export const EMAIL = "dev@handsontable.com";

/**
 * The deterministic-shell recipe: a stubbed version list, both Sandpack hosts
 * aborted (no external bundler, no grid — the shell renders fine without one),
 * and the login redirect neutered so a stray click cannot leave the app.
 */
export async function stubShell(page: Page) {
  await page.route("**/api/versions", (route) =>
    route.fulfill({ json: { latest: "18.0.0", next: "19.0.0-next.1", versions: ["18.0.0", "17.1.0"] } }),
  );
  await page.route("https://sandpack.codesandbox.io/**", (route) => route.abort());
  await page.route("https://sandpack-bundler.codesandbox.io/**", (route) => route.abort());
  await page.route("**/broker/login**", (route) => route.abort());
}

/**
 * Sign-in faked at the token layer — the app reads `sessionStorage.hot_token`
 * and asks the broker who that is. Faking here rather than via `VITE_DEV_USER`
 * keeps the production auth path in play (see sidebar-crud.spec.ts for the full
 * argument). Never add storage *clears* to an init script: it runs on
 * `page.reload()` too and silently defeats persistence tests (AGENTS.md).
 */
export async function signIn(page: Page, email: string = EMAIL) {
  await page.addInitScript(() => sessionStorage.setItem("hot_token", "e2e-token"));
  await page.route("**/broker/userinfo", (route) => route.fulfill({ json: { email } }));
}

/**
 * The visible editor pane. Scoped since T12 (DEV-2169): every open tab keeps
 * its own CodeMirror instance mounted, so a bare `.cm-content` trips strict
 * mode as soon as a test opens a second file.
 *
 * For *reading file contents*, prefer `workspaceFiles()` — CodeMirror
 * virtualises long documents, so `.cm-content` only holds the lines on screen.
 */
export function activeEditor(page: Page) {
  return page.locator('[data-pane-active="true"] .cm-content');
}

/**
 * The workspace files, via the `window.__HOT_FILES__` test contract
 * (apps/authoring/src/App.tsx). Poll with `expect(...).toPass()` when the
 * write you are waiting for rides the Style panel's 250 ms debounce.
 */
export function workspaceFiles(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const hook = (window as unknown as { __HOT_FILES__?: () => Record<string, string> }).__HOT_FILES__;
    if (!hook) throw new Error("window.__HOT_FILES__ is not installed — is the app older than DEV-2203?");
    return hook();
  });
}

/**
 * The version and framework pickers are custom listboxes in the preview bar
 * (T2, DEV-2156) — `selectOption` does not apply. Open the trigger, click the
 * option.
 */
export async function pickFromMenu(page: Page, menu: "Handsontable version" | "Framework", option: string) {
  await page.getByRole("button", { name: menu, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

/**
 * Wait for the preview to declare itself ready. Readiness comes off
 * `data-preview-status` on the preview section (PreviewPane.tsx — a documented
 * test contract), never off visible text. For containers, "ready" only means
 * the dev server responded; follow up with `expectGridRendered` before
 * asserting anything about the demo itself.
 */
export async function previewReady(page: Page, engine: "sandpack" | "container" = "sandpack") {
  await expect(page.locator('section[aria-label="Preview"]')).toHaveAttribute("data-preview-status", "ready", {
    timeout: engine === "container" ? 240_000 : 120_000,
  });
}

/** The rendered grid inside the preview frame — the real functional check. */
export function gridCells(page: Page) {
  return page.frameLocator('iframe[title="Demo preview"]').locator(".handsontable .htCore td");
}

export async function expectGridRendered(page: Page) {
  await expect
    .poll(async () => gridCells(page).count().catch(() => 0), { timeout: 60_000, intervals: [1_000] })
    .toBeGreaterThan(0);
}

// Console/page noise that isn't a real break. Extend as live runs surface new
// false positives (same list as starter-matrix.spec.ts).
export const NOISE = [
  /non-commercial|evaluation license/i,
  /Download the React DevTools/i,
  /favicon\.ico/i,
  /\[vite\] (connecting|connected)/i,
  /ERR_BLOCKED_BY_CLIENT|third-party cookie/i,
];
export const isKnownNoise = (message: string) => NOISE.some((re) => re.test(message));

/**
 * Track Tier-2 sessions a test creates so they can be torn down even when the
 * test fails: the container pool holds five global slots shared with real
 * traffic, and a leaked session squats one for its whole idle window.
 *
 *   const tracked = trackSessions(page);
 *   try { ... } finally { await tracked.cleanup(request); }
 */
export function trackSessions(page: Page) {
  const sessions: { id: string; apiBase: string }[] = [];
  page.on("response", async (res) => {
    if (res.request().method() === "POST" && /\/api\/session$/.test(res.url()) && res.ok()) {
      const body = (await res.json().catch(() => null)) as { sessionId?: string } | null;
      if (body?.sessionId) sessions.push({ id: body.sessionId, apiBase: new URL(res.url()).origin });
    }
  });
  return {
    sessions,
    async cleanup(request: APIRequestContext) {
      for (const { id, apiBase } of sessions) {
        await request.delete(`${apiBase}/api/session/${id}`).catch(() => {});
      }
    },
  };
}

/**
 * The docs bucket a visitor on the current release lands in, and the exact
 * version that reaches it.
 *
 * Every spec that deep-links `?docs=…&v=…` into the *real* committed buckets
 * has to name a version, and restating one goes stale twice over (DEV-2736).
 * It drifts on coverage the moment a new bucket lands — 18.0 stayed pinned
 * after 18.1 arrived, so the container engine was only ever exercised against
 * the previous release line, silently, because nothing asserted the bucket.
 * And it breaks outright when the old bucket is pruned: `writeDocsBucketIndex`
 * rebuilds `docs-buckets.json` from the directory listing and never
 * accumulates. PR #283 converted `docs-examples.spec.ts`'s suggestion
 * assertions the same way.
 *
 * `highestReleaseBucket` alone is not enough for a `?v=`: `planDocsBucket`
 * derives the bucket through a strict `semver.parse`, which answers null for
 * `18.1` and for `18` — a two-part `v=` lands on the not-found screen. The
 * bucket's own `manifest.json` records the full version it was imported at, so
 * that is read rather than synthesised as `${bucket}.0`; a bucket regenerated
 * at a later patch stays correct.
 */
export function currentDocsRelease(): { bucket: string; version: string } {
  const buckets: string[] = JSON.parse(
    readFileSync(new URL("../docs-buckets.json", import.meta.url), "utf8"),
  ).buckets;
  const bucket = highestReleaseBucket(buckets);
  if (!bucket) throw new Error("docs-buckets.json holds no release bucket");

  const manifestUrl = new URL(
    `../apps/authoring/public/docs-examples/${bucket}/manifest.json`,
    import.meta.url,
  );
  const { hotVersion } = JSON.parse(readFileSync(manifestUrl, "utf8")) as { hotVersion?: string };
  if (!hotVersion) throw new Error(`the ${bucket} docs manifest records no hotVersion`);

  return { bucket, version: hotVersion };
}
