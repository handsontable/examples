// T08 — the lite beacon: the standalone ES5 reporter (`monitor.ts`'s
// `injectLiteReporterIntoHtml`, contract §9, ADR §C.5) and the o11y worker's
// `POST /telemetry/lite` route (`workers/o11y/src/lite.ts`).
//
// The reporter half is *executed*, not read (the DEV-2129 lesson every other
// ES5-reporter test in this repo already follows, `monitor-inject.test.mjs`'s
// own header comment) — a transpiler/output test that only inspects the
// string would pass over a script that cannot actually run.
//
// Build prerequisite: `pnpm --filter @handsontable/demo-runtime build`.
// Run: node --experimental-strip-types --test pipeline/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Parser } from "acorn";
import {
  LITE_CLIENT_MESSAGE_MAX,
  LITE_CLIENT_STACK_MAX,
  LITE_ENDPOINT,
  LITE_REPORTER_MARKER,
  LITE_REPORTER_MAX_BYTES,
  LITE_VITALS_SAMPLE_RATE,
  MONITOR_EVENT_CEILING,
  injectLiteReporterIntoHtml,
} from "../packages/runtime/dist/monitor.js";
import { isValidLitePayload, LITE_PAYLOAD_MAX_BYTES } from "../packages/runtime/dist/telemetry/index.js";

register("./fixtures/o11y-worker-hooks.mjs", import.meta.url);

const { default: worker } = await import("../workers/o11y/src/index.ts");
const { InboxWriter } = await import("../workers/o11y/src/inbox/writer.ts");
const { makeEnv, ctx } = await import("./fixtures/o11y-harness.mjs");

// ---- the reporter, built for a representative config --------------------------

const CONFIG = { surface: "d", demo: "r-react-18-0-0", ht: "18", fw: "react" };

function reporterScriptSource(config = CONFIG) {
  const html = injectLiteReporterIntoHtml("<html><head></head><body></body></html>", config);
  const match = /<script>([\s\S]*)<\/script>/.exec(html);
  assert.ok(match, "the injector emitted no inline script");
  return match[1];
}

test("the injected reporter parses as ES5 (acorn ecmaVersion 5)", () => {
  // Node's `new Function` accepts syntax an old runtime would reject
  // (DEV-2129's own lesson, restated for this reporter) — acorn at
  // `ecmaVersion: 5` is the real gate.
  assert.doesNotThrow(() => Parser.parse(reporterScriptSource(), { ecmaVersion: 5 }));
});

test("the injected script stays inside its own size budget", () => {
  for (const config of [
    CONFIG,
    { surface: "embed", demo: "r-vanilla-typescript-18-1-1-a-fairly-long-id", ht: "next", fw: "vanilla-typescript" },
  ]) {
    const bytes = Buffer.byteLength(reporterScriptSource(config), "utf8");
    assert.ok(
      bytes <= LITE_REPORTER_MAX_BYTES,
      `script for ${JSON.stringify(config)} is ${bytes} bytes, budget is ${LITE_REPORTER_MAX_BYTES}`,
    );
  }
});

test("the marker survives injection and makes a second pass a no-op", () => {
  const once = injectLiteReporterIntoHtml("<html><head></head><body></body></html>", CONFIG);
  assert.ok(once.includes(LITE_REPORTER_MARKER));
  const twice = injectLiteReporterIntoHtml(once, CONFIG);
  assert.equal(twice, once, "second injection returns the same string, unchanged");
});

// ---- the reporter, executed ----------------------------------------------------

/** Stubs for every bare global the reporter references — passed as `new
 *  Function` parameters, exactly like `monitor-inject.test.mjs#runReporter`
 *  does for the framed reporter. In production every one of these resolves to
 *  the real global; here each is a plain object the test controls, which is
 *  what lets the sampling test fix `Math.random()` without touching the real,
 *  shared `Math` global. */
function makeStubs(opts = {}) {
  const sent = [];
  const winListeners = new Map();
  const docListeners = new Map();
  const poRegistry = [];

  const window_ = {
    __proto__: null,
    addEventListener(type, cb) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(cb);
    },
    fire(type, ev) {
      for (const cb of winListeners.get(type) ?? []) cb(ev);
    },
  };
  const document_ = {
    visibilityState: "visible",
    addEventListener(type, cb) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(cb);
    },
    fire(type) {
      for (const cb of docListeners.get(type) ?? []) cb();
    },
  };
  const navigator_ = {
    userAgent: opts.userAgent ?? "Mozilla/5.0 (X11; Linux x86_64) Chrome/128.0 Safari/537.36",
    sendBeacon(url, body) {
      sent.push({ url, payload: JSON.parse(String(body)) });
      return true;
    },
  };
  const navigationEntries = "navigationEntries" in opts ? opts.navigationEntries : [{ responseStart: 42 }];
  const performance_ = {
    getEntriesByType(type) {
      return type === "navigation" ? navigationEntries : [];
    },
  };
  class FakePerformanceObserver {
    constructor(cb) {
      this.cb = cb;
      this.type = null;
    }
    observe(config) {
      this.type = config.type;
      this.config = config;
      poRegistry.push(this);
    }
  }
  const Math_ = { random: opts.random ?? (() => 0.99) }; // unsampled by default
  const Date_ = { now: opts.now ?? (() => 1700000000000) };

  return {
    sent,
    window_,
    document_,
    navigator_,
    performance_,
    FakePerformanceObserver,
    poRegistry,
    Math_,
    Date_,
    /** Deliver entries to every observer registered for `type`, the way a
     *  real `PerformanceObserver` calls back incrementally. */
    fireEntries(type, entries) {
      for (const o of poRegistry) if (o.type === type) o.cb({ getEntries: () => entries });
    },
  };
}

function runLite(config = CONFIG, opts = {}) {
  const h = makeStubs(opts);
  const source = reporterScriptSource(config);
  // eslint-disable-next-line no-new-func
  new Function("window", "document", "navigator", "performance", "PerformanceObserver", "Math", "Date", source)(
    h.window_,
    h.document_,
    h.navigator_,
    h.performance_,
    h.FakePerformanceObserver,
    h.Math_,
    h.Date_,
  );
  return h;
}

test("an uncaught error produces one payload within the caps, matching the validator", () => {
  const h = runLite();
  h.window_.fire("error", { error: Object.assign(new Error("boom"), { name: "TypeError" }) });
  assert.equal(h.sent.length, 1);
  const [{ url, payload }] = h.sent;
  assert.equal(url, LITE_ENDPOINT);
  assert.equal(payload.t, "err");
  assert.equal(payload.n, "TypeError");
  assert.equal(payload.m, "boom");
  assert.equal(payload.val, null);
  assert.equal(payload.s, CONFIG.surface);
  assert.equal(payload.demo, CONFIG.demo);
  assert.equal(payload.ht, CONFIG.ht);
  assert.equal(payload.fw, CONFIG.fw);
  assert.ok(["desktop", "mobile", "tablet"].includes(payload.dev));
  assert.ok(isValidLitePayload(payload), "the reporter's own payload must satisfy the ingest validator");
});

test("an unhandled rejection is relayed the same way, with the reason's own name/message", () => {
  const h = runLite();
  h.window_.fire("unhandledrejection", { reason: Object.assign(new RangeError("out of range"), {}) });
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].payload.n, "RangeError");
  assert.equal(h.sent[0].payload.m, "out of range");
});

test("message and stack are truncated well under the field caps before sending", () => {
  const h = runLite();
  const longMessage = "x".repeat(5000);
  const longStack = "at frame\n".repeat(600);
  h.window_.fire("error", { error: Object.assign(new Error(longMessage), { stack: longStack }) });
  const { payload } = h.sent[0];
  // The caps are UTF-8 *bytes* (T08-D, fix round I2), not `.length` (UTF-16
  // code units) — ASCII text happens to make the two numbers equal, which is
  // exactly the coincidence that let a non-ASCII payload slip past a
  // char-count cap before this fix. `Buffer.byteLength` is the Node-side
  // stand-in for the reporter's own `bl()`.
  assert.ok(Buffer.byteLength(payload.m, "utf8") <= LITE_CLIENT_MESSAGE_MAX);
  assert.ok(Buffer.byteLength(payload.st, "utf8") <= LITE_CLIENT_STACK_MAX);
  assert.ok(isValidLitePayload(payload), "a maxed-out error must still fit the 2 KB payload cap");
});

test("D-I4 (fix round): a huge (1 MB) error message is trimmed in well under 50ms, not quadratic time", () => {
  // Before the fix, `bt(s,n)` re-encoded the WHOLE string on every
  // `slice(0,-1)` iteration — quadratic in string length. Measured against
  // the exact pre-fix function: 10k chars ~100ms, 50k chars ~2.4s, ~40s
  // projected at 200k. A demo throwing `new Error(hugeString)` (a message
  // embedding a data dump or a large JSON value) would then freeze the
  // main thread of the `/d`/`/embed` host page synchronously, in the
  // capturing `error` listener — exactly the "never harms the page it
  // observes" rule this reporter exists to uphold.
  const h = runLite();
  const hugeMessage = "x".repeat(1_000_000);
  const start = performance.now();
  h.window_.fire("error", { error: Object.assign(new Error(hugeMessage), { name: "TypeError" }) });
  const elapsedMs = performance.now() - start;
  assert.ok(elapsedMs < 50, `trimming a 1 MB message took ${elapsedMs}ms, expected well under 50ms`);
  assert.equal(h.sent.length, 1);
  const { payload } = h.sent[0];
  assert.ok(Buffer.byteLength(payload.m, "utf8") <= LITE_CLIENT_MESSAGE_MAX);
  assert.ok(isValidLitePayload(payload));
});

test("I2 (fix round): a non-ASCII error message/stack is byte-trimmed, never silently dropped for being over budget", () => {
  // Before the fix, `tc()` truncated by `.length` (UTF-16 code units): a
  // message of mostly multi-byte characters truncated to `LITE_CLIENT_
  // MESSAGE_MAX` *characters* could still serialize to well over 2 KB of
  // UTF-8, and the o11y route's own `isValidLitePayload` would then silently
  // drop the whole beacon at ingest — reported as "sent" client-side, never
  // actually stored. Chinese, Cyrillic, and an emoji together exercise 2-,
  // 3- and 4-byte UTF-8 sequences in one message.
  const h = runLite();
  const nonAsciiMessage = "网格渲染失败: не удалось отрисовать таблицу 😵‍💫 ".repeat(20);
  const nonAsciiStack = "at 渲染函数 (файл.js:1:1)\n".repeat(60);
  h.window_.fire("error", {
    error: Object.assign(new Error(nonAsciiMessage), { name: "渲染Error", stack: nonAsciiStack }),
  });
  assert.equal(h.sent.length, 1, "a non-ASCII error must still be sent, not silently swallowed");
  const { payload } = h.sent[0];
  assert.ok(Buffer.byteLength(payload.n, "utf8") <= 100, "name byte budget");
  assert.ok(Buffer.byteLength(payload.m, "utf8") <= LITE_CLIENT_MESSAGE_MAX, "message byte budget");
  assert.ok(Buffer.byteLength(payload.st, "utf8") <= LITE_CLIENT_STACK_MAX, "stack byte budget");
  const totalBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  assert.ok(totalBytes <= 2048, `serialized payload is ${totalBytes} bytes, over the 2 KB contract cap`);
  assert.ok(isValidLitePayload(payload), "must satisfy the ingest validator's own byte check");
  // No lone surrogate or truncated multi-byte sequence — a string that fails
  // to round-trip through JSON is the tell for a truncation cut mid-character.
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(payload)));
});

test("I2 (fix round): worst-case JSON-escaping content (all quotes and backslashes) still fits the 2 KB cap or is dropped, never sent oversize", () => {
  // JSON.stringify expands every `"`/`\` to two output characters — the one
  // inflation a per-field *byte* budget on the raw string does not see. This
  // is the adversarial case `bc()`'s own final serialized-length check exists
  // for, catching what per-field trimming alone cannot.
  const h = runLite();
  const adversarialMessage = '"\\'.repeat(400);
  h.window_.fire("error", { error: Object.assign(new Error(adversarialMessage), { stack: adversarialMessage }) });
  if (h.sent.length === 1) {
    const totalBytes = Buffer.byteLength(JSON.stringify(h.sent[0].payload), "utf8");
    assert.ok(totalBytes <= 2048, `serialized payload is ${totalBytes} bytes, over the 2 KB contract cap`);
  }
  // Either it fit and was sent (and just got asserted above), or the final
  // check refused to send it — both are correct; sending an oversize payload
  // is the only wrong outcome, and that's what the assertion above would
  // have caught.
});

test("errors stop at the monitor ceiling, never more", () => {
  const h = runLite();
  for (let i = 0; i < MONITOR_EVENT_CEILING + 10; i++) {
    h.window_.fire("error", { error: new Error(`err ${i}`) });
  }
  assert.equal(h.sent.length, MONITOR_EVENT_CEILING);
});

test("a resource-load failure (no Error, foreign target) is not relayed — §9 has no network kind", () => {
  const h = runLite();
  h.window_.fire("error", { target: { tagName: "IMG" } });
  assert.equal(h.sent.length, 0);
});

test("device class reflects the user agent", () => {
  const mobile = runLite(CONFIG, { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" });
  mobile.window_.fire("error", { error: new Error("x") });
  assert.equal(mobile.sent[0].payload.dev, "mobile");

  const tablet = runLite(CONFIG, { userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)" });
  tablet.window_.fire("error", { error: new Error("x") });
  assert.equal(tablet.sent[0].payload.dev, "tablet");
});

// ---- vitals: sampling, "once per page", LCP/CLS/INP/TTFB -----------------------

/** Simulate one page view: sampled iff `randomValue < LITE_VITALS_SAMPLE_RATE`.
 *  Returns the harness so the caller can drive PerformanceObserver deliveries
 *  and the hide/pagehide report trigger. */
function simulatePage(randomValue) {
  return runLite(CONFIG, { random: () => randomValue });
}

test("vitals are sampled at the contract rate, decided once per page", () => {
  // 100 simulated page views, evenly spread across [0, 1) — deterministic:
  // exactly the ones under LITE_VITALS_SAMPLE_RATE (0.1) sample.
  const N = 100;
  let sampledPages = 0;
  for (let i = 0; i < N; i++) {
    const h = simulatePage(i / N);
    h.document_.visibilityState = "hidden";
    h.document_.fire("visibilitychange");
    const vitals = h.sent.filter((s) => s.payload.t === "vital");
    if (vitals.length > 0) sampledPages++;
  }
  const expected = Math.round(N * LITE_VITALS_SAMPLE_RATE);
  assert.equal(sampledPages, expected, `expected ~${expected}/${N} page views to sample vitals`);
});

test("vitals report never more than once per page, even if hidden fires twice", () => {
  const h = simulatePage(0); // sampled: 0 < 0.1
  h.fireEntries("layout-shift", [{ value: 0.1, hadRecentInput: false }]);
  h.document_.visibilityState = "hidden";
  h.document_.fire("visibilitychange");
  h.document_.fire("visibilitychange"); // fires again — must be a no-op
  h.window_.fire("pagehide");
  const clsBeacons = h.sent.filter((s) => s.payload.t === "vital" && s.payload.n === "CLS");
  assert.equal(clsBeacons.length, 1);
});

test("an unsampled page view sends no vitals at all, even with a hide event", () => {
  const h = simulatePage(0.99); // unsampled
  h.fireEntries("layout-shift", [{ value: 0.5, hadRecentInput: false }]);
  h.document_.visibilityState = "hidden";
  h.document_.fire("visibilitychange");
  assert.equal(h.sent.filter((s) => s.payload.t === "vital").length, 0);
});

test("LCP reports the last candidate observed, not the first", () => {
  const h = simulatePage(0);
  h.fireEntries("largest-contentful-paint", [{ renderTime: 500 }]);
  h.fireEntries("largest-contentful-paint", [{ renderTime: 500 }, { renderTime: 1200 }]);
  h.document_.visibilityState = "hidden";
  h.document_.fire("visibilitychange");
  const lcp = h.sent.find((s) => s.payload.n === "LCP");
  assert.ok(lcp, "an LCP beacon must be sent");
  assert.equal(lcp.payload.val, 1200);
});

test("CLS sums every layout-shift entry without recent input, across deliveries", () => {
  const h = simulatePage(0);
  h.fireEntries("layout-shift", [{ value: 0.05, hadRecentInput: false }, { value: 0.02, hadRecentInput: true }]);
  h.fireEntries("layout-shift", [{ value: 0.03, hadRecentInput: false }]);
  h.document_.visibilityState = "hidden";
  h.document_.fire("visibilitychange");
  const cls = h.sent.find((s) => s.payload.n === "CLS");
  assert.ok(cls);
  assert.ok(Math.abs(cls.payload.val - 0.08) < 1e-9, `expected ~0.08, got ${cls.payload.val}`);
});

test("INP approximation: the longest real-interaction event duration, ignoring interactionId 0", () => {
  const h = simulatePage(0);
  h.fireEntries("event", [
    { interactionId: 0, duration: 900 }, // not a real interaction — ignored
    { interactionId: 7, duration: 120 },
    { interactionId: 8, duration: 260 },
  ]);
  h.document_.visibilityState = "hidden";
  h.document_.fire("visibilitychange");
  const inp = h.sent.find((s) => s.payload.n === "INP");
  assert.ok(inp);
  assert.equal(inp.payload.val, 260);
});

test("no INP is sent when nothing crosses the interaction filter", () => {
  const h = simulatePage(0);
  h.fireEntries("event", [{ interactionId: 0, duration: 900 }]);
  h.document_.visibilityState = "hidden";
  h.document_.fire("visibilitychange");
  assert.equal(h.sent.some((s) => s.payload.n === "INP"), false);
});

test("TTFB comes from the navigation entry's responseStart", () => {
  const h = simulatePage(0);
  h.document_.visibilityState = "hidden";
  h.document_.fire("visibilitychange");
  const ttfb = h.sent.find((s) => s.payload.n === "TTFB");
  assert.ok(ttfb);
  assert.equal(ttfb.payload.val, 42);
});

test("every sent vital payload satisfies the ingest validator", () => {
  const h = simulatePage(0);
  h.fireEntries("layout-shift", [{ value: 0.01, hadRecentInput: false }]);
  h.document_.visibilityState = "hidden";
  h.document_.fire("visibilitychange");
  assert.ok(h.sent.length > 0);
  for (const { payload } of h.sent) assert.ok(isValidLitePayload(payload), JSON.stringify(payload));
});

// ---- the o11y worker's POST /telemetry/lite route -------------------------------
//
// Driven through the REAL router (`workers/o11y/src/index.ts`'s default
// export), the same `o11y-routes.test.mjs` pattern — status codes and the
// stored shape are proven through the actual route, never a re-declared copy.

function litePayload(overrides = {}) {
  return {
    v: 1,
    t: "err",
    s: "d",
    demo: "abc12345",
    ht: "18",
    fw: "react",
    n: "TypeError",
    m: "grid.render is not a function",
    val: null,
    dev: "desktop",
    ts: Date.now(),
    ...overrides,
  };
}

function freshEnv() {
  return makeEnv(InboxWriter);
}

function liteRequest(body, headers = {}) {
  return new Request("https://demos.handsontable.com/telemetry/lite", {
    method: "POST",
    headers: { Origin: "https://demos.handsontable.com", "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("POST /telemetry/lite: an accepted error beacon answers 2xx and lands in the browser tenant", async () => {
  const { env, doStorage } = freshEnv();
  const res = await worker.fetch(liteRequest(litePayload()), env, ctx);
  await ctx.drain();
  assert.ok(res.status >= 200 && res.status < 300, `expected 2xx, got ${res.status}`);

  const rowKeys = [...doStorage._data.keys()].filter((k) => k.startsWith("row:"));
  assert.ok(rowKeys.length > 0, "a record must be pending in storage");
  const stored = rowKeys.map((k) => doStorage._data.get(k)).flatMap((row) => row.resourceLogs);
  assert.equal(stored.length, 1);
});

// Fix round (item 8, ingest test gaps): `checkBrowserGates` (`gates/browser.ts`)
// is the ONE gate function both `/telemetry/collect` (`index.ts#handleCollect`)
// and `/telemetry/lite` (`lite.ts`, this file's own header: "Reuses T02's
// ingest machinery end-to-end... the browser gate (checkBrowserGates)") call,
// keyed only by `cf-connecting-ip` — never by route. No route-level test
// proved that: a route-scoped rate limiter (e.g. one budget per path) would
// have satisfied every EXISTING per-route test unchanged. Driven through the
// real router on both routes, with a fake `RATE_LIMITER` that enforces one
// shared budget across whatever `key` it is called with — fails if either
// route starts keying its rate limit separately (each route would then get
// its own untouched budget and never see the other's exhaustion).
test("POST /telemetry/collect and POST /telemetry/lite share the same rate limiter (same key, one shared budget)", async () => {
  const BUDGET = 2;
  const calls = [];
  let used = 0;
  const rateLimiter = {
    async limit({ key }) {
      calls.push(key);
      used++;
      return { success: used <= BUDGET };
    },
  };
  const { env } = makeEnv(InboxWriter, { env: { RATE_LIMITER: rateLimiter } });
  const ip = "203.0.113.7";

  // Spend the whole shared budget on /telemetry/collect alone — a minimal,
  // even structurally-invalid body is fine: the rate limit gate runs BEFORE
  // any body is read (`gates/browser.ts#checkBrowserGates`, called first in
  // both `handleCollect` and `lite.ts`).
  const collectRequest = () =>
    new Request("https://demos.handsontable.com/telemetry/collect", {
      method: "POST",
      headers: { Origin: "https://demos.handsontable.com", "content-type": "application/json", "cf-connecting-ip": ip },
      body: "{}",
    });
  for (let i = 0; i < BUDGET; i++) {
    const res = await worker.fetch(collectRequest(), env, ctx);
    await ctx.drain();
    assert.notEqual(res.status, 429, `/telemetry/collect call ${i + 1} of ${BUDGET} must still be within budget`);
  }

  // The budget is now spent — a /telemetry/lite request from the SAME ip
  // must be refused too, proving the two routes share the same counter, not
  // two independent ones.
  const liteRes = await worker.fetch(liteRequest(litePayload(), { "cf-connecting-ip": ip }), env, ctx);
  await ctx.drain();
  assert.equal(liteRes.status, 429, "/telemetry/lite must be rate-limited once /telemetry/collect has spent the shared budget for this ip");

  assert.equal(calls.length, BUDGET + 1);
  assert.ok(calls.every((k) => k === ip), "both routes must call the rate limiter with the identical key");
});

test("POST /telemetry/lite: the stored record's resourceLogs land under the browser tenant scope", async () => {
  const { env, r2 } = freshEnv();
  await worker.fetch(liteRequest(litePayload()), env, ctx);
  await ctx.drain();
  const inboxWriter = env.INBOX_WRITER.get();
  await inboxWriter.alarm();
  assert.equal(r2.objects.size, 1);
  const [key] = [...r2.objects.keys()];
  assert.match(key, /^inbox\/browser\//, "the lite beacon is browser-tenant, never worker");
});

test("POST /telemetry/lite: an oversize body is dropped with reason 'size'", async () => {
  const { env, ae, doStorage } = freshEnv();
  const oversized = litePayload({ st: "x".repeat(3000) });
  const res = await worker.fetch(liteRequest(oversized), env, ctx);
  await ctx.drain();
  assert.equal(res.status, 413);
  const rowKeys = [...doStorage._data.keys()].filter((k) => k.startsWith("row:"));
  assert.equal(rowKeys.length, 0, "an oversize beacon must never reach storage");
  const ingestPoints = ae.points.filter((p) => p.indexes[0] === "o11y.ingest");
  assert.ok(ingestPoints.some((p) => p.blobs[8] === "size"), "reason (blob9, index 8) must be 'size'");
});

test("POST /telemetry/lite: a malformed payload is dropped with an o11y.ingest point, never stored", async () => {
  const { env, ae, doStorage } = freshEnv();
  const res = await worker.fetch(liteRequest({ v: 1, t: "err" }), env, ctx); // missing required fields
  await ctx.drain();
  assert.equal(res.status, 400);
  const rowKeys = [...doStorage._data.keys()].filter((k) => k.startsWith("row:"));
  assert.equal(rowKeys.length, 0);
  const ingestPoints = ae.points.filter((p) => p.indexes[0] === "o11y.ingest");
  assert.ok(ingestPoints.some((p) => p.blobs[7] === "dropped"), "hot.outcome (blob8, index 7) must be 'dropped'");
});

test("POST /telemetry/lite: not-quite-JSON is a clean 400, not a 500", async () => {
  const { env } = freshEnv();
  const res = await worker.fetch(liteRequest("{not json", {}), env, ctx);
  await ctx.drain();
  assert.equal(res.status, 400);
});

test("POST /telemetry/lite: the stored timestamp is the beacon's ts, clamped to the receive time", async () => {
  const { env, r2 } = freshEnv();
  // Ten minutes in the past — outside ADR §C.2's ±5-minute clamp window.
  const farPast = Date.now() - 10 * 60 * 1000;
  await worker.fetch(liteRequest(litePayload({ ts: farPast })), env, ctx);
  await ctx.drain();
  const inboxWriter = env.INBOX_WRITER.get();
  const before = Date.now();
  await inboxWriter.alarm();
  const [, bytes] = [...r2.objects.entries()][0];
  const text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
  const resourceLogs = JSON.parse(text.trim());
  const nano = BigInt(resourceLogs.scopeLogs[0].logRecords[0].timeUnixNano);
  const storedMs = Number(nano / 1_000_000n);
  assert.ok(Math.abs(storedMs - farPast) > 5000, "the far-past ts must not survive unclamped");
  assert.ok(storedMs >= before - 60_000, "the clamped timestamp must fall back to (near) the receive time");
});

test("POST /telemetry/lite: an accepted web_vital beacon writes a web_vital AE point with the right blobs", async () => {
  const { env, ae } = freshEnv();
  const vital = {
    v: 1,
    t: "vital",
    s: "d",
    demo: "abc12345",
    ht: "18",
    fw: "react",
    n: "LCP",
    val: 2500,
    dev: "desktop",
    ts: Date.now(),
  };
  const res = await worker.fetch(liteRequest(vital), env, ctx);
  await ctx.drain();
  assert.ok(res.status >= 200 && res.status < 300, `expected 2xx, got ${res.status}`);
  const point = ae.points.find((p) => p.indexes[0] === "web_vital");
  assert.ok(point, "a web_vital point must be written");
  assert.equal(point.blobs[3], "d"); // hot.surface, blob4
  assert.equal(point.blobs[8], "LCP"); // reason, blob9
  assert.equal(point.blobs[11], "abc12345"); // demo_id, blob12
  assert.equal(point.doubles[2], 2500); // value, double3
});

test("POST /telemetry/lite: a duplicated beacon (identical payload, redelivered) does not double-count its error.uncaught point (finding A-I4)", async () => {
  const { env, ae } = freshEnv();
  const payload = litePayload();
  const first = await worker.fetch(liteRequest(payload), env, ctx);
  await ctx.drain();
  assert.ok(first.status >= 200 && first.status < 300);

  const second = await worker.fetch(liteRequest(payload), env, ctx);
  await ctx.drain();
  assert.ok(second.status >= 200 && second.status < 300, "a duplicate beacon must still answer 2xx");

  const errorPoints = ae.points.filter((p) => p.indexes[0] === "error.uncaught");
  assert.equal(errorPoints.length, 1, "a redelivered beacon must write exactly one error.uncaught point, not two");

  const ingestPoints = ae.points.filter((p) => p.indexes[0] === "o11y.ingest");
  assert.ok(
    ingestPoints.some((p) => p.blobs[7] === "duplicate"),
    "the second delivery's o11y.ingest point must say duplicate, matching the (now correct) single error.uncaught count",
  );
});

test("POST /telemetry/lite: an accepted error beacon writes an error.uncaught point with a fingerprint", async () => {
  const { env, ae } = freshEnv();
  await worker.fetch(liteRequest(litePayload()), env, ctx);
  await ctx.drain();
  const point = ae.points.find((p) => p.indexes[0] === "error.uncaught");
  assert.ok(point);
  assert.equal(point.blobs[3], "d"); // hot.surface
  assert.ok(point.blobs[10].startsWith("d:"), "fingerprint (blob11) is '<surface>:<hash>'"); // index 10
  assert.equal(point.blobs[11], "abc12345"); // demo_id
});

test("POST /telemetry/lite: the fingerprint ignores the stack — two rebuilds with the same n/m but a different hashed chunk in the stack must collapse to one fingerprint", async () => {
  // T08-D (see the task Outcome): folding the stack into the fingerprint would
  // mint a "new" fingerprint on every rebuild that shifts a chunk hash or line
  // number in the first frame — the same DEV-2853 ladder problem
  // `normalizeMonitorMessage` exists to collapse for the framed reporter, and
  // `d`/`embed` surfaces (unlike `demo-runtime`) feed the new-fingerprint
  // alert, so a false "new" here would page someone every deploy.
  const { env: envA, ae: aeA } = freshEnv();
  const { env: envB, ae: aeB } = freshEnv();
  await worker.fetch(
    liteRequest(litePayload({ st: "at Grid.render (chunk-abc123.js:10:4)" })),
    envA,
    ctx,
  );
  await ctx.drain();
  await worker.fetch(
    liteRequest(litePayload({ st: "at Grid.render (chunk-def456.js:12:9)" })),
    envB,
    ctx,
  );
  await ctx.drain();
  const fpA = aeA.points.find((p) => p.indexes[0] === "error.uncaught").blobs[10];
  const fpB = aeB.points.find((p) => p.indexes[0] === "error.uncaught").blobs[10];
  assert.equal(fpA, fpB, "same n/m, different stack chunk hash — must be the same fingerprint");
});
