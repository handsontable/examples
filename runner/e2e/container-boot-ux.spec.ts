import { test, expect, type Page } from "@playwright/test";
import { stubShell } from "./helpers";

// The container boot surface (DEV-2530 item 6) — the guide's first troubleshooting
// entry. A Tier-2 boot is the one place in the product where a user stares at an
// empty pane for tens of seconds with no grid to reassure them, so the pane makes
// three promises (packages/editor-shell/src/PreviewPane.tsx, `BootLog`): it says
// what the wait is ("Starting the live dev server — …"), it keeps the live boot
// log within reach behind a Details disclosure, and it resolves — to the demo or
// to the error card — when the boot does. This spec is those three promises, one
// test each.
//
// Deterministic throughout: no container, no worker, no Docker. The whole session
// lifecycle is three HTTP shapes (packages/runtime/src/container.ts):
//
//   POST /api/session                      -> { previewUrl, port }
//   GET  /api/session/:id/status?port=...  -> { ready, log, failed? }   (polled, 2.5s)
//   DELETE /api/session/:id                                             (teardown)
//
// and the log on screen is the *last* status response's `log` wholesale —
// `App.tsx` line ~2104 replaces `bootLog` on every progress emission, it never
// appends. So a stub holding `ready: false` holds the pane in `booting` with any
// log we choose, and flipping one field of the same stub resolves the boot either
// way. Modeled on preview-recovery.spec.ts's /api/session stub, extended with the
// status route the boot surface is actually driven by.

/** The boot overlay's caption, verbatim from PreviewPane.tsx. Asserted as copy on
 *  purpose: the sentence IS the user-visible promise (the guide quotes it), so a
 *  reworded caption should fail this test and force the guide to move with it. */
const BOOT_CAPTION =
  "Starting the live dev server — first load installs dependencies and can take a minute…";

/** A plausible install-then-dev-server log. Deliberately already in `tailLines`'
 *  fixed point — no ANSI escapes, no `\r`, no blank lines, fewer than 12 lines —
 *  so the disclosure must show it byte-for-byte. The cleaning rules themselves
 *  (CSI stripping, last-`\r`-frame-wins) are PreviewPane's own concern, not this
 *  spec's promise. */
const BOOT_LOG_LINES = [
  "Progress: resolved 231, reused 231, downloaded 0, added 231, done",
  "dependencies:",
  "+ handsontable 18.0.0",
  "Done in 4.2s",
  "> demo@0.0.0 dev /workspace",
  "> vite --host --port 5173",
];
const BOOT_LOG = BOOT_LOG_LINES.join("\n");
const NEWEST_LINE = BOOT_LOG_LINES[BOOT_LOG_LINES.length - 1]!;

/** A failed install, shaped like pnpm's real output. The ERR_ line matters: it is
 *  what `bootFailureDetail`'s announcing tier picks as the cause, and the prose
 *  hint BELOW it is the decoy that tier exists to skip (failure-log.ts,
 *  CAUSE_LINE's anchoring comment). */
const FAILURE_CAUSE =
  "ERR_PNPM_NO_MATCHING_VERSION  No matching version found for handsontable@99.99.99";
const FAILURE_LOG_LINES = [
  "Progress: resolved 12, reused 12, downloaded 0, added 12",
  FAILURE_CAUSE,
  "This error happened while installing the dependencies of demo@0.0.0",
];
const FAILURE_LOG = FAILURE_LOG_LINES.join("\n");

/** Where the create stub claims the dev server lives. Never fetched in the hold
 *  and failure tests; the completion test routes it to a stub document so the
 *  runtime's point-the-iframe step has something real to load. `.invalid` is the
 *  RFC 2606 reserved TLD — if a request ever escapes the route, it cannot reach
 *  anything. */
const PREVIEW_URL = "https://e2e-container-preview.invalid/";

type ContainerStatus = { ready: boolean; log: string; failed?: boolean };

/**
 * Stub the Tier-2 session lifecycle (original: the /api/session 503 stub in
 * preview-recovery.spec.ts). The create succeeds — the runtime reads only
 * `{ previewUrl, port }` off the response and mints its session id client-side
 * (container.ts, `mintSessionId`) — and the status route answers with whatever
 * the returned controller currently holds, so a test can flip the boot's outcome
 * mid-flight. The DELETE is answered too: `dispose()` fires it on page close, and
 * swallowing it here keeps a developer machine's real worker out of the loop.
 */
async function stubContainerSession(page: Page, initial: ContainerStatus) {
  let status = initial;
  await page.route(/\/api\/session$/, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({ json: { sessionId: "e2e-boot-ux", previewUrl: PREVIEW_URL, port: 5173 } });
  });
  await page.route(/\/api\/session\/[^/]+\/status/, (route) => route.fulfill({ json: status }));
  await page.route(/\/api\/session\/[^/]+$/, (route) =>
    route.request().method() === "DELETE" ? route.fulfill({ json: { ok: true } }) : route.fallback(),
  );
  return {
    set(next: ContainerStatus) {
      status = next;
    },
  };
}

const preview = (page: Page) => page.locator('section[aria-label="Preview"]');

// `react-js` is a container starter (catalog.json: engine "container") — the same
// entry preview-recovery.spec.ts boots. It also flips `containerBoot` on the
// pane, which is what gates the whole surface under test: Tier 1 gets the bare
// spinner and none of this.
const CONTAINER_EXAMPLE = "/?example=react-js";

// Promise 1: while the container boots, the pane explains the wait and the boot
// log is one click away — and readable exactly as the container printed it.
//
// The stub never resolves, so nothing here is a race against a fast boot: every
// assertion runs against a pane that is *held* in `booting`, the state a user
// with a cold container sits in. `data-preview-status` is the documented
// machine-readable contract for that state (PreviewPane.tsx); the caption and the
// log are asserted as text because text is what the user was promised.
test("a booting container explains the wait and reveals the boot log behind Details", async ({ page }) => {
  await stubShell(page);
  await stubContainerSession(page, { ready: false, log: BOOT_LOG });

  await page.goto(CONTAINER_EXAMPLE);

  await expect(preview(page)).toHaveAttribute("data-preview-status", "booting");
  await expect(page.getByText(BOOT_CAPTION)).toBeVisible();

  // The always-visible single row is the NEWEST line (BootLog derives it from the
  // tail), the one signal that distinguishes "installing" from "stuck". Asserted
  // exact and BEFORE the disclosure opens: at that point the only element with
  // this text is the live line — afterwards the tail <pre> matches too — and its
  // visibility also proves the first poll's log replaced the runtime's own
  // "Starting container…" placeholder, so the disclosure below reads our fixture,
  // not the placeholder.
  await expect(page.getByText(NEWEST_LINE, { exact: true })).toBeVisible();

  // Details is a real disclosure with the accessible contract to match:
  // aria-expanded, and no log <pre> in the pane until asked.
  const details = page.getByRole("button", { name: "Details" });
  await expect(details).toHaveAttribute("aria-expanded", "false");
  await expect(preview(page).locator("pre")).toHaveCount(0);

  await details.click();
  await expect(details).toHaveAttribute("aria-expanded", "true");
  const tail = preview(page).locator("pre");
  await expect(tail).toBeVisible();
  // Strict equality, not toContainText: a contains-check would pass a tail that
  // dropped, reordered, or duplicated lines — the exact defects a log pipeline
  // invents (tailLines' own header documents one it used to). Equality is honest
  // here only because the fixture avoids everything tailLines cleans; see
  // BOOT_LOG_LINES.
  expect(await tail.textContent(), "the disclosure shows the stubbed tail verbatim").toBe(BOOT_LOG);

  // And it closes again — a disclosure that only opens is a reveal, not a control.
  await details.click();
  await expect(details).toHaveAttribute("aria-expanded", "false");
  await expect(preview(page).locator("pre")).toHaveCount(0);
});

// Promise 2 (resolution, unhappy leg): a boot script that exits nonzero turns the
// held boot surface into the error card — cause line first, full log kept, and a
// way out offered.
//
// The oracle chain is the real product path: `failed: true` on the status poll
// makes container.ts pick the cause via bootFailureDetail and emit
// ContainerBootFailure; App.tsx's describeRuntimeError composes "cause\n\ntail"
// into the card's <pre>, the ONLY place a user ever sees a boot log after a
// failure. The cause-leads assertion is the DEV-2533 regression pinned from the
// user's side: bury the ERR_ line under the tail again and this goes red.
test("a boot failure resolves the surface to the error card, cause first and log kept", async ({ page }) => {
  await stubShell(page);
  const session = await stubContainerSession(page, { ready: false, log: FAILURE_LOG });

  await page.goto(CONTAINER_EXAMPLE);
  // Prove we resolve *from* the held boot state, not that the app skipped it.
  await expect(page.getByText(BOOT_CAPTION)).toBeVisible();

  // Exactly what the status route reports when the boot script has exited: same
  // log, `failed` now true. The next poll (2.5s cadence) delivers it.
  session.set({ ready: false, log: FAILURE_LOG, failed: true });

  await expect(preview(page)).toHaveAttribute("data-preview-status", "error");
  await expect(page.getByText("The preview could not start")).toBeVisible();
  await expect(page.getByText(BOOT_CAPTION)).toHaveCount(0);

  const body = preview(page).locator("pre");
  await expect(body).toContainText(FAILURE_CAUSE);
  // The prose hint pnpm prints AFTER the code line stays visible as context —
  // and must not have been picked over the ERR_ line as the headline.
  await expect(body).toContainText("This error happened while installing");
  expect(
    (await body.textContent()) ?? "",
    "the picked cause line leads the card, not whatever the tail starts with",
  ).toMatch(/^ERR_PNPM_NO_MATCHING_VERSION/);

  // A Tier-2 boot failure kills the container's dev server outright; the card's
  // Restart is the only way back (preview-recovery.spec.ts proves the button
  // remounts — here it only has to be offered).
  await expect(page.getByRole("button", { name: "Restart preview" })).toBeVisible();
});

// Promise 3 (resolution, happy leg): when the dev server comes up, the overlay —
// caption, live line, disclosure — gets out of the way and the pane is the dev
// server.
//
// `ready: true` alone is deliberately NOT the oracle for "resolved": the runtime
// points the iframe, waits for its `load` plus a 3.5s render grace, then re-probes
// the status route before claiming ready (container.ts, DEV-2547) — so the test
// must supply a document at previewUrl for the frame to load, and the iframe's
// `src` landing on that URL is the concrete proof the pane was handed to the
// stubbed dev server rather than the status attribute flipping over a blank.
test("a boot that completes drops the overlay and points the pane at the dev server", async ({ page }) => {
  await stubShell(page);
  // The "dev server": whatever the create response named as previewUrl, fulfilled
  // locally so no request leaves the machine (and `.invalid` cannot resolve if
  // one did).
  await page.route(`${PREVIEW_URL}**`, (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>demo</title><p>demo up</p>" }),
  );
  const session = await stubContainerSession(page, { ready: false, log: BOOT_LOG });

  await page.goto(CONTAINER_EXAMPLE);
  await expect(page.getByText(BOOT_CAPTION)).toBeVisible();

  session.set({ ready: true, log: BOOT_LOG });

  // Poll cadence (2.5s) + frame load + render grace (3.5s) + confirm probe ≈ 6s
  // on the happy path; 30s leaves CI slack without masking a hang at the 60s
  // test budget.
  await expect(preview(page)).toHaveAttribute("data-preview-status", "ready", { timeout: 30_000 });
  await expect(page.getByText(BOOT_CAPTION)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Details" })).toHaveCount(0);
  await expect(page.locator('iframe[title="Demo preview"]')).toHaveAttribute("src", PREVIEW_URL);
});
