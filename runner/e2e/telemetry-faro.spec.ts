import { test, expect, type Route } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
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

  test("reportError (a handled diagnostic) reaches Faro, fingerprinted by its context", async ({ page }) => {
    await page.route("**/api/versions", (route) => route.fulfill({ status: 500, body: "boom" }));
    await page.route("https://sandpack.codesandbox.io/**", (route) => route.abort());
    await page.route("https://sandpack-bundler.codesandbox.io/**", (route) => route.abort());
    await page.route("**/broker/login**", (route) => route.abort());
    const captured = captureTelemetry(page);
    await page.goto("/");

    await expect.poll(() => captured.flatMap((b) => b.exceptions ?? []).length).toBeGreaterThan(0);
    // Found by `fingerprint` (contract §7, `fingerprint(context, message)`),
    // NOT by `context.handled` — that key does not survive the browser-side
    // scrubber's allowlist today (T06-D1 in the task Outcome: confirmed with a
    // live capture, `context: {}` where `{ handled: "true", context:
    // "versions-fetch" }` was sent). The fingerprint is a top-level Faro
    // exception field the scrubber does not touch, so it is what actually
    // proves this reached Faro.
    const exception = captured
      .flatMap((b) => b.exceptions ?? [])
      .find((e) => String(e.fingerprint ?? "").startsWith("versions-fetch:"));
    assert(exception, "no exception item fingerprinted versions-fetch:… — reportError never reached Faro");
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

  // KNOWN RED, by design — T06-D1. Kept LAST in this file on purpose:
  // `mode: "serial"` above skips every test after a failure, so this is the
  // only position where an expected failure does not swallow real coverage.
  //
  // `telemetry.error()`'s `context.handled = "true"` marker is stripped by
  // `scrub.ts#allowlistAttributes` before the request ever leaves the
  // browser: the allowlist (`attrs.ts`'s `ALLOWED_ATTRIBUTE_KEYS`, owned by
  // T00) has no entry for a bare `handled` key. Contract §6's table
  // ("exception with `context.handled = 'true'`" -> `error.handled`) cannot
  // be satisfied by this app alone — the fix is an attrs.ts/contract-doc
  // change outside this task's Owns rows, flagged for the controller. This
  // test encodes the CONTRACT's actual requirement, not what the code
  // currently does — leaving it red is correct per docs/TESTING.md
  // ("expectation correct, code wrong -> fix the code, leave the test
  // alone"); deleting, skipping or loosening it would hide a real gap.
  test("KNOWN RED (T06-D1): the handled=true marker should survive to the wire, but does not", async ({ page }) => {
    await page.route("**/api/versions", (route) => route.fulfill({ status: 500, body: "boom" }));
    await page.route("https://sandpack.codesandbox.io/**", (route) => route.abort());
    await page.route("https://sandpack-bundler.codesandbox.io/**", (route) => route.abort());
    await page.route("**/broker/login**", (route) => route.abort());
    const captured = captureTelemetry(page);
    await page.goto("/");

    await expect.poll(() => captured.flatMap((b) => b.exceptions ?? []).length).toBeGreaterThan(0);
    const exception = captured
      .flatMap((b) => b.exceptions ?? [])
      .find((e) => String(e.fingerprint ?? "").startsWith("versions-fetch:"));
    assert(exception, "no exception item fingerprinted versions-fetch:…");
    assert(
      (exception.context as Record<string, unknown> | undefined)?.handled === "true",
      "context.handled did not survive to the wire (T06-D1 — see this test's header comment)",
    );
  });
});

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
