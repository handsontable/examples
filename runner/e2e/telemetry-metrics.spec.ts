import { test, expect, type Route, type Page } from "@playwright/test";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { previewReady, expectGridRendered, trackSessions, activeEditor } from "./helpers.js";

// T07 phase 2 — observability contract §5 browser metric catalogue, live.
//
// Gated: needs a dist built with VITE_TELEMETRY_LOCAL=1 (contract §10, same as
// T06's e2e/telemetry-faro.spec.ts) AND a real preview mount (E2E_LIVE=1). The
// Tier-2 case additionally needs a local API worker — this spec starts its own
// `wrangler dev` inside workers/api, on this task's 4800-4899 port block, and
// builds the dist with `VITE_API_BASE` pointed at it. Never the production
// API: a plain `VITE_TELEMETRY_LOCAL=1` build inherits
// `apps/authoring/.env.production`'s `VITE_API_BASE=https://demos.handsontable.com`
// (AGENTS.md — that file outranks `.env.local`, and the app's own `:8787`
// fallback only applies to a FALSY value), so a Tier-2 session created here
// without overriding it would land in the real production container pool.
//
//   cd workers/api && npx wrangler dev --port 4810 --inspector-port 4811
//   (needs workers/api/.dev.vars — copy from the main checkout, PREVIEW_HOST=localhost:4810)
//   VITE_TELEMETRY_LOCAL=1 VITE_API_BASE=http://localhost:4810 \
//     pnpm --filter @handsontable/demo-authoring exec vite build --outDir dist-telemetry-metrics
//   E2E_LIVE=1 E2E_TELEMETRY=1 pnpm e2e e2e/telemetry-metrics.spec.ts
//
// This spec manages its own preview server (like telemetry-faro.spec.ts), never
// the shared playwright.config.ts webServer (:4173, no VITE_TELEMETRY_LOCAL).
//
// CI home: `.github/workflows/e2e-o11y-local.yml` (R1-followups) — on
// workflow_dispatch, nightly, and PRs touching the o11y ingest path. Not
// ci.yml's `e2e-telemetry` job: that job's two specs are self-contained
// (page.route mocks, no real API worker), this one needs Docker + a real
// `wrangler dev`, which the shared Playwright container image can't provide.

// Env-overridable (COMMON.md's per-worktree port block rule) — a local
// reproduction of the CI job running alongside other o11y worktrees on the
// same machine sets these to its own block instead of colliding on T07's
// original 4800-4899. Defaults unchanged: e2e-o11y-local.yml and every
// existing doc/comment naming ":4810" etc. still work unmodified.
const AUTHORING_PORT = Number(process.env.E2E_TELEMETRY_METRICS_AUTHORING_PORT ?? 4800);
const API_PORT = Number(process.env.E2E_TELEMETRY_METRICS_API_PORT ?? 4810);
const API_INSPECTOR_PORT = Number(process.env.E2E_TELEMETRY_METRICS_API_INSPECTOR_PORT ?? 4811);
const BASE_URL = `http://localhost:${AUTHORING_PORT}`;
const API_BASE_URL = `http://localhost:${API_PORT}`;
const AUTHORING_DIR = fileURLToPath(new URL("../apps/authoring", import.meta.url));
const API_DIR = fileURLToPath(new URL("../workers/api", import.meta.url));
const OUT_DIR = "dist-telemetry-metrics";

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

/** One decoded Faro transport body — same shape T06's spec captures. */
interface FaroBody {
  measurements?: { type?: string; values?: Record<string, number>; context?: Record<string, string> }[];
}

/** Every `/telemetry/collect` POST this test has seen, decoded. Registered
 *  before navigation so nothing is missed — same helper as telemetry-faro.spec.ts. */
function captureTelemetry(page: Page): FaroBody[] {
  const bodies: FaroBody[] = [];
  void page.route("**/telemetry/collect", async (route: Route) => {
    bodies.push(route.request().postDataJSON() as FaroBody);
    await route.fulfill({ status: 200, body: "" });
  });
  return bodies;
}

function measurementsOf(captured: FaroBody[], type: string) {
  return captured.flatMap((b) => b.measurements ?? []).filter((m) => m.type === type);
}

/** Insert a line at the top of the visible editor through CodeMirror's own
 *  dispatch (same as `editor-download.spec.ts#insertAtTop`) — `.cm-content` is
 *  contenteditable but virtualised, so a dispatch is the reliable edit path. */
async function insertAtTop(page: Page, text: string) {
  await activeEditor(page).waitFor();
  await page.evaluate(`(() => {
    const view = document.querySelector('[data-pane-active="true"] .cm-content').cmTile.view;
    view.dispatch({ changes: { from: 0, insert: ${JSON.stringify(text + "\n")} } });
  })()`);
}

test.describe("Browser metrics catalogue, live (T07)", () => {
  test.skip(
    process.env.E2E_LIVE !== "1" || process.env.E2E_TELEMETRY !== "1",
    "set E2E_LIVE=1 and E2E_TELEMETRY=1, and build with VITE_TELEMETRY_LOCAL=1 first",
  );
  // One worker, one pair of servers: both the authoring preview and the local
  // API worker are shared `--strictPort` processes for this whole file, so
  // parallel Playwright workers would race on the ports (AGENTS.md's 4173-reuse
  // trap, one port block over).
  test.describe.configure({ mode: "serial" });
  test.use({ baseURL: BASE_URL });
  test.setTimeout(300_000);

  let authoringServer: ChildProcess;
  let apiServer: ChildProcess;

  test.beforeAll(async () => {
    // The default hook timeout (60s) is not enough for wrangler dev's own
    // startup (the Sandbox container image check/build) plus the authoring
    // build plus the preview server — all sequential, all inside one hook.
    // F1 (V-triage): on a cold CI runner (no cached image layers) the
    // container check/build step alone can approach the old 180s budget,
    // so the whole hook intermittently tripped the timeout on attempt 1 and
    // only passed on Playwright's retry (masking the failure as green CI).
    // 360s gives the cold-build path real headroom without masking a hang.
    test.setTimeout(360_000);
    const authoringAlready = await fetch(BASE_URL).then(() => true).catch(() => false);
    if (authoringAlready) {
      throw new Error(
        `something is already answering on :${AUTHORING_PORT} — kill it first (lsof -ti :${AUTHORING_PORT} | xargs kill)`,
      );
    }
    const apiAlready = await fetch(API_BASE_URL).then(() => true).catch(() => false);
    if (apiAlready) {
      throw new Error(
        `something is already answering on :${API_PORT} — kill it first (lsof -ti :${API_PORT} | xargs kill)`,
      );
    }

    // The local API worker (Tier-2 needs Docker running — AGENTS.md). Started
    // before the authoring build: the build only reads the URL, it does not
    // need the server up yet, but starting it first means its own boot log is
    // visible in the console if it fails before the (slower) build even runs.
    apiServer = spawn(
      "node_modules/.bin/wrangler",
      ["dev", "--port", String(API_PORT), "--inspector-port", String(API_INSPECTOR_PORT)],
      { cwd: API_DIR, stdio: "pipe" },
    );
    let apiStderr = "";
    apiServer.stderr?.on("data", (chunk) => { apiStderr += String(chunk); });
    apiServer.stdout?.on("data", (chunk) => { apiStderr += String(chunk); });
    try {
      await waitForServer(API_BASE_URL, 60_000);
    } catch (err) {
      throw new Error(`local API worker on :${API_PORT} never came up: ${apiStderr || String(err)}`);
    }

    // A genuinely separate build: VITE_API_BASE/VITE_TELEMETRY_LOCAL are
    // build-time `import.meta.env` reads, so there is no way to point an
    // existing dist at this run's local API after the fact — see the file
    // header for why a bare VITE_TELEMETRY_LOCAL=1 build is not safe here.
    execSync(`node_modules/.bin/vite build --outDir ${OUT_DIR}`, {
      cwd: AUTHORING_DIR,
      env: { ...process.env, VITE_TELEMETRY_LOCAL: "1", VITE_API_BASE: API_BASE_URL },
      stdio: "pipe",
    });
    // AGENTS.md's own leak check (the dev-login bypass) — still applies to any
    // build. NOT a bare "demos.handsontable.com" grep: that string is
    // legitimately compiled in as the production-hostname constant
    // (`reportingGate.ts`) and in guide/error-message text, so it fires on
    // every build and would prove nothing. What this spec actually depends on
    // is that `API_BASE` compiled to the LOCAL worker, checked positively
    // below — a wrong host there is exactly the DEMOS-1x-shaped mistake this
    // file's header warns about, and the positive check catches it whether the
    // fallback silently won or `.env.production` did.
    const devLeak = execSync(`grep -rl "VITE_DEV_USER\\|dev@handsontable.com" ${OUT_DIR} || true`, {
      cwd: AUTHORING_DIR,
    }).toString().trim();
    if (devLeak) throw new Error(`dev-login bypass leaked into ${OUT_DIR}:\n${devLeak}`);
    const apiBaseCompiled = execSync(`grep -rl "localhost:${API_PORT}" ${OUT_DIR}/assets || true`, {
      cwd: AUTHORING_DIR,
    }).toString().trim();
    if (!apiBaseCompiled) {
      throw new Error(
        `VITE_API_BASE did not compile to http://localhost:${API_PORT} anywhere in ${OUT_DIR}/assets — ` +
          `a Tier-2 session from this run would target the wrong (or production) API`,
      );
    }

    authoringServer = spawn(
      "node_modules/.bin/vite",
      ["preview", "--outDir", OUT_DIR, "--port", String(AUTHORING_PORT), "--strictPort"],
      { cwd: AUTHORING_DIR, stdio: "pipe" },
    );
    let authoringStderr = "";
    authoringServer.stderr?.on("data", (chunk) => { authoringStderr += String(chunk); });
    try {
      await waitForServer(BASE_URL, 30_000);
    } catch (err) {
      throw new Error(`authoring preview on :${AUTHORING_PORT} never came up: ${authoringStderr || String(err)}`);
    }
  });

  test.afterAll(() => {
    authoringServer?.kill();
    apiServer?.kill();
  });

  test("Tier-1 (Sandpack): opening an example emits exactly one preview.ready_ms, tier=1, right framework — and a recompile does not re-emit", async ({
    page,
  }) => {
    // Only the login redirect neutered (T06's `stubShell` also aborts both
    // Sandpack hosts, which would prevent the live mount this test needs).
    await page.route("**/broker/login**", (route) => route.abort());
    const captured = captureTelemetry(page);

    await page.goto("/?example=react");
    await previewReady(page, "sandpack");
    await expectGridRendered(page);

    await expect.poll(() => measurementsOf(captured, "preview.ready_ms").length, { timeout: 30_000 }).toBe(1);
    const [point] = measurementsOf(captured, "preview.ready_ms");
    expect(point?.context?.["hot.tier"]).toBe("1");
    expect(point?.context?.["hot.framework"]).toBe("react");
    expect(point?.context?.["hot.outcome"]).toBe("ready");
    // T07 fix round: hot.bucket now survives the real browser scrub — a
    // non-empty string proves it reached the wire, not the `attrs.ts` unit
    // test's own literal input (this is the one attribute this Tier-1 flow
    // naturally sets; `reason`/`fingerprint` are proven against the real
    // `scrubTelemetry`/`toAePoint` functions in
    // `pipeline/telemetry-ae-only-attrs.test.mjs`, since neither a version
    // switch nor a compile error is part of this spec's flow).
    expect(typeof point?.context?.["hot.bucket"] === "string" && point.context["hot.bucket"].length > 0).toBe(true);
    const durationMs = point?.values?.duration_ms;
    expect(typeof durationMs === "number" && durationMs >= 0).toBe(true);
    test.info().annotations.push({
      type: "measured preview.ready_ms (tier 1, react)",
      description: String(durationMs),
    });

    // The recompile guard (`pipeline/browser-metrics.test.mjs` proves this
    // synthetically; this proves it against the real bundler): an edit
    // recompiles the sandbox (SandpackRuntime's `onReady` fires again on every
    // clean compile), and `preview.ready_ms` must not re-emit.
    const compileCountBefore = measurementsOf(captured, "sandpack.compile_ms").length;
    await insertAtTop(page, "// t07-e2e-recompile-probe");
    await expect
      .poll(() => measurementsOf(captured, "sandpack.compile_ms").length, { timeout: 30_000 })
      .toBeGreaterThan(compileCountBefore);
    expect(measurementsOf(captured, "preview.ready_ms").length, "guard: a recompile must not re-emit preview.ready_ms").toBe(1);
  });

  test("Tier-2 (container): opening an example emits exactly one preview.ready_ms, tier=2, right framework", async ({
    page,
    request,
  }) => {
    test.setTimeout(300_000);
    const tracked = trackSessions(page);
    try {
      await page.route("**/broker/login**", (route) => route.abort());
      const captured = captureTelemetry(page);

      await page.goto("/?example=react-js");
      await previewReady(page, "container");
      await expectGridRendered(page);

      await expect.poll(() => measurementsOf(captured, "preview.ready_ms").length, { timeout: 30_000 }).toBe(1);
      const [point] = measurementsOf(captured, "preview.ready_ms");
      expect(point?.context?.["hot.tier"]).toBe("2");
      expect(point?.context?.["hot.framework"]).toBe("react-js");
      expect(point?.context?.["hot.outcome"]).toBe("ready");
      const durationMs = point?.values?.duration_ms;
      expect(typeof durationMs === "number" && durationMs >= 0).toBe(true);
      test.info().annotations.push({
        type: "measured preview.ready_ms (tier 2, react-js)",
        description: String(durationMs),
      });

      // session.start_ms rides the same create-POST clock; it must also have
      // fired exactly once by the time the preview is ready.
      await expect.poll(() => measurementsOf(captured, "session.start_ms").length).toBe(1);
      expect(measurementsOf(captured, "session.start_ms")[0]?.context?.["hot.outcome"]).toBe("ready");

      // An edit, for the HMR observation (T07-D4's support table) and the same
      // no-re-emission guard `preview.ready_ms` gets on Tier-1. Not gated on
      // an `hmr.roundtrip_ms` point actually landing — the Outcome's support
      // table predicts most starters use in-place HMR, which this hook cannot
      // see (see `HmrRoundtripEvent`'s doc comment).
      await insertAtTop(page, "// t07-e2e-hmr-probe");
      await page.waitForTimeout(5_000);
      expect(
        measurementsOf(captured, "preview.ready_ms").length,
        "guard: an edit must not re-emit preview.ready_ms on Tier-2 either",
      ).toBe(1);
      const hmr = measurementsOf(captured, "hmr.roundtrip_ms");
      test.info().annotations.push({
        type: "hmr.roundtrip_ms observed on react-js",
        description: hmr.length > 0 ? String(hmr[0]?.values?.duration_ms) : "not observed (see T07-D4 / the support table)",
      });
    } finally {
      await tracked.cleanup(request);
    }
  });
});
