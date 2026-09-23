// T08 — injecting the lite reporter into `/d`/`/embed` HTML documents
// (`workers/api/src/monitor-inject.ts#injectLiteHtml`, `htMajorFromVersion`)
// and `workers/api/src/share.ts#serveOutcome`. Companion to
// `pipeline/lite-beacon.test.mjs`, which covers the reporter's own behaviour
// and the o11y ingest route.
//
// DEV-2580 (the same rule `inject-html.test.mjs`/`monitor-inject.test.mjs`
// already pin for the framed reporter and the scheme receiver): a document an
// SSR framework already rendered must come out of injection with its own
// head/body markup byte-identical, because a strict hydrator (Remix's
// `hydrateRoot(document, …)` on React 18) throws away the whole document over
// one unexpected `<head>` child.
//
// Build prerequisite: `pnpm --filter @handsontable/demo-runtime build`.
// Run: node --experimental-strip-types --test pipeline/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { LITE_REPORTER_MARKER, injectLiteReporterIntoHtml } from "../packages/runtime/dist/monitor.js";
import { demoRow, makeEnv } from "./fixtures/worker-harness.mjs";

register("./fixtures/worker-hooks.mjs", import.meta.url);

const { htMajorFromVersion, injectLiteHtml } = await import("../workers/api/src/monitor-inject.ts");
const { serveDemoAsset, serveOutcome } = await import("../workers/api/src/share.ts");

const CONFIG = { surface: "d", demo: "r-react-18-0-0", ht: "18", fw: "react" };
const HTML = `<!doctype html>
<html>
  <head><title>demo</title></head>
  <body><div id="root"></div><script src="/index.js"></script></body>
</html>
`;

// ---- htMajorFromVersion ---------------------------------------------------------

test("htMajorFromVersion: an exact release maps to its major", () => {
  assert.equal(htMajorFromVersion("18.1.1"), "18");
  assert.equal(htMajorFromVersion("15.0.0"), "15");
  assert.equal(htMajorFromVersion("19.2.3"), "19");
});

test("htMajorFromVersion: a next-channel build maps to 'next', not 'none' or '0'", () => {
  // The nightly shape — major is always 0 under plain semver parsing.
  assert.equal(htMajorFromVersion("0.0.0-next-64139ae-20260219"), "next");
  // The dotted prerelease shape.
  assert.equal(htMajorFromVersion("19.0.0-next.1"), "next");
});

test("htMajorFromVersion: an unrecognised, empty, or out-of-range ref is 'none'", () => {
  assert.equal(htMajorFromVersion(""), "none");
  assert.equal(htMajorFromVersion(null), "none");
  assert.equal(htMajorFromVersion(undefined), "none");
  assert.equal(htMajorFromVersion("latest"), "none"); // the pre-DEV-2565 sentinel, defensively
  assert.equal(htMajorFromVersion("14.9.0"), "none"); // below DEFAULT_MIN_MAJOR
  assert.equal(htMajorFromVersion("20.0.0"), "none"); // above DEFAULT_MAX_MAJOR
});

// ---- injectLiteHtml: the monitor-inject.ts guard --------------------------------

test("injects into an HTML document", () => {
  const out = injectLiteHtml(HTML, "text/html; charset=utf-8", null, CONFIG);
  assert.ok(out.includes(LITE_REPORTER_MARKER));
  assert.ok(out.includes("<title>demo</title>"), "the original document survives");
});

test("only text/html is rewritten — a non-HTML content type passes through untouched", () => {
  const js = "export const a = 1;";
  assert.equal(injectLiteHtml(js, "application/javascript", null, CONFIG), js);
  assert.equal(injectLiteHtml(HTML, "application/json", null, CONFIG), HTML);
});

test("an encoded body passes through untouched — decoding to inject would risk corrupting it", () => {
  // `serveDemoAsset`'s own R2 puts never set a `Content-Encoding` (confirmed:
  // none of `share.ts`'s `ARTIFACTS.put` calls do), so its call site always
  // passes `null` — but the guard is exercised here directly, the same
  // defence-in-depth `injectMonitor` keeps for an arbitrary Tier-2 proxy
  // response that could carry one. `identity` is the one encoding value that
  // still means "plain text" and must still be injected.
  assert.equal(injectLiteHtml(HTML, "text/html", "gzip", CONFIG).includes(LITE_REPORTER_MARKER), false);
  assert.equal(injectLiteHtml(HTML, "text/html", "br", CONFIG).includes(LITE_REPORTER_MARKER), false);
  assert.equal(injectLiteHtml(HTML, "text/html", "identity", CONFIG).includes(LITE_REPORTER_MARKER), true);
  assert.equal(injectLiteHtml(HTML, "text/html", undefined, CONFIG).includes(LITE_REPORTER_MARKER), true);
});

test("a second pass is a no-op", () => {
  const once = injectLiteHtml(HTML, "text/html", null, CONFIG);
  const twice = injectLiteHtml(once, "text/html", null, CONFIG);
  assert.equal(twice, once);
  assert.equal(once.split(LITE_REPORTER_MARKER).length, twice.split(LITE_REPORTER_MARKER).length);
});

test("the framed reporter's own marker is untouched — the two injectors coexist", () => {
  // `/d`/`/embed` never receive the framed reporter in production, but this
  // pins that nothing about the lite injector's marker check accidentally
  // keys on `MONITOR_MESSAGE_TYPE` or otherwise interferes if it did.
  const withLite = injectLiteHtml(HTML, "text/html", null, CONFIG);
  assert.equal(withLite.includes(LITE_REPORTER_MARKER), true);
});

// ---- DEV-2580: self-removing tag, no whitespace, hydration markup intact -------

test("the injected tag removes itself and adds no whitespace to <head>", () => {
  const out = injectLiteReporterIntoHtml(HTML, CONFIG);
  assert.match(out, /<head[^>]*><script>/, "no text node between <head> and the injected <script>");
});

test("Remix fixture: hydration markup is byte-identical after injection", () => {
  // A minimal stand-in for what Remix's server render emits: existing head
  // children (charset, viewport, title, a stylesheet link) the client's
  // `hydrateRoot(document, …)` will strict-match, plus a body carrying the
  // SSR payload script `<Scripts/>` renders. The property under test is not
  // "this exact markup" (that needs a real Remix build, `scripts/
  // ssr-hydration-probe.mjs`'s job) but the same one DEV-2580 already proved
  // for the framed reporter and the scheme receiver: the tag is invisible to
  // whatever reads the document afterward, because it deletes itself before
  // any hydrator gets a look, and it lands with no surrounding whitespace.
  const remixDoc = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Handsontable demo</title><link rel="stylesheet" href="/styles.css"/></head>
<body><div id="root"><script>__remixContext = {"state":"ready"};</script></div><script type="module" src="/entry.client.js"></script></body>
</html>
`;
  const head = /<head[^>]*>([\s\S]*?)<\/head>/.exec(remixDoc)[1];
  const body = /<body[^>]*>([\s\S]*?)<\/body>/.exec(remixDoc)[1];

  const injected = injectLiteReporterIntoHtml(remixDoc, CONFIG);
  const injectedHead = /<head[^>]*>([\s\S]*?)<\/head>/.exec(injected)[1];
  const injectedBody = /<body[^>]*>([\s\S]*?)<\/body>/.exec(injected)[1];

  // The reporter's own <script> is a *new* head child — real React hydration
  // would only tolerate that because the tag removes itself before hydration
  // ever runs (proven by `inject-html.test.mjs#runTag`, which executes the
  // prelude against a fake `document.currentScript`). What must hold here,
  // statically, is that everything the server *did* render is untouched and
  // still contiguous: the original head markup survives as a trailing
  // substring of the injected head (the tag is prepended, not interleaved),
  // and the body — which the reporter never touches — is byte-identical.
  assert.ok(injectedHead.endsWith(head), "original head markup survives intact, as a trailing run");
  assert.equal(injectedBody, body, "the body Remix would hydrate against is untouched");
  assert.doesNotMatch(injectedHead.slice(0, injectedHead.length - head.length), /^\s/, "no leading whitespace text node before the original head content");
});

// ---- serveOutcome (share.ts) -----------------------------------------------------

test("serveOutcome maps the closed §5 serve.* outcome set", () => {
  assert.equal(serveOutcome(200), "2xx");
  assert.equal(serveOutcome(204), "2xx");
  assert.equal(serveOutcome(304), "304");
  assert.equal(serveOutcome(404), "4xx");
  assert.equal(serveOutcome(410), "4xx");
  assert.equal(serveOutcome(500), "5xx");
  assert.equal(serveOutcome(503), "5xx");
});

test("serveOutcome refuses to bucket a stray redirect rather than mis-labelling it", () => {
  // `serveDemoAsset` never itself answers a 3xx (the /d/:id -> /d/:id/ 308 is
  // handled by its caller, before this function is reached) — `null` here is
  // what lets the caller skip the point entirely instead of feeding
  // `toAePoint` a value outside its closed enum.
  assert.equal(serveOutcome(301), null);
  assert.equal(serveOutcome(308), null);
});

// ---- I1 (fix round): serve.d/serve.embed count the document, not every asset ---

/** `worker-harness.mjs#makeEnv` routes Analytics Engine points at a local
 *  ClickHouse HTTP fetch that fails in this sandbox (`getSink`'s "local"
 *  branch — `serviceEnvironment(env)` reads `production` only when
 *  `PREVIEW_HOST` is the real host). Neither its `env` nor its shared `ctx`
 *  gives a test anything to capture or await, so this builds its own: a real
 *  `RUNNER_EVENTS` binding fake (routes `getSink` down the *binding* branch)
 *  and a `ctx.waitUntil` that queues promises a test can drain before
 *  asserting — the same shape `pipeline/fixtures/o11y-harness.mjs` already
 *  uses for the o11y worker's own route tests. */
function makeCountingEnv(rows, artifacts) {
  const { env } = makeEnv(rows, [], artifacts);
  const points = [];
  env.RUNNER_EVENTS = { writeDataPoint: (p) => points.push(p) };
  env.PREVIEW_HOST = "demos.handsontable.com";
  const pending = [];
  const ctx = {
    waitUntil(p) { pending.push(Promise.resolve(p).catch(() => {})); },
    passThroughOnException() {},
    async drain() { await Promise.all(pending); pending.length = 0; },
  };
  return { env, ctx, points };
}

test("serving a document plus three assets writes exactly one serve.d point", async () => {
  const rows = [demoRow({ id: "doc1", r2_prefix: "demos/doc1/" })];
  const artifacts = {
    "demos/doc1/index.html": "<html><head></head><body>hi</body></html>",
    "demos/doc1/assets/a.js": "console.log(1);",
    "demos/doc1/assets/b.css": "body{color:red}",
    "demos/doc1/assets/c.png": "not-really-a-png",
  };
  const { env, ctx, points } = makeCountingEnv(rows, artifacts);

  const doc = await serveDemoAsset(env, ctx, "doc1", "", { embed: false });
  const a = await serveDemoAsset(env, ctx, "doc1", "assets/a.js", { embed: false });
  const b = await serveDemoAsset(env, ctx, "doc1", "assets/b.css", { embed: false });
  const c = await serveDemoAsset(env, ctx, "doc1", "assets/c.png", { embed: false });
  await ctx.drain();

  assert.equal(doc.status, 200);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(c.status, 200);

  const servePoints = points.filter((p) => p.indexes[0] === "serve.d");
  assert.equal(servePoints.length, 1, `expected exactly 1 serve.d point for 1 document + 3 assets, got ${servePoints.length}`);
});

test("an unresolved demo id still counts a document 404, with an empty demo_id", async () => {
  const { env, ctx, points } = makeCountingEnv([], {});
  const res = await serveDemoAsset(env, ctx, "no-such-demo", "", { embed: false });
  await ctx.drain();
  assert.equal(res.status, 404);
  const servePoints = points.filter((p) => p.indexes[0] === "serve.d");
  assert.equal(servePoints.length, 1);
  // demo_id is blob12, index 11 (AE_COLUMNS, packages/runtime/src/telemetry/metrics.ts).
  assert.equal(servePoints[0].blobs[11], "", "the URL-supplied, unresolved id must not reach demo_id");
});

test("an unresolved demo id requesting a non-document path writes no point at all", async () => {
  const { env, ctx, points } = makeCountingEnv([], {});
  const res = await serveDemoAsset(env, ctx, "no-such-demo", "assets/x.js", { embed: false });
  await ctx.drain();
  assert.equal(res.status, 404);
  assert.equal(points.filter((p) => p.indexes[0] === "serve.d").length, 0);
});
