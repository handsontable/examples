import { test, expect } from "@playwright/test";
import { expectGridRendered, previewReady, trackSessions } from "./helpers";

// One render per engine (DEV-2203) — the smallest set that still proves both
// halves of the runtime can put a grid on screen.
//
// The starter matrix covers all 19 starters × 5 majors, but it is a manual,
// three-hour workflow. These two tests are the @smoke slice: cheap enough to
// run after every deploy, wide enough that "Sandpack broke" or "containers
// broke" cannot both hide. react-js is the container case on purpose — it is
// a Tier-1 example that ships engine: "container" (the five UI-library
// starters share that shape), so it also pins the rule that `engine`, not
// `tier`, picks the runtime.

test("a Sandpack starter renders a grid", { tag: "@smoke" }, async ({ page }) => {
  test.skip(process.env.E2E_LIVE !== "1", "set E2E_LIVE=1 to run live-render checks");
  test.setTimeout(240_000);

  await page.goto("/?example=react");
  await previewReady(page, "sandpack");
  await expectGridRendered(page);
});

test("a container starter boots and renders a grid at the requested version", { tag: "@smoke" }, async ({
  page,
  request,
}) => {
  test.skip(process.env.E2E_LIVE !== "1", "set E2E_LIVE=1 to run live-render checks");
  test.skip(!process.env.E2E_BASE_URL, "containers need a deployed API origin — vite preview has no /api proxy");
  test.setTimeout(300_000);

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
    await page.goto("/?example=react-js");
    await previewReady(page, "container");
    await expectGridRendered(page);
    // "At the requested version" needs a real oracle, not non-null: with no
    // ?v= in the URL the app must resolve /api/versions' latest, so ask the
    // same endpoint and compare. not.toBeNull() stayed green when version
    // resolution regressed to a stale hardcoded default (audit, DEV-2203).
    const versions = (await (await request.get(`${process.env.E2E_BASE_URL}/api/versions`)).json()) as {
      latest?: string;
    };
    expect(postedHtVersion, "the session was asked for the resolved latest version").toBe(versions.latest);
  } finally {
    await tracked.cleanup(request);
  }
});
