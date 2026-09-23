import { test, expect, type Route, type Page } from "@playwright/test";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stubShell } from "./helpers.js";

// T06 — Faro in the authoring app.
//
// Gated: needs a dist built with VITE_TELEMETRY_LOCAL=1 (contract §10), served
// on its own port (this task's 4700-4799 block — never 4173, which another
// worktree's `vite preview` may already hold, AGENTS.md). No o11y worker
// needed: `/telemetry/collect` is captured with `page.route`, per the
// controller's note that T02 is not in this base.
//
//   VITE_TELEMETRY_LOCAL=1 pnpm --filter @handsontable/demo-authoring build
//   E2E_TELEMETRY=1 pnpm e2e e2e/telemetry-faro.spec.ts
//
// This spec manages its own preview server (not the shared playwright.config.ts
// webServer, which serves :4173 without the flag) so it never depends on, or
// interferes with, whatever `dist` another spec run left behind.

const PORT = 4711;
const BASE_URL = `http://localhost:${PORT}`;
const AUTHORING_DIR = fileURLToPath(new URL("../apps/authoring", import.meta.url));

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

/** One decoded Faro transport body — the shape `FetchTransport` posts to
 *  `/telemetry/collect` (`@grafana/faro-core`'s `TransportBody`). */
interface FaroBody {
  meta?: Record<string, unknown>;
  exceptions?: Record<string, unknown>[];
  logs?: Record<string, unknown>[];
  measurements?: Record<string, unknown>[];
  events?: Record<string, unknown>[];
}

/**
 * Fix round I3's e2e-only hooks (`sentry.ts`'s `localTestSentryEnabled()`
 * branch — `window.__t06SentryCapture`, `window.__t06ReportDemoEvent`), read
 * from the browser. Every Sentry envelope is `[EnvelopeHeader, Item[]]`; each
 * `Item` is `[ItemHeader, payload]`. This flattens to just the `event`-typed
 * payloads (skips session/client-report items Sentry may also queue), which
 * is all these tests need.
 */
function readSentryEvents(page: Page): Promise<Record<string, unknown>[]> {
  return page.evaluate(() => {
    const envelopes =
      (window as unknown as { __t06SentryCapture?: unknown[][] }).__t06SentryCapture ?? [];
    const events: Record<string, unknown>[] = [];
    for (const envelope of envelopes) {
      const items = (envelope[1] as unknown[][]) ?? [];
      for (const item of items) {
        const header = item[0] as { type?: string } | undefined;
        if (header?.type === "event") events.push(item[1] as Record<string, unknown>);
      }
    }
    return events;
  });
}

/** `window.__t06ReportDemoEvent`, called from the browser with a minimal
 *  `MonitorPayload`/`DemoEventContext` pair — bypasses `monitorDemos` (see
 *  `sentry.ts#reportDemoEventUnguarded`'s doc comment) so this deterministic
 *  spec can drive `reportDemoEvent`'s reporting logic without a real
 *  (E2E_LIVE-gated) preview mount. */
function callReportDemoEvent(page: Page, message: string): Promise<void> {
  return page.evaluate((msg) => {
    (
      window as unknown as {
        __t06ReportDemoEvent?: (
          payload: { type: string; kind: string; message: string },
          context: { tier: number; framework: string },
        ) => void;
      }
    ).__t06ReportDemoEvent?.(
      { type: "hot-runner-monitor", kind: "error", message: msg },
      { tier: 1, framework: "react" },
    );
  }, message);
}

test.describe("Faro in the authoring app (T06)", () => {
  test.skip(
    process.env.E2E_TELEMETRY !== "1",
    "set E2E_TELEMETRY=1 and build with VITE_TELEMETRY_LOCAL=1 first",
  );
  // One worker, one server: `beforeAll`/`afterAll` are per-worker, and this
  // suite's `--strictPort` preview process is shared state — under the
  // default `fullyParallel` config (playwright.config.ts) each of Playwright's
  // parallel workers would spawn its own and race on the port, with whichever
  // worker's `afterAll` fires first killing the server underneath the others.
  test.describe.configure({ mode: "serial" });
  test.use({ baseURL: BASE_URL });

  let server: ChildProcess;

  test.beforeAll(async () => {
    // Fail loudly rather than silently reusing whatever already answers on
    // this port (the exact 4173-reuse trap AGENTS.md warns about, one port
    // block over) — a stale server from an earlier interrupted run would
    // otherwise serve an unknown build and every assertion below would be
    // testing the wrong bits.
    const already = await fetch(BASE_URL).then(() => true).catch(() => false);
    if (already) {
      throw new Error(
        `something is already answering on :${PORT} — kill it first (lsof -ti :${PORT} | xargs kill)`,
      );
    }
    server = spawn(
      "node_modules/.bin/vite",
      ["preview", "--port", String(PORT), "--strictPort"],
      { cwd: AUTHORING_DIR, stdio: "pipe" },
    );
    let stderr = "";
    server.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    try {
      await waitForServer(BASE_URL, 30_000);
    } catch (err) {
      throw new Error(`preview server on :${PORT} never came up: ${stderr || String(err)}`);
    }
  });

  test.afterAll(() => {
    server?.kill();
  });

  /** Every `/telemetry/collect` POST this test has seen, decoded. Registered
   *  before navigation so nothing is missed. */
  function captureTelemetry(page: import("@playwright/test").Page): FaroBody[] {
    const bodies: FaroBody[] = [];
    void page.route("**/telemetry/collect", async (route: Route) => {
      const body = route.request().postDataJSON() as FaroBody;
      bodies.push(body);
      await route.fulfill({ status: 200, body: "" });
    });
    return bodies;
  }

  // Fix round D-I2: `beforeSend` must apply the shared noise gates
  // (contract §6) to Faro exception items, same as Sentry's own
  // `beforeSend` already did — otherwise a benign ResizeObserver-loop
  // warning (or any of the other `isUnhandledNoise`/`isForeignUnhandled`
  // shapes) reaches Loki AND mints a fresh §F.3 `fp:` first-seen entry,
  // paging on noise Sentry has always filtered.
  test("D-I2: an unhandled ResizeObserver-loop warning does NOT reach Faro (shared noise gate)", async ({ page }) => {
    await stubShell(page);
    const captured = captureTelemetry(page);
    await page.goto("/");

    const marker = "T06 e2e D-I2 noise probe " + Date.now();
    await page.evaluate((msg) => {
      setTimeout(() => {
        throw new Error(`ResizeObserver loop completed with undelivered notifications. (${msg})`);
      });
    }, marker);

    // A real, non-noise probe right after, on the same page — proves the
    // page (and Faro transport) is still alive and would have captured the
    // noise probe too if the gate had not dropped it, rather than this
    // being a false pass from nothing having run yet.
    await page.evaluate((msg) => {
      setTimeout(() => { throw new Error(`T06 e2e D-I2 control probe (${msg})`); });
    }, marker);
    await expect
      .poll(() => captured.flatMap((b) => b.exceptions ?? []).some((e) => String(e.value ?? "").includes("control probe")))
      .toBe(true);

    const noiseHit = captured.flatMap((b) => b.exceptions ?? []).find((e) => String(e.value ?? "").includes(marker) && !String(e.value ?? "").includes("control probe"));
    assert(!noiseHit, "a ResizeObserver-loop warning must never reach Faro/telemetry/collect");
  });

  test("an uncaught error reaches Faro (window.onerror, via ErrorsInstrumentation)", async ({ page }) => {
    await stubShell(page);
    const captured = captureTelemetry(page);
    await page.goto("/");

    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error("T06 e2e uncaught probe " + Date.now());
      });
    });

    await expect.poll(() => captured.flatMap((b) => b.exceptions ?? []).length).toBeGreaterThan(0);
    const exception = captured.flatMap((b) => b.exceptions ?? []).find((e) =>
      String(e.value ?? "").includes("T06 e2e uncaught probe"),
    );
    assert(exception, "no exception item matched the probe message");
    // Uncaught: NOT tagged handled — the facade's own `.error()` always sets
    // `context.handled = "true"` (contract §6); Faro's automatic
    // ErrorsInstrumentation never does.
    assert(
      (exception.context as Record<string, unknown> | undefined)?.handled !== "true",
      "an uncaught window error must not carry context.handled = 'true'",
    );
  });

  test("a render crash inside the error boundary reaches Faro too, still not handled", async ({ page }) => {
    await stubShell(page);
    const captured = captureTelemetry(page);
    await page.goto("/?__test_crash_boundary=1");

    // The boundary's own fallback UI is Sentry's half of the tee — it can only
    // render if Sentry.ErrorBoundary's componentDidCatch actually ran.
    await expect(page.getByText("Something went wrong")).toBeVisible();

    await expect.poll(() => captured.flatMap((b) => b.exceptions ?? []).length).toBeGreaterThan(0);
    const exception = captured.flatMap((b) => b.exceptions ?? []).find((e) =>
      String(e.value ?? "").includes("T06 e2e render-crash probe"),
    );
    assert(exception, "no exception item matched the render-crash probe message");
    assert(
      (exception.context as Record<string, unknown> | undefined)?.handled !== "true",
      "a render crash must not carry context.handled = 'true' — it is uncaught (ADR §E.1), just relayed manually",
    );
  });

  test("reportError (a handled diagnostic) reaches Faro, fingerprinted by its context, tagged handled=true", async ({ page }) => {
    await page.route("**/api/versions", (route) => route.fulfill({ status: 500, body: "boom" }));
    await page.route("https://sandpack.codesandbox.io/**", (route) => route.abort());
    await page.route("https://sandpack-bundler.codesandbox.io/**", (route) => route.abort());
    await page.route("**/broker/login**", (route) => route.abort());
    const captured = captureTelemetry(page);
    await page.goto("/");

    await expect.poll(() => captured.flatMap((b) => b.exceptions ?? []).length).toBeGreaterThan(0);
    // Found by `fingerprint` (contract §7, `fingerprint(context, message)`) —
    // a top-level Faro exception field the scrubber never touches, so it
    // alone already proves this reached Faro even before checking `context`.
    const exception = captured
      .flatMap((b) => b.exceptions ?? [])
      .find((e) => String(e.fingerprint ?? "").startsWith("versions-fetch:"));
    assert(exception, "no exception item fingerprinted versions-fetch:… — reportError never reached Faro");
    // T06 fix round D1: `handled` is now in `attrs.ts#DIAGNOSTIC_TAG_KEYS`
    // (`packages/runtime/src/telemetry/attrs.ts`, contract §3 "Diagnostic
    // tags"), so the browser-side scrub keeps it — this used to be the
    // spec's KNOWN RED case (T06-D1); fixed in the same fix round, in its own
    // commit against the T00-owned contract module (`fix(contract): ...`).
    assert(
      (exception.context as Record<string, unknown> | undefined)?.handled === "true",
      "reportError must tag every Faro push context.handled = 'true' (contract §6 error.handled split)",
    );
  });

  test("API requests carry x-hot-session, matching the Faro session id", async ({ page }) => {
    await stubShell(page);
    let versionsHeader: string | undefined;
    await page.route("**/api/versions", async (route) => {
      versionsHeader = route.request().headers()["x-hot-session"];
      await route.fulfill({ json: { latest: "18.0.0", next: null, versions: ["18.0.0"] } });
    });
    const captured = captureTelemetry(page);
    await page.goto("/");
    await page.evaluate(() => {
      setTimeout(() => { throw new Error("T06 e2e header probe"); });
    });
    await expect.poll(() => captured.length).toBeGreaterThan(0);

    assert(versionsHeader, "GET /api/versions carried no x-hot-session header");
    const sessionId = captured[0]?.meta?.session as { id?: string } | undefined;
    assert(sessionId?.id, "no Faro item carried meta.session.id");
    assert(
      versionsHeader === sessionId.id,
      `x-hot-session (${versionsHeader}) must equal the Faro page-load id (${sessionId.id}) — same in-memory id, contract §6`,
    );
  });

  test("nothing is written to localStorage or sessionStorage by Faro or the facade", async ({ page }) => {
    await stubShell(page);
    const captured = captureTelemetry(page);
    await page.goto("/");
    await page.evaluate(() => {
      setTimeout(() => { throw new Error("T06 e2e storage probe"); });
    });
    await expect.poll(() => captured.length).toBeGreaterThan(0);
    // Faro's (disabled) persistent-session write is debounced
    // (`STORAGE_UPDATE_DELAY`, 1s in the SDK) — give it the chance to land
    // before asserting its absence, or this assertion would pass for the
    // wrong reason (too early to have seen a write that will still happen).
    await page.waitForTimeout(1_500);

    const keys = await page.evaluate(() => ({
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
    }));
    for (const key of [...keys.local, ...keys.session]) {
      assert(
        !key.toLowerCase().includes("faro"),
        `Faro/facade must write no storage key — found "${key}" (contract §6/§10)`,
      );
    }
  });

  test("no captured payload carries a query string, a user-agent string, an email, console text, or a Babel code frame", async ({ page }) => {
    await page.route("**/api/versions", (route) => route.fulfill({ status: 500, body: "boom" }));
    await page.route("https://sandpack.codesandbox.io/**", (route) => route.abort());
    await page.route("https://sandpack-bundler.codesandbox.io/**", (route) => route.abort());
    await page.route("**/broker/login**", (route) => route.abort());
    const captured = captureTelemetry(page);
    // A harmless query param + fragment on the page URL itself — `App.tsx`
    // does not recognise `probeleak`, so the app renders its ordinary `/`
    // route; the only thing under test is whether Faro's `meta.page.url`
    // strips it (contract §3: "strip query strings and fragments from every
    // URL-valued field").
    await page.goto("/?probeleak=should-be-stripped#fragment");
    await page.evaluate(() => {
      setTimeout(() => { throw new Error("T06 e2e scrub probe"); });
    });
    await expect.poll(() => captured.flatMap((b) => b.exceptions ?? []).length).toBeGreaterThanOrEqual(2);

    const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
    // A real Chrome UA always names the engine and the platform together.
    const UA_RE = /Mozilla\/5\.0|AppleWebKit|Gecko\)/;
    const CODE_FRAME_GUTTER_RE = /^[ \t]*>?[ \t]*\d+[ \t]*\|/m;
    const QUERY_STRING_RE = /\?[a-zA-Z0-9_=&%-]+=|probeleak=should-be-stripped/;

    function scan(value: unknown, path: string): void {
      if (typeof value === "string") {
        assert(!EMAIL_RE.test(value), `email-shaped string at ${path}: ${JSON.stringify(value)}`);
        assert(!UA_RE.test(value), `user-agent string at ${path}: ${JSON.stringify(value)}`);
        assert(!CODE_FRAME_GUTTER_RE.test(value), `Babel code-frame gutter at ${path}: ${JSON.stringify(value)}`);
        assert(!QUERY_STRING_RE.test(value), `query string survived at ${path}: ${JSON.stringify(value)}`);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((v, i) => scan(v, `${path}[${i}]`));
        return;
      }
      if (value !== null && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) scan(v, `${path}.${k}`);
      }
    }
    captured.forEach((body, i) => scan(body, `body[${i}]`));
  });

  // ---- Fix round I3: "an uncaught error reaches Sentry (transport spy)" ----
  //
  // Three cases, all against this describe block's `full`-scope build (the
  // default — no VITE_SENTRY_SCOPE set): uncaught always reaches Sentry;
  // reportError and demo-runtime reach it too, because full scope keeps
  // today's behaviour. The mirror describe block below rebuilds with
  // VITE_SENTRY_SCOPE=uncaught and proves the opposite for the latter two.

  test("I3: an uncaught error reaches Sentry (transport spy)", async ({ page }) => {
    await stubShell(page);
    await page.goto("/");
    await page.evaluate(() => {
      setTimeout(() => { throw new Error("T06 e2e I3 uncaught probe " + Date.now()); });
    });
    await expect.poll(() => readSentryEvents(page).then((e) => e.length)).toBeGreaterThan(0);
    const events = await readSentryEvents(page);
    const hit = events.find((e) =>
      JSON.stringify((e as { exception?: unknown }).exception ?? "").includes("T06 e2e I3 uncaught probe"),
    );
    assert(hit, "no Sentry event matched the uncaught probe message");
  });

  test("I3: reportError reaches Sentry under full scope", async ({ page }) => {
    await page.route("**/api/versions", (route) => route.fulfill({ status: 500, body: "boom" }));
    await page.route("https://sandpack.codesandbox.io/**", (route) => route.abort());
    await page.route("https://sandpack-bundler.codesandbox.io/**", (route) => route.abort());
    await page.route("**/broker/login**", (route) => route.abort());
    await page.goto("/");
    await expect.poll(() => readSentryEvents(page).then((e) => e.length)).toBeGreaterThan(0);
    const events = await readSentryEvents(page);
    const hit = events.find((e) => (e as { tags?: { context?: string } }).tags?.context === "versions-fetch");
    assert(hit, "no Sentry event tagged context=versions-fetch — reportError did not reach Sentry under full scope");
  });

  test("I3: a demo-runtime event reaches Sentry under full scope, re-homed to the demo-runtime environment", async ({ page }) => {
    await stubShell(page);
    await page.goto("/");
    await callReportDemoEvent(page, "T06 e2e I3 demo-runtime probe");
    await expect.poll(() => readSentryEvents(page).then((e) => e.length)).toBeGreaterThan(0);
    const events = await readSentryEvents(page);
    const hit = events.find((e) => (e as { tags?: { surface?: string } }).tags?.surface === "demo-runtime");
    assert(hit, "no Sentry event tagged surface=demo-runtime — reportDemoEvent did not reach Sentry under full scope");
    // Fix round I1: the re-homing that beforeSend restored.
    assert(
      (hit as { environment?: string }).environment === "demo-runtime",
      `demo-runtime event must be re-homed to environment "demo-runtime", got ${JSON.stringify((hit as { environment?: string }).environment)}`,
    );
  });
});

// ---- Sentry scope switch = uncaught (fix round I1/I3) -----------------------
//
// A second dist, built by this describe block's own `beforeAll` with
// VITE_SENTRY_SCOPE=uncaught (a build-time define — not overridable per-request,
// so this needs its own build and its own port). Proves the OTHER half of the
// scope truth table: uncaught still reaches Sentry (ADR §E.1: it always does,
// regardless of scope), but reportError and demo-runtime do not (ADR §E.3:
// moved diagnostic reports go to the facade only once the scope is uncaught).
test.describe("Sentry scope switch = uncaught (fix round I1/I3)", () => {
  test.skip(
    process.env.E2E_TELEMETRY !== "1",
    "set E2E_TELEMETRY=1 and build with VITE_TELEMETRY_LOCAL=1 first",
  );
  test.describe.configure({ mode: "serial" });

  const UNCAUGHT_PORT = 4712;
  const UNCAUGHT_BASE_URL = `http://localhost:${UNCAUGHT_PORT}`;
  const OUT_DIR = "dist-uncaught-scope";
  test.use({ baseURL: UNCAUGHT_BASE_URL });

  let server: ChildProcess;

  test.beforeAll(async () => {
    const already = await fetch(UNCAUGHT_BASE_URL).then(() => true).catch(() => false);
    if (already) {
      throw new Error(
        `something is already answering on :${UNCAUGHT_PORT} — kill it first (lsof -ti :${UNCAUGHT_PORT} | xargs kill)`,
      );
    }
    // A genuinely separate build: VITE_SENTRY_SCOPE is a build-time
    // `import.meta.env` read (`sentry.ts`'s `resolveSentryScope`), so there is
    // no way to flip it per-request against the `full`-scope dist above.
    execSync("node_modules/.bin/vite build --outDir " + OUT_DIR, {
      cwd: AUTHORING_DIR,
      env: { ...process.env, VITE_TELEMETRY_LOCAL: "1", VITE_SENTRY_SCOPE: "uncaught" },
      stdio: "pipe",
    });
    server = spawn(
      "node_modules/.bin/vite",
      ["preview", "--outDir", OUT_DIR, "--port", String(UNCAUGHT_PORT), "--strictPort"],
      { cwd: AUTHORING_DIR, stdio: "pipe" },
    );
    let stderr = "";
    server.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    try {
      await waitForServer(UNCAUGHT_BASE_URL, 30_000);
    } catch (err) {
      throw new Error(`preview server on :${UNCAUGHT_PORT} never came up: ${stderr || String(err)}`);
    }
  });

  test.afterAll(() => {
    server?.kill();
  });

  function captureTelemetry(page: Page): FaroBody[] {
    const bodies: FaroBody[] = [];
    void page.route("**/telemetry/collect", async (route: Route) => {
      bodies.push(route.request().postDataJSON() as FaroBody);
      await route.fulfill({ status: 200, body: "" });
    });
    return bodies;
  }

  test("I3: an uncaught error still reaches Sentry under uncaught scope (ADR §E.1)", async ({ page }) => {
    await stubShell(page);
    await page.goto("/");
    await page.evaluate(() => {
      setTimeout(() => { throw new Error("T06 e2e I3 uncaught-scope uncaught probe " + Date.now()); });
    });
    await expect.poll(() => readSentryEvents(page).then((e) => e.length)).toBeGreaterThan(0);
    const events = await readSentryEvents(page);
    const hit = events.find((e) =>
      JSON.stringify((e as { exception?: unknown }).exception ?? "").includes("T06 e2e I3 uncaught-scope uncaught probe"),
    );
    assert(hit, "an uncaught error must reach Sentry under EVERY scope, including uncaught");
  });

  test("I3: reportError does NOT reach Sentry under uncaught scope, but still reaches the facade", async ({ page }) => {
    await page.route("**/api/versions", (route) => route.fulfill({ status: 500, body: "boom" }));
    await page.route("https://sandpack.codesandbox.io/**", (route) => route.abort());
    await page.route("https://sandpack-bundler.codesandbox.io/**", (route) => route.abort());
    await page.route("**/broker/login**", (route) => route.abort());
    const captured = captureTelemetry(page);
    await page.goto("/");
    // The facade side must still fire (contract-mandated, scope-independent) —
    // wait on that first so a false pass below can't be "nothing ran yet".
    await expect.poll(() => captured.flatMap((b) => b.exceptions ?? []).length).toBeGreaterThan(0);
    const faroHit = captured
      .flatMap((b) => b.exceptions ?? [])
      .find((e) => String((e as { fingerprint?: string }).fingerprint ?? "").startsWith("versions-fetch:"));
    assert(faroHit, "reportError must still reach the facade under uncaught scope");

    const events = await readSentryEvents(page);
    const sentryHit = events.find((e) => (e as { tags?: { context?: string } }).tags?.context === "versions-fetch");
    assert(!sentryHit, "reportError must NOT reach Sentry under uncaught scope (ADR §E.3)");
  });

  test("I3: a demo-runtime event does NOT reach Sentry under uncaught scope, but still reaches the facade", async ({ page }) => {
    await stubShell(page);
    const captured = captureTelemetry(page);
    await page.goto("/");
    await callReportDemoEvent(page, "T06 e2e I3 uncaught-scope demo-runtime probe");
    await expect.poll(() => captured.flatMap((b) => b.measurements ?? []).length).toBeGreaterThan(0);
    const events = await readSentryEvents(page);
    const sentryHit = events.find((e) => (e as { tags?: { surface?: string } }).tags?.surface === "demo-runtime");
    assert(!sentryHit, "a demo-runtime event must NOT reach Sentry under uncaught scope (ADR §E.3 / task Scope)");
  });
});

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
