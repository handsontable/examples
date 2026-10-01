// The API worker bundles a compact docs taxonomy (`docs-taxonomy.generated.ts`)
// so `example.saved` can attribute a save to its guide and area (DEV-3146).
// The import-docs workflow regenerates it from the docs-examples manifests; this
// fails when a manifest changed and the file did not follow, which would
// silently leave new guides' saves unattributed.
// Run: node --experimental-strip-types --test pipeline/docs-taxonomy-generated.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";
import { buildDocsTaxonomy, renderDocsTaxonomy } from "./import-docs.mjs";

register("./fixtures/worker-hooks.mjs", import.meta.url);
const { resolveExampleSource } = await import("../workers/api/src/telemetry/example-saved.ts");

const GENERATED = fileURLToPath(new URL("../workers/api/src/docs-taxonomy.generated.ts", import.meta.url));

test("the committed taxonomy is exactly what the docs-examples manifests produce", () => {
  assert.equal(
    fs.readFileSync(GENERATED, "utf8"),
    renderDocsTaxonomy(buildDocsTaxonomy()),
    "regenerate: node --input-type=module -e 'import(\"./pipeline/import-docs.mjs\").then(m => m.writeDocsTaxonomy())'",
  );
});

test("every manifest example resolves, in its own bucket, to the guide and area its example.open carries", async () => {
  const base = fileURLToPath(new URL("../apps/authoring/public/docs-examples/", import.meta.url));
  let checked = 0;
  for (const bucket of fs.readdirSync(base)) {
    const manifestPath = `${base}${bucket}/manifest.json`;
    if (!fs.existsSync(manifestPath)) continue;
    for (const e of JSON.parse(fs.readFileSync(manifestPath, "utf8")).examples) {
      const got = await resolveExampleSource(`docs:${bucket}:${e.docsPath}`, async () => null);
      assert.deepEqual(
        [got?.kind, got?.ref, got?.area, got?.bucket],
        ["docs", e.guide, e.breadcrumb[0] ?? undefined, bucket],
        `${bucket} ${e.docsPath}`,
      );
      checked++;
    }
  }
  assert.ok(checked > 1000, `checked ${checked} examples`);
});

function fakeBuckets(spec) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docs-taxonomy-"));
  for (const [bucket, examples] of Object.entries(spec)) {
    fs.mkdirSync(path.join(dir, bucket));
    fs.writeFileSync(
      path.join(dir, bucket, "manifest.json"),
      JSON.stringify({ examples: examples.map(([docsPath, guide, area]) => ({ docsPath, guide, breadcrumb: [area] })) }),
    );
  }
  return dir;
}

test("a path whose guide differs between buckets is answered per bucket; the newest wins the default", () => {
  const dir = fakeBuckets({
    "18.9": [["a/x/react/e1.tsx", "guides/old.md", "Old"]],
    "18.10": [["a/x/react/e1.tsx", "guides/mid.md", "Mid"]],
    next: [["a/x/react/e1.tsx", "guides/new.md", "New"], ["a/y/react/e1.tsx", "guides/y.md", "Y"]],
  });
  const { guides, pathGuide, overrides } = buildDocsTaxonomy(dir);
  const at = (i) => guides[i][0];
  assert.equal(at(pathGuide["a/x/react/e1.tsx"]), "guides/new.md", "numeric order: 18.10 is newer than 18.9, next is newest");
  assert.equal(at(overrides["18.9"]["a/x/react/e1.tsx"]), "guides/old.md");
  assert.equal(at(overrides["18.10"]["a/x/react/e1.tsx"]), "guides/mid.md");
  assert.equal(overrides.next, undefined, "the newest bucket needs no overrides");
  assert.deepEqual(Object.keys(overrides["18.9"]), ["a/x/react/e1.tsx"], "only differing paths are stored");
});
