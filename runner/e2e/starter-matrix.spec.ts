import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

// Empirical starter-compatibility matrix (DEV-2102 / ADR-0021 decision 10):
// boots every starter in catalog.json at the latest patch of each supported
// Handsontable major (15-19) and records what actually breaks. Opt-in via
// E2E_STARTER_MATRIX=1 — this is not part of the deterministic PR suite; it
// spins ~55 real Tier-2 container sessions (the live-preview `Sandbox` class)
// and takes ~80-90 minutes.
//
// Prod only allows 5 concurrent live-preview containers
// (workers/api/wrangler.jsonc: Sandbox max_instances=5, separate from
// BuilderSandbox max_instances=3 which this test never touches). The
// e2e:matrix script runs at --workers=2 to leave headroom for real traffic —
// do not raise concurrency without checking current prod load.
//
// Run: E2E_BASE_URL=https://demos.handsontable.com pnpm e2e:matrix
// Report: pnpm e2e:matrix:report

const ENABLED = process.env.E2E_STARTER_MATRIX === "1";
const MAJORS = [15, 16, 17, 18, 19] as const;

type CatalogExample = {
  framework: string;
  displayName: string;
  engine: "sandpack" | "container";
  minCoreMajor: number | null;
};

const catalog = JSON.parse(readFileSync(new URL("../catalog.json", import.meta.url), "utf8")) as {
  examples: CatalogExample[];
};

// Console/page noise that isn't a real compatibility break. Extend as the
// matrix surfaces new false positives.
const NOISE = [
  /non-commercial|evaluation license/i,
  /Download the React DevTools/i,
  /favicon\.ico/i,
  /\[vite\] (connecting|connected)/i,
  /ERR_BLOCKED_BY_CLIENT|third-party cookie/i,
];
const isKnownNoise = (message: string) => NOISE.some((re) => re.test(message));

let latestByMajorPromise: Promise<Map<number, string>> | null = null;

// Resolve the latest stable patch release per major straight from npm — the
// app's own GET /api/versions slices results to 15 entries and can drop older
// majors, so it isn't a reliable source for "latest per major".
function resolveLatestByMajor(): Promise<Map<number, string>> {
  latestByMajorPromise ??= (async () => {
    const res = await fetch("https://registry.npmjs.org/handsontable", {
      headers: { Accept: "application/vnd.npm.install-v1+json" },
    });
    if (!res.ok) throw new Error(`npm registry responded ${res.status}`);
    const doc = (await res.json()) as { versions: Record<string, unknown> };
    const best = new Map<number, string>();
    for (const version of Object.keys(doc.versions)) {
      if (!/^\d+\.\d+\.\d+$/.test(version)) continue;
      const [major, minor, patch] = version.split(".").map(Number);
      const current = best.get(major);
      if (!current) {
        best.set(major, version);
        continue;
      }
      const [, currentMinor, currentPatch] = current.split(".").map(Number);
      if (minor > currentMinor || (minor === currentMinor && patch > currentPatch)) {
        best.set(major, version);
      }
    }
    return best;
  })();
  return latestByMajorPromise;
}

for (const entry of catalog.examples) {
  for (const major of MAJORS) {
    test(`matrix: ${entry.framework} @ ${major} [${entry.engine}]`, async ({ page, request }, testInfo) => {
      test.skip(!ENABLED, "set E2E_STARTER_MATRIX=1 to run the starter compatibility matrix");
      test.setTimeout(entry.engine === "container" ? 300_000 : 150_000);

      const byMajor = await resolveLatestByMajor();
      const version = byMajor.get(major);
      // A major with no stable npm release yet (e.g. 19 is pre-release as of
      // writing — dist-tags carry only `next`/`rc`) isn't a starter failure,
      // it's nothing to test yet. Skip rather than report a false breakage.
      test.skip(!version, `no stable handsontable release published for major ${major} yet`);
      if (!version) return;

      // A starter may declare a minimum core major (e.g. the UI-library starters
      // need the themes API added in core 17). Below-floor combos are
      // intentionally unavailable — the authoring app refuses to boot them and
      // shows a "try another version" message — so they are nothing to test as
      // bootable, not a breakage. Skip rather than assert a mounted grid.
      test.skip(
        entry.minCoreMajor != null && major < entry.minCoreMajor,
        `${entry.framework} requires Handsontable >= ${entry.minCoreMajor}; ${major} is intentionally unavailable`,
      );

      // Annotate immediately so a failing test still reports which version it
      // was testing — the report shouldn't say "unknown" just because the
      // test threw before reaching the end.
      testInfo.annotations.push({ type: "resolvedVersion", description: version }, { type: "engine", description: entry.engine });

      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      const htRequestVersions: string[] = [];
      const sessions: { id: string; apiBase: string }[] = [];
      let postedHtVersion: string | null = null;

      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });
      page.on("pageerror", (err) => pageErrors.push(String(err)));
      page.on("request", (req) => {
        const url = req.url();
        const match = url.match(/handsontable[@/](\d+\.\d+\.\d+)/);
        if (match) htRequestVersions.push(match[1]);
        if (req.method() === "POST" && /\/api\/session$/.test(url)) {
          try {
            postedHtVersion = (JSON.parse(req.postData() ?? "{}") as { htVersion?: string }).htVersion ?? null;
          } catch {
            // ignore malformed payloads — absence just leaves postedHtVersion null
          }
        }
      });
      page.on("response", async (res) => {
        if (res.request().method() === "POST" && /\/api\/session$/.test(res.url()) && res.ok()) {
          const body = (await res.json().catch(() => null)) as { sessionId?: string } | null;
          if (body?.sessionId) sessions.push({ id: body.sessionId, apiBase: new URL(res.url()).origin });
        }
      });

      try {
        await page.goto(`/?example=${encodeURIComponent(entry.framework)}&v=${version}`);

        const preview = page.locator('section[aria-label="Preview"]');
        // The status bar is the first direct child <div> of the preview
        // section (PreviewPane.tsx) — scope to it directly rather than
        // getByText scanning the whole section, which also matches the live
        // boot-log <pre> when a container's dev-server error text happens to
        // start with "Error:" (seen with mui: strict-mode violation, two
        // elements matched).
        const statusBar = preview.locator(":scope > div").first();
        await expect(statusBar).toHaveText("Live", {
          timeout: entry.engine === "container" ? 240_000 : 120_000,
        });

        // Container "Live" only means the dev server responded — the frame may
        // still be blank or mid-hydration (Next/Nuxt/Astro). The rendered grid
        // is the real functional check.
        const frame = page.frameLocator('iframe[title="Demo preview"]');
        const cells = frame.locator(".handsontable .htCore td");
        await expect
          .poll(async () => cells.count().catch(() => 0), { timeout: 60_000, intervals: [1_000] })
          .toBeGreaterThan(0);

        const realErrors = [...consoleErrors, ...pageErrors].filter((e) => !isKnownNoise(e));
        expect(realErrors, `console/page errors:\n${realErrors.join("\n")}`).toEqual([]);

        let detectedVersion: string | null = null;
        if (entry.engine === "sandpack") {
          detectedVersion = htRequestVersions.find((v) => v === version) ?? htRequestVersions[0] ?? null;
        } else {
          expect(postedHtVersion, "requested handsontable version reached the container session").toBe(version);
          detectedVersion = await frame
            .locator("body")
            .evaluate(() => (window as unknown as { Handsontable?: { version?: string } }).Handsontable?.version ?? null)
            .catch(() => null);
        }

        testInfo.annotations.push({ type: "detectedVersion", description: detectedVersion ?? "unverified" });
        if (detectedVersion) expect(detectedVersion.startsWith(`${major}.`)).toBe(true);
      } finally {
        for (const { id, apiBase } of sessions) {
          await request.delete(`${apiBase}/api/session/${id}`).catch(() => {});
        }
      }
    });
  }
}
