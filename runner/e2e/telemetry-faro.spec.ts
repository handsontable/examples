import { test, expect, type Route, type Page } from "@playwright/test";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { activeEditor, flushFaro, previewReady, stubShell } from "./helpers.js";
import { fingerprint } from "../packages/runtime/src/telemetry/fingerprint.js";

// Faro in the authoring app. Gated: needs a dist built with
// VITE_TELEMETRY_LOCAL=1 (contract §10), served on its own port (never
// 4173, which another worktree's `vite preview` may already hold). No o11y
// worker needed: `/telemetry/collect` is captured with `page.route`.
//
//   VITE_TELEMETRY_LOCAL=1 pnpm --filter @handsontable/demo-authoring build
//   E2E_TELEMETRY=1 pnpm e2e e2e/telemetry-faro.spec.ts
//
// This spec manages its own preview server, not the shared
// playwright.config.ts webServer, so it never depends on whatever `dist`
// another spec run left behind. `E2E_TELEMETRY_PORT` /
// `E2E_TELEMETRY_UNCAUGHT_PORT` override the ports.
const PORT = Number(process.env.E2E_TELEMETRY_PORT ?? 4711);
// 127.0.0.1, not "localhost": in CI (the Playwright container job) this
// spec's own `fetch("http://localhost:…")` readiness poll failed outright
// ("TypeError: fetch failed", see `formatFetchFailure` below) while `vite
// preview` itself bound the default, unqualified host with no startup
// error — a likely dual-stack "localhost" resolution mismatch between the
// bind and the poller. Pinning both sides to the same literal IPv4 address
// removes that whole axis of ambiguity.
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTHORING_DIR = fileURLToPath(new URL("../apps/authoring", import.meta.url));

/** Node's `fetch` (undici) reports a connection failure as a bare
 *  `TypeError: fetch failed` — the useful part (ECONNREFUSED vs ENETUNREACH,
 *  which address/port it actually tried) is one level down in `.cause`,
 *  which a plain `String(err)` drops. This is exactly the CI failure that
 *  motivated this helper: the logged line said nothing more than "fetch
 *  failed". */
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
 *  which fires on `"error"` rather than either stream — e.g. the vite binary
 *  missing — plus an early exit) into one string, so a `waitForServer`
 *  timeout's thrown error explains what happened instead of just restating
 *  the timeout. Stdout matters as much as stderr here: vite's own
 *  `➜ Local: http://…` bind line — which address it actually listened on —
 *  goes to stdout, and that line is exactly what would have told the CI
 *  failure apart from a genuine startup error. */
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

/** One decoded Faro transport body — the shape `FetchTransport` posts to
 *  `/telemetry/collect` (`@grafana/faro-core`'s `TransportBody`). */
interface FaroBody {
  meta?: Record<string, unknown>;
  exceptions?: Record<string, unknown>[];
  logs?: Record<string, unknown>[];
  measurements?: Record<string, unknown>[];
  events?: Record<string, unknown>[];
}

/** `flushFaro`'s probe check over a spec's captured bodies. */
const eventSeen = (captured: FaroBody[]) => (ref: string) =>
  captured.flatMap((b) => b.events ?? []).some((e) => (e.attributes as Record<string, unknown> | undefined)?.["hot.ref"] === ref);

/**
 * Reads the e2e-only hooks (`sentry.ts`'s `localTestSentryEnabled()` branch)
 * from the browser. Every Sentry envelope is `[EnvelopeHeader, Item[]]`;
 * each `Item` is `[ItemHeader, payload]`. Flattens to just the
 * `event`-typed payloads.
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
          context: { tier: number; framework: string; htMajor: string },
        ) => void;
      }
    ).__t06ReportDemoEvent?.(
      { type: "hot-runner-monitor", kind: "error", message: msg },
      { tier: 1, framework: "react", htMajor: "18" },
    );
  }, message);
}

test.describe("Faro in the authoring app", () => {
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
      ["preview", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"],
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

  // `beforeSend` must apply the shared noise gates (contract §6) to Faro
  // exception items, same as Sentry's own `beforeSend` — otherwise a
  // benign ResizeObserver-loop warning (or any of the other
  // `isUnhandledNoise`/`isForeignUnhandled` shapes) reaches Loki and mints
  // a fresh §F.3 `fp:` first-seen entry, paging on noise Sentry filters.
  test("an unhandled ResizeObserver-loop warning does NOT reach Faro (shared noise gate)", async ({ page }) => {
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

  test("the Outlook/Office safelink scanner's injected rejection does NOT reach Faro (shared noise gate)", async ({ page }) => {
    await stubShell(page);
    const captured = captureTelemetry(page);
    await page.goto("/");

    const marker = "T06 e2e D-I2 scanner probe " + Date.now();
    await page.evaluate((msg) => {
      setTimeout(() => {
        // eventGate.ts's INJECTED_SCANNER_MESSAGES regex, same wording DEMOS-5F
        // classified as the Office/Outlook safelink scanner's own injected
        // rejection (not our own code's, never authored by this app).
        throw new Error(
          `Non-Error promise rejection captured with value: Object Not Found Matching Id:12, MethodName:update, ParamCount:4 (${msg})`,
        );
      });
    }, marker);

    await page.evaluate((msg) => {
      setTimeout(() => { throw new Error(`T06 e2e D-I2 control probe (${msg})`); });
    }, marker);
    await expect
      .poll(() => captured.flatMap((b) => b.exceptions ?? []).some((e) => String(e.value ?? "").includes("control probe")))
      .toBe(true);

    const scannerHit = captured.flatMap((b) => b.exceptions ?? []).find((e) => String(e.value ?? "").includes(marker) && !String(e.value ?? "").includes("control probe"));
    assert(!scannerHit, "the Office scanner's injected rejection must never reach Faro/telemetry/collect");
  });

  // faro-core's default `dedupe: true` keeps one `lastPayload` per API
  // (events/measurements) and silently skips a push that deep-equals the
  // previous one, with no time window — a real second `example.downloaded`
  // (repeat Download, Share) or a second `example.open` on a guide's
  // second example (identical `ref`-keyed attrs) must still leave the
  // browser. `faro.ts`'s `event()`/`metric()` pass `skipDedupe: true`;
  // `window.__t06Telemetry` (a build+host-gated e2e-only hook, same
  // guarantee as `__t06ReportDemoEvent`) calls the real facade methods
  // directly so this proves the facade's own behaviour without driving the
  // real save/download UI.
  test("two identical example.downloaded events both reach Faro (facade skipDedupe)", async ({ page }) => {
    await stubShell(page);
    const captured = captureTelemetry(page);
    await page.goto("/");

    const ref = "t06-h1-event-probe-" + Date.now();
    await page.evaluate((probeRef) => {
      const hook = (
        window as unknown as {
          __t06Telemetry?: { event: (name: string, attrs: Record<string, string>) => void };
        }
      ).__t06Telemetry;
      hook?.event("example.downloaded", { surface: "authoring", kind: "docs", ref: probeRef });
      hook?.event("example.downloaded", { surface: "authoring", kind: "docs", ref: probeRef });
    }, ref);

    const matching = () =>
      captured
        .flatMap((b) => b.events ?? [])
        .filter((e) => e.name === "example.downloaded" && (e.attributes as Record<string, unknown> | undefined)?.["hot.ref"] === ref);
    await expect.poll(matching).toHaveLength(2);
  });

  test("two identical bucket.resolve_ms measurements both reach Faro (facade skipDedupe)", async ({ page }) => {
    await stubShell(page);
    const captured = captureTelemetry(page);
    await page.goto("/");

    const bucket = "t06-h1-metric-probe-" + Date.now();
    await page.evaluate((probeBucket) => {
      const hook = (
        window as unknown as {
          __t06Telemetry?: { metric: (name: string, values: Record<string, number>, attrs: Record<string, string>) => void };
        }
      ).__t06Telemetry;
      hook?.metric("bucket.resolve_ms", { duration_ms: 0 }, { bucket: probeBucket, outcome: "ok" });
      hook?.metric("bucket.resolve_ms", { duration_ms: 0 }, { bucket: probeBucket, outcome: "ok" });
    }, bucket);

    const matching = () =>
      captured
        .flatMap((b) => b.measurements ?? [])
        .filter((m) => m.type === "bucket.resolve_ms" && (m.context as Record<string, unknown> | undefined)?.["hot.bucket"] === bucket);
    await expect.poll(matching).toHaveLength(2);
  });

  // The ingest gate answers an over-limit IP 429 with `Retry-After: 60` (the
  // limiter window). The page clock is advanced only after the 429 has been
  // answered, so Faro's own 10 s request timeout never fires under fake time.
  test("a batch answered 429 with Retry-After: 60 is sent again after the wait, with the same Idempotency-Key", async ({ page }) => {
    await stubShell(page);
    await page.clock.install();
    const ref = "retry-probe-" + Date.now();
    const attempts: { key: string; refs: string[]; at: number }[] = [];
    let limitedKey: string | null = null;
    await page.route("**/telemetry/collect", async (route: Route) => {
      const body = route.request().postDataJSON() as FaroBody;
      const key = route.request().headers()["idempotency-key"] ?? "";
      const refs = (body.events ?? []).map((e) => String((e.attributes as Record<string, unknown> | undefined)?.["hot.ref"]));
      attempts.push({ key, refs, at: await page.evaluate(() => Date.now()) });
      if (limitedKey === null && refs.includes(ref)) {
        limitedKey = key;
        await route.fulfill({ status: 429, headers: { "retry-after": "60" }, body: "" });
        return;
      }
      await route.fulfill({ status: 204, body: "" });
    });
    await page.goto("/");

    await page.evaluate((probeRef) => {
      (window as unknown as {
        __t06Telemetry?: { event: (name: string, attrs: Record<string, string>) => void };
      }).__t06Telemetry?.event("example.downloaded", { surface: "authoring", kind: "docs", ref: probeRef });
    }, ref);
    await expect.poll(() => limitedKey, { timeout: 20_000 }).not.toBeNull();
    const forKey = () => attempts.filter((a) => a.key === limitedKey);

    // Relative to the 429'd attempt: the page clock keeps running while the test waits.
    const [first] = forKey();
    const pageNow = await page.evaluate(() => Date.now());
    await page.clock.fastForward(Math.max(0, first!.at + 58_000 - pageNow));
    await page.waitForTimeout(500);
    expect(forKey(), "not retried before the Retry-After window").toHaveLength(1);
    await page.clock.fastForward(17_000);
    await expect.poll(() => forKey().length).toBe(2);
    const [, retry] = forKey();
    expect(retry!.refs).toContain(ref);
    expect(retry!.at - first!.at).toBeGreaterThanOrEqual(60_000);
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

  // Faro's gecko-regex stack fallback can turn this message's own trailing
  // URL into a fake, lineno-less frame, which `isForeignUnhandled` then
  // reads as "foreign" and drops the whole event. This only proves the
  // event is kept; it deliberately does not assert anything about the
  // IP/email text surviving or being redacted (a separate concern).
  test("an uncaught error whose message quotes a foreign URL is kept, not dropped as foreign", async ({ page }) => {
    await stubShell(page);
    const captured = captureTelemetry(page);
    await page.goto("/");

    const marker = Date.now();
    await page.evaluate((m) => {
      setTimeout(() => {
        throw new Error(
          `HAIKU1 pii jane.doe@example.com 192.0.2.55 https://x.test/p?token=SECRET123 (${m})`,
        );
      });
    }, marker);

    await expect
      .poll(() => captured.flatMap((b) => b.exceptions ?? []).some((e) => String(e.value ?? "").includes(`HAIKU1 pii`) && String(e.value ?? "").includes(String(marker))))
      .toBe(true);
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
    // `handled` is in `attrs.ts#DIAGNOSTIC_TAG_KEYS`
    // (`packages/runtime/src/telemetry/attrs.ts`, contract §3 "Diagnostic
    // tags"), so the browser-side scrub keeps it.
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

  // ---- an uncaught error reaches Sentry (transport spy) ----------------------
  //
  // Three cases, all against this describe block's `full`-scope build (the
  // default — no VITE_SENTRY_SCOPE set): uncaught always reaches Sentry;
  // reportError and demo-runtime reach it too, because full scope keeps
  // today's behaviour. The mirror describe block below rebuilds with
  // VITE_SENTRY_SCOPE=uncaught and proves the opposite for the latter two.

  test("an uncaught error reaches Sentry (transport spy)", async ({ page }) => {
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

  test("reportError reaches Sentry under full scope", async ({ page }) => {
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

  test("a demo-runtime event reaches Sentry under full scope, re-homed to the demo-runtime environment", async ({ page }) => {
    await stubShell(page);
    await page.goto("/");
    await callReportDemoEvent(page, "T06 e2e I3 demo-runtime probe");
    await expect.poll(() => readSentryEvents(page).then((e) => e.length)).toBeGreaterThan(0);
    const events = await readSentryEvents(page);
    const hit = events.find((e) => (e as { tags?: { surface?: string } }).tags?.surface === "demo-runtime");
    assert(hit, "no Sentry event tagged surface=demo-runtime — reportDemoEvent did not reach Sentry under full scope");
    // The re-homing that beforeSend restores.
    assert(
      (hit as { environment?: string }).environment === "demo-runtime",
      `demo-runtime event must be re-homed to environment "demo-runtime", got ${JSON.stringify((hit as { environment?: string }).environment)}`,
    );
  });

  // ---- reportDemoEvent's own gate (previewMonitoring), not the
  // ---- __t06ReportDemoEvent bypass above -----------------------------------
  //
  // Every test above drives `reportDemoEventUnguarded` directly (the
  // `__t06ReportDemoEvent` hook), which never exercises `reportDemoEvent`'s
  // own `monitorDemos` gate. With no `VITE_MONITOR_DEMOS` (so `monitorDemos`
  // is false, same as every real `dev:full` run), `reportDemoEvent` itself
  // must not be a no-op. `__t06ReportDemoEventGuarded` calls
  // `reportDemoEvent` (the real, guarded entry point `App.tsx`'s
  // `onPreviewMessage` uses) so this proves the fix without a real
  // (E2E_LIVE-gated) preview mount.
  test("reportDemoEvent (guarded) reaches Faro under the local leg, and never Sentry", async ({ page }) => {
    await stubShell(page);
    const captured = captureTelemetry(page);
    await page.goto("/");

    const guardedMarker = "T06 e2e R3 F10 guarded probe " + Date.now();
    await page.evaluate((msg) => {
      (
        window as unknown as {
          __t06ReportDemoEventGuarded?: (
            payload: { type: string; kind: string; message: string },
            context: { tier: number; framework: string; htMajor: string },
          ) => void;
        }
      ).__t06ReportDemoEventGuarded?.(
        { type: "hot-runner-monitor", kind: "error", message: msg },
        { tier: 1, framework: "react", htMajor: "18" },
      );
    }, guardedMarker);

    // The AE metric (contract §5): `previewMonitoring`
    // (`monitorDemos || localTestSentryEnabled()`) is what lets this call
    // through `reportDemoEvent`'s gate at all.
    await expect
      .poll(() => captured.flatMap((b) => b.measurements ?? []).some((m) => m.type === "preview.runtime_error"))
      .toBe(true);

    // Control: a second demo-runtime event, fired through the unguarded
    // hook (opts.sentry=true default), which does reach Sentry on this
    // exact dist (proved by the sibling "I3: a demo-runtime event reaches
    // Sentry under full scope" test above). Waiting for this first rules
    // out "no Sentry event yet because nothing has flushed" as the reason
    // the guarded marker is absent below — Sentry capture/transport is
    // provably alive on this page.
    const controlMarker = "T06 e2e R3 F10 control probe " + Date.now();
    await callReportDemoEvent(page, controlMarker);
    await expect
      .poll(() => readSentryEvents(page).then((events) => events.some((e) => JSON.stringify(e).includes(controlMarker))))
      .toBe(true);

    // Never Sentry: `opts.sentry` is `monitorDemos` (false in this build,
    // same as every real local run) — independent of `previewMonitoring` and
    // of `diagnosticsGoToSentry`, which is true in this build (the control
    // above proved it). Matched on the message text, not `tags.surface`:
    // the control event also carries `surface: "demo-runtime"`, so a
    // surface-only match would pass even if the guarded call had leaked
    // through too.
    const events = await readSentryEvents(page);
    const guardedHit = events.find((e) => JSON.stringify(e).includes(guardedMarker));
    assert(!guardedHit, "reportDemoEvent must never reach Sentry through the R3 F10 local leg");
  });
  // ---- the edit-burst collapse in front of the facade ------------------------
  //
  // Typing one throwing line relayed one `preview.runtime_error` per
  // half-typed prefix. Drives the same two entry points `App.tsx` uses — the
  // guarded `reportDemoEvent` and the edit signal `noteDemoEdit` — through
  // their local-only hooks, so no real (E2E_LIVE-gated) preview is needed.
  test("a keystroke ladder emits one preview.runtime_error + one Faro record; a first-load error counts at once; Sentry is not collapsed", async ({ page }) => {
    await stubShell(page);
    const captured = captureTelemetry(page);
    await page.goto("/");
    // The stubbed version list remounts the preview once after load, and a
    // remount closes the open burst; drive the ladder after it.
    await expect(page).toHaveURL(/[?&]v=18\.0\.0\b/);

    const relay = (message: string, sentry = false) =>
      page.evaluate(
        ([msg, viaSentry]) => {
          const w = window as unknown as Record<string, (p: unknown, c: unknown) => void>;
          const hook = viaSentry ? w.__t06ReportDemoEvent : w.__t06ReportDemoEventGuarded;
          hook({ type: "hot-runner-monitor", kind: "error", message: msg }, { tier: 1, framework: "react", htMajor: "18" });
        },
        [message, sentry] as const,
      );
    const noteEdit = () =>
      page.evaluate(() => (window as unknown as { __t06ReportDemoEventNoteEdit: () => void }).__t06ReportDemoEventNoteEdit());
    // Letters only in the markers: digits would be normalised to `<n>` in the shape.
    const run = "F" + Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 8);
    // Scoped to this test's own relays: the real (bundler-less) preview on this
    // page relays events of its own — a Handsontable "Theme … is already
    // registered" console warning, observed — which are real reports, just not
    // the ones this test drives. Every relay below is `kind: "error"`
    // (reason `uncaught`), and every record it produces carries `run`.
    const runtimePoints = () =>
      captured
        .flatMap((b) => b.measurements ?? [])
        .filter((m) => m.type === "preview.runtime_error")
        .filter((m) => (m.context as Record<string, string> | undefined)?.["hot.reason"] === "uncaught");
    const demoRecords = () =>
      captured
        .flatMap((b) => b.exceptions ?? [])
        .filter((e) => (e.context as Record<string, string> | undefined)?.["hot.surface"] === "demo-runtime")
        .filter((e) => String(e.value ?? "").includes(run) || String(e.value ?? "").includes("is not defined"));
    const ladder = ["s", "se", "set", "setT", "setTi", "setTim", "setTime", "setTimeo"].map((p) => `${p} is not defined`);
    ladder.push(`Unexpected token ${run}`, `Unterminated string constant ${run}`);
    for (const rung of ladder) {
      await noteEdit();
      await relay(rung);
    }
    await noteEdit(); // the last keystroke
    await relay(`ladder final ${run} 'secretLiteral'`);

    // Held back while the burst is open (the settle window is 2 s).
    await page.waitForTimeout(700);
    await flushFaro(page, eventSeen(captured));
    expect(runtimePoints()).toHaveLength(0);

    await expect.poll(() => runtimePoints().length, { timeout: 10_000 }).toBe(1);
    await expect.poll(() => demoRecords().length).toBe(1);
    // Nothing else trickles in after the burst closed.
    await page.waitForTimeout(1500);
    await flushFaro(page, eventSeen(captured));
    expect(runtimePoints()).toHaveLength(1);
    expect(demoRecords()).toHaveLength(1);

    // The one record is the final run's, as the §7 shape: handled, no stack,
    // quoted text (authored content, contract §3) replaced.
    const record = demoRecords()[0]!;
    expect(record.type).toBe("DemoError");
    expect(String(record.value)).toBe(`ladder final ${run} <str>`);
    expect(record.stacktrace).toBeUndefined();
    expect((record.context as Record<string, string>).handled).toBe("true");
    expect(JSON.stringify(captured)).not.toContain("secretLiteral");
    expect(runtimePoints()[0]!.context).toMatchObject({ "hot.surface": "demo-runtime", "hot.reason": "uncaught" });

    // A first-load / interaction error (no edit open): counted without the settle wait.
    await relay(`first load ${run}`);
    await flushFaro(page, eventSeen(captured));
    expect(runtimePoints()).toHaveLength(2);
    expect(demoRecords().map((r) => r.value)).toContain(`first load ${run}`);

    // Sentry is NOT behind the collapse: under an open burst, every rung still
    // reaches it at once (the unguarded hook is the `opts.sentry` path).
    await noteEdit();
    for (const rung of ["a is not defined", "ab is not defined", "abc is not defined"]) {
      await relay(`${rung} ${run}`, true);
    }
    await expect
      .poll(() => readSentryEvents(page).then((events) => events.filter((e) => JSON.stringify(e).includes(run)).length))
      .toBe(3);
  });

  // The test above drives the edit signal through its hook; this one proves
  // `App.tsx` actually sends it: a real keystroke in the code editor must open
  // a burst, so an error relayed right after it is held back until the editor
  // goes quiet, instead of counting at once like a first-load error.
  test("a code-editor keystroke opens the edit burst (App.tsx wiring)", async ({ page }) => {
    await stubShell(page);
    // Every bundler host, the versioned one too: with a live bundler the keystroke's run
    // starts after the injected relay (a run's start drops what the burst held), and a
    // compile error of the typed `x` replaces it, so the outcome would race the bundler.
    await page.route(/\.codesandbox\.io\//, (route) => route.abort());
    const captured = captureTelemetry(page);
    await page.goto("/");
    await expect(page).toHaveURL(/[?&]v=18\.0\.0\b/);
    await expect(activeEditor(page)).toBeVisible();

    const run = "F" + Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 8);
    const points = () =>
      captured
        .flatMap((b) => b.measurements ?? [])
        .filter((m) => m.type === "preview.runtime_error")
        .filter((m) => (m.context as Record<string, string> | undefined)?.["hot.reason"] === "uncaught");

    await activeEditor(page).click();
    await page.keyboard.type("x");
    await page.evaluate((msg) => {
      (window as unknown as Record<string, (p: unknown, c: unknown) => void>).__t06ReportDemoEventGuarded(
        { type: "hot-runner-monitor", kind: "error", message: msg },
        { tier: 1, framework: "react", htMajor: "18" },
      );
    }, `after keystroke ${run}`);

    await page.waitForTimeout(700);
    await flushFaro(page, eventSeen(captured));
    expect(points(), "an error right after a keystroke waits for the burst to settle").toHaveLength(0);
    await expect.poll(() => points().length, { timeout: 10_000 }).toBe(1);
  });

  // Handsontable's load-time notices are console warnings (18: the theme
  // notice; 17: the `date` deprecation), relayed on every preview load. A
  // warning is not a runtime error; a demo's own console.error is.
  test("a relayed console warning is not a preview.runtime_error; a console.error is", async ({ page }) => {
    await stubShell(page);
    const captured = captureTelemetry(page);
    await page.goto("/");
    const run = "F" + Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 8);
    const relay = (kind: string, message: string) =>
      page.evaluate(
        ([k, msg]) =>
          (window as unknown as Record<string, (p: unknown, c: unknown) => void>).__t06ReportDemoEventGuarded(
            { type: "hot-runner-monitor", kind: k, message: msg },
            { tier: 1, framework: "react", htMajor: "18" },
          ),
        [kind, message] as const,
      );
    const themeNotice = 'Theme "main" is already registered. Registration skipped.';
    const consoleError = `a real console.error ${run}`;
    const points = (message: string) =>
      captured
        .flatMap((b) => b.measurements ?? [])
        .filter((m) => m.type === "preview.runtime_error")
        .filter((m) => (m.context as Record<string, string>)["hot.fingerprint"] === fingerprint("demo-runtime", message));

    await relay("console-warn", themeNotice);
    await relay("console-error", consoleError);

    await expect.poll(() => points(consoleError).length, { timeout: 10_000 }).toBe(1);
    expect(points(consoleError)[0]!.context).toMatchObject({ "hot.reason": "console" });
    // The page's own preview (if the bundler answers) relays the same notice on load.
    await page.waitForTimeout(3000);
    await flushFaro(page, eventSeen(captured));
    expect(points(themeNotice), "the notice, whoever relayed it, never counts").toHaveLength(0);
  });

  // A syntax error typed into a Tier-1 parcel example never reaches the
  // bundler — the client-side pre-transpile rejects it — so
  // `sandpack.compile_error` must fire for the most common compile error
  // there is. Real keystrokes in the real editor, the real runtime, babel
  // and collapse, and a real preview.
  //
  // E2E_LIVE, not just E2E_TELEMETRY: the edit path needs a mounted Sandpack
  // client, and with every bundler host aborted `mount()` never resolves
  // (the preview stays `booting`, measured) — so no keystroke reaches the
  // runtime at all. The live preview is also what makes the keystroke-
  // prefix rungs (`c`..`cons`) run and relay ReferenceErrors, which the
  // compile failure must keep out of `preview.runtime_error` (the
  // `replacesRun` rule).
  test("a syntax error typed key by key reaches /telemetry/collect as one sandpack.compile_error, not a runtime error", async ({ page }) => {
    test.skip(process.env.E2E_LIVE !== "1", "set E2E_LIVE=1 (needs the hosted Sandpack bundler) to run the typed compile-error check");
    await stubShell(page);
    const captured = captureTelemetry(page);
    await page.goto("/");
    await previewReady(page);
    const measurementsSince = (mark: number) => captured.slice(mark).flatMap((b) => b.measurements ?? []);
    const mark = captured.length;

    await activeEditor(page).click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.press("Enter");
    // No delay on purpose: the prefixes' runs relay their ReferenceErrors
    // after later keystrokes (compile slower than the typist). With a 40 ms
    // delay the relays land before the next keystroke and the `replacesRun`
    // rule goes unexercised (measured: that mutation stayed green).
    await page.keyboard.type("const R9C = ;", { delay: 0 });

    await expect
      .poll(() => measurementsSince(mark).filter((m) => m.type === "sandpack.compile_error").length, { timeout: 15_000 })
      .toBe(1);
    const [point] = measurementsSince(mark).filter((m) => m.type === "sandpack.compile_error");
    const ctx = point!.context as Record<string, string>;
    expect(ctx["hot.fingerprint"]).toMatch(/^sandpack\.compile_error:[0-9a-f]{16}$/);
    expect(ctx["hot.ht_major"]).toMatch(/^\d+$/);
    expect(ctx["hot.framework"]).toBeTruthy();
    // The compile point is only emitted when the burst closes, in the same
    // flush as anything the burst still held. One short negative wait
    // anyway: nothing trickles in afterwards.
    await page.waitForTimeout(1500);
    await flushFaro(page, eventSeen(captured));
    const after = measurementsSince(mark);
    expect(after.filter((m) => m.type === "sandpack.compile_error")).toHaveLength(1);
    expect(
      after.filter((m) => m.type === "preview.runtime_error"),
      "no runtime error (of any reason) from the rungs of a line that ends in a syntax error",
    ).toHaveLength(0);
    // No authored text on the wire (contract §3): the point carries a hash only.
    expect(JSON.stringify(captured.slice(mark))).not.toContain("R9C");
  });

  // Every prefix of a typed throwing line runs and relays in the same preview
  // document, and the closing `;` transpiles to the sandbox already running,
  // so nothing re-runs after it. Waiting for the finished line's relay before
  // typing the `;` pins that order. E2E_LIVE for the same reason as the test
  // above: the edit path needs a mounted Sandpack client.
  test("a runtime error typed key by key reaches /telemetry/collect as one preview.runtime_error with its message", async ({ page }) => {
    test.skip(process.env.E2E_LIVE !== "1", "set E2E_LIVE=1 (needs the hosted Sandpack bundler) to run the typed runtime-error check");
    await stubShell(page);
    const captured = captureTelemetry(page);
    await page.goto("/?example=javascript");
    await previewReady(page);
    const mark = captured.length;
    // Letters only: digits would be normalised to `<n>` in the record's shape.
    const marker = "typed" + Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 8);
    const uncaught = () =>
      captured
        .slice(mark)
        .flatMap((b) => b.measurements ?? [])
        .filter((m) => m.type === "preview.runtime_error")
        .filter((m) => (m.context as Record<string, string>)["hot.reason"] === "uncaught");
    const records = () =>
      captured
        .slice(mark)
        .flatMap((b) => b.exceptions ?? [])
        .filter((e) => String(e.value ?? "").includes(marker));

    await page.evaluate(() => {
      const w = window as unknown as { __e2eRelays: string[] };
      w.__e2eRelays = [];
      window.addEventListener("message", (e) => {
        if (e.data?.type === "hot-runner-monitor") w.__e2eRelays.push(String(e.data.message));
      });
    });

    await activeEditor(page).click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type(`setTimeout(() => { throw new Error('${marker}'); }, 100)`, { delay: 20 });
    await page.waitForFunction(
      (m) => (window as unknown as { __e2eRelays: string[] }).__e2eRelays.includes(m),
      marker,
      { timeout: 15_000 },
    );
    await page.keyboard.type(";");
    expect(await activeEditor(page).innerText(), "guard: the editor holds the finished line").toContain(
      `setTimeout(() => { throw new Error('${marker}'); }, 100);`,
    );

    await expect.poll(() => uncaught().length, { timeout: 15_000 }).toBe(1);
    await expect.poll(() => records().length).toBe(1);
    await page.waitForTimeout(1500);
    await flushFaro(page, eventSeen(captured));
    expect(uncaught(), "one point for the finished line, none for its prefixes").toHaveLength(1);
    const [record] = records();
    expect(record!.type).toBe("DemoError");
    expect(uncaught()[0]!.context).toMatchObject({ "hot.surface": "demo-runtime", "hot.framework": "javascript" });
  });
});

// ---- Sentry scope switch = uncaught ----------------------------------------
// A second dist, built by this describe block's own `beforeAll` with
// VITE_SENTRY_SCOPE=uncaught (a build-time define, needing its own build
// and port). Proves the other half of the scope truth table: uncaught
// still reaches Sentry (ADR §E.1, regardless of scope), but reportError and
// demo-runtime do not (ADR §E.3: moved diagnostic reports go to the facade
// only once the scope is uncaught).
test.describe("Sentry scope switch = uncaught", () => {
  test.skip(
    process.env.E2E_TELEMETRY !== "1",
    "set E2E_TELEMETRY=1 and build with VITE_TELEMETRY_LOCAL=1 first",
  );
  test.describe.configure({ mode: "serial" });

  const UNCAUGHT_PORT = Number(process.env.E2E_TELEMETRY_UNCAUGHT_PORT ?? 4712);
  const UNCAUGHT_BASE_URL = `http://127.0.0.1:${UNCAUGHT_PORT}`;
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
      ["preview", "--outDir", OUT_DIR, "--host", "127.0.0.1", "--port", String(UNCAUGHT_PORT), "--strictPort"],
      { cwd: AUTHORING_DIR, stdio: "pipe" },
    );
    const diagnostics = captureServerDiagnostics(server);
    try {
      await waitForServer(UNCAUGHT_BASE_URL, 30_000);
    } catch (err) {
      throw new Error(`preview server on :${UNCAUGHT_PORT} never came up: fetch: ${formatFetchFailure(err)} | server output: ${diagnostics.get() || "(none)"}`);
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

  test("an uncaught error still reaches Sentry under uncaught scope (ADR §E.1)", async ({ page }) => {
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

  test("reportError does NOT reach Sentry under uncaught scope, but still reaches the facade", async ({ page }) => {
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

  test("a demo-runtime event does NOT reach Sentry under uncaught scope, but still reaches the facade", async ({ page }) => {
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
