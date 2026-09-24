import { test, expect, type Page, type Route } from "@playwright/test";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { signIn, stubShell } from "./helpers.js";

// T12 — ADR-0042 example analytics: `example.open` at the App.tsx
// example-resolve path.
//
// Gated: needs a dist built with VITE_TELEMETRY_LOCAL=1 (contract §10), same
// pattern as T06's `e2e/telemetry-faro.spec.ts`. No o11y worker needed:
// `/telemetry/collect` is captured with `page.route`, exactly as T06's spec
// does.
//
//   E2E_TELEMETRY=1 pnpm e2e e2e/example-analytics.spec.ts
//
// (No separate manual build step — unlike telemetry-faro.spec.ts, this spec
// builds itself, into its OWN `--outDir` below.)
//
// Fix round D-I1: this spec used to be ungated (ran under plain `pnpm e2e`,
// no `test.skip`) AND rebuilt `apps/authoring/dist` itself with no
// `--outDir`, in place. That broke three ways: (a) `ci.yml`'s `e2e` job has
// no `@handsontable/demo-runtime` dist and no telemetry build step, so
// `beforeAll` threw there; (b) `e2e-telemetry` runs this file and
// `telemetry-faro.spec.ts` together (`fullyParallel`), and this spec
// emptying/rebuilding the shared `dist/` mid-run raced telemetry-faro's own
// `:4711` preview into flaky 404s; (c) a local `pnpm e2e` left a
// telemetry-flagged, `.env.local`-poisoned `dist/` behind for every later
// spec (and a manual deploy) to pick up. Gating like every other telemetry
// spec, and building into a private `dist-example-analytics` the way
// telemetry-faro's own uncaught-scope block already does, closes all three.
//
// The docs catalog itself is fully stubbed (same recipe as
// `e2e/docs-picker.spec.ts#installDocsCatalog`) rather than the real
// `apps/authoring/public/docs-examples/` content — the task's own Traps say
// "never hard-code a docs bucket minor in a spec," and a stub sidesteps that
// by construction: the bucket is whatever `stubShell`'s fake `/api/versions`
// resolves to (currently 18.0.0 → bucket "18.0"), read back from the SAME
// fixture this file defines, never a literal written into an assertion.

test.skip(
  process.env.E2E_TELEMETRY !== "1",
  "set E2E_TELEMETRY=1 first — this spec builds its own VITE_TELEMETRY_LOCAL=1 dist",
);

// F3 fix-round port block (final review wave, COMMON.md) — never 4173/4711/
// 4712 (other specs' shared/own preview ports) and never another fixer's
// concurrent worktree block.
const PORT = 5701;
// 127.0.0.1, not "localhost": see telemetry-faro.spec.ts's BASE_URL comment —
// in CI's Playwright container, this spec's own `fetch("http://localhost:…")`
// readiness poll failed with "TypeError: fetch failed" while `vite preview`
// itself bound the default host with no startup error logged. Not
// reproduced locally; pinning bind and poll to the same literal address
// removes a whole axis of ambiguity regardless of the exact mechanism.
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTHORING_DIR = fileURLToPath(new URL("../apps/authoring", import.meta.url));
const OUT_DIR = "dist-example-analytics";

/** Node's `fetch` (undici) reports a connection failure as a bare
 *  `TypeError: fetch failed` — the useful part (ECONNREFUSED vs ENETUNREACH,
 *  which address/port it actually tried) is one level down in `.cause`,
 *  which a plain `String(err)` drops. Mirrors telemetry-faro.spec.ts's
 *  helper — this is exactly the CI failure that motivated it: the logged
 *  line said nothing more than "fetch failed". */
function formatFetchFailure(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause && typeof cause === "object") {
      const c = cause as { code?: string; address?: string; port?: number; message?: string };
      return `${err.message} (cause: ${c.code ?? "?"} ${c.address ?? ""}${c.port ? `:${c.port}` : ""} ${c.message ?? ""})`.trim();
    }
    return err.message;
  }
  return String(err);
}

function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      fetch(url)
        .then(() => resolve())
        .catch((err) => {
          if (Date.now() > deadline) reject(err);
          else setTimeout(attempt, 200);
        });
    };
    attempt();
  });
}

/** Wires a spawned preview server's stdout+stderr (and a hard spawn failure,
 *  which fires on `"error"` rather than either stream) into one string, so a
 *  `waitForServer` timeout's thrown error explains what happened instead of
 *  just restating the timeout. Stdout matters as much as stderr: vite's own
 *  `➜ Local: http://…` bind line goes to stdout. Mirrors
 *  telemetry-faro.spec.ts's helper. */
function captureServerDiagnostics(child: ChildProcess): { get(): string } {
  let text = "";
  child.stdout?.on("data", (chunk) => { text += String(chunk); });
  child.stderr?.on("data", (chunk) => { text += String(chunk); });
  child.on("error", (err) => { text += `\n[spawn error] ${String(err)}`; });
  child.on("exit", (code, signal) => {
    if (code !== 0 && code !== null) text += `\n[exited early with code ${code}]`;
    else if (signal) text += `\n[killed by signal ${signal}]`;
  });
  return { get: () => text.trim() };
}

interface FaroEvent {
  name?: string;
  attributes?: Record<string, string>;
}
interface FaroBody {
  events?: FaroEvent[];
}

/** One deterministic docs example — same shape/route recipe as
 *  `docs-picker.spec.ts#installDocsCatalog`, trimmed to what this spec
 *  needs: a `guide`/`breadcrumb`/`framework` distinct from `docsPath` (so a
 *  test that reads `ref`/`area` off `docsPath` or the URL by mistake fails),
 *  and one entry so both the deep-link and the picker paths resolve it. */
const DOCS_ENTRY = {
  breadcrumb: ["Columns", "Adding and removing columns"],
  guide: "guides/columns/column-adding/column-adding.md",
  guideTitle: "Adding and removing columns",
  docsPath: "guides/columns/column-adding/react/example2.tsx",
  exampleId: "example2",
  exampleTitle: "Add and remove columns from the context menu",
  docPermalink: "/column-adding",
};

async function installDocsCatalog(page: Page) {
  await stubShell(page); // versions stub -> latest 18.0.0 -> bucket "18.0"
  await page.route("**/docs-examples/*/*.json", async (route: Route) => {
    const url = new URL(route.request().url());
    const [, bucket, file] = url.pathname.match(/\/docs-examples\/([^/]+)\/(.+)\.json$/) ?? [];
    const path = decodeURIComponent(file ?? "").replace(/__/g, "/");
    if (path !== DOCS_ENTRY.docsPath) {
      await route.fulfill({ status: 404, body: "not found" });
      return;
    }
    await route.fulfill({
      json: {
        framework: "react",
        displayName: "React",
        tier: 1,
        engine: "sandpack",
        sandpackTemplate: "react-ts",
        sandpackEnvironment: "parcel",
        container: null,
        htWrappers: ["@handsontable/react-wrapper"],
        entry: "/src/App.tsx",
        htmlEntry: "/index.html",
        devCommand: null,
        buildCommand: "vite build",
        outputDir: "dist",
        outputGlob: null,
        staticExport: false,
        spaMode: false,
        port: null,
        installCommand: "pnpm install",
        htCoreRange: "18.0.0",
        fileCount: 3,
        assets: [],
        skipped: [],
        docsPath: path,
        breadcrumb: [...DOCS_ENTRY.breadcrumb],
        guide: DOCS_ENTRY.guide,
        guideTitle: DOCS_ENTRY.guideTitle,
        exampleId: DOCS_ENTRY.exampleId,
        lang: "tsx",
        files: {
          "/src/App.tsx": `export const fixture = "${bucket}:${path}";\n`,
          "/index.html": `<div id="root"></div>`,
          "/package.json": JSON.stringify(
            { dependencies: { handsontable: "18.0.0", "@handsontable/react-wrapper": "18.0.0" } },
            null,
            2,
          ),
        },
      },
    });
  });
  await page.route("**/docs-examples/*/manifest.json", async (route: Route) => {
    const bucket = new URL(route.request().url()).pathname.split("/").at(-2) ?? "";
    await route.fulfill({
      json: {
        bucket,
        docsBranch: "e2e-fixture",
        generatedFrom: "e2e fixture",
        hotVersion: "18.0.0",
        count: 1,
        examples: [
          {
            bucket,
            docsPath: DOCS_ENTRY.docsPath,
            file: DOCS_ENTRY.docsPath.replace(/\//g, "__") + ".json",
            breadcrumb: [...DOCS_ENTRY.breadcrumb],
            guide: DOCS_ENTRY.guide,
            guideTitle: DOCS_ENTRY.guideTitle,
            exampleId: DOCS_ENTRY.exampleId,
            exampleTitle: DOCS_ENTRY.exampleTitle,
            docPermalink: DOCS_ENTRY.docPermalink,
            framework: "react",
            displayName: "React",
          },
        ],
      },
    });
  });
}

/** Captures every Faro event `page.route` sees on `/telemetry/collect` (the
 *  real Faro `TransportBody` shape, T02-D6: one shared `meta` plus separate
 *  typed arrays). Fulfils with a bare 202 so the SDK's own retry logic never
 *  kicks in. */
function captureTelemetryEvents(page: Page): FaroEvent[] {
  const events: FaroEvent[] = [];
  void page.route(`${BASE_URL}/telemetry/collect`, async (route: Route) => {
    let body: FaroBody = {};
    try {
      body = (route.request().postDataJSON() as FaroBody) ?? {};
    } catch {
      body = {};
    }
    events.push(...(body.events ?? []));
    await route.fulfill({ status: 202, body: "" });
  });
  return events;
}

test.describe.configure({ mode: "serial" });

let server: ChildProcess;

test.beforeAll(async () => {
  // Fail loudly rather than silently reusing whatever already answers on
  // this port — same trap AGENTS.md warns about for the shared :4173.
  const already = await fetch(BASE_URL).then(() => true).catch(() => false);
  if (already) {
    throw new Error(
      `something is already answering on :${PORT} — kill it first (lsof -ti :${PORT} | xargs kill)`,
    );
  }
  // D-I1: built into its OWN --outDir, never the shared apps/authoring/dist
  // other specs' :4173 webServer (playwright.config.ts) or a manual deploy
  // could pick up.
  execSync("node_modules/.bin/vite build --outDir " + OUT_DIR, {
    cwd: AUTHORING_DIR,
    env: { ...process.env, VITE_TELEMETRY_LOCAL: "1" },
    stdio: "pipe",
  });
  server = spawn(
    "node_modules/.bin/vite",
    ["preview", "--outDir", OUT_DIR, "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"],
    { cwd: AUTHORING_DIR, stdio: "pipe" },
  );
  const diagnostics = captureServerDiagnostics(server);
  try {
    await waitForServer(BASE_URL, 30_000);
  } catch (err) {
    throw new Error(`preview server on :${PORT} never came up: fetch: ${formatFetchFailure(err)} | server output: ${diagnostics.get() || "(none)"}`);
  }
});

test.afterAll(() => {
  server?.kill();
});

test("a docs example opened by ?docs= fires one example.open with entry=deep-link, taxonomy read from the loaded entry", async ({
  page,
}) => {
  await installDocsCatalog(page);
  const events = captureTelemetryEvents(page);

  await page.goto(`${BASE_URL}/?docs=${encodeURIComponent(DOCS_ENTRY.docsPath)}&v=18.0.0`);

  // The editor showing the fetched artifact's own marker is the same "loaded
  // the RIGHT example" oracle docs-picker.spec.ts uses — a regression that
  // fires example.open without actually resolving the example would still
  // pass a bare "one event exists" check.
  await expect(page.locator('[data-pane-active="true"] .cm-content')).toContainText(
    `18.0:${DOCS_ENTRY.docsPath}`,
  );

  await expect.poll(() => events.filter((e) => e.name === "example.open").length).toBe(1);
  const [open] = events.filter((e) => e.name === "example.open");
  const attrs = open.attributes ?? {};
  expect(attrs["hot.reason"]).toBe("deep-link");
  expect(attrs["hot.metric_kind"]).toBe("docs");
  // ref is the GUIDE, never docsPath or the URL (the task's own Traps).
  expect(attrs["hot.ref"]).toBe(DOCS_ENTRY.guide);
  expect(attrs["hot.ref"]).not.toBe(DOCS_ENTRY.docsPath);
  expect(attrs["hot.area"]).toBe(DOCS_ENTRY.breadcrumb[0]);
  expect(attrs["hot.framework"]).toBe("react");
  expect(attrs["hot.ht_major"]).toBe("18");
  expect(attrs["hot.bucket"]).toBe("18.0");

  // "none on re-render": reloading the same URL is a fresh page load (and so
  // a fresh, legitimate second open) but simply letting the page sit idle
  // must not add a second one.
  await page.waitForTimeout(1000);
  expect(events.filter((e) => e.name === "example.open")).toHaveLength(1);
});

test("a docs example opened from the picker fires one example.open with entry=picker", async ({ page }) => {
  await installDocsCatalog(page);
  const events = captureTelemetryEvents(page);

  // Deliberately no `?example=` in the URL: the bare-`/` default landing on
  // the react starter is NOT itself an `example.open` (T12-D — the top-bar
  // "React" trigger below still renders identically either way), so the
  // only `example.open` this test ever sees is the picker's own.
  await page.goto(`${BASE_URL}/`);
  await page.getByRole("button", { name: /React/ }).first().click();
  const search = page.getByPlaceholder("Search examples…");
  await expect(search).toBeFocused();
  await search.fill("context menu");
  await page.getByRole("listbox", { name: "Search results" }).getByRole("option").first().click();

  await expect(page).toHaveURL(/docs=guides%2Fcolumns%2Fcolumn-adding%2Freact%2Fexample2\.tsx/);

  await expect.poll(() => events.filter((e) => e.name === "example.open").length).toBe(1);
  const [open] = events.filter((e) => e.name === "example.open");
  expect(open.attributes?.["hot.reason"]).toBe("picker");
  expect(open.attributes?.["hot.metric_kind"]).toBe("docs");
  expect(open.attributes?.["hot.ref"]).toBe(DOCS_ENTRY.guide);
});

// T12-D2 fix round: a post-fork landing on the new demo's own `/edit/:id`
// must classify as `entry=fork`, not `deep-link` — `onFork` does a full
// `location.href` reload (no in-memory flag survives it), so the signal is
// a one-shot URL marker (`?fork=1`) the saved-demo load effect reads and
// strips (`exampleAnalytics.ts#consumeForkMarker`). Stubs the saved-demo
// source/meta pair the same way `e2e/description-markdown.spec.ts#stubSavedDemo`
// does — this spec never actually calls `onFork` itself (that needs a real
// POST /api/demos), it simulates landing on the fork's OWN destination URL,
// which is the half `consumeForkMarker` is responsible for.
const FORKED_DEMO_ID = "e2efork01";
const FORKED_DEMO_FILES = {
  "/src/App.tsx": "export default function App() { return null; }\n",
  "/index.html": '<div id="root"></div>',
  "/package.json": JSON.stringify({ dependencies: { handsontable: "18.0.0" } }, null, 2),
};

async function stubForkedDemo(page: Page) {
  await page.route("**/api/demos/**", (route: Route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith("/source")
        ? { framework: "react", files: FORKED_DEMO_FILES }
        : { title: "Fork of React", description: null, ht_version: "18.0.0", created_at: "2026-09-23T00:00:00.000Z" },
    }),
  );
}

test("landing on /edit/:id?fork=1 (onFork's own destination) fires example.open with entry=fork, and strips the marker", async ({
  page,
}) => {
  await stubShell(page);
  await signIn(page);
  await stubForkedDemo(page);
  const events = captureTelemetryEvents(page);

  await page.goto(`${BASE_URL}/edit/${FORKED_DEMO_ID}?fork=1`);

  await expect.poll(() => events.filter((e) => e.name === "example.open").length).toBe(1);
  const [open] = events.filter((e) => e.name === "example.open");
  expect(open.attributes?.["hot.reason"]).toBe("fork");
  expect(open.attributes?.["hot.metric_kind"]).toBe("saved");
  expect(open.attributes?.["hot.ref"]).toBe(FORKED_DEMO_ID);

  // One-shot: the marker is gone from the URL once it has been read, so a
  // manual reload of this same address is a plain deep-link, not a fork.
  await expect(page).toHaveURL(new RegExp(`/edit/${FORKED_DEMO_ID}$`));
});
