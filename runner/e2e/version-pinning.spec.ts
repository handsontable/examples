import { test, expect, type Page } from "@playwright/test";
import { activeEditor, expectGridRendered, previewReady, stubShell, trackSessions } from "./helpers";

// Version dispatch, end to end (DEV-2203, groundwork for DEV-2198 PR previews).
//
// pipeline/version.test.mjs proves the rewrite rules on file maps and
// starter-matrix.spec.ts proves live per-major rendering, but nothing walked
// the URL → pin → workspace path a PR-preview link will actually take: paste
// `?v=`, and the *open workspace's* package.json now pins core and wrapper in
// lockstep. The three deterministic tests below run in PR CI; the live one
// proves the newest -next build still installs through the real bundler.
//
// pkg.pr.new refs are deliberately never hardcoded live: builds expire per
// commit, `/api/versions/exists` only vouches for npm, and Sandpack cannot
// install URL tarballs at all (containers only). The mechanism is pinned
// deterministically instead, and E2E_PKG_PR_NEW_REF lets a DEV-2198
// validation run point one real container at a fresh build id on demand.

/** Open a root file through its tree row and hand back the visible editor.
 *  package.json is short enough to sit fully inside CodeMirror's viewport, so
 *  reading `.cm-content` is safe here — do not copy this pattern for long
 *  files (the virtualisation trap that killed the first style-panel draft). */
async function openRootFile(page: Page, path: string) {
  await page.locator(`.hot-file-row:has(> button[title="${path}"])`).locator(`button[title="${path}"]`).click();
  return activeEditor(page);
}

test("a semver deep link pins core and wrapper in lockstep", async ({ page }) => {
  await stubShell(page);
  await page.goto("/?example=react&v=17.1.0");

  const editor = await openRootFile(page, "/package.json");
  // Pinning happens when the bucket artifact lands, so poll rather than sample.
  await expect(editor).toContainText('"handsontable": "17.1.0"');
  await expect(editor).toContainText('"@handsontable/react-wrapper": "17.1.0"');
});

test("a pkg.pr.new build id rewrites every Handsontable dependency to a tarball URL", async ({ page }) => {
  await stubShell(page);
  // A bare id ≥ 1000 reads as a pkg.pr.new build ref and resolves the `next`
  // starter bucket (there is no semver to derive a bucket from).
  await page.goto("/?example=react&v=7940");

  const editor = await openRootFile(page, "/package.json");
  await expect(editor).toContainText('"handsontable": "https://pkg.pr.new/handsontable@7940"');
  await expect(editor).toContainText('"@handsontable/react-wrapper": "https://pkg.pr.new/@handsontable/react-wrapper@7940"');
});

test("a pkg.pr.new ref reaches the container session payload", async ({ page }) => {
  await stubShell(page);

  // react-js is engine: container, so opening it posts /api/session. Refusing
  // the session keeps the test deterministic — the payload is the assertion.
  const posted: string[] = [];
  await page.route("**/api/session", async (route) => {
    posted.push(route.request().postData() ?? "");
    await route.fulfill({ status: 503, json: { error: "e2e: refused on purpose" } });
  });

  await page.goto("/?example=react-js&v=7940");

  await expect(async () => {
    expect(posted.length).toBeGreaterThan(0);
    const { htVersion } = JSON.parse(posted[0]) as { htVersion?: string };
    expect(htVersion, "the validated ref, not the raw URL param, travels to the container").toBe("7940");
  }).toPass({ timeout: 30_000 });
});

test("the newest -next build installs and renders", async ({ page, request, baseURL }) => {
  test.skip(process.env.E2E_LIVE !== "1", "set E2E_LIVE=1 to run live-render checks");
  test.skip(!process.env.E2E_BASE_URL, "needs a deployed /api/versions — vite preview has no API proxy");
  test.setTimeout(240_000);

  const versions = (await (await request.get(`${baseURL}/api/versions`)).json()) as { next?: string };
  test.skip(!versions.next, "no -next build is published right now");

  const htRequests: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes(`handsontable`) && req.url().includes(versions.next!)) htRequests.push(req.url());
  });

  await page.goto(`/?example=react&v=${encodeURIComponent(versions.next!)}`);
  await previewReady(page, "sandpack");
  await expectGridRendered(page);
  expect(htRequests.length, `the bundler asked for handsontable@${versions.next}`).toBeGreaterThan(0);
});

test("a fresh pkg.pr.new build boots a real container at that ref", async ({ page, request }) => {
  const ref = process.env.E2E_PKG_PR_NEW_REF;
  test.skip(!ref, "set E2E_PKG_PR_NEW_REF=<build id> to verify a pkg.pr.new build end to end (DEV-2198)");
  test.skip(!process.env.E2E_BASE_URL, "needs a deployed API origin");
  test.setTimeout(300_000);

  // The ref must be *proven* to reach the session, not assumed: without this,
  // deleting the ?v= pkg.pr.new dispatch entirely would leave react-js booting
  // at DEFAULT_VERSION and the render assertions green (audit, DEV-2203). The
  // install itself happens server-side in the container, so the session
  // payload is the observable seam — the browser never fetches pkg.pr.new.
  let postedHtVersion: string | null = null;
  page.on("request", (req) => {
    if (req.method() === "POST" && /\/api\/session$/.test(req.url())) {
      try {
        postedHtVersion = (JSON.parse(req.postData() ?? "{}") as { htVersion?: string }).htVersion ?? null;
      } catch {
        // malformed payload just leaves the assertion below to fail
      }
    }
  });

  const tracked = trackSessions(page);
  try {
    await page.goto(`/?example=react-js&v=${encodeURIComponent(ref!)}`);
    await previewReady(page, "container");
    await expectGridRendered(page);
    expect(postedHtVersion, "the validated pkg.pr.new ref reached the container session").toBe(ref);
  } finally {
    await tracked.cleanup(request);
  }
});
