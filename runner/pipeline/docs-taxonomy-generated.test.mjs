// The API worker bundles a compact docs taxonomy (`docs-taxonomy.generated.ts`)
// so `example.saved` can attribute a save to its guide and area (DEV-3146).
// The import-docs workflow regenerates it from the docs-examples manifests; this
// fails when a manifest changed and the file did not follow, which would
// silently leave new guides' saves unattributed.
// Run: node --experimental-strip-types --test pipeline/docs-taxonomy-generated.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { buildDocsTaxonomy, renderDocsTaxonomy } from "./import-docs.mjs";
import { DOCS_GUIDES, DOCS_PATH_GUIDE } from "../workers/api/src/docs-taxonomy.generated.ts";

const GENERATED = fileURLToPath(new URL("../workers/api/src/docs-taxonomy.generated.ts", import.meta.url));

test("the committed taxonomy is exactly what the docs-examples manifests produce", () => {
  assert.equal(
    fs.readFileSync(GENERATED, "utf8"),
    renderDocsTaxonomy(buildDocsTaxonomy()),
    "regenerate: node --input-type=module -e 'import(\"./pipeline/import-docs.mjs\").then(m => m.writeDocsTaxonomy())'",
  );
});

test("every manifest example resolves to the guide and area its example.open carries", () => {
  const base = fileURLToPath(new URL("../apps/authoring/public/docs-examples/", import.meta.url));
  let checked = 0;
  for (const bucket of fs.readdirSync(base)) {
    const manifestPath = `${base}${bucket}/manifest.json`;
    if (!fs.existsSync(manifestPath)) continue;
    for (const e of JSON.parse(fs.readFileSync(manifestPath, "utf8")).examples) {
      const [guide, area] = DOCS_GUIDES[DOCS_PATH_GUIDE[e.docsPath]];
      assert.equal(guide, e.guide, `${bucket} ${e.docsPath}`);
      assert.equal(area, e.breadcrumb[0] ?? "", `${bucket} ${e.docsPath}`);
      checked++;
    }
  }
  assert.ok(checked > 1000, `checked ${checked} examples`);
});
