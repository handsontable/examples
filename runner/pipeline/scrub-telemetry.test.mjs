// Observability contract §3 / ADR §E.4 — `scrubTelemetry`, one case per rule.
// Every input is realistic (a real Babel code frame, a real Tier-2 preview
// host, a real Chrome user-agent, an OTLP-shaped record with `url.full` and
// geo), and each case is isolated to the one rule it proves: a query-string
// case runs on a field the attribute allowlist would never touch by itself
// (`meta.page.url`, not `attributes["url.full"]`), so removing the
// query-stripping rule alone is what turns that case red — not a different
// rule accidentally covering for it.
//
// Filename note: the task's "Owns" row names this `pipeline/telemetry-*`;
// the acceptance criteria name the file `scrub-telemetry.test.mjs` verbatim,
// which is what this file is called (a deliberate exception, not a slip).
//
// Build prerequisite: `pnpm --filter @handsontable/demo-runtime build`.
// Run: node --experimental-strip-types --test pipeline/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { scrubTelemetry, stripQueryAndFragment } from "../packages/runtime/dist/telemetry/index.js";

// A real Babel code-frame throw, captured from
// `babel.transform("const x = ;", { presets: ["env"] })` (see
// telemetry-fingerprint.test.mjs for the two-line variant).
const CODE_FRAME_MESSAGE = "unknown: Unexpected token (1:10)\n\n> 1 | const x = ;\n    |           ^";

// A real Tier-2 preview host shape (`<port>-<sandboxId>-<token>.demos.handsontable.com`).
const PREVIEW_HOST = "3000-sbx7f2a-tok9xQ.demos.handsontable.com";

// A real Chrome-on-Windows UA string.
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

function faroLog(overrides = {}) {
  return {
    type: "log",
    payload: { message: "hello", ...overrides.payload },
    meta: { ...overrides.meta },
  };
}

// ---- console items are dropped ------------------------------------------------

test("drops a Faro log item tagged as relayed console output", () => {
  const item = faroLog({ payload: { context: { "hot.relay": "console-error" } } });
  assert.equal(scrubTelemetry(item), null);
});

test("does not drop an ordinary log item", () => {
  const item = faroLog({ payload: { context: { "hot.surface": "authoring" } } });
  assert.notEqual(scrubTelemetry(item), null);
});

// ---- drop `meta.user` -----------------------------------------------------------

test("drops meta.user entirely", () => {
  const item = faroLog({ meta: { user: { email: "artur.medrygal@handsontable.com", id: "u1" } } });
  const scrubbed = scrubTelemetry(item);
  assert.equal(scrubbed.meta.user, undefined);
});

// ---- reduce browser meta to device/browser classes ------------------------------

test("reduces meta.browser (a real Chrome UA) to the browser and device classes, dropping the raw UA", () => {
  const item = faroLog({ meta: { browser: { userAgent: CHROME_UA, viewportWidth: "1920", viewportHeight: "1080" } } });
  const scrubbed = scrubTelemetry(item);
  assert.deepEqual(scrubbed.meta.browser, { browser: "chrome", device: "desktop" });
});

test("drops meta.os and meta.device (fingerprint-shaped fields)", () => {
  const item = faroLog({ meta: { os: { name: "Windows", version: "10" }, device: { model_name: "Pixel 7" } } });
  const scrubbed = scrubTelemetry(item);
  assert.equal(scrubbed.meta.os, undefined);
  assert.equal(scrubbed.meta.device, undefined);
});

// ---- strip query/fragment on a URL-valued field, isolated from the attribute
// allowlist (advisor note: url.full would be dropped by the allowlist rule
// regardless, which would keep this case green even with query-stripping
// removed — meta.page.url is not an "attribute" at all, so only the
// query-stripping rule can make this pass) ---------------------------------------

test("strips the query string and fragment from meta.page.url", () => {
  const item = faroLog({ meta: { page: { url: "https://demos.handsontable.com/share/abc123?secret=1#frag" } } });
  const scrubbed = scrubTelemetry(item);
  assert.equal(scrubbed.meta.page.url, "https://demos.handsontable.com/share/abc123");
});

test("stripQueryAndFragment falls back to a cut at the first ?/# for a non-URL value", () => {
  assert.equal(stripQueryAndFragment("/share/abc123?secret=1#frag"), "/share/abc123");
  assert.equal(stripQueryAndFragment("/share/abc123"), "/share/abc123");
});

// ---- redact preview hosts, on a field the query-stripping rule never touches ---

test("redacts a real Tier-2 preview host in a stack-frame filename with no query string", () => {
  const item = {
    type: "exception",
    payload: {
      value: "boom",
      stacktrace: { frames: [{ filename: `https://${PREVIEW_HOST}/src/main.js`, function: "render" }] },
    },
    meta: {},
  };
  const scrubbed = scrubTelemetry(item);
  assert.equal(scrubbed.payload.stacktrace.frames[0].filename, "https://<preview>/src/main.js");
});

test("strips a bundler cache-busting query string from a stack-frame filename too", () => {
  const item = {
    type: "exception",
    payload: {
      value: "boom",
      stacktrace: { frames: [{ filename: "https://demos.handsontable.com/src/main.js?t=1758625200001", function: "render" }] },
    },
    meta: {},
  };
  const scrubbed = scrubTelemetry(item);
  assert.equal(scrubbed.payload.stacktrace.frames[0].filename, "https://demos.handsontable.com/src/main.js");
});

test("redacts a preview host on meta.page.url together with the query strip", () => {
  const item = faroLog({ meta: { page: { url: `https://${PREVIEW_HOST}/src/main.js?x=1` } } });
  const scrubbed = scrubTelemetry(item);
  assert.equal(scrubbed.meta.page.url, "https://<preview>/src/main.js");
});

// ---- strip Babel code frames from message-bearing fields -----------------------

test("strips a real Babel code frame from a log item's message", () => {
  const item = faroLog({ payload: { message: CODE_FRAME_MESSAGE } });
  const scrubbed = scrubTelemetry(item);
  assert.equal(scrubbed.payload.message, "unknown: Unexpected token (1:10)");
});

test("strips a real Babel code frame from an exception's value", () => {
  const item = { type: "exception", payload: { value: CODE_FRAME_MESSAGE }, meta: {} };
  const scrubbed = scrubTelemetry(item);
  assert.equal(scrubbed.payload.value, "unknown: Unexpected token (1:10)");
});

// ---- allowlist attributes/context (drops forbidden attrs, §3) ------------------

test("drops forbidden Faro context attributes (url.full, geo), keeps allowlisted hot.* ones", () => {
  const item = faroLog({
    payload: {
      context: {
        "hot.surface": "authoring",
        "url.full": "https://demos.handsontable.com/api/versions?x=1",
        "geo.country": "PL",
        "client.address": "127.0.0.1",
      },
    },
  });
  const scrubbed = scrubTelemetry(item);
  assert.deepEqual(scrubbed.payload.context, { "hot.surface": "authoring" });
});

// ---- redactPreviewHosts on every string, not only the fields named above -------

test("redacts a preview host inside an allowlisted context value (session.id), which no targeted rule above touches", () => {
  const item = faroLog({
    payload: { context: { "session.id": `plid-from-https://${PREVIEW_HOST}/leaked` } },
  });
  const scrubbed = scrubTelemetry(item);
  assert.equal(scrubbed.payload.context["session.id"], "plid-from-https://<preview>/leaked");
});

test("redacts a preview host inside payload.type (an exception's error-class name), a field no targeted rule names", () => {
  const item = {
    type: "exception",
    payload: { type: `Error<https://${PREVIEW_HOST}>`, value: "boom" },
    meta: {},
  };
  const scrubbed = scrubTelemetry(item);
  assert.equal(scrubbed.payload.type, "Error<https://<preview>>");
});

// ---- the OTLP-shape branch (ingest, on an already-normalised record) -----------

test("scrubs an OTLP-shaped record: drops url.full and geo attributes, strips code frame and preview host from the body", () => {
  const record = {
    body: `${CODE_FRAME_MESSAGE}\nat https://${PREVIEW_HOST}/src/main.js`,
    attributes: { "hot.demo_id": "r-react-18-0-0" },
    resourceAttributes: {
      "hot.surface": "api",
      "url.full": "https://demos.handsontable.com/api/versions?x=1",
      "geo.country": "PL",
      "geo.asn": "12345",
    },
  };
  const scrubbed = scrubTelemetry(record);
  assert.deepEqual(scrubbed.resourceAttributes, { "hot.surface": "api" });
  assert.deepEqual(scrubbed.attributes, { "hot.demo_id": "r-react-18-0-0" });
  assert.equal(scrubbed.body, "unknown: Unexpected token (1:10)\nat https://<preview>/src/main.js");
});

// ---- never mutates the input ----------------------------------------------------

test("never mutates its argument", () => {
  const item = faroLog({ meta: { user: { email: "x@y.z" } } });
  const before = JSON.stringify(item);
  scrubTelemetry(item);
  assert.equal(JSON.stringify(item), before);
});
