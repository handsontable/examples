import test from "node:test";
import assert from "node:assert/strict";
import { BOOT_WINDOW_MS, classifyPreviewBootFailure, isPortNotListening } from "../workers/api/src/preview-boot.ts";
import { errorPageHtml, errorPageResponse } from "../workers/api/src/error-page.ts";

// DEV-2537. The classifier decides what an anonymous visitor sees when the
// container is up but nothing is listening on the dev-server port, and whether
// that fact is worth a Sentry issue. Both halves are pinned here because the
// Durable Object seam that calls it cannot be exercised from `pipeline/` at all
// — reproducing a mid-boot port refusal needs a real container caught in a
// narrow window.

/** The verbatim workerd message behind the DEMOS-K issue. */
const WORKERD = "There has been an internal error connecting to the port.";

const html = { isUpgrade: false, wantsHtml: true, acceptsHtml: true };

test("recognises the workerd port message", () => {
  assert.equal(isPortNotListening(new Error(WORKERD)), true);
});

test("recognises it through a cause chain", () => {
  const wrapped = new Error("preview forward failed", { cause: new Error(WORKERD) });
  assert.equal(isPortNotListening(wrapped), true);
  assert.equal(isPortNotListening(new Error("outer", { cause: wrapped })), true);
});

test("does not match errors that are somebody else's job", () => {
  // Handled upstream by forwardPreviewRequest, which turns it into a 500 of
  // its own. Matching it here would take over a case we have not diagnosed.
  assert.equal(isPortNotListening(new Error("Network connection lost.")), false);
  assert.equal(isPortNotListening(new Error("boom")), false);
  assert.equal(isPortNotListening(new Error("no such image")), false);
});

test("does not match non-errors", () => {
  assert.equal(isPortNotListening(undefined), false);
  assert.equal(isPortNotListening(null), false);
  assert.equal(isPortNotListening("connecting to the port"), false);
});

test("terminates on a self-referencing cause", () => {
  const loop = new Error("a");
  loop.cause = loop;
  assert.equal(isPortNotListening(loop), false);

  const a = new Error("a");
  const b = new Error("b", { cause: a });
  a.cause = b;
  assert.equal(isPortNotListening(a), false);
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

test("the copy never asserts a first boot", () => {
  // The dominant cause is wake-from-sleep, where the boot script is not re-run.
  // "still starting" would be a guess dressed as a fact.
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
