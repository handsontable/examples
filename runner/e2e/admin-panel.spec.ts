import { test, expect, type Page } from "@playwright/test";
import { signIn, stubShell } from "./helpers";

// The /admin BROWSER surface (DEV-2530 item 7, second half).
//
// session-abandoned-create.spec.ts already exercises `/api/admin/sessions`
// against the deployed Worker nightly — the *data* is covered. What nothing
// covered is the page an operator actually looks at: AdminGate's login wall,
// and the LiveSessionsSection table that DEV-2567 rebuilt (state labels,
// billable-time pricing, the pager that replaced the silent `limit: 50` cap).
// A rendering regression there is invisible to an API test by construction.
//
// Everything is stubbed with `page.route`, so the whole file runs in PR CI
// with no deployed API: the panel is one `GET /api/admin/usage` plus
// `GET /api/admin/sessions` for paging/filtering (Admin.tsx's own header
// comment), and both answer deterministic payloads built here. The payload
// shapes mirror `LiveSessionsPage` in Admin.tsx / `admin.ts` in the Worker —
// if those drift, this spec fails the way production would.
//
// The oracles are the rendered strings, not the stub echoed back: `usd()` and
// `duration()` in Admin.tsx decide what an operator reads ($1.50 vs $0.048 —
// the sub-dollar branch keeps three decimals so a cheap session doesn't
// render as $0.00), so the assertions pin the formatted VALUE the stub
// implies, magnitude branches included.

/** One `LiveSession` row as `/api/admin/sessions` serves it (field names
 *  confirmed against workers/api/src/admin.ts). Refs are 8-hex digests —
 *  session ids are bearer capabilities and never reach the browser. */
function session(overrides: {
  ref: string;
  framework: string;
  awakeSeconds: number;
  billableSeconds: number;
  quietSeconds: number;
  state: "awake" | "slept";
  estimatedUsd: number;
}) {
  return { startedAt: 1_700_000_000_000, ...overrides };
}

/** A page envelope in the `LiveSessionsPage` shape. */
function sessionsPage(
  rows: ReturnType<typeof session>[],
  counts: { offset: number; limit: number; total: number; awakeCount: number; meterCount: number },
) {
  return { rows, ...counts, truncated: false };
}

/**
 * The smallest `UsageReport` the panel renders without throwing — every field
 * Admin.tsx dereferences, empty where emptiness has a designed rendering
 * ("Nothing metered yet this month.", the LITELLM hint). The interesting part,
 * `liveSessions`, is the caller's: it is the embedded first page of the table,
 * which is why the main flow needs no `/api/admin/sessions` call at all.
 */
function usageReport(liveSessions: ReturnType<typeof sessionsPage>) {
  return {
    generatedAt: 1_700_000_100_000,
    windowDays: 30,
    budget: { tier: "ok", pct: 0.1, spendUsd: 10, limitUsd: 100, reconciled: true, enforced: true },
    settings: {
      limitUsd: 100, warnUsd: 40, anonBlockUsd: 60, newBlockUsd: 80, closedUsd: 95,
      enforce: true, alertsUsd: [50], source: "defaults" as const, updatedAt: null, updatedBy: null,
    },
    audience: {
      totals: { views: 0, visitors: 0, bots: 0 },
      daily: [], pages: [], demos: [], referrers: [], countries: [], devices: [], browsers: [], languages: [],
    },
    spendBySku: {},
    ledger: [],
    usage: [],
    demos: { total: 0, revoked: 0, createdInWindow: 0, byFramework: [], topViewed: [] },
    liveSessions,
  };
}

/** The Live sessions section — scoped by its own h2, because the SKU table and
 *  the top-viewed table are also `<table>`s and a bare role query is ambiguous. */
function liveSessionsSection(page: Page) {
  return page.locator("section").filter({
    has: page.getByRole("heading", { name: "Live sessions", exact: true }),
  });
}

test("signed out, /admin is a login wall — the panel never renders and no admin data is fetched", async ({ page }) => {
  // The contrast case. AdminGate answers a null user by calling `login()`
  // (App.tsx), a top-level `location.href` to the broker. stubShell's abort of
  // `**/broker/login**` is not enough here: an *aborted* top-level navigation
  // dumps Chromium on chrome-error://chromewebdata and takes the splash with
  // it (probed while writing this spec). A 204 is the neutering that keeps the
  // page: Chromium ignores no-content main-frame navigations and stays put —
  // registered after stubShell, so it wins (last-registered matches first,
  // the same override trick style-panel.spec.ts uses for /api/versions).
  await stubShell(page);
  let loginRedirects = 0;
  await page.route("**/broker/login**", (route) => {
    loginRedirects += 1;
    return route.fulfill({ status: 204 });
  });

  // The sharpest oracle for "the panel did not render" is that it never asked
  // for its data: AdminPanel fetches /api/admin/usage from a mount effect, so
  // any rendering of it — even a flash before a redirect — trips this flag.
  let adminApiHit = false;
  await page.route("**/api/admin/**", (route) => {
    adminApiHit = true;
    return route.fulfill({ status: 401, json: { error: "unauthorized" } });
  });

  await page.goto("/admin");

  await expect(page.getByText("Sign in to view usage…")).toBeVisible();
  // No panel chrome: the h1 belongs to AdminPanel alone.
  await expect(page.getByRole("heading", { name: /usage & cost/ })).toHaveCount(0);
  // Both halves of the gate: it sent the visitor to the broker, and it never
  // touched the admin API on their behalf. Polled: the redirect is a
  // location.href navigation from AdminGate's effect, so nothing orders the
  // route interception before a synchronous read of the counter.
  await expect.poll(() => loginRedirects, {
    message: "the gate redirected to the broker login",
  }).toBeGreaterThan(0);
  expect(adminApiHit, "no admin endpoint was called while signed out").toBe(false);
});

test("signed in, the table renders one row per session with honest state labels and derived costs", async ({ page }) => {
  await stubShell(page);
  await signIn(page);

  // Two awake rows in the report's embedded first page (the default view is
  // awake-only — DEV-2567's whole point), plus one slept meter behind the
  // filter. Cost inputs chosen to land on both `usd()` branches:
  //   1.5   -> "$1.50"  (>= $1: two decimals)
  //   0.048 -> "$0.048" (sub-dollar: three decimals — the branch that keeps a
  //                      cheap session from rendering as $0.00)
  //   0.12  -> "$0.120" (slept row — the sub-dollar branch again, on a row
  //                      whose age (2h) and billable time (15m) diverge; the
  //                      pricing itself is the server's estimatedUsd, rendered
  //                      verbatim, so what this row pins client-side is the
  //                      formatting plus the billable-basis tooltip below)
  const awake = [
    session({ ref: "aaaa1111", framework: "react", awakeSeconds: 4260, billableSeconds: 4260, quietSeconds: 30, state: "awake", estimatedUsd: 1.5 }),
    session({ ref: "bbbb2222", framework: "angular", awakeSeconds: 300, billableSeconds: 300, quietSeconds: 45, state: "awake", estimatedUsd: 0.048 }),
  ];
  const slept = session({ ref: "cccc3333", framework: "vue", awakeSeconds: 7200, billableSeconds: 900, quietSeconds: 600, state: "slept", estimatedUsd: 0.12 });

  await page.route("**/api/admin/usage**", (route) =>
    route.fulfill({ json: usageReport(sessionsPage(awake, { offset: 0, limit: 25, total: 2, awakeCount: 2, meterCount: 3 })) }),
  );
  // Filter changes re-read `/api/admin/sessions` alone (Admin.tsx). Answer by
  // the `awake` query param, exactly as parseSessionQuery reads it.
  await page.route("**/api/admin/sessions?*", (route) => {
    const awakeOnly = new URL(route.request().url()).searchParams.get("awake") !== "0";
    const rows = awakeOnly ? awake : [...awake, slept];
    return route.fulfill({
      json: sessionsPage(rows, { offset: 0, limit: 25, total: rows.length, awakeCount: 2, meterCount: 3 }),
    });
  });

  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: /usage & cost/ })).toBeVisible();

  const section = liveSessionsSection(page);
  const rows = section.locator("tbody tr");

  // One row per stubbed session, addressed by ref — never by session id.
  await expect(rows).toHaveCount(2);
  const react = rows.filter({ hasText: "aaaa1111" });
  await expect(react.getByRole("cell", { name: "react", exact: true })).toBeVisible();
  await expect(react.getByRole("cell", { name: "awake", exact: true })).toBeVisible();
  // Age is duration(4260s) = "1h 11m"; cost is usd(1.5) = "$1.50".
  await expect(react.getByRole("cell", { name: "1h 11m", exact: true })).toBeVisible();
  await expect(react.getByRole("cell", { name: "$1.50", exact: true })).toBeVisible();
  // The sub-dollar branch: three decimals, not a rounded-to-nothing "$0.05".
  await expect(rows.filter({ hasText: "bbbb2222" }).getByRole("cell", { name: "$0.048", exact: true })).toBeVisible();

  // The counts line prices the filter honestly: 2 awake now, 1 more meter
  // hiding behind the checkbox. Fed by awakeCount/meterCount, not rows.length —
  // a table that recomputes these from the visible page is the regression.
  await expect(section.getByText("2 awake · 1 slept but still metered (24h window)")).toBeVisible();

  // Two rows fit one 25-row page, so no pager — the other half of the pager
  // test below, asserted here where the fixture makes it true.
  await expect(section.getByRole("button", { name: "Next →" })).toHaveCount(0);

  // Unchecking the filter is the documented route to the 24h tail (DEV-2567:
  // that tail is where a phantom row has to be visible to be killed).
  await section.getByRole("checkbox", { name: "Only sessions still awake" }).uncheck();

  await expect(rows).toHaveCount(3);
  const sleptRow = rows.filter({ hasText: "cccc3333" });
  // The state cell says slept AND how long the meter has been quiet —
  // duration(600s) = "10m 0s". A bare "slept" would hide the one number that
  // tells an operator whether the row is a phantom or a backgrounded tab.
  await expect(sleptRow.getByRole("cell", { name: "slept · quiet 10m 0s", exact: true })).toBeVisible();
  // "$0.120" is the stub's own estimatedUsd through the usd() formatter — the
  // client renders the server's figure verbatim, so the assertion pins the
  // sub-dollar formatting branch, not the pricing math (that lives in
  // admin.ts and is the API tests' job). The tooltip IS client behavior: the
  // billable basis ("15m 0s billable"), the documented title contract that
  // stops a 2h-old slept row from reading as a 2h bill (DEV-2567's misread).
  await expect(sleptRow.getByRole("cell", { name: "$0.120", exact: true })).toBeVisible();
  await expect(sleptRow.locator('td[title="15m 0s billable"]')).toBeVisible();
});

test("past one page the pager appears, and Next asks the API for the next offset", async ({ page }) => {
  await stubShell(page);
  await signIn(page);

  // 27 awake meters against the server's 25-row page (SESSIONS_PAGE_SIZE in
  // session-listing.ts). Refs generated as real 8-hex digests so the fixture
  // stays contract-plausible.
  const ref = (i: number) => (0x10000000 + i).toString(16);
  const rowAt = (i: number) =>
    session({ ref: ref(i), framework: "react", awakeSeconds: 120, billableSeconds: 120, quietSeconds: 10, state: "awake", estimatedUsd: 0.01 });
  const firstPage = sessionsPage(
    Array.from({ length: 25 }, (_, i) => rowAt(i)),
    { offset: 0, limit: 25, total: 27, awakeCount: 27, meterCount: 27 },
  );
  const secondPage = sessionsPage(
    [rowAt(25), rowAt(26)],
    { offset: 25, limit: 25, total: 27, awakeCount: 27, meterCount: 27 },
  );

  await page.route("**/api/admin/usage**", (route) => route.fulfill({ json: usageReport(firstPage) }));
  // Record the offsets the panel actually sends: the pager's promise is the
  // query contract (`?awake=1&offset=25`), not a client-side slice of rows it
  // already holds — the old table's silent 50-row cap was exactly a client
  // that never asked for more.
  const askedOffsets: number[] = [];
  await page.route("**/api/admin/sessions?*", (route) => {
    const params = new URL(route.request().url()).searchParams;
    const offset = Number(params.get("offset") ?? 0);
    askedOffsets.push(offset);
    return route.fulfill({ json: offset >= 25 ? secondPage : firstPage });
  });

  await page.goto("/admin");

  const section = liveSessionsSection(page);
  await expect(section.locator("tbody tr")).toHaveCount(25);

  // The pager renders because total (27) > limit (25), and says where you are.
  await expect(section.getByText("1–25 of 27")).toBeVisible();
  await expect(section.getByRole("button", { name: "← Previous" })).toBeDisabled();
  const next = section.getByRole("button", { name: "Next →" });
  await expect(next).toBeEnabled();

  await next.click();

  await expect(section.locator("tbody tr")).toHaveCount(2);
  await expect(section.getByText("26–27 of 27")).toBeVisible();
  // On the last page the roles flip — Next has nothing left to ask for.
  await expect(section.getByRole("button", { name: "Next →" })).toBeDisabled();
  await expect(section.getByRole("button", { name: "← Previous" })).toBeEnabled();
  expect(askedOffsets, "Next re-read /api/admin/sessions at the next offset").toEqual([25]);
});
