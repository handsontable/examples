import { test, expect } from "@playwright/test";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { previewReady, expectGridRendered } from "./helpers.js";

// T11 — the automatable slice of the local end-to-end walkthrough
// (ADR-0041 §L, docs/run-and-deploy.md's local-dev section). Unlike
// T06's `telemetry-faro.spec.ts` and T07's `telemetry-metrics.spec.ts`,
// this spec does NOT mock `/telemetry/*` with `page.route` — the whole
// point is that a real browser's telemetry reaches the REAL o11y worker
// and is queryable back out of the REAL (local) Analytics Engine sink,
// proving the wiring T02–T08 built, not just each task's own unit tests.
//
// Preconditions (own port block, COMMON.md 5200-5299 — NOT the shared
// playwright.config.ts webServer on :4173, and NOT any other task's
// ports):
//
//   1. Local ClickHouse + MinIO (T01's compose stand-in for Analytics
//      Engine + the Loki bucket), on this spec's own ports:
//        COMPOSE_PROJECT_NAME=o11y-t11-e2e \
//        O11Y_MINIO_PORT=5210 O11Y_MINIO_CONSOLE_PORT=5211 \
//        O11Y_CLICKHOUSE_PORT=5212 O11Y_CLICKHOUSE_NATIVE_PORT=5213 \
//        AE_SQL_TOKEN=local-dev-token \
//        docker compose -f containers/o11y/compose.yml up -d --wait minio clickhouse
//      (T1: no more separate `minio-init` container — `minio` creates its
//      own `loki` bucket via MINIO_DEFAULT_BUCKETS before its healthcheck
//      goes green; `--wait` blocks on that.)
//   2. `workers/o11y/.dev.vars` (copy from `.dev.vars.example`, fill in
//      O11Y_ENV=local, DEV_ADMIN, O11Y_EXPORT_SECRET, SENTRY_HOOK_SECRET,
//      AE_SQL_TOKEN=local-dev-token, O11Y_LOCAL_MINIO_PORT=5210,
//      O11Y_LOCAL_CLICKHOUSE_PORT=5212, RUNNER_EVENTS_CLICKHOUSE_URL=
//      http://localhost:5212 — the last one only works with T11's fix to
//      `normalise/points.ts#aeSink`, see the T11 report).
//   3. `workers/api/.dev.vars` (copy from the main checkout per COMMON.md,
//      add RUNNER_EVENTS_CLICKHOUSE_URL=http://localhost:5212 and
//      AE_SQL_TOKEN=local-dev-token; PREVIEW_HOST must stay a non-production
//      host, e.g. localhost:8799, or the API worker starts reporting to the
//      real Sentry project).
//   4. `apps/authoring/vite.config.ts`'s dev proxy is not used here (this
//      spec builds a real dist and serves it standalone) — instead the
//      build points `VITE_API_BASE` straight at this spec's API worker,
//      the same shape `telemetry-metrics.spec.ts` already uses.
//
// This spec starts (and tears down) its own o11y + API `wrangler dev`
// processes and its own authoring dist/preview server; it does NOT start
// docker or apply D1 migrations — those are one-time local setup, same
// division of labour `telemetry-metrics.spec.ts`'s header already
// documents for the API worker alone (Tier-2 needs Docker running).
//
//   cd workers/o11y && WRANGLER_REGISTRY_PATH=<your worktree>/.wrangler-registry \
//     npx wrangler dev --port 5220 --inspector-port 5221
//   (or `O11Y_DEV_PORT=5220 O11Y_DEV_INSPECTOR_PORT=5221 node ../../scripts/o11y-dev.mjs`)
//   cd workers/api && npx wrangler d1 migrations apply handsontable-demos --local
//   E2E_O11Y_LOCAL=1 pnpm e2e e2e/o11y-local.spec.ts
//
// CI home: `.github/workflows/e2e-o11y-local.yml` (R1-followups) — on
// workflow_dispatch, nightly, and PRs touching the o11y ingest path, never
// the per-PR `ci.yml` gate (docs/TESTING.md's "every gate needs a workflow
// home" rule, docs/run-and-deploy.md's "Tests (CI)" section): the
// prerequisite stack is Docker + two `wrangler dev` processes + D1
// migrations, the same class of gap T10 already left
// `telemetry-metrics.spec.ts` with. Also run it locally before every o11y
// change that touches the ingest path, and before a launch.

// Env-overridable (COMMON.md's per-worktree port block rule), same reasoning
// telemetry-metrics.spec.ts gives — O11Y_PORT/CLICKHOUSE_PORT below already
// were. Defaults unchanged.
const AUTHORING_PORT = Number(process.env.E2E_O11Y_LOCAL_AUTHORING_PORT ?? 5290);
const API_PORT = Number(process.env.E2E_O11Y_LOCAL_API_PORT ?? 5280);
const API_INSPECTOR_PORT = Number(process.env.E2E_O11Y_LOCAL_API_INSPECTOR_PORT ?? 5281);
const O11Y_PORT = Number(process.env.O11Y_DEV_PORT ?? 5220);
const CLICKHOUSE_PORT = Number(process.env.O11Y_LOCAL_CLICKHOUSE_PORT ?? 5212);
const BASE_URL = `http://localhost:${AUTHORING_PORT}`;
const API_BASE_URL = `http://localhost:${API_PORT}`;
const O11Y_BASE_URL = `http://localhost:${O11Y_PORT}`;
const AUTHORING_DIR = fileURLToPath(new URL("../apps/authoring", import.meta.url));
const API_DIR = fileURLToPath(new URL("../workers/api", import.meta.url));
const OUT_DIR = "dist-o11y-local";

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

/** Queries the local ClickHouse stand-in for Analytics Engine directly —
 *  the same table/columns `clickhouseSink` writes (contract §10), the same
 *  one `workers/o11y/src/normalise/points.ts#aeSink` and
 *  `workers/api/src/telemetry/resource.ts`'s sink selection write to in
 *  local mode. Not through Grafana/the AE-query allowlist (T04's own
 *  module) — this spec checks the point landed, not that a dashboard query
 *  can read it back, which `pipeline/o11y-dashboards.test.mjs` already
 *  covers deterministically. */
async function chRows(sql: string): Promise<Record<string, string>[]> {
  const res = await fetch(`http://localhost:${CLICKHOUSE_PORT}/?default_format=JSONEachRow`, {
    method: "POST",
    headers: { "X-ClickHouse-User": "default", "X-ClickHouse-Key": "local-dev-token" },
    body: sql,
  });
  if (!res.ok) throw new Error(`ClickHouse query failed (${res.status}): ${await res.text()}`);
  const text = await res.text();
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// `timestamp` is `DateTime64(3)`; comparing it against a bare integer
// literal silently uses ClickHouse's *seconds* interpretation (measured
// live against this task's own compose stack — a bare-integer `WHERE
// timestamp >= <epoch ms>` returned zero rows for data inserted seconds
// earlier). `toUnixTimestamp64Milli` makes the comparison explicit and
// matches the millisecond encoding `sink.ts#clickhouseTimestamp` (T00-D2)
// writes.
async function pointsFor(metric: string, sinceMs: number): Promise<Record<string, string>[]> {
  return chRows(
    `SELECT * FROM runner_events WHERE index1 = '${metric}' AND toUnixTimestamp64Milli(timestamp) >= ${sinceMs} FORMAT JSONEachRow`,
  );
}

test.describe("o11y local end-to-end (T11)", () => {
  test.skip(process.env.E2E_O11Y_LOCAL !== "1", "set E2E_O11Y_LOCAL=1 — needs Docker + two wrangler dev processes, see the file header");
  // One shared authoring+API pair for the whole file, the same reasoning
  // telemetry-metrics.spec.ts gives (a second Playwright worker would race
  // on these `--strictPort` processes).
  test.describe.configure({ mode: "serial" });
  test.use({ baseURL: BASE_URL });
  test.setTimeout(180_000);

  let authoringServer: ChildProcess;
  let apiServer: ChildProcess;

  test.beforeAll(async () => {
    test.setTimeout(360_000);

    const o11yUp = await fetch(O11Y_BASE_URL).then(() => true).catch(() => false);
    if (!o11yUp) {
      throw new Error(
        `no o11y worker answering on ${O11Y_BASE_URL} — start it first (see this file's header): ` +
          `cd workers/o11y && WRANGLER_REGISTRY_PATH=<worktree>/.wrangler-registry npx wrangler dev --port ${O11Y_PORT}`,
      );
    }
    const chUp = await fetch(`http://localhost:${CLICKHOUSE_PORT}/ping`).then((r) => r.ok).catch(() => false);
    if (!chUp) {
      throw new Error(
        `no local ClickHouse answering on :${CLICKHOUSE_PORT} — start compose first (see this file's header)`,
      );
    }

    const apiAlready = await fetch(API_BASE_URL).then(() => true).catch(() => false);
    if (apiAlready) {
      throw new Error(`something is already answering on :${API_PORT} — kill it first (lsof -ti :${API_PORT} | xargs kill)`);
    }

    // The API worker keeps containers enabled: the /d test's Fork is
    // "fork -> build -> R2", and the build runs in a container. Starting it
    // with `--enable-containers=false` (an earlier F1 flake fix) made Fork
    // fail with no redirect to /edit/. The cold-runner image step is covered
    // by the longer hook timeout above instead.
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

    // A real build, not a mocked one: VITE_API_BASE/VITE_TELEMETRY_LOCAL/
    // VITE_DEV_USER are build-time `import.meta.env` reads. VITE_DEV_USER
    // opens the local auth bypass (`auth.ts`) — this dist must never be
    // treated as shippable (same rule `check:telemetry-leak` enforces for
    // VITE_TELEMETRY_LOCAL); it exists only for this gated, local-only spec.
    execSync(`node_modules/.bin/vite build --outDir ${OUT_DIR}`, {
      cwd: AUTHORING_DIR,
      env: {
        ...process.env,
        VITE_TELEMETRY_LOCAL: "1",
        VITE_DEV_USER: "t11-e2e@handsontable.com",
        VITE_API_BASE: API_BASE_URL,
        VITE_SENTRY_SCOPE: "full",
      },
      stdio: "pipe",
    });
    const apiBaseCompiled = execSync(`grep -rl "localhost:${API_PORT}" ${OUT_DIR}/assets || true`, {
      cwd: AUTHORING_DIR,
    }).toString().trim();
    if (!apiBaseCompiled) {
      throw new Error(
        `VITE_API_BASE did not compile to http://localhost:${API_PORT} anywhere in ${OUT_DIR}/assets — ` +
          `this run would otherwise talk to the wrong (or production) API`,
      );
    }

    // Faro's transport always posts to SAME-ORIGIN `/telemetry/collect`, and
    // the `/d`/`/embed` lite beacon (T08) posts to SAME-ORIGIN
    // `/telemetry/lite` too (contract §6/§9) — there is no
    // `VITE_TELEMETRY_BASE` the way there is a `VITE_API_BASE`, so this
    // preview server must proxy BOTH `/telemetry/*` (to the real o11y
    // worker) and `/d`/`/embed` (to the real API worker) itself, the same
    // "one origin stands in for production's one zone" trick
    // `vite.config.ts`'s own header comment explains. `vite preview` reads
    // `server.proxy` from `vite.config.ts` the same way `vite dev` does
    // (measured live for this task, not assumed) — `O11Y_DEV_PORT` (T01) and
    // `API_DEV_PORT` (T11, this task's own minimal fix to the proxy's other
    // wise-hardcoded `:8787` target — see the T11 report) are that config's
    // own env vars, read at this process's startup. Navigating straight at
    // the API worker's own origin for `/d/:id` (skipping this proxy) was
    // tried first and found live to be the wrong move: the lite beacon it
    // serves would then post to the API worker's OWN origin, which has no
    // `/telemetry/*` route at all — a 404 the production zone's shared
    // routing never lets happen.
    authoringServer = spawn(
      "node_modules/.bin/vite",
      ["preview", "--outDir", OUT_DIR, "--port", String(AUTHORING_PORT), "--strictPort"],
      {
        cwd: AUTHORING_DIR,
        stdio: "pipe",
        env: { ...process.env, O11Y_DEV_PORT: String(O11Y_PORT), API_DEV_PORT: String(API_PORT) },
      },
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

  test("Tier-1 preview.ready_ms reaches the real o11y worker and lands in Analytics Engine", async ({ page }) => {
    const sinceMs = Date.now() - 5_000;
    const collectRequests: number[] = [];
    page.on("response", (res) => {
      if (res.url().includes("/telemetry/collect")) collectRequests.push(res.status());
    });

    await page.goto("/?example=react");
    await previewReady(page, "sandpack");
    await expectGridRendered(page);

    // The request genuinely left the browser and reached the real o11y
    // worker (not intercepted) — a 204 from anywhere else (a stale proxy
    // target, a 404 from the authoring server itself) would fail this.
    await expect.poll(() => collectRequests, { timeout: 15_000 }).toContain(204);

    // The real ingest pipeline wrote a real Analytics Engine point — not a
    // captured request body, an actual row read back out of the sink T02
    // wired. `emitPoint`/normalise are fire-and-forget past the 204
    // (T05/T02's own doc comments), so this polls rather than asserting
    // once.
    const rows = await expect
      .poll(async () => pointsFor("preview.ready_ms", sinceMs), { timeout: 15_000, message: "preview.ready_ms never landed in ClickHouse" })
      .not.toHaveLength(0)
      .then(() => pointsFor("preview.ready_ms", sinceMs));
    const point = rows[rows.length - 1];
    expect(point.blob5, "hot.tier").toBe("1");
    expect(point.blob6, "hot.framework").toBe("react");
    expect(point.blob8, "outcome").toBe("ready");
    expect(point.blob1, "service.name").toBe("demos-authoring");
  });

  test("a forced /d error reaches the real o11y worker as a demos-embed lite beacon point", async ({ page, request }) => {
    // Fork + save a real demo through the real API worker (T12's exampleAnalytics
    // path, D1-backed) — the same real Fork/Save flow the walkthrough exercises
    // by hand, not a stubbed fixture, so `/d/:id` really serves through
    // `serveDemoAsset`'s injection seam (T08).
    await page.goto("/?example=react&v=18.1.1");
    await previewReady(page, "sandpack");
    await page.getByRole("button", { name: "Fork" }).click();
    await expect(page).toHaveURL(/\/edit\//);
    const demoId = new URL(page.url()).pathname.split("/edit/")[1];
    await page.getByRole("button", { name: "Save" }).click();

    const sinceMs = Date.now() - 2_000;
    await page.goto(`/d/${demoId}`);
    // A real uncaught error on the /d page, caught by the injected lite
    // reporter's own `window.addEventListener("error", ...)` (packages/runtime/
    // src/monitor.ts) — 100% sampled, unlike web vitals.
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error("t11-o11y-local forced /d error");
      }, 0);
    });

    const rows = await expect
      .poll(
        async () =>
          chRows(
            `SELECT * FROM runner_events WHERE index1 = 'error.uncaught' AND blob1 = 'demos-embed' AND toUnixTimestamp64Milli(timestamp) >= ${sinceMs} FORMAT JSONEachRow`,
          ),
        { timeout: 15_000, message: "no demos-embed error.uncaught point landed in ClickHouse" },
      )
      .not.toHaveLength(0)
      .then(() =>
        chRows(
          `SELECT * FROM runner_events WHERE index1 = 'error.uncaught' AND blob1 = 'demos-embed' AND toUnixTimestamp64Milli(timestamp) >= ${sinceMs} FORMAT JSONEachRow`,
        ),
      );
    expect(rows[rows.length - 1].blob4, "hot.surface").toBe("d");

    await request.delete(`${API_BASE_URL}/api/demos/${demoId}`).catch(() => {});
  });
});
