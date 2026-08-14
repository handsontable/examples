import { test, expect, type Page } from "@playwright/test";

// Booting an ad-hoc project by id — `?payload=<id>` (DEV-2517).
//
// `GET /api/payload/:id` is stubbed: what the Worker accepts into a payload is
// covered in pipeline/payload.test.mjs, and what is worth testing here is the
// wiring the unit tests explicitly leave out — the record opens instead of the
// starter, it opens for a *signed-out* visitor (the route is public, unlike
// `/api/import`), the param is consumed, and a miss is worded as an expiry.
//
// Deterministic — no `E2E_LIVE=1`: the Sandpack bundler is aborted.

const PAYLOAD_ID = "k3f9x2ab10";

// Shaped like the Theme Builder's `javascript` export: its entry is the starter's
// own `/index.js`, plus the generated theme module the whole point of this flow is
// to carry over.
const PAYLOAD = {
  framework: "javascript",
  title: "Midnight Slate",
  files: {
    "/index.html": '<div id="example"></div>',
    "/index.js":
      "import { theme } from './theme.js';\nimport Handsontable from 'handsontable';\n// payload-marker\n",
    "/theme.js": "export const theme = { name: 'ht-theme-midnight-slate' };\n",
    "/package.json": JSON.stringify({ dependencies: { handsontable: "^18.0.0" } }, null, 2),
  },
};

async function stubShell(page: Page) {
  await page.route("**/api/versions", (route) =>
    route.fulfill({ json: { latest: "18.0.0", next: "19.0.0-next.1", versions: ["18.0.0", "17.1.0"] } }),
  );
  await page.route("https://sandpack.codesandbox.io/**", (route) => route.abort());
  await page.route("https://sandpack-bundler.codesandbox.io/**", (route) => route.abort());
  await page.route("**/broker/login**", (route) => route.abort());
}

/** Signed out, which is the state a Theme Builder visitor arrives in. */
async function anonymous(page: Page) {
  await page.route("**/broker/userinfo", (route) => route.fulfill({ status: 401, json: {} }));
}

const filesPanel = (page: Page) => page.getByRole("region", { name: "Files" });
const fileRow = (page: Page, path: string) => filesPanel(page).locator(`button[title="${path}"]`);

test("?payload= opens the stored project, not the starter, without signing in", async ({ page }) => {
  await stubShell(page);
  await anonymous(page);
  let calls = 0;
  await page.route(`**/api/payload/${PAYLOAD_ID}`, (route) => {
    calls += 1;
    return route.fulfill({ json: PAYLOAD });
  });
  await page.goto(`/?payload=${PAYLOAD_ID}`);

  // The payload's files — and *not* the react starter the playground defaults to:
  // the starter fetch already in flight has to stay out of the way.
  await expect(fileRow(page, "/theme.js")).toBeVisible();
  await expect(fileRow(page, "/index.html")).toBeVisible();
  await expect(fileRow(page, "/src/index.tsx")).toHaveCount(0);

  // `/index.js` is a path the `javascript` starter also has, so its *contents* are
  // what prove which one is open.
  await fileRow(page, "/index.js").click();
  await expect(page.locator('[data-pane-active="true"] .cm-content')).toContainText("payload-marker");

  // The payload's own title, not the starter's display name — this is what Save
  // and Fork would mint the demo's name from.
  await expect(page.getByRole("region", { name: "Box info" })).toContainText("Midnight Slate");

  // The param is consumed, so a reload does not reinstall the generated files
  // over whatever the visitor has edited since.
  await expect(page).not.toHaveURL(/payload=/);
  expect(calls).toBe(1);
});

test("an expired id says so instead of hanging on a spinner", async ({ page }) => {
  await stubShell(page);
  await anonymous(page);
  // What KV answers for an expired record and for an id that never existed alike.
  await page.route("**/api/payload/**", (route) =>
    route.fulfill({ status: 404, json: { error: "not found" } }),
  );
  await page.goto(`/?payload=${PAYLOAD_ID}`);

  await expect(page.getByText(/this playground link has expired/i)).toBeVisible();
  // And no starter quietly took its place behind the message: the starter effect is
  // gated on a failed boot too, because `loadWorkspace` clears `errorMessage` and
  // the message would be gone a second after appearing.
  await expect(fileRow(page, "/src/index.tsx")).toHaveCount(0);
});

test("a starter is the way out of a failed boot", async ({ page }) => {
  // The other side of gating "failed": the workspace is empty and the card is up,
  // so picking a starter has to be reachable from there — it is the only exit. (A
  // version change is not: the starter effect stays gated and the re-pin effect
  // wants a loaded workspace, so it moves the label and nothing else.)
  await stubShell(page);
  await anonymous(page);
  await page.route("**/api/payload/**", (route) =>
    route.fulfill({ status: 404, json: { error: "not found" } }),
  );
  await page.goto(`/?payload=${PAYLOAD_ID}`);
  await expect(page.getByText(/this playground link has expired/i)).toBeVisible();

  // The picker still opens over the error card, with no workspace behind it.
  await page.getByRole("button", { name: /React|Starter/ }).first().click();
  await page.getByRole("option", { name: "Starter templates" }).click();
  await page.getByRole("treeitem", { name: "TypeScript (Vite)" }).click();

  await expect(fileRow(page, "/index.ts")).toBeVisible();
  await expect(page.getByText(/this playground link has expired/i)).toHaveCount(0);

  // Bugbot: and the dead id is gone from the URL, so the recovery survives a
  // reload. It used to be left behind — the URL-sync effect copies
  // `location.search` forward, so the next load replaced the starter with the
  // expiry card again.
  await expect(page).not.toHaveURL(/payload=/);
});

test("a starter picked while the boot is in flight lands when it fails", async ({ page }) => {
  // Bugbot: the "failed" gate is only reachable if the starter effect re-runs on the
  // phase change. A pick made during the request returns early on "loading", and
  // without `importPhase` in the dependency list nothing re-ran when the phase went
  // to "failed" — the pick was swallowed and the visitor had to ask twice.
  await stubShell(page);
  await anonymous(page);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/payload/**", async (route) => {
    await held;
    return route.fulfill({ status: 404, json: { error: "not found" } });
  });
  await page.goto(`/?payload=${PAYLOAD_ID}`);

  // Pick a starter while the payload request is still open.
  await page.getByRole("button", { name: /React|Starter/ }).first().click();
  await page.getByRole("option", { name: "Starter templates" }).click();
  await page.getByRole("treeitem", { name: "TypeScript (Vite)" }).click();
  release();

  // The pick wins: it is what the visitor asked for after the link.
  await expect(fileRow(page, "/index.ts")).toBeVisible();
  await expect(page.getByText(/this playground link has expired/i)).toHaveCount(0);
});

test("a payload survives a version change, re-pinned in place", async ({ page }) => {
  // The starter effect is gated off while an ad-hoc workspace is open (it would
  // otherwise fetch a catalog snapshot over these files), so the version picker
  // only keeps working because the payload shares the import's re-pin effect.
  await stubShell(page);
  await anonymous(page);
  await page.route(`**/api/payload/${PAYLOAD_ID}`, (route) => route.fulfill({ json: PAYLOAD }));
  await page.goto(`/?payload=${PAYLOAD_ID}`);
  await expect(fileRow(page, "/theme.js")).toBeVisible();

  await page.getByRole("button", { name: "Handsontable version", exact: true }).click();
  await page.getByRole("option", { name: "17.1.0", exact: true }).click();

  await expect(fileRow(page, "/theme.js")).toBeVisible();
  await expect(fileRow(page, "/src/index.tsx")).toHaveCount(0);
  await fileRow(page, "/package.json").click();
  await expect(page.locator('[data-pane-active="true"] .cm-content')).toContainText("17.1.0");
});

test("picking a starter after a payload still loads it", async ({ page }) => {
  // The other half of that gate: it has to shut for the payload's own re-renders
  // and open again the moment the user asks for something from the catalog.
  await stubShell(page);
  await anonymous(page);
  await page.route(`**/api/payload/${PAYLOAD_ID}`, (route) => route.fulfill({ json: PAYLOAD }));
  await page.goto(`/?payload=${PAYLOAD_ID}`);
  await expect(fileRow(page, "/theme.js")).toBeVisible();

  await page.getByRole("button", { name: /Midnight Slate|JavaScript/ }).first().click();
  await page.getByRole("option", { name: "Starter templates" }).click();
  await page.getByRole("treeitem", { name: "TypeScript (Vite)" }).click();

  await expect(fileRow(page, "/index.ts")).toBeVisible();
  await expect(fileRow(page, "/theme.js")).toHaveCount(0);
});
