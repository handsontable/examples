import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { importDocs } from "./import-docs.mjs";

function makeFixture(t, version = "18.0.3") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "import-docs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const docsDir = path.join(root, "docs");
  const exampleDir = path.join(docsDir, "content", "guides", "example", "javascript");
  fs.mkdirSync(exampleDir, { recursive: true });
  fs.mkdirSync(path.join(docsDir, "content", "recipes"), { recursive: true });
  fs.mkdirSync(path.join(root, "handsontable"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "handsontable", "package.json"),
    JSON.stringify({ version }),
  );
  fs.writeFileSync(
    path.join(docsDir, "content", "guides", "example", "index.md"),
    "---\ntitle: Example guide\n---\n\n## Standard\n::: example #example1\n@[code](@/content/guides/example/javascript/example1.js)\n:::\n",
  );
  fs.writeFileSync(
    path.join(exampleDir, "example1.js"),
    "const container = document.createElement('div');\ndocument.body.append(container);\n",
  );

  return { docsDir, outDir: path.join(root, "docs-examples") };
}

test("regenerating a release bucket preserves a sibling next bucket", async (t) => {
  const { docsDir, outDir } = makeFixture(t);
  const nextDir = path.join(outDir, "next");
  fs.mkdirSync(nextDir, { recursive: true });
  fs.writeFileSync(path.join(nextDir, "manifest.json"), '{"sentinel":"next"}\n');
  fs.mkdirSync(path.join(outDir, "18.0"), { recursive: true });
  fs.writeFileSync(path.join(outDir, "18.0", "stale.json"), "stale");

  await importDocs({ docsDir, docsBranch: "prod-docs/18.0", outDir });

  assert.equal(fs.readFileSync(path.join(nextDir, "manifest.json"), "utf8"), '{"sentinel":"next"}\n');
  assert.equal(fs.existsSync(path.join(outDir, "18.0", "stale.json")), false);

  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "18.0", "manifest.json"), "utf8"));
  assert.equal(manifest.bucket, "18.0");
  assert.equal(manifest.docsBranch, "prod-docs/18.0");
  assert.equal(manifest.hotVersion, "18.0.3");
  assert.equal(manifest.examples[0].bucket, "18.0");
  assert.equal(fs.existsSync(path.join(outDir, "18.0", manifest.examples[0].file)), true);

  const artifact = JSON.parse(
    fs.readFileSync(path.join(outDir, "18.0", manifest.examples[0].file), "utf8"),
  );
  assert.equal(artifact.htCoreRange, "18.0.3");
  assert.equal(JSON.parse(artifact.files["/package.json"]).dependencies.handsontable, "18.0.3");
  assert.match(artifact.files["/index.html"], /handsontable@18\.0\.3/);
});

test("develop writes the next bucket with npm dist-tags.next", async (t) => {
  const { docsDir, outDir } = makeFixture(t);

  await importDocs({
    docsDir,
    docsBranch: "develop",
    outDir,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ "dist-tags": { next: "19.0.0-next.1" } }),
    }),
  });

  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "next", "manifest.json"), "utf8"));
  assert.equal(manifest.bucket, "next");
  assert.equal(manifest.hotVersion, "19.0.0-next.1");
});
