import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDocsBranch,
  resolveDocsHotVersion,
} from "./docs-import-config.mjs";

test("normalizes develop to the next bucket", () => {
  assert.deepEqual(normalizeDocsBranch("develop"), {
    docsBranch: "develop",
    bucket: "next",
  });
});

test("normalizes a production docs branch to its release bucket", () => {
  assert.deepEqual(normalizeDocsBranch("prod-docs/18.0"), {
    docsBranch: "prod-docs/18.0",
    bucket: "18.0",
  });
});

test("rejects unsupported and unsafe docs branch names", () => {
  for (const branch of [undefined, "", "18.0", "prod-docs/18", "prod-docs/18.0/../../next"]) {
    assert.throws(() => normalizeDocsBranch(branch), /--docs-branch/);
  }
});

test("uses the checkout package version for a release branch", async () => {
  const version = await resolveDocsHotVersion({
    docsBranch: "prod-docs/18.0",
    docsDir: "/docs",
    readFile: (file) => {
      assert.equal(file, "/handsontable/package.json");
      return JSON.stringify({ version: "18.0.3" });
    },
  });

  assert.equal(version, "18.0.3");
});

test("uses npm dist-tags.next for develop", async () => {
  const version = await resolveDocsHotVersion({
    docsBranch: "develop",
    docsDir: "/docs",
    fetchImpl: async (url) => {
      assert.equal(url, "https://registry.npmjs.org/handsontable");
      return { ok: true, json: async () => ({ "dist-tags": { next: "19.0.0-next.1" } }) };
    },
  });

  assert.equal(version, "19.0.0-next.1");
});

test("fails when npm does not provide dist-tags.next", async () => {
  await assert.rejects(
    resolveDocsHotVersion({
      docsBranch: "develop",
      docsDir: "/docs",
      fetchImpl: async () => ({ ok: true, json: async () => ({ "dist-tags": {} }) }),
    }),
    /dist-tags\.next/,
  );
});

test("fails when npm cannot fetch or parse dist-tags.next", async () => {
  await assert.rejects(
    resolveDocsHotVersion({
      docsBranch: "develop",
      docsDir: "/docs",
      fetchImpl: async () => ({ ok: false, status: 503 }),
    }),
    /dist-tags\.next/,
  );
  await assert.rejects(
    resolveDocsHotVersion({
      docsBranch: "develop",
      docsDir: "/docs",
      fetchImpl: async () => ({ ok: true, json: async () => { throw new Error("invalid JSON"); } }),
    }),
    /dist-tags\.next/,
  );
});
