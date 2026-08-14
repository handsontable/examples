import test from "node:test";
import assert from "node:assert/strict";
import { injectMonitor } from "../workers/api/src/monitor-inject.ts";
import { MONITOR_MESSAGE_TYPE } from "../packages/runtime/dist/monitor.js";

// DEV-2527, Tier-2 half. This gate decides whether every anonymous visitor's
// container preview reports, so each branch is pinned: the flag, the production-host
// pairing, and the three response shapes that must pass through untouched.

const PROD = "demos.handsontable.com";
const ON = { MONITOR_DEMOS: "1", PREVIEW_HOST: PROD };
const HTML = "<!doctype html><html><head><title>demo</title></head><body>hi</body></html>";

const htmlResponse = (body = HTML, headers = {}) =>
  new Response(body, { headers: { "content-type": "text/html; charset=utf-8", ...headers } });

test("injects into a proxied HTML document", async () => {
  const out = await injectMonitor(htmlResponse(), ON, PROD);
  const body = await out.text();
  assert.ok(body.includes(MONITOR_MESSAGE_TYPE));
  assert.ok(body.includes("<title>demo</title>"), "the dev server's own document survives");
  assert.equal(out.headers.get("content-type"), "text/html; charset=utf-8");
});

test("drops a now-wrong Content-Length", async () => {
  // A stale length against a longer body is a truncated page.
  const out = await injectMonitor(htmlResponse(HTML, { "content-length": String(HTML.length) }), ON, PROD);
  assert.equal(out.headers.get("content-length"), null);
});

test("is off unless the flag is exactly \"1\"", async () => {
  for (const vars of [{ PREVIEW_HOST: PROD }, { MONITOR_DEMOS: "0", PREVIEW_HOST: PROD }, { MONITOR_DEMOS: "true", PREVIEW_HOST: PROD }]) {
    const body = await (await injectMonitor(htmlResponse(), vars, PROD)).text();
    assert.equal(body.includes(MONITOR_MESSAGE_TYPE), false, `flag ${JSON.stringify(vars)} must be off`);
  }
});

test("is off outside production, whatever the flag says", async () => {
  // `wrangler dev` overrides PREVIEW_HOST in .dev.vars — the same discriminator the
  // Sentry init uses, so a local run can never inject.
  const local = { MONITOR_DEMOS: "1", PREVIEW_HOST: "localhost:8787" };
  const body = await (await injectMonitor(htmlResponse(), local, PROD)).text();
  assert.equal(body.includes(MONITOR_MESSAGE_TYPE), false);
});

test("passes non-HTML assets straight through", async () => {
  const js = new Response("export const a = 1;", { headers: { "content-type": "application/javascript" } });
  const out = await injectMonitor(js, ON, PROD);
  assert.equal(out, js, "same response object — the body must keep streaming");
});

test("leaves an encoded body alone", async () => {
  const gz = htmlResponse(HTML, { "content-encoding": "gzip" });
  const out = await injectMonitor(gz, ON, PROD);
  assert.equal(out, gz, "decoding to inject would risk corrupting the preview");
});

test("passes a bodyless response through", async () => {
  const empty = new Response(null, { status: 304, headers: { "content-type": "text/html" } });
  const out = await injectMonitor(empty, ON, PROD);
  assert.equal(out, empty);
});

test("preserves status and statusText", async () => {
  const notFound = new Response(HTML, {
    status: 404,
    statusText: "Not Found",
    headers: { "content-type": "text/html" },
  });
  const out = await injectMonitor(notFound, ON, PROD);
  assert.equal(out.status, 404);
  // A dev server's own 404 page is a document worth seeing errors from too.
  assert.ok((await out.text()).includes(MONITOR_MESSAGE_TYPE));
});

test("is idempotent", async () => {
  const once = await injectMonitor(htmlResponse(), ON, PROD);
  const twice = await injectMonitor(htmlResponse(await once.clone().text()), ON, PROD);
  const body = await twice.text();
  assert.equal(body.split(MONITOR_MESSAGE_TYPE).length - 1, (await once.text()).split(MONITOR_MESSAGE_TYPE).length - 1);
});
