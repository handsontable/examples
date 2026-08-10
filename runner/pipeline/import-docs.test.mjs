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
  // DEV-2129: Tier-1 sandboxes must run on `parcel` — the only classic-bundler
  // environment that shares Handsontable's module registry (plugins work).
  // Modern syntax/TSX is handled by client-side pre-transpilation, not the env.
  assert.equal(artifact.sandpackEnvironment, "parcel");
  assert.equal(JSON.parse(artifact.files["/package.json"]).dependencies.handsontable, "18.0.3");
  // DEV-2207: the bucket version reaches the artifact through package.json only
  // (asserted above). The generated HTML carries no Handsontable stylesheet at
  // all — this used to assert a baked `dist/handsontable.full.min.css` CDN link,
  // a path removed from the package at 17.0.0, so it was asserting a 404.
  assert.equal(/handsontable[^"]*\.css/i.test(artifact.files["/index.html"]), false);
});

test("develop writes the next bucket with the newest npm -next version by publish date", async (t) => {
  const { docsDir, outDir } = makeFixture(t);

  await importDocs({
    docsDir,
    docsBranch: "develop",
    outDir,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        // Stale tag — must be ignored in favour of the publish-date winner.
        "dist-tags": { next: "0.0.0-next-64139ae-20260219" },
        time: {
          created: "2020-01-01T00:00:00.000Z",
          "0.0.0-next-64139ae-20260219": "2026-02-19T04:00:00.000Z",
          "19.0.0-next.1": "2026-07-24T04:00:00.000Z",
        },
      }),
    }),
  });

  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "next", "manifest.json"), "utf8"));
  assert.equal(manifest.bucket, "next");
  assert.equal(manifest.hotVersion, "19.0.0-next.1");
});

test("pins every imported extra dependency to its npm version once", async (t) => {
  const { docsDir, outDir } = makeFixture(t);
  const sourcePath = path.join(docsDir, "content", "guides", "example", "javascript", "example1.js");
  fs.writeFileSync(
    sourcePath,
    "import Chart from 'chart.js/auto';\nimport { color } from '@scope/colors';\nconsole.log(Chart, color);\n",
  );
  const requests = [];

  await importDocs({
    docsDir,
    docsBranch: "prod-docs/18.0",
    outDir,
    fetchImpl: async (url) => {
      requests.push(url);
      if (url.endsWith("/chart.js")) {
        return { ok: true, json: async () => ({ "dist-tags": { latest: "4.4.8" } }) };
      }
      if (url.endsWith("/%40scope%2Fcolors")) {
        return { ok: true, json: async () => ({ "dist-tags": { latest: "2.1.0" } }) };
      }
      throw new Error(`unexpected registry request ${url}`);
    },
  });

  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "18.0", "manifest.json"), "utf8"));
  const artifact = JSON.parse(
    fs.readFileSync(path.join(outDir, "18.0", manifest.examples[0].file), "utf8"),
  );
  const dependencies = JSON.parse(artifact.files["/package.json"]).dependencies;

  assert.deepEqual(requests.sort(), [
    "https://registry.npmjs.org/%40scope%2Fcolors",
    "https://registry.npmjs.org/chart.js",
  ]);
  assert.equal(dependencies["chart.js"], "4.4.8");
  assert.equal(dependencies["@scope/colors"], "2.1.0");
  assert.equal(Object.values(dependencies).includes("latest"), false);
});

// DEV-2130: a react example authored only as `.jsx` used to ship an artifact
// whose `entry` (/src/main.tsx) pointed at a file the wrapper never emitted —
// Sandpack "succeeded" without executing anything and the preview stayed blank.
// The importer must refuse to write such an artifact and fail the run.
test("fails and skips the artifact when generated files miss the module entry", async (t) => {
  const { docsDir, outDir } = makeFixture(t);
  const reactDir = path.join(docsDir, "content", "guides", "example", "react");
  fs.mkdirSync(reactDir, { recursive: true });
  fs.writeFileSync(
    path.join(docsDir, "content", "guides", "example", "index.md"),
    "---\ntitle: Example guide\n---\n\n## Standard\n::: example #example1\n@[code](@/content/guides/example/react/example1.jsx)\n:::\n",
  );
  fs.writeFileSync(
    path.join(reactDir, "example1.jsx"),
    "export default function App() { return null; }\n",
  );

  await assert.rejects(
    importDocs({ docsDir, docsBranch: "prod-docs/18.0", outDir }),
    /module entry \/src\/main\.tsx/,
  );

  const bucket = path.join(outDir, "18.0");
  const written = fs.existsSync(bucket) ? fs.readdirSync(bucket) : [];
  assert.equal(written.some((f) => f.includes("react__example1.jsx")), false);
});

// DEV-2182: the docs Pikaday recipe moves from the `@handsontable/pikaday` fork
// (bundled typings) to upstream `pikaday` (none). Angular is the only variant
// that type-checks, so the importer must resolve `@types/pikaday` alongside it —
// otherwise `ng serve` fails on TS7016 and the demo renders blank.
test("resolves @types/pikaday for an Angular example importing upstream pikaday", async (t) => {
  const { docsDir, outDir } = makeFixture(t);
  const angularDir = path.join(docsDir, "content", "guides", "example", "angular");
  fs.mkdirSync(angularDir, { recursive: true });
  fs.writeFileSync(
    path.join(docsDir, "content", "guides", "example", "index.md"),
    "---\ntitle: Example guide\n---\n\n## Standard\n::: example #example1\n@[code](@/content/guides/example/angular/example1.ts)\n:::\n",
  );
  fs.writeFileSync(
    path.join(angularDir, "example1.ts"),
    "/* file: app.component.ts */\nimport { Component } from '@angular/core';\nimport moment from 'moment';\nimport Pikaday from 'pikaday';\nimport 'pikaday/css/pikaday.css';\n@Component({ selector: 'app-root', template: '' })\nexport class AppComponent { picker = Pikaday; now = moment(); }\n/* end-file */",
  );

  const versions = {
    pikaday: "1.8.2",
    "%40types%2Fpikaday": "1.7.10",
    moment: "2.30.1",
    "%40types%2Fmoment": "2.13.0",
  };

  await importDocs({
    docsDir,
    docsBranch: "prod-docs/18.0",
    outDir,
    fetchImpl: async (url) => {
      const latest = versions[url.split("/").pop()];
      if (!latest) throw new Error(`unexpected registry request ${url}`);
      return { ok: true, json: async () => ({ "dist-tags": { latest } }) };
    },
  });

  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "18.0", "manifest.json"), "utf8"));
  const artifact = JSON.parse(
    fs.readFileSync(path.join(outDir, "18.0", manifest.examples[0].file), "utf8"),
  );
  const pkg = JSON.parse(artifact.files["/package.json"]);

  assert.equal(pkg.dependencies.pikaday, "1.8.2");
  assert.equal(pkg.devDependencies["@types/pikaday"], "1.7.10");
});

test("fails before writing an imported package with no concrete npm version", async (t) => {
  const { docsDir, outDir } = makeFixture(t);
  fs.writeFileSync(
    path.join(docsDir, "content", "guides", "example", "javascript", "example1.js"),
    "import Chart from 'chart.js';\nconsole.log(Chart);\n",
  );

  await assert.rejects(
    importDocs({
      docsDir,
      docsBranch: "prod-docs/18.0",
      outDir,
      fetchImpl: async () => ({ ok: true, json: async () => ({ "dist-tags": {} }) }),
    }),
    /chart\.js.*dist-tags\.latest/,
  );
});
