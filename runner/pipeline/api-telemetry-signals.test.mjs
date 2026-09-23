import test from "node:test";
import assert from "node:assert/strict";
import { demoIdFromPath, routeClassOf } from "../workers/api/src/telemetry/route-class.ts";
import { serviceEnvironment, serviceVersion } from "../workers/api/src/telemetry/resource.ts";
import { sentryScopeIsFull } from "../workers/api/src/telemetry/scope.ts";

// T05 — route classification (blob10 `route_class`, contract §4) and the
// service.version / deployment.environment.name resource attrs (contract §3).
//
// `route-class.ts` and `resource.ts` are deliberately import-free of their
// sibling `.ts` files (see resource.ts's own doc comment) so this file can
// import them directly under `--experimental-strip-types`, the same
// constraint `sentry-gate.ts`/`preview-boot.ts` already document — a sibling
// `.ts` file's compiled `.js` specifier does not resolve that way (confirmed
// while writing this task: importing the pre-fix `resource.ts`, which
// re-exported `sentry-gate.ts`'s `PRODUCTION_HOST`, failed with
// `Cannot find module '.../sentry-gate.js'`).

test("routeClassOf: the exact case the acceptance criteria names", () => {
  assert.equal(routeClassOf("GET", "/api/versions"), "api/versions");
});

test("routeClassOf: dynamic ids collapse, not the whole path", () => {
  assert.equal(routeClassOf("POST", "/api/session"), "api/session");
  assert.equal(routeClassOf("DELETE", "/api/session/react-18-abc123"), "api/session/:id");
  assert.equal(routeClassOf("GET", "/api/session/react-18-abc123/status"), "api/session/:id/status");
  assert.equal(routeClassOf("POST", "/api/session/react-18-abc123/file"), "api/session/:id/file");
});

test("routeClassOf: shared demos and embeds", () => {
  assert.equal(routeClassOf("GET", "/d/abc123"), "d/:id");
  assert.equal(routeClassOf("GET", "/embed/abc123"), "embed/:id");
});

test("routeClassOf: versions/exists is distinct from versions", () => {
  assert.equal(routeClassOf("GET", "/api/versions/exists"), "api/versions/exists");
});

test("routeClassOf: chat/event is distinct from chat", () => {
  assert.equal(routeClassOf("POST", "/api/chat"), "api/chat");
  assert.equal(routeClassOf("POST", "/api/chat/event"), "api/chat/event");
});

test("routeClassOf: root and an unmatched top-level path", () => {
  assert.equal(routeClassOf("GET", "/"), "root");
  assert.equal(routeClassOf("GET", "/robots.txt"), "other");
});

test("routeClassOf: never throws on a malformed path", () => {
  assert.doesNotThrow(() => routeClassOf("GET", ""));
  assert.doesNotThrow(() => routeClassOf("GET", "//api//"));
});

test("demoIdFromPath: extracted for the routes that name one, empty otherwise", () => {
  assert.equal(demoIdFromPath("/d/abc123"), "abc123");
  assert.equal(demoIdFromPath("/embed/abc123"), "abc123");
  assert.equal(demoIdFromPath("/api/versions"), "");
  assert.equal(demoIdFromPath("/api/session/sess-1/status"), "");
});

test("serviceEnvironment: production only under the real host", () => {
  assert.equal(serviceEnvironment({ PREVIEW_HOST: "demos.handsontable.com" }), "production");
  assert.equal(serviceEnvironment({ PREVIEW_HOST: "localhost:8787" }), "local");
  assert.equal(serviceEnvironment({}), "local");
});

test("serviceEnvironment: the check is equality, not a prefix or a suffix test", () => {
  // Same rule sentry-gate.ts's apiSentryDsn already pins, both directions: a
  // `.startsWith(PRODUCTION_HOST)` relaxation would still fail this first
  // case, and (measured, not assumed — this exact case did NOT catch a
  // `.endsWith(PRODUCTION_HOST)` mutation on a first draft of this test,
  // caught only by adding the second case) an `.endsWith(PRODUCTION_HOST)`
  // relaxation would pass the first case but fail the second.
  assert.equal(serviceEnvironment({ PREVIEW_HOST: "demos.handsontable.com.evil.test" }), "local");
  assert.equal(serviceEnvironment({ PREVIEW_HOST: "evil-demos.handsontable.com" }), "local");
});

test("serviceVersion: SERVICE_VERSION wins, then CF_VERSION_METADATA, then a literal fallback", () => {
  assert.equal(serviceVersion({ SERVICE_VERSION: "abc123" }), "abc123");
  assert.equal(serviceVersion({ CF_VERSION_METADATA: { id: "v-id", tag: "" } }), "v-id");
  assert.equal(serviceVersion({}), "dev");
});

test("serviceVersion: an empty --var (wrangler's own empty-string shape) still falls through", () => {
  // `wrangler deploy --var SERVICE_VERSION:` yields "", exactly like
  // SENTRY_ENVIRONMENT's documented empty-string case in sentry-gate.ts.
  assert.equal(serviceVersion({ SERVICE_VERSION: "", CF_VERSION_METADATA: { id: "v-id", tag: "" } }), "v-id");
});

// ── contract §11: the Sentry scope switch's decision ─────────────────────────
//
// `diagnostic.ts#reportDiagnostic` gates its `Sentry.captureException` call on
// this function's result (`if (sentryScopeIsFull(env)) { Sentry.captureException(...) }`
// — read directly in the source, since `diagnostic.ts` itself pulls in the
// real `@sentry/cloudflare` package and `./lines.js`/`./points.js`, which this
// harness cannot resolve the same way `resource.ts`'s doc comment explains).
// This is the decision alone; a live transport-spy integration check needs a
// running `wrangler dev`, where Sentry deliberately never initialises at all
// (sentry-gate.ts's own local-dev gate) — reported instead in the task Outcome.

test("sentryScopeIsFull: full (the default) is true", () => {
  assert.equal(sentryScopeIsFull({ SENTRY_SCOPE: "full" }), true);
});

test("sentryScopeIsFull: uncaught is false", () => {
  assert.equal(sentryScopeIsFull({ SENTRY_SCOPE: "uncaught" }), false);
});

test("sentryScopeIsFull: absent means full, exactly like leaving the wrangler.jsonc var out", () => {
  assert.equal(sentryScopeIsFull({}), true);
});
