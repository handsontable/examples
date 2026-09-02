import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { stableBucketVersions } from "../packages/runtime/src/version.js";

// The picker's fallback has to be a *current* version when /api/versions cannot
// answer (DEV-2735).
//
// Before this the fallback was a literal in `catalog.ts` that nothing bumped:
// it still named 18.0.0 as the newest choice months after 18.1.0 became npm
// `latest`, so a visitor whose versions call had not landed — or had failed,
// which is the fail-open branch, not an edge case — was offered no current
// release at all. The unit tests cover the derivation and the pin; this covers
// the part neither can see, that the derived value actually reaches the picker.
//
// Read from `catalog.json` rather than written down here: a hardcoded version
// in a spec is the same drift this fix removes, one release from being wrong.
const { bucketVersions } = JSON.parse(
  readFileSync(new URL("../catalog.json", import.meta.url), "utf8"),
) as { bucketVersions: Record<string, string> };
const NEWEST = stableBucketVersions(bucketVersions)[0];

test("the version fallback names the newest bucket when /api/versions is unreachable", async ({
  page,
}) => {
  // `abort`, not a stubbed body: this asserts the fail-open path, which is what
  // a visitor gets on a registry hiccup or an API deploy.
  await page.route("**/api/versions", (route) => route.abort());

  await page.goto("/");

  // `.first()`: the preview bar and the status bar both print it.
  await expect(page.getByText(`Handsontable ${NEWEST}`).first()).toBeVisible();
});
