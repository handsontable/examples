import test from "node:test";
import assert from "node:assert/strict";
import {
  BOOT_WINDOW_MS,
  classifyPreviewBootFailure,
  isPreviewPortUnreachable,
} from "../workers/api/src/preview-boot.ts";
import { errorPageHtml, errorPageResponse } from "../workers/api/src/error-page.ts";

// DEV-2537. The classifier decides what an anonymous visitor sees when the
// container is up but nothing is listening on the dev-server port, and whether
// that fact is worth a Sentry issue. Both halves are pinned here because the
// Durable Object seam that calls it cannot be exercised from `pipeline/` at all
// — reproducing a mid-boot port refusal needs a real container caught in a
// narrow window.

// DEMOS-K. `isPreviewPortUnreachable` (renamed from `isPortNotListening`) has to
// recognise all three workerd messages behind the throw, not just the one it
// shipped with — see the fixtures below, verbatim from the issue's `error.value`.

/** The verbatim workerd message PR #195 originally covered. */
const WORKERD = "There has been an internal error connecting to the port";
/** 3 of 20 DEMOS-K events, last seen 2026-08-10 — pre-deploy only. */
const WORKERD_NOT_LISTENING = "The container is not listening in the TCP address 10.0.0.1:4321";
/** 14 of 20 DEMOS-K events, and 5 of 5 post-deploy — the shape the old regex missed. */
const WORKERD_NOT_RUNNING = "The container is not running, consider calling start()";

const html = { isUpgrade: false, wantsHtml: true, acceptsHtml: true };

test("recognises the workerd port message PR #195 shipped with", () => {
  // Silent in production for 14 days straight — a regression here is a shipped 500.
  assert.equal(isPreviewPortUnreachable(new Error(WORKERD)), true);
});

test("recognises the 'not listening in the TCP address' shape", () => {
  assert.equal(isPreviewPortUnreachable(new Error(WORKERD_NOT_LISTENING)), true);
});

test("the TCP-address matcher is not pinned to one address", () => {
  // A second IP/port that never appeared in a fixture before this plan.
  assert.equal(
    isPreviewPortUnreachable(new Error("The container is not listening in the TCP address 10.0.0.2:3001")),
    true,
  );
});

test("recognises the 'not running, consider calling start()' shape", () => {
  // 14 of 20 DEMOS-K events and 5 of 5 post-deploy — the shape the old regex
  // never covered, and the entire reason this plan exists.
  assert.equal(isPreviewPortUnreachable(new Error(WORKERD_NOT_RUNNING)), true);
});

test("recognises all three shapes through a cause chain", () => {
  const wrapped = new Error("preview forward failed", { cause: new Error(WORKERD) });
  assert.equal(isPreviewPortUnreachable(wrapped), true);
  assert.equal(isPreviewPortUnreachable(new Error("outer", { cause: wrapped })), true);

  assert.equal(
    isPreviewPortUnreachable(new Error("wrapped", { cause: new Error(WORKERD_NOT_LISTENING) })),
    true,
  );
  assert.equal(
    isPreviewPortUnreachable(new Error("wrapped", { cause: new Error(WORKERD_NOT_RUNNING) })),
    true,
  );
});

test("does not match errors that are somebody else's job", () => {
  // Handled upstream by forwardPreviewRequest, which turns it into a 500 of
  // its own. Matching it here would take over a case we have not diagnosed.
  assert.equal(isPreviewPortUnreachable(new Error("Network connection lost.")), false);
  assert.equal(isPreviewPortUnreachable(new Error("boom")), false);
  assert.equal(isPreviewPortUnreachable(new Error("no such image")), false);
});

test("does not match a genuine boot failure or an adjacent 'container is not …' phrasing", () => {
  // Keeps the widening from becoming a catch-all: both of these keep today's
  // status (a thrown 500) and today's report.
  assert.equal(isPreviewPortUnreachable(new Error("Container failed to start: exit 137")), false);
  assert.equal(isPreviewPortUnreachable(new Error("The container is not authorized")), false);
});

test("does not match non-errors", () => {
  assert.equal(isPreviewPortUnreachable(undefined), false);
  assert.equal(isPreviewPortUnreachable(null), false);
  assert.equal(isPreviewPortUnreachable("connecting to the port"), false);
});

test("terminates on a self-referencing cause", () => {
  const loop = new Error("a");
  loop.cause = loop;
  assert.equal(isPreviewPortUnreachable(loop), false);

  const a = new Error("a");
  const b = new Error("b", { cause: a });
  a.cause = b;
  assert.equal(isPreviewPortUnreachable(a), false);
});

test("a WebSocket upgrade is never answered with a document", () => {
  for (const elapsedMs of [1_000, 200_000]) {
    const d = classifyPreviewBootFailure({ elapsedMs, isUpgrade: true, wantsHtml: true, acceptsHtml: true });
    assert.equal(d.shape, "bare", `elapsedMs=${elapsedMs}`);
    assert.equal(d.refreshSeconds, undefined, "a meta-refresh in an upgrade body is meaningless");
  }
});

test("a sub-resource gets plain text, not a styled page", () => {
  const d = classifyPreviewBootFailure({ ...html, elapsedMs: 5_000, wantsHtml: false });
  assert.equal(d.shape, "text");
  assert.equal(d.refreshSeconds, undefined);
});

test("an extensionless request that did not ask for HTML gets plain text", () => {
  // Vite serves `/@vite/client` and `/@react-refresh` — extensionless, so the
  // path heuristic calls them documents. Their `Accept` is `*/*`.
  const d = classifyPreviewBootFailure({ ...html, elapsedMs: 5_000, acceptsHtml: false });
  assert.equal(d.shape, "text");
});

test("inside the boot window the page retries and files nothing", () => {
  const d = classifyPreviewBootFailure({ ...html, elapsedMs: 5_000 });
  assert.equal(d.shape, "html");
  assert.equal(d.report, false);
  assert.equal(d.refreshSeconds, 2);
  assert.equal(d.retryAfterSeconds, 2);
  assert.ok(d.title.length > 0 && d.body.length > 0);
});

test("past the boot window the page stops promising a recovery", () => {
  const d = classifyPreviewBootFailure({ ...html, elapsedMs: 120_000 });
  assert.equal(d.shape, "html");
  assert.equal(d.report, true);
  assert.equal(d.refreshSeconds, undefined, "a refresh loop past the window lies to the visitor");
  assert.equal(d.retryAfterSeconds, 30);
});

test("the window boundary is crossed exactly once", () => {
  assert.equal(classifyPreviewBootFailure({ ...html, elapsedMs: BOOT_WINDOW_MS - 1 }).report, false);
  assert.equal(classifyPreviewBootFailure({ ...html, elapsedMs: BOOT_WINDOW_MS }).report, true);
});

test("the terminal branch reports for every shape, not just the document", () => {
  const past = { elapsedMs: BOOT_WINDOW_MS + 1 };
  assert.equal(classifyPreviewBootFailure({ ...html, ...past, isUpgrade: true }).report, true);
  assert.equal(classifyPreviewBootFailure({ ...html, ...past, wantsHtml: false }).report, true);
});

test("the terminal copy never tells the visitor to reload the frame", () => {
  // The page renders inside the demo's iframe. Reloading it re-requests the
  // same dead preview URL and lands back here; only reopening the enclosing
  // page mints a new session.
  const d = classifyPreviewBootFailure({ ...html, elapsedMs: 120_000 });
  assert.ok(!/reload/i.test(`${d.title} ${d.body}`));
});

test("the copy never asserts a first boot", () => {
  // A refusal is only reachable inside the container generation that exposed the
  // port — a restart turns every preview URL into a 410 instead — so the usual
  // cause is a dev server that died after serving happily for minutes. "Still
  // starting" would be a guess dressed as a fact.
  for (const elapsedMs of [5_000, 120_000]) {
    const d = classifyPreviewBootFailure({ ...html, elapsedMs });
    assert.ok(!/still starting/i.test(`${d.title} ${d.body}`), `elapsedMs=${elapsedMs}`);
  }
});

test("errorPageHtml emits a meta-refresh only when asked", () => {
  const withRefresh = errorPageHtml({ status: 503, title: "x", body: "y", refreshSeconds: 2 });
  assert.match(withRefresh, /<meta http-equiv="refresh" content="2">/);

  const without = errorPageHtml({ status: 404, title: "x", body: "y" });
  assert.ok(!without.includes("http-equiv=\"refresh\""), "the 404 page must not reload itself");
});

test("errorPageResponse carries Retry-After only alongside a refresh", () => {
  const retrying = errorPageResponse({ status: 503, title: "x", body: "y", refreshSeconds: 2 });
  assert.equal(retrying.status, 503);
  assert.equal(retrying.headers.get("retry-after"), "2");
  assert.equal(retrying.headers.get("cache-control"), "no-store");

  const plain = errorPageResponse({ status: 404, title: "x", body: "y" });
  assert.equal(plain.headers.get("retry-after"), null);
  assert.equal(plain.headers.get("cache-control"), "no-store");
});

// DEV-2547. The classifier also names what the frame is holding, so the shell can
// keep `data-preview-status` off "ready" while the frame shows one of these pages.

test("the descriptor names the frame state per branch", () => {
  assert.equal(classifyPreviewBootFailure({ elapsedMs: 1_000, ...html }).previewState, "booting");
  assert.equal(classifyPreviewBootFailure({ elapsedMs: BOOT_WINDOW_MS, ...html }).previewState, "dead");
});

test("the frame state is independent of the shape", () => {
  // The shell only ever receives it from the document shape, but the classifier must
  // not make the state depend on what the client asked for — a sub-resource refused
  // past the window is the same dead server as a navigation refused past it.
  for (const shapeInput of [
    { isUpgrade: true, wantsHtml: true, acceptsHtml: true },
    { isUpgrade: false, wantsHtml: false, acceptsHtml: false },
  ]) {
    assert.equal(classifyPreviewBootFailure({ elapsedMs: 1_000, ...shapeInput }).previewState, "booting");
    assert.equal(classifyPreviewBootFailure({ elapsedMs: 200_000, ...shapeInput }).previewState, "dead");
  }
});

test("errorPageHtml tells the parent what it is holding, only when asked", () => {
  const booting = errorPageHtml({ status: 503, title: "x", body: "y", refreshSeconds: 2, previewState: "booting" });
  assert.match(booting, /postMessage\(\{source:"demo-preview",state:"booting"\}/);
  // Inline and parse-time: a deferred or external script would be a second request to
  // the same dead port, and the shell's grace timer would already have run.
  assert.ok(!/\bdefer\b|\bsrc=/.test(booting.slice(booting.indexOf("<script"))), "must stay inline");

  const dead = errorPageHtml({ status: 503, title: "x", body: "y", previewState: "dead" });
  assert.match(dead, /postMessage\(\{source:"demo-preview",state:"dead"\}/);

  const other = errorPageHtml({ status: 404, title: "x", body: "y" });
  assert.ok(!other.includes("<script"), "the /d/:id and /embed/:id pages have no parent to tell");
});
