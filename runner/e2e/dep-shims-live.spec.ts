import { test, expect, type Page } from "@playwright/test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Dependency shims against the real hosted Sandpack bundler (dep-shims.ts).
//
// The classic bundler's babel 6 parses every file it pulls into /node_modules,
// so a dependency that ships syntax it cannot read kills the sandbox at setup.
// pipeline/dep-shims.test.mjs proves the shim transpiles; what it cannot prove
// is that the bundler then accepts the shadowed file and resolves what it
// imports. That is what this spec checks, with a project that failed on
// production before the shim existed:
//
//   @a2ui/web_core 0.12 — `import x from './schemas/x.json' with { type: 'json' }`
//   in its two version entry points → "Support for the experimental syntax
//   'moduleAttributes' isn't currently enabled". With the shim the attribute is
//   stripped and the bundler's own JSON loader has to serve the schema.
//
// The project is booted through `?payload=` with `GET /api/payload/:id` stubbed
// (payload-boot.spec.ts covers that route itself), so no demo is created.
//
// Live — needs the external Sandpack bundler and npm; opt-in via E2E_LIVE=1.

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "a2ui-hotgrid");

/** The fixture directory as the files map a payload carries: `/index.html`, `/src/...`. */
function fixtureFiles(dir = FIXTURE, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) Object.assign(out, fixtureFiles(full, `${prefix}/${name}`));
    else out[`${prefix}/${name}`] = readFileSync(full, "utf8");
  }
  return out;
}

const PAYLOAD_ID = "a2uiattrs1";

async function openFixture(page: Page) {
  await page.route("**/broker/userinfo", (route) => route.fulfill({ status: 401, json: {} }));
  await page.route(`**/api/payload/${PAYLOAD_ID}`, (route) =>
    route.fulfill({ json: { framework: "react", title: "A2UI HotGrid (dep-shim live check)", files: fixtureFiles() } }),
  );
  await page.goto(`/?payload=${PAYLOAD_ID}`);
}

test("live: a dependency that ships import attributes (@a2ui/web_core) previews", async ({ page }) => {
  test.skip(process.env.E2E_LIVE !== "1", "set E2E_LIVE=1 to run live-render checks");
  test.setTimeout(180_000);

  const parseErrors: string[] = [];
  page.on("console", (m) => {
    if (/moduleAttributes|importAttributes|SyntaxError/i.test(m.text())) parseErrors.push(m.text());
  });

  await openFixture(page);

  // The agent script renders a HotGrid with these rows; a cell with the first
  // item proves the whole chain: shim fetched, attribute stripped, JSON schema
  // resolved by the bundler, @a2ui/react mounted, Handsontable rendered.
  const preview = page.frameLocator('iframe[title="Demo preview"]');
  await expect(preview.getByText("Standing desk").first()).toBeVisible({ timeout: 150_000 });
  await expect(preview.locator(".handsontable td").first()).toBeVisible();
  expect(parseErrors, "no babel parse errors on the dependency's import attributes").toHaveLength(0);
});
